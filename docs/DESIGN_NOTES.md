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

Pre-Phase-2 the `messages.user_id` was a free-text `:string` (Phase 1 hardcoded `"vjt"`). Phase 2 made it an `Ecto.UUID` FK to `users.id`. Decision G2 accepted **wipe + recreate the dev/prod DB** rather than write a backfill migration.

**Why wipe:**

1. **Data was throwaway.** Phase 1 was a walking skeleton; the messages in `grappa_dev.db` were vjt's solo testing chatter, not load-bearing scrollback.
2. **Backfill semantically impossible.** Pre-Phase-2 messages had no `user_id` at all (single-user); attributing them to "the operator's UUID" would be a fabricated FK. The operator's account didn't exist at the time the rows were written.
3. **Migration scaffolding cost > value.** Writing a backfill migration that conjures a default User row, then UPDATEs every messages.user_id to that UUID, then ALTERs the column to NOT NULL + adds the FK — 60+ lines of ecto migration for data that's about to be deleted anyway.

**The flip-condition:** if Phase 2 had landed AFTER any production deploy with non-trivial scrollback, the migration would have been mandatory regardless of cost. The wipe is allowed *because* the only consumer was the operator who knew the data was throwaway.

**Apply:** Phase 5 hardening adds a real backfill-migration discipline. From this point forward (post-Phase-2 close), schema changes that touch FK columns get migrations, not wipes.

### 2026-04-26 — Phase 2 close: no `delete_network/1`; cascade-on-empty-unbind only

> **SUPERSEDED (twice).** The "no `delete_network/1`" stance was reversed
> by the admin-panel B1 cluster, which added an explicit, doubly-gated
> `Networks.delete_network/1`. The "cascade-on-empty-unbind" half — and
> the `:scrollback_present` rollback below — was removed by GH #105 (see
> the 2026-06-28 entry at the end of this log): unbind now ONLY detaches
> the credential, never deletes the network. The rationale below is kept
> as the historical record of the original design.

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

Filed as "Post-T31 state" follow-ups:

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

S5 of the integration-testing plan called BUG7
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
`Grappa.QueryWindows`'s `broadcast_windows_list/2`: the function was
sending raw `%Window{}` structs over PubSub, and the struct
doesn't derive `Jason.Encoder`. Phoenix.Socket.V2.JSONSerializer's
`fastlane!/1` crashed at the WS edge during fan-out, the crash
dropped the user-channel process, and any subsequent
`close_query_window` push from cic landed on a dying ref and was
lost — explaining a long-suspected "DM windows you close stay
open server-side" bug that pre-dated CP15. Fix:
`Grappa.QueryWindows.Wire.render_grouped/1`, sibling to
`Grappa.Scrollback.Wire`. Both `broadcast_windows_list/2` (PubSub
side) and `GrappaWeb.GrappaChannel`'s `push_query_windows_list/2`
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

**Two design options weighed:**

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
re-exporting `Grappa.Log`'s private `session_metadata/0` so the IRC namespace
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
Grappa.Admission.Captcha.SiteVerifyHttp — every upstream-side
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

## 2026-05-12 — bucket Z LANDED-with-caveat: carry-forward closures + long-tail sweep + mega-cluster close

7 commits (`bf66bb2..98cae46`) shipping the bucket Z scope from the
2026-05-12 codebase review's mega-cluster — closure batch for prior
buckets' carry-forwards, long-tail MED+LOW sweep, mega-cluster
retrospective.

### Z-1 carry-forward closures

The Z-1 phase re-evaluated every bucket's open carry-forward against
current code BEFORE shipping. Three resolved as ship, two as
NON-FINDING (transitively closed or misclassified), three as defer
(behavior change / migration / refactor scope outside bucket Z's
"sweep + close" charter):

1. **H-Z1 — `query_windows_list` envelope unification** (commit
   `bf66bb2`). Bucket D's code-review counted three "inlined sites"
   for `%{kind: "query_windows_list", windows: ...}`; close reading
   broke them down to two true call sites
   (`QueryWindows.broadcast_windows_list/2`,
   `GrappaChannel.push_query_windows_list/2`) plus one moduledoc
   example. The per-window body already delegated via
   `Grappa.QueryWindows.Wire.render_grouped/1`; only the OUTER
   envelope was hand-rolled at each site. Lift to
   `Wire.windows_list_payload/1` mirrors the bucket D pattern for
   `Grappa.Cic.Wire.bundle_hash/1` (cross-module/S4): the helper
   takes the already-rendered `windows_map` so callers retain the
   existing two-step pipeline. The `GrappaChannel`
   `@type query_windows_list_payload` becomes a thin alias for
   `Wire.windows_list_payload/0`; the in-context `@typedoc` likewise
   delegates so the typespec, the value constructor, and the
   consumer all reference one source of truth. +7 unit tests in new
   `test/grappa/query_windows/wire_test.exs`. Existing pattern-match
   assertions in channel + context tests pin the wire contract from
   the consumer side and stay as-is — that's the correct level of
   coupling.

2. **persistence/S18 — `User.password_hash` `redact: true`** (commit
   `7177ad6`). Re-evaluated as MED (not the HIGH the bucket H
   carry-forward note implied); pure schema-attribute add, no
   migration. `Visitor.password_encrypted` and
   `Networks.Credential.password_encrypted` both carry `redact: true`;
   `User.password_hash` was the outlier. Argon2 PHC-format is
   functionally not a credential, but `inspect(%User{})` leaks the
   algorithm + salt + cost params (fingerprintable surface). One-line
   discipline parity.

3. **L3 `auth_json` `:kind` discriminator — NON-FINDING.** The
   `kind: "user" | "visitor"` discriminator at `auth_json.ex:38,45`
   is a controller-action shape (which subject type was logged in),
   NOT a Wire concern. The Accounts.Wire + Visitors.Wire bodies
   already delegate via `*_to_credential_json/1`; the `:kind` tag
   is intrinsic to `AuthController.login/2`'s API contract. Lifting
   to a hypothetical `Auth.Wire` would force the auth domain into
   both context Wire modules — boundary violation. One site per
   discriminator + zero cross-file drift surface. Documented +
   dropped from Z scope. (The brief itself flagged this as "lower
   urgency than H-Z1".)

4. **persistence/S13 (kind-enum CHECK frozen-snapshot) —
   NON-FINDING.** Already addressed transitively. The test at
   `test/grappa/migrations/check_constraints_test.exs:125-146` reads
   `Message.kinds()` from the prod accessor and asserts every kind
   passes the CHECK; an 11th kind that the CHECK doesn't cover
   red-flags THERE before silently slipping past. The requested
   "drift surface" guard already exists. Documented closure.

5. **persistence/S15 (`EncryptedBinary` field-name lie) —
   DEFERRED.** Renaming `password_encrypted` →
   `password_at_rest` (or splitting into ciphertext + virtual
   decrypted field) is a multi-module rename touching every callsite
   + a migration. Brief excludes "behavior change" + "migration"
   from bucket Z. Re-evaluate post-Phase-5 hardening cluster.

6. **persistence/S17 (`:utc_datetime` vs `:utc_datetime_usec`
   precision) — DEFERRED.** Aligning `query_windows.opened_at` with
   the microsecond-precision schema family requires an `alter table`
   migration. Brief excludes migrations. Re-evaluate post-Phase-5.

### Z-2 long-tail sweep

Six commits, in the brief's "5-10 commits, 3-5 related fixes per
commit" target. Touched the cleanest, lowest-risk findings across
docker / cross-module / CLAUDE.md without bleeding into refactor
or behavior-change territory:

1. **Docgen warning silencing** (commit `e119b51`). `mix docs`
   surfaced 5 in-source warnings — moduledocs / docstrings / type
   docs referencing private functions (`Bootstrap.spawn_with_admission/6`,
   `NetworksController.spawn_session_after_connect/3`,
   `GrappaChannel.push_bundle_hash/1`, `Admission.Config.put_test_config/1`)
   or hidden modules (Grappa.Application and its `start/2`). Each
   reword turns the backtick-link into either a public-module
   reference + plain-prose helper name OR a path hint to
   `lib/grappa/application.ex`. Also caught one self-introduced
   warning from the H-Z1 commit (the `Cic.Bundle.bundle_hash_payload/1`
   typo — actual fn is `Grappa.Cic.Wire.bundle_hash/1`); fixed
   inline. Residual 6 warnings are DESIGN_NOTES historical
   references + Phoenix internals — out of scope.

2. **Post-CP23 stale comment cleanup** (commit `e4a3912`). Three
   comment-only fixes flagged by agent-docker (L1, L7, L10):
   `scripts/dialyzer.sh` PLT comment said "named volume grappa_build"
   but CP23 collapsed to bind-mounted `priv/plts/`; `compose.yaml`
   said "Compose evaluates the `:?` only when consumed" but the
   block uses `${X:-}` (empty default), never `${X:?}`;
   `infra/snippets/security-headers.conf` said "via the nginx service
   `volumes:` block in compose.prod.yaml" but CP23 collapsed to
   `compose.yaml --profile prod`. Three NON-FINDINGs in the same
   agent re-verified as already addressed: docker/M2 LABEL (already
   removed in CP23), docker/L4 port-4002 comment (accurate), docker/L5
   `dist/` line in `.dockerignore` (already absent).

3. **`require Logger` hoist** (commit `d3266bf`, agent-cross-module
   S9). Two private helpers each carried inline `require Logger`
   instead of one top-of-module require. Idiomatic Elixir is one
   require at module top; the in-helper requires were no-op
   duplicates. First attempt placed `require Logger` BEFORE the alias
   block; Credo's ConsistentAliasOrder check correctly flagged it
   as a code-readability issue — the fix is post-alias placement
   matching every other controller in the codebase. (Lesson: Credo
   is a useful constraint on style intuitions; trust the tool's
   judgment over the "logical pre-alias because it's a directive"
   instinct.)

4. **`async: false` rationale documentation** (commit `946e83d`,
   agent-cross-module S8). Two test files (`Grappa.LogTest`,
   `Grappa.ApplicationTest`) carried `async: false` without a
   moduledoc explanation; most async-false files in the suite have
   one. Both are genuinely async-false-required (LogTest mutates
   `Logger.metadata/1` (process-global within the test process) +
   asserts against the metadata it just set; ApplicationTest reads
   `Grappa.Admission.Config.config/0` from `:persistent_term`,
   node-global). Document via comment so the next reader knows
   whether a refactor is safe (it isn't) without re-deriving the
   constraint.

5. **CLAUDE.md PubSub topic shape correction** (commit `98cae46`,
   agent-cross-module S6). The highest-impact Z-2 finding because
   CLAUDE.md is declared authority by its own moduledoc. CLAUDE.md
   documented topics as `grappa:user:{user}`, `grappa:network:{net}`,
   `grappa:network:{net}/channel:{chan}` — but Phase 2 sub-task 2h
   shipped user-rooted topics (`grappa:user:{user_name}`,
   `grappa:user:{user_name}/network:{network_slug}`,
   `grappa:user:{user_name}/network:{network_slug}/channel:{channel_name}`)
   for cross-user authz at the routing layer. The implementation in
   `Grappa.PubSub.Topic` is correct; CLAUDE.md was the divergent
   source. Drift would have misled future agents into proposing
   non-user-rooted topics that bypass routing-layer authz partition.
   Both occurrences fixed (key-invariant section + Phoenix/Ecto
   patterns section); both now point at `Grappa.PubSub.Topic` as
   SoT.

### Caveat — `ci.yml` RED on FIRST RUN, integration.yml GREEN

Same shape as bucket I per memory `feedback_no_ci_retries_on_first_failure`:

- ✓ `integration.yml` 25759757864 GREEN ON FIRST RUN (5m26s)
- ✗ `ci.yml` 25759757869 RED ON FIRST RUN (1m59s) — 1 failure on
  `test/grappa/spawn_orchestrator_test.exs:186` (different line in
  the same file as bucket I's :251 failure).

Documented shared-singleton class — the test-infra cluster's
charter. Per brief `(h.2)` "If shared-singleton class: document in
CP24 as Z-N LANDED-with-caveat, continue with the next Z task. Do
NOT spend bucket Z time fixing the class." Bucket Z honoured the
brief: ship the carry-forwards + sweep, document the caveat, hand
off to test-infra.

Bucket Z content does NOT cause the failure: zero touches to
`lib/grappa/admission/`, `lib/grappa/session/backoff.ex`,
`lib/grappa/spawn_orchestrator.ex` implementation,
`lib/grappa/admission/network_circuit.ex`, or
`lib/grappa/session_registry.ex` across all 7 commits.

### Mega-cluster CLOSED

10 buckets (A through I plus Z, plus the H regression cluster)
across one calendar day (2026-05-12). 37 HIGH closed; 1 deferred
(lifecycle/S5 → test-infra). 0 CRITICAL outstanding. ~62 MED + ~58
LOW long-tail catalogued for future-cluster cherry-picks.

**What worked, mega-cluster scale:**

1. **Per-bucket deploy cadence.** Memory `feedback_per_bucket_deploy`
   discipline — every bucket close ran push → deploy → healthcheck →
   integration smoke. Caught the bucket H regression cluster within
   30 minutes of bucket H ship; would have taken hours to discover
   at end-of-cluster otherwise.
2. **Sequential bucket order.** Buckets closed in strict order, no
   parallel buckets. Kept us out of merge-hell — no bucket's
   worktree had to rebase against another's surprise edits. 8
   parallel agents would have collided on `Grappa.Scrollback.Wire`,
   `Session.Server`, and `lib/grappa/admission/` repeatedly.
3. **Reviewer-pass discipline post bucket close.** Bucket D + bucket
   H both ran a separate code-reviewer pass after the LANDED claim;
   any HIGH findings either folded back into the bucket or carried
   forward to bucket Z. The reviewer is part of the LANDED contract,
   not optional.
4. **Per-bucket carry-forward enumeration.** Each bucket's CP24
   section explicitly lists what carries forward. Z had a clear
   punch list, not an open-ended sweep.
5. **NON-FINDING discipline.** Re-evaluating findings against
   current code BEFORE shipping fixes (Z-1 L3, persistence/S13,
   docker/M2/L4/L5, cross-surface/L4) avoided 4+ false-fix commits.
   Bucket A's C2 NON-FINDING set the tone — verifying with a live
   probe + reading the adapter source before assuming the review's
   premise is the right reflex.

**What didn't, mega-cluster scale:**

1. **Shared-singleton test class.** Surfaced in CI ~5 times across
   the mega-cluster (bucket H BootstrapTest series, bucket I
   spawn_orchestrator_test:251, bucket Z spawn_orchestrator_test:186,
   bucket I local cp13/cp15-b5/m9 e2e flakes). Each surface was
   logged but not fixed — the class is unfixed across the entire
   mega-cluster. Documentation (caveat sections in CP24, memory
   `feedback_shared_singleton_test_class`) is no substitute for the
   architectural fix. test-infra cluster is the explicit follow-up.
2. **Hot-deploy preflight blind-spots.** Bucket I cross-module/S1
   discovered the `deploy.sh` regex was structurally blind to
   bare-map state shapes for THREE of the modules it enumerated.
   Memory `feedback_hot_deploy_preflight` codified the lesson; the
   `Grappa.HotReload.LongLivedModules` SoT module is the
   architectural fix. Lesson: enumerations in shell scripts that
   parallel atom lists in Elixir code drift silently — encode the
   list in Elixir + parse from the script.
3. **DESIGN_NOTES docgen residuals.** Bucket Z silenced 5 in-source
   moduledoc warnings but DESIGN_NOTES historical references to
   private functions / hidden modules remain. Touching DESIGN_NOTES
   historical entries to satisfy docgen would erase the original
   phrasing of the decision; defer to a hypothetical
   "history-rewrite" cluster (which probably should never happen).
4. **Mega-cluster duration.** ~13 hours from review-LANDED to
   bucket Z LANDED-with-caveat. Sustainable in a one-day burst but
   not as a default cadence — code-review every 2 weeks (per
   `docs/reviewing.md`) is correctly load-spreading. Resist the
   temptation to repeat this pattern.

### Test-infra cluster opens next

Per brief (i): the test-infra cluster (briefed in
`/tmp/orchestrate-next-test-infra.txt`) is the next cluster opening.
Its charter is the architectural fix that dissolves the
shared-singleton class — the principal carry-forward from both
bucket I and bucket Z. After test-infra closes, Phase 5 hardening
opens (TLS verify_none → CA chain, PromEx, Sobelow strictness,
NickServ-on-connect/NOTICE/REGISTER); then image-upload, /names UX
silent bugs, hostname rename — per memory `project_post_p4_1_arc`
arc.


## 2026-05-12 — Test-infra cluster (CP25): max_cases=1 closes shared-singleton class

Followed CP24 mega-cluster close immediately. Sequential 3-bucket
cluster (TI-1 + TI-2 + TI-3) addressing the latent shared-singleton
fight that surfaced ~5 times across CP24 buckets H/I/Z without
getting fixed.

### Root cause

The Application starts ONCE per `mix test` process, so
`Grappa.Session.Backoff`, `Grappa.Admission.NetworkCircuit`,
`Grappa.WSPresence`, and `Grappa.SessionRegistry` are application-wide
singletons shared across every test. ExUnit defaults to
`max_cases = schedulers_online * 2` (typically 16 on 8-core boxes);
`Ecto.Adapters.SQL.Sandbox` covers the Repo, but those GenServers +
ETS tables have no per-test sandbox. Two concurrent tests colliding
on a recycled sqlite rowid (network_id) inherit each other's session
counts / circuit state / registry entries, surfacing as intermittent
CI failures whose surface line/file does not predict the offending
pair.

### Path chosen

Two paths considered:

- **Path A** — per-test supervised singleton instances + injected
  lookup name. Preserves async perf but invasive: 3 production
  GenServer signature changes (name + ETS table parameterization)
  plus per-test setup scaffolding for every test that touches them.
- **Path B** — `config :ex_unit, max_cases: 1`. 1-line config, zero
  production code changes, ~22s → ~42s test-suite latency.

vjt-blessed Path B per CLAUDE.md "Lightweight over heavyweight." The
architectural cost of A is heavyweight relative to a problem that
surfaces ~once-per-mega-cluster. The perf delta is bearable.

### Buckets

- **TI-1 `35b12ba`** — `config :ex_unit, max_cases: 1` in
  `config/test.exs` with full rationale comment. Defense in depth:
  each singleton module gains a `## Test isolation` moduledoc
  paragraph documenting the `async: false` constraint at the
  declaration site so future contributors don't reintroduce the class
  even if `max_cases` is later relaxed for a faster lane.
- **TI-2 `ac76ee4`** — Audit fixed all 18 bare-string
  `user_fixture(name:)` calls. Collateral fix: two hardcoded
  `Topic.channel("vjt", ...)` literals in
  `messages_controller_outbound_test.exs` masked by the prior
  fixture-name match; switched to `vjt.name` per CLAUDE.md "Use
  production code in tests."
- **TI-3 `3a2184c`** — Flipped `admin_controller_test.exs` from
  `async: true` to `async: false` (cic-bundle-changed tests register
  fake socket pids against the `Grappa.WSPresence` singleton — the
  prior moduledoc claim "no shared state" was wrong). Audit
  confirmed `reap_visitors_test.exs` is genuinely singleton-free.

Total class is now closed: 0 `async: true` tests touch any
application singleton, suite is sequentialized at the ExUnit level,
and singleton modules document the rule at their declaration site.

### Closure evidence (CLOSED 2026-05-12)

Cluster-landing commit `5bfce29` — both workflows GREEN ON FIRST
RUN: `ci.yml` `25761866724` + `integration.yml` `25761866714`. The
prior 2 docs-only commits to main (`e873ece` bucket Z LANDED docs +
`98cae46` CLAUDE.md docs) had `ci.yml` red with the
`bootstrap_test.exs` shared-singleton signature — same branch, no
production-code changes. Signature-match in the docs-only failures +
green-on-first-run post-fix is direct evidence the class is closed.

Cluster CLOSED ~30 minutes after open. Path B was the right call:
zero production-code changes (only moduledoc additions documenting
the constraint at the declaration site), ~20s test-suite latency
cost, class provably closed at the lowest possible cost.

## CP26 — Message replay on reconnect (2026-05-13)

Vjt-observed live 2026-05-12 ~22:51 CEST: cic on iOS Safari (and other
tab-suspending contexts) loses live messages after a transient WS
disconnect. Server scrollback DB has the rows; only a full page
refresh recovers them. Multiple consecutive misses on `#it-opers`,
14s gap. NEVER happened before the post-cr-review mega-cluster per
vjt — even on iOS Safari which routinely suspends tabs.

The triggering regression was in the mega-cluster but the
**architectural gap** is older: server-side Phoenix.PubSub.broadcast/2
is fire-and-forget. If the WS drops the instant before a row's
broadcast, the in-flight payload has no live subscriber and is
silently lost for THAT cic session. Scrollback DB is source-of-truth;
the live stream is best-effort.

The cluster fixes the architectural gap, not just the mega-cluster
regression that surfaced it.

### Server-side delta — `Scrollback.fetch_after/6`

Mirror-symmetric to existing `fetch/6` but with cursor on `id > after_id`
(NOT `server_time`). Three reasons:

  - The wire shape (`Wire.to_json/1`) already exposes `id` so cic has
    the value cheap.
  - `id` is monotonic per-row; same-millisecond `server_time` ties (the
    existing `fetch/6` docstring's caveat) become a non-issue.
  - Returns ASC (chronological) so cic appends in natural sequence
    without a flip in the consumer.

REST controller adds `?after=<id>` query param. Mutually exclusive
with `?before=` (silent precedence would mask client bugs); both
unparseable / both supplied together → 400.

### Cic-side reconnect-backfill — three concerns, one module

`cicchetto/src/lib/reconnectBackfill.ts`:

  - `recordSeen(key, msg)` — high-water mark per topic, monotonic.
    Wired into `routeMessage` so EVERY rendered row updates the
    cursor. Live and backfilled rows go through the same site by
    design.
  - `noteJoinOk(slug, name)` — per-topic join counter. First call
    returns false (initial subscribe); subsequent calls return true
    (re-join after disconnect). phoenix.js's `Push.resend()` does
    not clear `recHooks`, so a single `.receive("ok", cb)` registered
    at first join keeps firing on every auto-rejoin — the WS reconnect
    lifecycle is the natural detector, no parallel signal needed.
  - `runBackfill(slug, name)` — REST GET `?after=<lastSeenId>`,
    dispatches each row through `appendToScrollback` (the SAME verb
    the live WS handler uses → dedupe-by-id is automatic, ordering
    preserved by monotonic id, no special interleave logic).
    Concurrency-guarded (no overlapping fetches per key); errors log
    + leave cursor for next reconnect to retry.

`socket.ts:joinChannel` gained an optional `onJoinOk` callback parameter;
all 5 join sites in `subscribe.ts` (channels, pending, query, dm-listener,
$server) pass `() => noteJoinOk(...) && runBackfill(...)`. The
DM-listener variant carries an extra paragraph explaining why
own-nick-topic backfill recovers self-msgs only (CP14-B3 own-nick
narrowing on the controller); inbound peer DM gap recovery rides
each per-peer query window's own backfill cursor.

### Bonus — defensive resync on socket-open transitions

A second gap class: a topic added server-side DURING the disconnect
window. Cic never learns of it because the `channels_changed`
broadcast on the user-topic was best-effort fan-out and got dropped
on the disconnected WS. Phoenix.js's auto-rejoin handles known
Channel objects; topics cic never knew about are silently absent
forever (until the next page refresh).

Fix: a new createEffect in `subscribe.ts` watches `socketHealth().state`
and on every transition into "open" (post-initial) calls
`refetchNetworks()` + `refetchChannels()`. Forces the channels-loop
createEffect to re-run with fresh server-side truth so any topic
added during the gap is picked up. The `prev` filter masks the
initial open transition so the bootstrap path isn't double-fired.

Together with the per-topic backfill, the cluster covers BOTH the
missed-message gap and the missed-topic gap. Per the cluster prompt:
"the right behavior is BOTH: 1. Resub ALL channels on reconnect
(no missed topic) 2. Backfill any messages that arrived during the
gap." Both shipped in the same cluster.

### Acceptance + LANDED evidence

`scripts/check.sh` exit-0:
- `8 doctests, 29 properties, 1577 tests, 0 failures`
- `Total errors: 0, Skipped: 0, Unnecessary Skips: 0` (Dialyzer)

`scripts/integration.sh message-replay-on-reconnect`:
- `1 passed (430ms inside the parallel suite)` first-run green
- `1 passed (746ms standalone)` second-run green

Pre-existing local-only flake observed: `cp13-server-window:171`.
Confirmed identical failure on plain `main` (pre-cluster) — NOT a
regression from this cluster. CI on `main` remains green per
`gh run list`.


---

## 2026-05-13 — channel-state numerics delegated, 329 RPL_CREATIONTIME wired (CP28 cluster `channel-created-notice`)

### Bug

Live DB on `raccooncity.azzurra.chat` had 94 rows of
`kind: notice, body: "1776720934", meta: %{"numeric": 333}` — the
333 RPL_TOPICWHOTIME unix timestamp leaking as user-visible
scrollback noise. Same disease for 332 RPL_TOPIC (94 rows
duplicating the topic text already conveyed by the typed
`topic_changed` event).

### Diagnosis history (the orchestrator brief was wrong)

The brief proposed handling a "Bahamut bare-integer NOTICE"
pattern + treating 329 RPL_CREATIONTIME as silently dropped at
the `event_router.ex` catch-all. Live DB query disproved both:

- `count(*) WHERE meta LIKE '%329%'` → 0 rows (Bahamut/Azzurra
  doesn't emit 329 at all).
- `count(*) WHERE kind='notice' AND meta='{}' AND body GLOB '[0-9]*'`
  → 0 rows (no bare-int NOTICE pattern in evidence).

The actual source: `lib/grappa/session/numeric_router.ex
@delegated_numerics` was missing `324, 329, 331, 332, 333`.
`Server.handle_info({:irc, %Message{command: {:numeric, _}}}, ...)`
persists every non-delegated numeric as a bare `:notice` row
BEFORE delegating. EventRouter's dedicated handlers for 331/332/
333/324 update `state.topics` / `state.channel_modes` correctly —
but the dual-path also wrote duplicate notice rows with
body=trailing-param.

Per CLAUDE.md "Challenge the spec" + memory
`feedback_orchestrator_autonomy` (HALT only on big deviations),
the sibling halted before writing code, paged the human, and
re-scoped on confirmation.

### Fix

1. Added 324/329/331/332/333 to `@delegated_numerics`. Stops the
   dual-persist for all five.
2. New 329 RPL_CREATIONTIME handler in EventRouter caches a parsed
   `DateTime.t()` in `state.channels_created` (lifecycle mirrors
   `state.topics` — drop on self-PART, self-KICK) and emits
   `{:channel_created, channel, dt}`.
3. New `:channel_created` Server apply_effects clause broadcasts
   on the per-channel topic via `SessionWire.channel_created/3`.
   Wire shape carries an ISO 8601 string (`DateTime.to_iso8601/1`)
   so Jason encoding stays trivial.
4. Cic: `channelTopic` store gains `createdByChannel` signal +
   `seedChannelCreated` setter. `JoinBanner` renders 2 new
   irssi-style lines:
   - "Channel was created on …" (from 329 cache)
   - "Topic set by … on …" (from existing 333-fed `set_by` /
     `set_at` — store had the data, JoinBanner just wasn't
     rendering it pre-cluster).

### Why a separate state field instead of extending topic_entry

`state.channels_created` is a sibling cache, not a field of
`topic_entry`. Same lifecycle (per-channel, JOIN-time,
PART/KICK-cleanup) but different domain — channel creation time
is a property of the channel, topic set-by/set-at is a property
of the topic. Per CLAUDE.md "no leaky abstractions" + "reuse the
verbs, not the nouns": shared execution shape (cache + effect +
broadcast + cic store + JoinBanner line) is fine; merging the
nouns under `topic_entry` would have polluted a topic-named
struct with a non-topic field.

### Acceptance + LANDED evidence

`scripts/check.sh` exit-0:
- `8 doctests, 29 properties, 1581 tests, 0 failures`

`scripts/bun.sh run test`:
- `808 tests, 0 failures`

`scripts/bun.sh run check`:
- biome + tsc clean, 102 files

Hot-vs-cold preflight: this cluster modifies
`Grappa.Session.Server`'s `@type t :: %{...}` (adds
`channels_created` field) so `deploy.sh` auto-classifies as COLD.
~30s session downtime on deploy.


---

### 2026-05-13 — invariant flip: read state moves server-side

Original CLAUDE.md invariant from Phase 1: *"No server-side `MARKREAD`
/ read cursors. Read position is client-side only. Adding it later is
forward-compatible; removing it later would break clients that came to
depend on it."* That invariant is being deliberately flipped in the
`server-side-read-state` cluster. Three forces drove
the flip at once:

1. **The cp13-S5 race.** `tests/cp13-server-window.spec.ts:171` fails
   in cluster ordering on macOS local but passes on Linux CI. Logs
   from `.worktrees/p0-numerics/` on 2026-05-13 caught the race
   timeline: cic GETs `/messages` (empty), POSTs PRIVMSG, server
   inserts the upstream `401 :notice`, broadcasts on the per-channel
   topic — and the cic Phoenix Channel JOIN lands ~20ms LATER. The
   broadcast fires before subscribe; the `401` row vanishes from cic
   state. The shape of the bug is "cic is the cursor authority": when
   the WS join lands after the broadcast, the row is lost forever
   because cic has no way to ask "what did I miss since cursor X".
   With server-side cursor + a unified `?after=<id>` endpoint +
   refresh-on-join-ok, the WS join becomes "tell me what I missed
   since cursor X" and the row is recovered deterministically. The
   U-line server-config bug investigated 2026-05-12 was a red herring
   — cp13-S5 reproduces with the U-line fix REVERTED.

2. **Multi-device sync.** Today each cic instance is its own island.
   Read on phone → no badge cleared on laptop. Operator-grade tools
   are expected to sync read state across devices.

3. **Phase 6 IRCv3 facade alignment.** `+draft/read-marker` (`MARKREAD
   #chan timestamp=X`) and CHATHISTORY both presume server-side cursor
   storage. Building it now means the listener facade is a thin
   translation layer, not a redesign.

A fourth bug (operator's own JOIN/PART/QUIT counts against `eventsUnread`
on rejoin) lands cleanly in the same cluster — the badge logic is
touched in the same file (`cicchetto/src/lib/subscribe.ts`).

**New invariant** (per plan §"CLAUDE.md invariant change"):

> Read state is server-owned, per (subject, network, channel). Cursor
> stored as `last_read_message_id` (FK to `messages.id`). cic reads the
> cursor from the subject envelope on login + per-window from a topic
> event; cic POSTs the operator's current position as they settle.
> Phase 6 IRCv3 facade exposes the same cursor as `+draft/read-marker`
> MARKREAD lines on the listener side. Removing server-side cursor is
> a breaking change.

Schema lives at `read_cursors (subject, network_id, channel,
last_read_message_id)` with subject XOR check + partial unique indexes
mirroring `messages` schema convention. `Grappa.ReadCursor` is the
context module. The cic-side `lib/readCursor.ts` is replaced (same name,
new shape) by a signal-map fed from `/me` envelope + Phoenix Channel
join replies + `read_cursor_set` typed wire events on the per-channel
topic. No feature flag, no transition period — straight cutover per
CLAUDE.md "total consistency" rule. cic state is reconstructable from
server state on first load post-flip.

**Apply:** the cluster ships in seven buckets (R-1 schema + context →
R-2 REST unification → R-3 POST + envelope + WS push → R-4 cic cutover
→ R-5 refresh-on-join → R-6 own-action unread filter → R-Z legacy
cleanup). Per-bucket commit + deploy + healthcheck + browser smoke.
After R-5 the parked `cluster/numeric-delegation-p0` branch unblocks
(rebase onto main, verify cp13-S5 green, merge cold-deploy, continue
P-0b through P-0e).


---

## 2026-05-13 — CP29 server-side read-state cluster CLOSED

The seven-bucket `cluster/server-side-read-state` shipped end-to-end.
Buckets R-1..R-Z merged to main; `0.2.0 → 0.3.0` minor bump for the
invariant flip. Cold-deploy gate triggered by mix.exs version change
+ new migration; per-bucket integration was done on the branch with
the cold cutover held to R-Z so production sees the cluster as one
atom (matches the cluster mandate).

Commits (in landing order):

- `c9fe7f1` R-1 — server-owned cursor schema + `Grappa.ReadCursor` context
- `b7fc135` R-2 — unify REST surface around id cursors + `?around=`
- `d851ec6` R-3 — `POST /networks/:slug/channels/:name/read_cursor` +
  `/me` envelope + `read_cursor_set` typed WS push
- `7598839` R-4 — cic-side cursor backend flip (signal map; legacy
  localStorage one-shot nuke)
- `1106264` R-5 — refresh-on-WS-join-ok + collapse cic
  reconnectBackfill into `refreshScrollback` (closes cp13-S5)
- `5189d2c` R-6 — `isOwnPresenceEvent` predicate at
  `cicchetto/src/lib/ownPresenceEvent.ts`; refactor subscribe.ts gate
  + extend ScrollbackPane in-pane unread-marker filter (closes vjt's
  "/part → /join shows 'unread messages' for my own actions" bug)
- R-Z — this docs sweep + version bump

Bugs closed in production after the cold cutover lands:

- **cp13-S5** (S5 caveat in `cp13-server-window.spec.ts`) — peer DM
  during WS gap recovered by R-5's refresh-on-join.
- **vjt's own-action unread alert** — own JOIN/PART/QUIT/MODE/NICK/KICK
  rows no longer surface in the in-pane `── XX unread messages ──`
  marker. Sidebar/bottom-bar badge gate (subscribe.ts:191) and in-pane
  marker filter (ScrollbackPane.tsx) now share one predicate; the
  drift class is closed.

Decisions deferred (documented for future readers):

- **Auto-set cursor on operator's own POST**: not wired. The
  selection.ts focus-leave model (with sibling browser-blur arm) is
  the canonical "I've moved on" signal and is uniform across own-msg
  vs peer-msg vs scroll-up scenarios. Wiring site if needed:
  post-`Grappa.Scrollback.persist_event/1`, before broadcast, so the
  broadcast carries the new cursor.
- **Explicit mark-as-unread UI**: server verb (`Grappa.ReadCursor.set/4`,
  last-write-wins) is the wire surface; cic exposure (slash command,
  right-click) is a follow-up cluster.
- **Scroll-settle cursor derivation**: cic currently sets the cursor
  to the scrollback tail on settle. Reading the actual visible row
  from scroll position and setting the cursor there is a follow-up.
- **Mention click cursor-rewind UX**: requires extending
  `MentionsBundle` wire shape with message ids + a one-shot
  scroll-to verb in `ScrollbackPane`. Separate cluster.

Invariant flip wording is unchanged from R-1 (CLAUDE.md lines 51-57)
and remains accurate post-cluster. Phase 6 IRCv3 facade exposes the
same cursor as `+draft/read-marker` MARKREAD lines.

Next-up: parked `cluster/numeric-delegation-p0` worktree unblocks
(rebase onto main; verify cp13-S5 + m3/m4/replay green; cold deploy
for the U-line submodule bump; continue P-0b → P-0e, order:
P-0b AWAY → P-0e INVITING → P-0d LUSERS → P-0c WHOWAS).


---

## 2026-05-14 — CP30 P-0 numeric-delegation cluster CLOSED

6-bucket cluster shipping 5 typed wire events for previously-leaked
Bahamut numerics: `whois_bundle` (extended with 11 flags), `peer_away`
(standalone 301), `invite_ack` (341), `lusers_bundle` (251–266
sequence), `whowas_bundle` (314/369/406 with 312 conflict-gate).
Branch `cluster/numeric-delegation-p0` merged ff-only to main as
`8a38660`. Cluster close
detail at `docs/checkpoints/2026-05-14-cp30.md`.

Three slash commands wired through cic: `/lusers`, `/whowas <nick>`,
plus `/invite` (the verb already existed but its 341 ack was
silently dropped pre-P-0e/P-0f).

**Mid-cluster route flip (P-0f).** P-0e shipped `invite_ack` on
`Topic.channel(subject, slug, channel)` where `channel` is the
TARGET. Live browser smoke at cluster close caught the silent drop:
operators usually invite peers to channels they are NOT in (e.g.
`/invite grappa #it-opers` from #bofh), and cic only subscribes to
per-channel topics for joined channels — so the broadcast landed on
a topic with zero listeners. P-0f flipped the route to
`Topic.user/1` and moved the cic mount to the always-visible
$server window. Wire payload shape unchanged; the `channel` field
becomes informational instead of a routing key.
`feedback_silent_retry_anti_pattern` shape — caught only because
`feedback_per_bucket_deploy` mandates real browser smoke at cluster
close.

**Bugs surfaced (deferred to next cluster).** Two principle violations
caught by vjt's manual smoke: (1) inbound `INVITE <ourNick> <#chan>`
is silent-dropped by EventRouter fallthrough — P-0e/P-0f addressed
the WRONG direction (operator-issued 341 confirmation, not inbound
INVITE command); (2) the EventRouter fallthrough is a silent-drop
class — KILL, WALLOPS, GLOBOPS, ERROR, CHGHOST, AUTHENTICATE,
vendor verbs all silently dropped. Both fold into the next cluster's
**no-silent-drops** principle — EventRouter fallthrough → structured
`:notice` persist with `meta.raw = %{verb, sender, params}`; cic
owns localization.

**312 conflict-gate.** Bahamut reuses 312 RPL_WHOISSERVER for both
WHOIS (carrying serverinfo) AND WHOWAS (carrying ctime(logoff_time)).
EventRouter clause now conflict-gates: prefer whois_pending; else
fold into most-recent WHOWAS entry; else no-op. WHOWAS entries
stored REVERSED (head = most recent 314) so the 312 fold is O(1)
head-prepend instead of O(n) `++ [entry]` (which Credo's MapInto
check rejects). Wire builder reads `hd(entries)` for the most-recent
projection; multi-history rendering deferred (RFC allows N entries
per nick but accumulator only projects head).

**Cards UX renegotiation flagged.** vjt: "I am not convinced on
cards but we can renegotiate this at a later stage". Cards stayed in
this cluster (consistency with WhoisCard precedent +
`feedback_card_vs_scrollback_ux`); a brainstorm-then-bucket cluster
will reconsider the shape post-no-silent-drops.

**Cold-deploy required** because P-0c added `whowas_pending` and
P-0d added `lusers_pending` to `Session.Server` long-lived state.
Per `feedback_deploy_sh_preflight_field_addition_gap`, the preflight
regex misses field-additions inside existing struct blocks; manual
`--force-cold` was required.

**Phase 5 list cleanup.** P-3 "jitter" reference in the original
Phase 5 list is ALREADY DONE — `Grappa.Session.Backoff` has
`@jitter_pct 25` since T31 shipped. Drop from any future Phase 5
scoping. P-4 PromEx + P-5 NickServ Vault HSM both deferred much
later per vjt 2026-05-14.

Next cluster: **no-silent-drops** (vjt-blessed 6 buckets,
fully orchestrator-automated). Brief in `/tmp/orchestrate-next.txt`
+ `project_post_p4_1_arc` memory.


## 2026-05-14 — CP31 no-silent-drops cluster CLOSED

Closed at `455c481`. Cluster mandate per `project_post_p4_1_arc`:
surface every event the server produces; close the silent-drop
class introduced in P-0 (route flip) plus the broader pattern
observed across surfaces. Fully orchestrator-automated.

### Shape

19 commits across 11 sub-buckets. The B5 codebase review (8 parallel
agents covering IRC + lifecycle + persistence + web + cicchetto +
cross-module + cross-surface + docker/deploy) produced 152 findings
total: 1 CRIT + 31 HIGH + ~57 MED + ~44 LOW + ~19 NIT. B6.x folded
in every actionable HIGH:

* **CRIT closed:** 1/1 — CRIT-1 AUTHENTICATE deny-list at
  `EventRouter` catch-all head (closes plaintext-credential leak
  to `$server` scrollback, same disease class as W12 NickServ-leak).
* **HIGH closed:** 25/31 (H-2 through H-31 — see CP31 ledger for
  per-bucket mapping).
* **HIGH NON-FINDING:** 2 (H-13 server-side, H-21 web — re-evaluated
  against current code per `feedback_mega_cluster_lessons`).
* **HIGH DEFER:** 1 (H-23 `Scrollback.list_archive/3` perf via
  generated column → Phase 6 CHATHISTORY cluster; design AGAINST
  Phase 6's actual listener query shape, not speculatively).

### Headline lessons

**1. The catch-all-vs-typed-event tradeoff resolved**

B1 (the original `:notice` catch-all bucket on 2026-05-13) closed
the visible silent-drop — KILL/WALLOPS/GLOBOPS/ERROR/CHGHOST/INVITE
now persist + render. But it introduced THREE secondary failure
modes the B5 review surfaced:

  * CRIT-1 — credential leak (AUTHENTICATE base64) into `$server`
    scrollback.
  * HIGH-2 — empty-trailing verbs silently dropped by
    `validate_required(:body)`.
  * HIGH-7 — kind reuse: `:notice` is a CONTENT kind
    (`@body_required_kinds` includes it), so the catch-all rows
    leaked into any future filter `kind in [:privmsg, :notice,
    :action]` for "human content."

B6.11 ultimately resolved (3) by adding `:server_event` to
`Message.@kinds`, excluded from `@body_required_kinds` AND
`@dm_with_eligible_kinds`. The migration is sqlite's full
table-recreate dance for `messages` (precedent at the 2026-05-04
caps/auth migration) PLUS a recreate of `read_cursors` to refresh
its `last_read_message_id → messages(id)` FK ref text — sqlite
>=3.25 auto-rewrites dependent FK refs during ALTER TABLE RENAME,
which would have left `read_cursors` pointing at the dropped
`messages_old`. Same disease class the 2026-05-04 precedent fixed
for `network_servers`. **Caught by the code-reviewer agent BEFORE
landing**, not by tests.

The arc is one of accumulated discipline: B1 fixed the wire-layer
silent drop (rows now persist), B6.1 fixed three implementation-
quality regressions atop that (CRIT-1 deny-list + HIGH-2 body
fallback + HIGH-6 meta atom-key flattening), and B6.11 fixed the
type-layer silent drop (`:server_event` kind for what isn't a
notice). Each step depended on the previous; none could have
shipped first.

**2. Wire-edge runtime allowlists must be exhaustiveness-tested**

B6.11 shipped the new `:server_event` kind end-to-end: server +
schema + cic dispatcher + cic type union. Vitest passed (933
tests). Then B2 INVITE-CTA integration smoke failed —
`.scrollback-invite-join` never appeared. Root cause:
`cicchetto/src/lib/wireNarrow.ts`'s `VALID_MESSAGE_KINDS` runtime
allowlist (a `Set<MessageKind>`) was missing `"server_event"`. The
narrower silently dropped every server_event row at the WS edge —
a textbook silent-drop bug in code shipped to close silent-drop
bugs. Madonna porca.

Mitigation: `wireNarrow.test.ts` gains an exhaustiveness pin —
loop over all 11 MessageKind values, assert each is accepted by
the narrower. Future enum additions that update only the
TypeScript union without the runtime allowlist will fail vitest,
not a Playwright run.

The deeper lesson: TypeScript discriminated unions are
compile-time fences. Runtime allowlists are separate moving parts.
Anywhere the codebase has a runtime `Set<EnumValue>` mirror of a
type union, an exhaustiveness test is mandatory infrastructure.

**3. Subagent-driven development on cluster work**

Mid-cluster vjt called out my drift to linear single-thread mode.
The orchestrator handoff doc pre-loaded the implementation plan so
each bucket felt small enough to do directly — but the cluster as
a whole (migration + cross-surface + cold-deploy at Z) was
high-stakes. Switching to the code-reviewer agent for the B6.11
migration design IMMEDIATELY caught the dangling-FK-ref bug above.
Memory `feedback_subagent_driven_development` codifies the rule:
Plan agent for design, Explore agent for exploration, code-reviewer
for migration + cross-surface buckets, regardless of how detailed
the orchestrator brief is.

### Per-bucket discipline (verified)

Every B6.x sub-bucket shipped with: `scripts/check.sh` exit-0
(literal gate-tail in commit body per `feedback_landed_claim_evidence`),
cic gates where touching cic, integration smoke at cic-touching
buckets, `git diff --quiet HEAD` pre-push verification per
`feedback_check_sh_working_tree_trap`. Cluster Z deploy was the
single end-of-cluster cold-deploy event per `feedback_per_bucket_deploy`.

### Trajectory

Public-open trajectory advances one notch: silent-drop class
closed end-to-end, runtime allowlist exhaustiveness pinned, web
boundary hardening (HIGH-19 body-size cap) shipped. Remaining
public-open blockers per CP31 § Trajectory: image upload
(needs HIGH-19 wired into nginx via `client_max_body_size 16m`),
voice (separate `/voice/websocket`), mobile UI polish, M3 rate
limits, W-16 signing_salt rotation, M-cic-2 production strip of
`__cic_*` debug globals.


## 2026-05-15 — CP32 visitor-parity-and-NickServ cluster CLOSED

10 commits across 9 production buckets shipped same-day on
`cluster/visitor-parity-and-nickserv`, ff-merged to main as
`f51618a..2668fba`. V8 DROPPED at brainstorm. Cluster
checkpoint at `docs/checkpoints/2026-05-15-cp32.md`.

### The subject parity invariant

Pre-cluster, every server-side feature surface that touched
"who owns this row" branched on `{:user, _}` vs `{:visitor, _}`
and refused the visitor branch (or accepted it via a parallel
short-circuit code path). V1-V9 collapse those branches: every
persistence-write codepath now builds its changeset via
`Grappa.Subject.put_subject_id/2`, every read query goes through
`Grappa.Subject.subject_where/2`, every controller picks subject
from `Subject.from_assigns/1` rather than `safe_get_user/1`. Three
subject-scoped tables (`query_windows`, `push_subscriptions`,
`user_settings`) gained the XOR FK pattern that `read_cursors` had
since CP29 — `(user_id IS NULL) <> (visitor_id IS NULL)` CHECK +
two partial UNIQUE indexes per subject branch + ON DELETE CASCADE
to both parents. Per V5's cascade test, deleting a visitor wipes
all four owned tables (plus `messages` from the CP29 cluster) in
one Reaper sweep — the database does the work.

The invariant is now: "every server-side feature surface that
branched on subject kind to refuse the visitor branch now accepts
both and dispatches through `Grappa.Subject.t()`." Any per-subject
behaviour difference that REMAINS post-cluster must be explicitly
justified — today the only one is V7's TTL semantics (anon vs
identified expiry).

### Two-tier identity model

| Subject                          | Auth proof                                              | Data lifetime |
|----------------------------------|---------------------------------------------------------|---------------|
| Anonymous visitor                | none (visitor row + bearer)                              | 48h sliding TTL — Reaper sweep + FK CASCADE wipes everything |
| NickServ-identified visitor      | NickServ password verified vs upstream `+r` MODE        | **infinite** — `expires_at = NULL` |
| Registered user (admin/operator) | local Argon2 password (`users.password_hash`)           | infinite (operator-only path via `mix grappa.create_user`) |

V7 codifies the lifetime model. Anon visitors get `expires_at = now
+ 48h` on every touch; identified visitors get `expires_at = NULL`
written at the `commit_password/2` transition (called from
`Session.Server.apply_effects([{:visitor_r_observed, password} | _], _)`
when upstream signals the `+r` mode). Subsequent `Visitors.touch/1`
calls become no-ops for identified visitors (no reason to bump a
NULL timestamp). The Reaper's sweep query carries
`WHERE expires_at < now() AND expires_at IS NOT NULL` so identified
visitors are skipped automatically.

V7's `Visitors.Login.login/2` extension supports the returning-from-
new-device path: visitor submits nick + NickServ password, server
matches against `password_encrypted`, REUSES the existing visitor
row (no new id), binds a fresh accounts_session to it. Mismatch
returns `:invalid_credentials` (uniform with the user wrong-password
shape, no enumeration).

### V8 dropped — NickServ identification IS the permanent identity

The pre-cluster spec carried a V8 "promote visitor → registered
user with reparenting transaction" bucket. The 2026-05-15 spec
refinement dropped it: NickServ identification with infinite TTL
already provides everything a "registered user" tier would. The
visitor row stays a `visitor_id` row forever; capability-equality
with `users` is established by the V1 XOR FK migrations. No
double-password UX problem, zero data-migration code, zero
double-account-state classes. The "registered user" tier exists
ORTHOGONALLY as the admin/operator account path (the bouncer admin,
future read-only dashboard accounts) — not a visitor's promotion
target.

The bucket numbering keeps V8 reserved for the optional future
"admin can create non-IRC user accounts" enhancement; today this is
already the `mix grappa.create_user` path, so nothing new to ship.

### V9 NICK rename safety analysis

Pre-V9 the visitor branch at `nick_controller.ex:61` returned
`403 forbidden`. V9 lifts the gate. Two lines of defense protect
the `(nick, network_slug)` UNIQUE on `visitors`:

1. Pre-check `Visitors.nick_in_use?(visitor_id, target_nick,
   network_slug)` BEFORE the upstream NICK frame — catches >99% of
   collision races at the controller boundary, returns 409
   `nick_in_use`.
2. UNIQUE constraint at the EventRouter persist site — second line
   of defense via `Visitors.update_nick/2`'s
   `unique_constraint(:nick, :network_slug)`. Logged + dropped on
   collision per the no-silent-drops cluster's discipline.

User subjects don't carry the persister callback — their nick lives
in `Networks.Credential` (operator-driven, not session-driven).
Visitor subjects route through an injected `visitor_nick_persister`
function-ref (mirror of `visitor_committer` for `+r` MODE) — the
same opaque indirection pattern that dodges the
`Visitors → Session` boundary cycle.

vjt vetoed the orchestrator's complex sync-wait + 422-on-433-numeric
+ `pending_nick_rename` correlation field design. User path is
fire-and-forget 202 today; visitor=user per the parity invariant;
432/433 silently leaves DB unchanged via natural EventRouter shape
(no echo → no effect → no DB write); cic already listens to
`own_nick_changed` (CP-15). The pre-existing UX hole around silent
432/433 is orthogonal to V9 and stays open.

### HOT-vs-COLD preflight gap surfaced

V9's deploy hit a real `scripts/deploy.sh` gap.
`Session.Server`'s `@type t :: %{...}` got a new
`visitor_nick_persister` field — per
`feedback_deploy_sh_preflight_field_addition_gap` the AST oracle
SHOULD have caught it. But the deploy operator did `git merge --
ff-only` BEFORE invoking `scripts/deploy.sh`. The deploy's
`git pull --ff-only` returned "Already up to date", `HEAD@{1}` and
`HEAD` were the same commit, the preflight diff was empty, the AST
oracle saw nothing, classification was falsely HOT.

`Phoenix.CodeReloader` accepted the reload (BEAM survived) but
`_build/prod` got corrupted; a subsequent `--force-cold` rebuild
failed `compile_env validation`. Recovery:
`rm -rf _build/prod && scripts/deploy.sh --force-cold`. Captured
in `feedback_deploy_preflight_empty_diff_after_merge` —
`scripts/deploy.sh`'s preflight diff base is broken when the
operator pre-merges locally. The CLAUDE.md "merge → deploy"
canonical workflow IS the broken case. Until the script learns to
diff against `origin/main@{1}..origin/main` (the actual pre-pull
remote state) or persists a last-deployed-SHA marker, the operator
must manually inspect `lib/grappa/hot_reload/long_lived_modules.ex`
+ migrations + `mix.lock` post-local-merge and pass `--force-cold`
defensively.


## 2026-05-15 — I cluster (image upload) CLOSED

4 commits across 4 buckets shipped same-day on `cluster/images`,
ff-merged to main. Cluster checkpoint at
`docs/checkpoints/2026-05-15-cp33.md`.

### Bucket summary

- **I-CSP** (`764486b`) — `infra/snippets/security-headers.conf`
  CSP `connect-src` allowlist for `https://litterbox.catbox.moe`.
  COLD-deployed because nginx config doesn't reload on the hot
  path (per `feedback_hot_deploy_preflight` + the deploy.sh
  nginx-class preflight gate added in CP31).
- **I-1** (`8112f4f`) — pluggable `ImageHost` interface
  (`cicchetto/src/lib/image-upload.ts`, 211 LOC) + litterbox
  first impl. The interface shape (`upload(blob, opts) →
  {url, expires_at}`) is designed against three hosters'
  documented APIs: litterbox (TTL), 0x0.st (form-multipart),
  catbox-permanent (auth header) — vjt's "we DONT KNOW if we
  stay on litterbox thus BUILD INTERFACE" directive.
- **I-2** (`8f1a76b`) — ComposeBox surface (`📸` button +
  drag-drop on the textarea + clipboard paste + mobile camera
  via `<input type=file capture=environment>` at ≤768px) +
  `PrivacyModal` (per-host localStorage ack, gated on first
  upload) + `imageUploadOrchestrator.ts` (240 LOC, async state
  machine + auto-send on resolve). 28 + 22 + 7 + 17 vitest
  units; 2 Playwright e2e via `scripts/integration.sh
  --grep i2-`.
- **I-3** (this commit) — docs sweep: README "Image upload"
  subsection, this entry, project-story episode, CLAUDE.md
  "IRC stays text only" rule (A10) under Engineering Standards
  → Code-shape rules.

### Key decisions

- **Direct-to-litterbox (no grappa proxying).** The browser POSTs
  the blob directly to `litterbox.catbox.moe`; the server never
  sees the bytes. Saves bandwidth + sidesteps any "image upload
  storage layer" obligation. CSP `connect-src` is the only server
  surface that participates.
- **📸-prefix wire shape.** PRIVMSG body is literally
  `📸 https://litter.catbox.moe/abc.png`. No IRC tags, no
  `client-only` namespace, no client-side detection magic. Any
  IRCv3 listener client (Goguma, Quassel, mIRC) sees a normal
  text PRIVMSG with a URL — no special handling required, no
  silent-drop class on the listener side. vjt: "plain irc message
  with just a photocamera emoji 📸 and the fucking link. that's
  it."
- **Pluggable `ImageHost` interface.** `cicchetto/src/lib/
  image-upload.ts` exports `interface ImageHost` with
  `upload(blob, opts)` + `name` + `default_ttl_seconds`. The
  litterbox impl is the first concrete; the interface shape was
  validated against imgur / 0x0.st / catbox-permanent docs
  before locking. Per-host configuration carries the host's
  human-readable name through to the `PrivacyModal` copy.
- **Per-host localStorage namespacing.** Privacy ack key is
  `image-upload-ack:<host-name>`. TTL preferences (litterbox-
  specific 1h/12h/24h/72h knob) keyed identically. Adding a new
  host doesn't migrate existing acks; visitor sees the modal once
  per host as expected.
- **CSP `connect-src` only, NOT `img-src`.** Cic doesn't render
  the image inline — the URL becomes a clickable link via the
  existing `linkify` path. `connect-src` covers the upload XHR;
  `img-src` is irrelevant because no `<img>` tag renders the
  uploaded URL.
- **Four trigger surfaces.** 📸 compose button (desktop + mobile),
  mobile camera capture (`<input type=file accept=image/*
  capture=environment>` shown ≤768px next to the 📸 button),
  drag-drop onto the compose textarea, clipboard paste. All four
  funnel through the same `imageUploadOrchestrator` —
  one orchestrator, one privacy modal, one auto-send.
- **Auto-send on resolve.** When the upload succeeds, the
  orchestrator constructs the `📸 <url>` body and calls
  `compose.send` directly — the operator's draft text in the
  textarea is preserved (it would be unrelated to the image
  anyway). vjt: "fire-and-forget, the photo IS the message."

### Lessons from the buckets

**1. CSP empirical pin: response host ≠ request host (I-CSP)**

The litterbox upload endpoint is `https://litterbox.catbox.moe/
resources/internals/api.php`. The successful response carries
the URL on `https://litter.catbox.moe/<random>.png` — note the
DROPPED `box`. Both hosts must be in `connect-src` (the request
to `litterbox.catbox.moe`, the redirect/response read from
`litter.catbox.moe`). Captured empirically via curl during
I-CSP verification — the docs don't mention the host split.

**2. e2e selector strict-mode violation (I-2)**

`page.getByRole("dialog")` matched both the new `PrivacyModal`
AND the existing `SettingsDrawer` (which also carries
`role=dialog`). Playwright's strict mode rejected the ambiguous
locator. Fix: `page.getByRole("dialog", { name: /privacy/i })`
disambiguates by accessible name. Lesson for future cic dialogs:
always include an `aria-label` or visible `<h2>` so e2e selectors
have a name to match against.

**3. Pre-session uncommitted state can block the deploy chain**

A pre-cluster `cicchetto-build` oneshot had wiped
`runtime/cicchetto-dist/.gitkeep` while repopulating the dir with
bundle artifacts. The deletion sat as an unstaged `D` for an
unknown number of sessions until I-CSP's deploy chain hit `git
pull --rebase` and refused to proceed. Recovery: restore from
HEAD. Mitigation TBD — either `cicchetto-build` should preserve
`.gitkeep`, or the dir should be `.gitignored` entirely with the
`.gitkeep` removed from tracking. Captured but not actioned this
cluster.

### Trajectory

Public-open trajectory advances one notch: image upload was the
last shipped UX gap from the CP31 § Trajectory list. Remaining
public-open blockers per CP31 + CP32: voice (separate
`/voice/websocket`), mobile UI polish, M3 rate limits, W-16
signing_salt rotation, M-cic-2 production strip of `__cic_*`
debug globals, P-2 TLS verify-CA, cards UX renegotiation
(low-priority).


---

## 2026-05-16 — T cluster (task harness) CLOSED

Three-cluster arc:
T (task harness) → M (admin console) → U (cap honesty). T-cluster
closed first.

### Why

Captured live during the 2026-05-16 stale-visitor incident: vjt
couldn't connect because every cap slot on azzurra was held by
debug visitors that nobody had a clean way to delete. Adjacent
findings: `scripts/mix.sh` hardcoded `MIX_ENV=dev` (prod-DB tasks
unreachable without a manual env-var dance); no way to attach to
the LIVE BEAM (`bin/start.sh` lacked sname + cookie so `iex --remsh`
was unavailable); `scripts/db.sh` against prod was readonly, forcing
operators to bypass the helper to delete rows; mix-task
discoverability was poor (9 `grappa.*` tasks scattered with no
top-level help). Cluster goal: "should be fucking simple to run an
admin task" (vjt).

### What shipped

| Bucket | Commit | Notes |
|--------|--------|-------|
| T-1 | `ab59d3e` | `bin/grappa` host-side dispatcher + MIX_ENV refactor + bats suite |
| T-2 | `3fcb269` + `82096a1` | Erlang dist on the live BEAM + `remote-shell --batch -e <expr>` via `--rpc-eval` |
| T-3 precursor | `72b91c9` | `AdmissionStateHelpers.reset_session_supervisor/0` (raises on leak) — closed B5 ETS-leak review action |
| T-3 | `427c22d` | `Grappa.Operator` + 5 live-state verbs (delete-visitor, reap-visitors, list-*) via `--rpc-eval` |
| T-4 | (this commit) | Docs sweep + `Credentials.count_by_state/0` + Bootstrap honest log |

### Decisions

| ID | Decision | Why |
|----|----------|-----|
| T-A1 | `bin/grappa` is host-side, not container-side | Operator already has the repo; no chicken-and-egg "how do I get into the container to run bin/grappa" problem |
| T-A2 | Hybrid: boot-time verbs → mix tasks; live-state verbs → `--rpc-eval` against the live BEAM | Live-state mutations need to terminate Session.Server synchronously to free the registry cap slot; a fresh BEAM (mix-task path) can't see the live tree |
| T-A3 | Keep `scripts/mix.sh` name; drop the `MIX_ENV=dev` hardcode; auto-detect from container env with `--env=` override | vjt 2026-05-16: "mix rename makes sense if mix is used only in dev. if we can use mix in prod as well no" |
| T-A4 | `kebab-case` on CLI, `snake_case` for underlying mix tasks; per-verb help via heredoc | Unix convention + Elixir convention; mapping table inside `bin/grappa` |
| T-A5 | Bats for `bin/grappa` dispatch + ExUnit for underlying helpers | Bats stubs `docker compose` via PATH override so tests don't need a live container |
| T-A6 | Bootstrap honest log → `Credentials.count_by_state/0` new helper | Pre-T-4 "no credentials bound" lied when N creds existed but all were `:parked` — masked the real "user disconnected" state |
| T-A7 | DESCOPED (phantom bug) | Brainstorm claim "Login doesn't set expires_at, prod has NULL rows" was false: `Visitors.find_or_provision_anon/3` already sets `expires_at = now + 48h`; schema validates "must be in future"; prod DB has 0 NULL rows (verified via `scripts/db.sh`). V7 migration made the column nullable specifically for IDENTIFIED visitors. Per CLAUDE.md "Challenge the spec" |

### Reviewer-caught bugs (T-3 pre-commit)

1. **`Credentials.list_credentials_for_all_users/0` silent-filter**:
   filters `connection_state == :connected`. `bin/grappa
   list-credentials` claimed "every bound credential" but parked +
   failed rows were invisible — exactly the rows an operator
   triaging a stuck network needs. Fix: new
   `Credentials.list_all_credentials/0` drops the filter. Verified
   live post-deploy: vjt's `grappa@azzurra` cred shows
   `state=parked reason=user-disconnect`.

2. **Registry match spec too loose**: pattern `{{:"$1", :"$2",
   :"$3"}, ...}` matched any 3-tuple key — runtime-crashes if a
   future non-session registration ever appears. Fix: pin `:session`
   literal in the head (mirror of
   `auth_controller.ex:236`'s `stop_all_user_sessions` pattern).

3. **`delete_visitor!` success line lied on concurrent-reaper race**:
   when `Visitors.delete/1` returned `{:error, :not_found}` (Reaper
   raced), the code printed "deleted visitor X" claiming a delete
   the sibling did. Fix: distinct "already deleted (concurrent
   reaper or operator)" line.

### Lessons captured

- **Phantom-bug descope discipline**: when a spec claims a bug
  exists, verify against current code AND current DB state before
  building the fix. T-A7's "backfill helper for NULL expires_at"
  would have touched ZERO rows; the brainstorm inherited a stale
  observation. Lesson now codified in CLAUDE.md "Directions over
  code" + "Challenge the spec" rules (already there; T-3 was the
  validation that they fire correctly).
- **NetworkCircuit ETS leak closed** (B5 codebase-review action):
  per-test-file `clear_registry_for/1` helpers silently exhausted
  their 500ms budget under CI load, leaving zombie Session.Servers
  registered against `network_id`s that sqlite recycled into the
  next test's fresh row. Fix:
  `AdmissionStateHelpers.reset_session_supervisor/0` terminates
  every SessionSupervisor child + raises on Registry-converge
  timeout. Loud > silent.
- **Log honesty as a code-shape rule**: T-A6 added a new CLAUDE.md
  rule under "Code-shape rules" — fast paths state what they
  observed, not what they did. The pre-T-4 Bootstrap line is the
  archetypal anti-pattern; codifying so future skip-and-log
  shortcuts have a doc to violate.


---

## 2026-05-16 — M-5 admin networks + reaper + circuit (M cluster bucket)

- `GET /admin/networks` ships combined DB-row + live circuit ETS
  projection at one endpoint per MD2. Composition happens at the
  GrappaWeb boundary (the only place that deps both Networks +
  Admission) — `Networks → Admission` would form a cycle with the
  existing `Admission → Networks` edge.
- `NetworkCircuit.reset/1` added (additive, single cast). Distinct
  from `record_success/1`: the operator verb emits
  `[:grappa, :admission, :circuit, :close]` reason `:operator_reset`
  UNCONDITIONALLY — even when prior state was no-row or sub-threshold
  `:closed`. Operator intent is "I asked, you did it"; the audit
  signal fires on every invocation. `record_success/1` keeps its
  open→closed-only filter so PromEx transition metrics aren't skewed
  by sub-threshold clears. Telemetry reason atom set widened
  `[:success, :cooldown_expired] → +:operator_reset` in
  `Admission.Telemetry.circuit_close/2`'s @spec + guard.
- `Operator.reap_visitors/0` + `Operator.reset_circuit/1` typed
  siblings (no IO) added so HTTP controllers render counts/state into
  JSON. `reap_visitors!/0` keeps stdout for `bin/grappa`; one feature,
  one code path, every door.
- PATCH whitelist for caps: `max_concurrent_sessions`, `max_per_client`
  only; extra body keys → 400 `bad_request`. `nil` clears the cap.

---

## 2026-05-16 — M-6 admin users + credentials (M cluster bucket)

- Two more operator-facing endpoints land:
  `GET/PATCH /admin/users` (toggle `is_admin`) and
  `GET/PATCH /admin/credentials` (operator-editable fields
  EXCLUDING password rotation). The combined-shape pattern from MD2
  continues: DB intent + live BEAM state in one payload —
  `live_session_count` per user (count across networks),
  `live_state` per credential (single SessionEntry per binding).
- Wire-shape allowlist defense is CRITICAL for credentials:
  `Credential.password_encrypted` carries the Cloak-DECRYPTED
  plaintext IRC password after `Repo` load (the field name
  describes on-disk shape, not in-memory shape). The new
  `Networks.Credentials.AdminWire` projects per-key with
  `:password`/`:password_encrypted` deliberately omitted; the
  controller test asserts the response body never contains either
  key (defense-in-depth alongside the pure unit test).
- Boundary discipline kept the controller-side composition pattern
  from M-5: Accounts stays `[Repo]`-only deps; Networks gains a
  typespec-only `LiveIntrospection` dep for the AdminWire
  `SessionEntry` alias; `GrappaWeb → Repo` stays FORBIDDEN — the
  `:network` preload moved INSIDE `Credentials.update_credential/3`
  on success, so the controller can render the post-PATCH wire
  shape without an illegal Repo dep.
- `Operator` was NOT extended for M-6. Pure DB writes have no live
  BEAM side effect to coordinate; controllers call contexts
  directly. `Operator` stays reserved for `delete_visitor`,
  `reset_circuit`, `reap_visitors` — verbs that mutate live state.
- Whitelist enforcement remained loud (400 on extra body key, not
  silent ignore) at both PATCH endpoints, mirroring M-5's
  `NetworksController.caps_attrs/1` precedent. Adding `password`
  to a user PATCH body OR `password_encrypted` to a credential
  PATCH body collapses to 400 BEFORE the controller touches the
  context — defense-in-depth against future spec drift.
- Auth-method change without fresh password surfaces as 422 via the
  existing `Credential.changeset/2` rule. The controller doesn't
  add a custom guard; operators wanting the SASL swap with password
  rotation go through `bin/grappa update-network-credential` which
  bypasses the HTTP whitelist for password handling.

---

## 2026-05-16 — M-7 cic admin drawer entry + admin pane skeleton

- First cic-side bucket of the M cluster. Server-side `/me` has
  emitted `is_admin: boolean` for every user-shape envelope since
  M-1; M-7 widens cic's `MeResponse` type to REQUIRE the field
  (not optional) so the codebase enforces the contract uniformly.
  Per `feedback_no_silent_drops_closed` discipline: a typed boolean
  is the only acceptable shape; a missing/undefined arm would be a
  silent gate failure at runtime.
- Drawer entry placement: inside `SettingsDrawer.tsx` above the
  existing logout button, gated by a single `isAdmin()` predicate
  (`me.kind === "user" && me.is_admin === true`). The same
  predicate gates the `<AdminPane>` mount in `Shell.tsx` and feeds
  the demote-auto-close `createEffect`. Single shape, two call
  sites — easy to grep, no parallel state machine.
- Admin pane mount mechanism: a `createSignal<boolean>(false)` on
  Shell (`adminOpen`) replaces the channel-fallback branch with
  `<AdminPane>` when true. Symmetric with the existing
  `sidebarOpen` / `membersOpen` / `settingsOpen` signals — no
  hash-routing, no `useLocation()` fanout, no parallel mount
  surface. Both desktop AND mobile Shell branches mount the same
  AdminPane shape.
- Demote-mid-session: `createEffect` reads `isAdmin()` reactively
  and calls `setAdminOpen(false)` the instant the user resource
  resolves to a non-admin state. Correctness depends on
  `lib/networks.ts`'s `createResource` accessor keeping the prior
  value during refetches (so a mid-fetch `user()` returning
  `undefined` doesn't transiently close the pane mid-interaction).
  Comment at Shell.tsx flags the invariant for future refactors.
- Three-class parity matrix per
  `feedback_e2e_user_class_parity_matrix`: admin-gated EXEMPT.
  The Playwright spec covers admin + non-admin user classes; the
  visitor class is covered by the vitest at SettingsDrawer.test
  (visitor subject in localStorage → entry hidden). Visitor mint
  via the captcha gate inside the e2e harness is out of scope for
  M-7 (the cost would be a separate captcha-disabled mint helper;
  per CLAUDE.md "Don't overengineer" the vitest pin is sufficient
  alongside the production e2e for the two seeded classes).
- M-7 ships NO actual admin tabs — strictly the outer pane +
  "tabs land in M-8/M-9/M-10/M-11" placeholder copy. M-8 (Visitors
  view), M-9 (Sessions view), M-10 (Networks + Credentials view),
  M-11 (Events topic) own their own tab markup; pre-emptive tab
  scaffolding would commit M-7 to a tab-bar shape before knowing
  which axis serves the operator best.
- Test-fixture sweep: extending `MeResponse.is_admin` to required
  forced every `vi.mocked(api.me).mockResolvedValue({ kind: "user",
  ... })` site to add `is_admin: false`. 15+ fixture sites swept
  uniformly via perl + biome `check:fix`. Per CLAUDE.md "Total
  consistency or nothing" — the required-not-optional choice is
  load-bearing, otherwise half the tests would assume admin-gated
  branches don't exist and the other half would explicitly opt
  out, creating two patterns.
- E2e seeder: second user `admin-vjt` (no network bind — the
  admin gate is orthogonal to IRC presence) created via the
  existing `mix grappa.create_user` task + inline `mix run -e
  'Grappa.Accounts.update_admin_flags(user, %{is_admin: true})'`
  for the admin flag flip. No `--admin` flag added to the mix task
  — M-7 is cic-only; server-side mix-task surface change waits for
  a bucket that touches Operator + bin/grappa.
- Deploy class: cic bundle deploy via `scripts/deploy-cic.sh` (NOT
  `scripts/deploy.sh`). Per `feedback_hot_reload_bypasses_cic_bundle`:
  the cic bundle is a separate artifact; the BundleRefreshBanner
  auto-prompts connected clients on hash mismatch so vjt sees the
  refresh CTA on the prod tab the moment the new bundle lands.
- Known gap for M-11: the demote-auto-close effect is unit-tested
  only via the steady-state branches (non-admin sees no pane,
  admin opens via drawer, close button returns). The mid-session
  is_admin flip from true → false is not exercised in vitest
  because the test mock's `user()` is a plain accessor, not a
  Solid resource — the createEffect won't re-fire without
  signal-driven reactivity. Real demote behavior lands in the
  Playwright surface when M-11 wires up the `grappa:admin:events`
  topic and the admin operator can demote themselves end-to-end.

---

## 2026-05-16 — M-8 cic admin pane: Visitors tab + delete action

- Second cic-side bucket of the M cluster. M-8 fills the M-7
  AdminPane skeleton with the FIRST admin tab (Visitors list +
  per-row inline-confirm DELETE). No new server endpoints —
  M-3 + M-4 already provide GET + DELETE `/admin/visitors`.
- **Tab nav shape**: a `<div role="tablist">` (NOT `<nav>` — biome's
  `noNoninteractiveElementToInteractiveRole` rule rejects
  `<nav role="tablist">` because `<nav>` is a landmark element,
  not a tab container; the WAI-ARIA APG canonical tablist
  container is in fact a `div`). M-8 ships ONE tab; M-9 / M-10 /
  M-11 each append their own `<button role="tab">` siblings + a
  `currentTab()` signal driving `aria-selected`. The minimal
  markup is intentional — disabled placeholder tabs are friction
  without value and lock the tab order before it's earned.
- **Inline-confirm state machine** per MD4 ("NO modals; button
  text 'Delete' → on click → 'Confirm delete?' → on second click
  → fire"): single signal `confirmingId: string | null`. Sticky
  (no timeout, no cancel button, no global click reset). Switching
  rows mid-confirm re-arms the new row. Refresh DOES reset
  `confirmingId` (MED-2 reviewer fix) to maintain the "armed row
  exists in `visitors()`" invariant that M-11's live-events
  refit will depend on.
- **Splice over refetch on successful delete**: 204 → in-memory
  `visitors().filter(x => x.id !== deletedId)`. Keeps scroll
  position + avoids the visible flash a full refetch would cause.
  Loses concurrent-admin-delete state until the operator clicks
  refresh; M-11's `grappa:admin:events` topic ships the live-
  refit. Per design Q3 the trade-off is the right shape for M-8.
- **U-0 honesty signal**: `live_state === null` (DB intent says
  active, BEAM has no pid for `{:visitor, id} × network.id`)
  renders as a visible red badge "BEAM has no pid". Per
  `feedback_no_silent_drops_closed`: the orphan condition was
  the entire motivation behind M-3/M-4 ("the unblock verb"); the
  operator MUST see the divergence at a glance. M-9 will surface
  `introspection_degraded` per-field for a richer detail view;
  M-8 keeps the per-row rendering minimal.
- **Visitor mint helper for e2e** (`cicchetto/e2e/fixtures/grappaApi.ts`
  `mintVisitor`): POSTs `/auth/login {identifier: nick}`. The
  e2e harness has `GRAPPA_CAPTCHA_PROVIDER: disabled` so no
  captcha_token is required. Identifier-shape classification at
  `auth_controller.ex login/2` routes plain nicks (no `@host`)
  through `visitor_login/4`. The new `adminDeleteVisitor` e2e
  helper provides idempotent teardown so failed-assertion paths
  don't leak visitor rows.
- **Test boundary**: 9 vitest cases (row render, U-0 badge,
  alive badge, inline-confirm 4-state machine, refresh, empty
  state, error-banner-with-retry-hint per MED-3). Playwright
  e2e: single admin case (admin-gated EXEMPT per
  `feedback_e2e_user_class_parity_matrix` — non-admin + visitor
  can't reach the AdminPane; M-7's spec already pins the
  reachability gate at the drawer entry layer).
- **CSS posture**: dropped `var(--mode-deop, #c00)` (HIGH-1
  reviewer fix) — the token wasn't defined in either theme;
  fallback always won; future grep for the token returned zero.
  Inlined the hex literal until an `--error` token earns its
  keep by appearing at a second site (today's `.admin-error` +
  hardcoded `#c00`/`#c33` at three other sites — extraction
  belongs in a later sweep, not M-8).
- **Known gap for M-11**: no live updates. Refresh button is the
  only re-fetch surface. Acceptable per design Q4. M-11 wires
  `grappa:admin:events` PubSub topic for end-to-end live updates
  (concurrent admin deletes, visitor reaps, new visitor mints).

---

## 2026-05-16 — M-9a admin sessions mutation endpoints (M cluster bucket)

Two server-only endpoints land the operator-side primitives for the
admin pane's Sessions tab (M-9b will consume from cic). M-9 in the plan
called for a single bucket; per `feedback_per_bucket_deploy` we split
into M-9a (server: HOT) + M-9b (cic bundle deploy) so reviewer scope
stays sharp and deploy classes don't fight each other.

### Endpoints

- `POST /admin/sessions/:id/disconnect` — T32 park for user sessions
  (`Networks.disconnect/2` orchestration: QUIT upstream + stop pid +
  transition `connection_state` to `:parked` + broadcast). For visitor
  sessions, collapses to the same orchestration as terminate (visitors
  carry no `connection_state` to park; uniform-surface choice).
- `DELETE /admin/sessions/:id` — synchronously stops the Session.Server
  pid without touching the DB row. Distinct from
  `DELETE /admin/visitors/:id` which deletes the visitor row outright.

### `:id` URL shape

Composite string `"<subject_kind>:<subject_id>:<network_id>"` — e.g.
`"user:b8...:3"`. Cic already has all three fields from the M-4 wire
shape; constructing the URL is a simple join. Pid in URL is rejected
per the `Grappa.LiveIntrospection.AdminWire` pid_inspect contract (pid
is human-display only; cic must NEVER round-trip it). A minted opaque
id would be a parallel-state structure with lifecycle housekeeping —
exactly what CLAUDE.md "Don't duplicate state that already exists —
derive it" forbids.

Parse rules: exactly two `:` delimiters → three non-empty segments;
kind ∈ {user, visitor}; UUID via `Ecto.UUID.cast/1`; network_id is a
positive integer (no trailing chars). Any deviation → 400 bad_request
(distinct from 404 "parse OK but no matching row").

### Visitor disconnect semantics — collapses to terminate

T32 `Networks.disconnect/2` is hard-coded to user credentials
(`{:user, _}` subject, transitions `connection_state`). Visitors have
no credential row to park. Options considered:

- **A (PICKED)**: Disconnect on a visitor ≡ terminate semantics. Stop
  the pid; visitor row stays. Cic shows both buttons regardless of
  subject_kind; no subject-discriminated client-side state machine.
- **B (rejected)**: 422 `:not_supported_for_visitor`. Forces cic to
  discriminate UI by subject; violates "uniform admin surface" intent
  and grows a parallel state machine in the client.
- **C (rejected)**: New `visitor.is_alive` schema field. Out of scope;
  KISS; visitor TTL + reaper already handle lifecycle.

### Idempotency: post-condition over introspection

Both verbs return success when the post-condition is reached,
regardless of who reached it.

- `DELETE` on an already-gone pid → 204 (the post-condition "no live
  pid" is met). `Session.stop_session/2` is already idempotent.
- `POST disconnect` on a credential already `:parked` / `:failed` →
  204 (the post-condition "not connected" is met). The Operator
  boundary absorbs `:not_connected` from `Networks.disconnect/2`
  rather than letting it bubble up as a 400; the controller can stay
  uniform and admin UI doesn't have to interpret the prior state.
- `POST disconnect` on a user with NO credential row → 404. This is
  genuinely unknown — the URL referenced a key with neither a DB row
  nor a live registry entry.

The pre-existing `:not_connected` FallbackController clause (used by
`/connect` PATCH) remains untouched; M-9a just doesn't reach it.

### Self-disconnect protection — 422 at the Operator boundary

If an admin POSTs disconnect / DELETE on their own user session, the
Operator verb returns `{:error, :cannot_disconnect_self}` → 422
`{"error": "cannot_disconnect_self"}`. The cic surface can grey the
button, but server is the gate (CLAUDE.md "fix root causes, not
examples" — curl bypasses cic).

422 (unprocessable entity), not 403: the request is well-formed AND
the admin has authz; the action is semantically rejected. The
Operator verbs take an explicit `actor_user_id` parameter (no
process-dict, no Plug.Conn reach-in); `nil` disables the check —
reserved for a future `bin/grappa disconnect-session` operator
override where the rpc-eval path runs as root.

Visitor subjects bypass the self-check unconditionally — admins are
users, so a user `actor_user_id` never collides with a
`{:visitor, _}` subject's UUID in practice; the check is skipped
structurally on the pattern match.

### Logger.info instead of IO.puts

The pre-existing `Operator.delete_visitor/1` typed sibling prints
human-readable lines via `IO.puts/1` (a holdover from its bang-variant
text-formatter pattern). The HTTP visitor controller captures the
stdout via `with_io` just to silence it in tests.

M-9a's new verbs route through `Logger.info/1` with structured context
inlined into the message body (not as Logger metadata — `:subject`,
`:network_id`, `:actor_user_id` would require expanding the global
Logger metadata allowlist for context that only this verb produces;
same pattern as `Session.stop_session/2`'s budget-exhaustion line at
`session.ex:230-238`).

Stdout is the wrong door for HTTP-driven mutations — Logger.info lands
in the container stdout with timestamp + level prefix, doesn't pollute
the test path, and remains appropriate for the future `bin/grappa`
rpc-eval path. A hygiene bucket can later migrate `delete_visitor/1`'s
stdout to match — out of scope for M-9a.

### Tests

- `test/grappa/operator_test.exs` — 11 new cases across two describe
  blocks (`terminate_session/3` + `disconnect_session/3`). Covers:
  pid-stop + DB invariants (credential preserved for terminate;
  `:parked` transition for disconnect); idempotency (no pid; already
  `:parked` / `:failed`); not_found (no credential); visitor collapse
  (pid gone, row preserved); self-protection (user only; visitor
  bypass; `nil` actor disables).
- `test/grappa_web/controllers/admin/sessions_controller_test.exs` —
  14 new cases across four describe blocks (POST + DELETE auth gate +
  admin happy path + 422 self-protection + 400 malformed URL).
  `async: false`; mirrors `visitors_controller_test.exs`'s shape.

Three-class parity matrix EXEMPT (admin-gated; visitor + non-admin
collapse to 403 via the `:admin_authn` pipeline upstream — covered by
`MeControllerTest`'s 403 cases).

Gate evidence: `scripts/check.sh` exit 0; `8 doctests, 29 properties,
1985 tests, 0 failures`; bats 23/23 ok.

### Deploy class — HOT

Per CLAUDE.md `### Hot vs cold deploy` preflight: no `mix.exs` /
`mix.lock` / `application.ex` / migrations / Dockerfile / nginx
changes; no long-lived GenServer state-shape changes (`Operator` is
stateless; controllers are stateless; `Networks` + `Credentials`
context functions are stateless). Pure lib/ + test/ + docs.

`scripts/deploy.sh` auto-detects HOT.

## 2026-05-16 — M-9b cic Sessions tab + InlineConfirmButton extraction + nginx admin allowlist fix

10th bucket of the M cluster. Cic consumer of M-9a's server surface.

### What shipped

- `cicchetto/src/AdminSessionsTab.tsx` — sessions admin tab with two
  per-row actions (Disconnect / Terminate) routed through the shared
  `InlineConfirmButton`. Singleton mutex key shape
  `"<id>:disconnect" | "<id>:terminate"` keeps the operator from
  priming two destructive verbs simultaneously across the whole tab
  (per-row AND per-button mutual exclusion in one signal). `LiveBadge`
  surfaces three states: alive-with-channel-count, "alive unknown"
  (when `"alive"` is in `introspection_degraded` — the boolean value
  is unreliable so we don't trust it), "pid registered but dead".
- `cicchetto/src/InlineConfirmButton.tsx` — extracted from M-8's
  per-row Delete machine. "Dumb" component — parent owns the singleton
  signal; the child renders + dispatches `onArm` / `onConfirm` based
  on the current `armed` prop. M-8's `AdminVisitorsTab.tsx` refactored
  to consume it (CSS `delete-btn` class preserved via `extraClass`).
- `cicchetto/src/AdminPane.tsx` — `currentTab` signal + second
  `<button role="tab">` for Sessions + `<Show when>` per-panel guards.
  Visitors stays default-active.
- `cicchetto/src/lib/api.ts` — `AdminLiveState` (shared base for
  visitor + session live-state shapes; M-8's `AdminVisitorLiveState`
  collapses to an alias per "Implement once, reuse everywhere") +
  `AdminSession` + `adminSessionId/1` helper + three fetch wrappers
  (`adminListSessions`, `adminDisconnectSession`, `adminTerminateSession`).
- Tests: 13 vitest cases for AdminSessionsTab (list, alive badge,
  alive-unknown, dead badge, degraded chip, both verbs' inline-confirm
  state machines, per-row + cross-row mutex, refresh, empty, error,
  verb-prefixed 422 surface); 6 cases for InlineConfirmButton; 4
  Playwright e2e (list, mutex, disconnect-fires, terminate-fires).
  AdminPane suite extended with tab-switching cases. AdminVisitorsTab
  refactor preserves all 9 pre-existing vitest cases.

### Nginx admin allowlist — latent M-cluster bug surfaced

The nginx allowlist regex in `infra/nginx.conf` line 91 (and the
e2e mirror at `cicchetto/e2e/nginx-test.conf`) was
`^/(auth|me|networks|push|healthz)(/|$)` — `/admin/*` was NOT
permitted through nginx. M-7's admin gate spec passed because it
never fetched an admin endpoint; M-8's visitor-delete Playwright was
SKIPPED ("loud test.skip" per `feedback_visitor_mint_e2e_cold_start`)
so the nginx 404-via-`try_files` fall-through to the SPA's
`index.html` was never surfaced. M-9b's first Playwright run made it
unmissable: `/admin/sessions` returned `text/html` 200 (the SPA
shell) and cic's `JSON.parse` threw, surfacing as "failed:
fetch_failed" in the operator's banner.

Fix: explicit allowlist
`^/admin/(visitors|sessions|credentials|networks|reaper|circuit|users|me)(/|$)`
in both prod (`infra/nginx.conf`) and e2e (`cicchetto/e2e/nginx-test.conf`,
mirrored in both `:80` and `:443` server blocks). The loopback-only
verbs (`/admin/reload`, `/admin/cic-bundle-changed`) are NOT in the
regex so they stay unreachable from outside the container — the
`Plugs.LoopbackOnly` gate fires server-side, and nginx never proxies
them to begin with.

This DID break M-7 + M-8's live admin surface on prod between
2026-05-16 morning (M-7 ship) and now — but vjt's admin-surface
usage was all via direct-to-grappa curl + remote-shell smokes per
`reference_smoke_via_mint_session`, never via nginx → cic. The bug
was latent until cic actually started fetching admin endpoints.

### Deploy class — COLD (forced by nginx change)

Per CLAUDE.md `### Hot vs cold deploy` preflight: `infra/nginx.conf`
modified → COLD path forced (CLAUDE.md HIGH-29 "hot path doesn't
reload nginx; CSP allowlist drift particularly bad"). The cic-bundle
sub-deploy is folded into the cold path naturally (the
`cicchetto-build` oneshot runs as part of `--profile prod` boot).

Per `feedback_per_bucket_deploy` the original M-9b plan was
cic-bundle-only via `scripts/deploy-cic.sh`. The nginx fix changes
that to a full `scripts/deploy.sh` cold cycle. Single bucket, single
cold deploy.

### Gate evidence

cic check: `biome check src && tsc --noEmit` exit 0.
cic vitest (admin suite): 36 tests passed (4 files; AdminPane=7,
AdminSessionsTab=14, AdminVisitorsTab=9, InlineConfirmButton=6).
Elixir-side `scripts/check.sh`: `8 doctests, 29 properties, 1985
tests, 0 failures`; bats 23/23 ok.
Playwright e2e M-9b: 4/4 passed in 8.7s.

Three-class parity matrix EXEMPT (admin-gated; M-7 gate spec
covers reachability across all three classes).

## 2026-05-16 — M-10 cic Networks tab + cap editor + reaper + circuit reset (M cluster bucket)

Third admin pane tab (after Visitors + Sessions). Wires the
operator-side controls for the network-level safety knobs landed
in M-5: per-network cap editor (partial-PATCH), Reset Circuit
(clears `NetworkCircuit` ETS), Force Reap (on-demand
`Visitors.Reaper` sweep).

Commit `c86d8d8`. HOT cic-bundle deploy.

### What shipped

- `AdminNetworksTab.tsx` — per-row table view of every network with
  current cap, live session count, circuit state, and 3 action
  buttons (Edit Cap / Reset Circuit / Force Reap).
- Cap editor uses partial-PATCH body shape: only `cap` field sent,
  empty body 422s at the controller. Avoids the
  "send-the-whole-resource-or-clobber-it" trap.
- Reset Circuit + Force Reap reuse `InlineConfirmButton` from M-9b
  (the second + third callsites that validate the M-9b lift
  decision). Third use case = boundary confirmed.

### Decisions

- **MD-1 — partial PATCH over PUT-replace.** PATCH lets cap edit
  ship one field; PUT-replace would force the operator surface
  to round-trip the full network resource for every cap tweak.
  REST-pedantic, but the right ergonomics for the UI.
- **MD-2 — Reset Circuit + Force Reap are POST, not DELETE.** They
  trigger side-effects (ETS flush + reaper sweep), not resource
  deletion. DELETE on `/admin/networks/:id/circuit` reads like
  "remove the circuit object" — false analogy. POST
  `/admin/networks/:id/circuit/reset` reads correctly as a verb.
- **MD-3 — InlineConfirmButton third use case = lift to shared.**
  Pattern: button click → inline "Confirm? [Yes] [Cancel]" replaces
  the button → action fires on Yes / dismisses on Cancel. Third
  callsite without modification = stable shape. Lifted to
  `cicchetto/src/components/InlineConfirmButton.tsx` at M-9b;
  M-10 just imports.

### Deploy class — HOT cic-bundle

`scripts/deploy-cic.sh` only; no Elixir code changed. Connected
browsers see refresh banner on bundle-hash mismatch.

## 2026-05-16 — M-11 real-time admin events channel + cic Events tab (M cluster bucket)

Fourth admin pane tab. Closes the operator-visibility gap: the
prior 3 tabs (Visitors / Sessions / Networks) were poll-on-refresh;
M-11 streams admin-relevant events as they happen via a dedicated
`grappa:admin:events` Phoenix Channel topic. Last cic-side feature
bucket of the M cluster.

Commit `418cdf1`. COLD deploy (new channel routing + `AdminChannel`
wired into the socket).

### What shipped

- `Grappa.AdminEvents` singleton — ring-buffer cap=200 of admin
  events; `record/1` API used by every admin-mutating surface
  (visitor delete, session disconnect/terminate, cap edit, circuit
  reset, reaper trigger). Sweep-and-cap on every record.
- 10 typed event kinds — `{:session, :spawned | :crashed |
  :terminated}`, `{:visitor, :minted | :deleted | :reaped}`,
  `{:network, :cap_changed | :circuit_reset}`, `{:reaper, :swept}`,
  `{:credential, :state_changed}`. Each event is a typed map; cic
  wire-edge has exhaustive switch.
- `GrappaWeb.AdminChannel` joined on `grappa:admin:events` — gates
  on `socket.assigns.is_admin == true` at `join/3`; non-admin
  subjects get `{:error, :unauthorized}`. WS-boundary authz (NOT
  per-message), per OTP "crash boundary alignment" rule.
- `AdminEventsTab.tsx` — live tail of the last 200 events; auto-
  scrolls on new entries; click to inspect raw payload.

### Decisions

- **MD-4 — dedicated `grappa:admin:events` topic, NOT a fork of
  user-rooted topics.** Admin events fan out to N admins, not to
  the user whose session generated them. A separate topic avoids
  the "fan-out a kicked-from-channel event to the operator pane
  AND the channel's chat surface AND the global admin tail" mess.
  Single source of truth: `Grappa.PubSub.Topic.admin_events()`.
- **MD-5 — WS-boundary authz at `join/3`, never per-message.**
  Reviewer-caught CRIT-1 during M-11 review: pre-fix authz was
  per-`handle_in`, which would have allowed a non-admin socket to
  join the topic and only fail on the (zero) messages it could
  send. `join/3` gating is the only correct shape; the channel is
  closed before payload exchange.
- **MD-6 — ring buffer over append-only log.** 200 events is a
  diagnostic tail, not an audit trail. Persistent storage was
  evaluated and rejected: events are derived from state-changing
  endpoints, so the source-of-truth is the DB (`connection_state`,
  `is_admin`, etc.). Audit-trail concerns belong in a separate
  cluster.
- **MD-7 — `Grappa.AdminEvents` singleton (`max_cases: 1` test
  lane).** Single GenServer owns the buffer + broadcasts. Per the
  test-singleton lane convention (`config :ex_unit, max_cases: 1`
  for any singleton test class), `AdminEventsTest` ships the
  `## Test isolation` moduledoc paragraph.

### Reviewer-caught bugs (M-11 pre-commit)

- **CRIT-1** — `AdminChannel.handle_in/3` authz check (would have
  allowed non-admin sockets to subscribe). Fixed by moving the
  gate to `join/3`.
- **MED-1** — `record/1` did not bump telemetry counter on
  full-buffer drop. Diagnostic-only; fixed inline.

### Deploy class — COLD

New `Phoenix.Channel` route + socket assigns logic; cold-deploy to
re-evaluate channel routing table at boot. `scripts/deploy.sh`
preflight correctly classified.

## 2026-05-16 — M cluster CLOSED — operator-visible admin pane

Twelve buckets across ~4 days (M-1..M-12), closing the missing
half of grappa's operational story: a browser surface for
operators that pairs with the `bin/grappa` CLI verbs landed in the
T cluster. Pre-M-1, every admin operation required ssh +
remembering Elixir incantations; post-M-Z, the same operator can
flip between the 4-tab cic admin pane and the dispatcher with
zero context loss.

### Bucket summary

- **M-1** `b851b3b` — `users.is_admin` migration + helpers.
- **M-2** `48a7369` — `:admin_authn` pipeline + `GET /admin/me`.
- **M-3** `9e8a7d7` — `DELETE /admin/visitors/:id` (first mutation).
- **M-4** `3a6dcd1` — `GET /admin/visitors` + `GET /admin/sessions`
  (live introspection).
- **M-5** `617cd3b` — `GET/PATCH /admin/networks` + reaper trigger
  + circuit reset.
- **M-6** `adf8817` — `GET/PATCH /admin/users` + credentials.
- **M-7** `a77313a` — cic admin drawer entry + admin pane
  skeleton + `me.is_admin` gate.
- **M-8** `e0cc028` — Visitors tab + inline-confirm delete.
- **M-9a** `28edbd6` — admin sessions disconnect + terminate
  REST endpoints + Operator verbs.
- **M-9b** `6be0bc3` — Sessions tab + `InlineConfirmButton`
  shared + nginx admin allowlist fix.
- **M-10** `c86d8d8` — Networks tab + cap editor + reaper +
  circuit reset.
- **M-11** `418cdf1` — real-time `grappa:admin:events` channel +
  Events tab.
- **M-12** (this commit) — docs sweep (README + DESIGN_NOTES +
  project-story + 2 CLAUDE.md rules).

### Key architectural calls (collected)

- **User-rooted topics + dedicated admin topic.** Per-user state
  flows on `grappa:user:{name}` and descendants; admin fan-out is a
  sibling top-level topic `grappa:admin:events`. Single source of
  truth `Grappa.PubSub.Topic`. M-11's MD-4.
- **WS-boundary authz, never per-message.** AdminChannel gates on
  `socket.assigns.is_admin` at `join/3`. The closed channel never
  sees a payload it could mis-authorize. Reviewer-caught CRIT-1
  at M-11 review; the principle propagates back to T cluster's
  `bin/grappa` verb shape too (operator verbs assume the dist
  cookie is the gate).
- **`Grappa.AdminEvents` ring buffer cap=200.** Diagnostic tail,
  not audit trail. Sweep-and-cap on every record. Persistent
  audit log was considered + rejected (state-changing endpoints
  already source-of-truth their effects in the DB).
- **`InlineConfirmButton` lifted at the second use case.** M-9b
  delete-session + M-10 reset-circuit + force-reap. Three call
  sites confirmed the boundary; lifted to shared widget at M-9b.
  Pattern: button → inline "Confirm? [Yes] [Cancel]" replacement
  → fire on Yes. Reuses the verbs (confirmation flow), not the
  nouns (the underlying action). Per CLAUDE.md design discipline.
- **Composite-id URL shape for `/admin/sessions/:id`.**
  `:id = "kind:uuid:network_slug"` (subject kind + uuid +
  network), not a synthetic PK. Sessions are
  per-`(subject, network)`; no natural single PK exists. A
  composite id in the URL avoids spinning up a parallel routing
  table mirror in the DB.
- **Two-tier identity flows through admin endpoints uniformly.**
  Both user-sessions and visitor-sessions are observable +
  mutable from `/admin/sessions/*`; the controller branches on
  `kind` and visitor-disconnect collapses to terminate (visitors
  have no parked state).
- **DB state + live state are separate sources of truth.**
  `AdminSessionsTab` surfaces BOTH `connection_state` (DB) and
  `live_pid` (registry lookup) per row. Now a CLAUDE.md rule
  under "Code-shape rules" (the U-0 honesty signal); see M-12.
- **`/admin/<resource>` requires nginx allowlist.** Base REST
  regex excludes `/admin/*` (loopback gate). New admin resource
  paths must be added to BOTH `infra/nginx.conf` and
  `cicchetto/e2e/nginx-test.conf`, both `:80` and `:443` server
  blocks. Now a CLAUDE.md rule under "Phoenix / Ecto patterns";
  see M-12. Origin: latent M-cluster bug surfaced at M-9b.

### Lessons captured

- **Per-bucket reviewer loops are not optional for cross-surface
  clusters.** Plan agent → code-search → code-review:loop caught
  CRIT-1 (M-11 WS authz) + MED-class drift inside InlineConfirm
  + M-9b nginx-allowlist gap. Skipping any of these for a
  bucket would have shipped a bypass-class vuln.
- **Pre-existing CI red since M-9a is its own followup, not a
  regression.** `m10-cap-editor` Playwright spec "Cannot type
  text into input\[type=number\]" + 30s timeout cascade is
  tracked separately; M cluster did not unblock CI for it
  because the failure pattern pre-dates M-9a and would have
  blocked legitimate M-9b/M-10/M-11 ship.
- **`bin/grappa create-user` does not yet take `--admin`.** Plan
  text mentioned the flag aspirationally; M-12 verified it
  doesn't exist and documented the two-step (`create-user` then
  remote-shell `update_user/2`). A future bucket can add the
  flag once the next admin onboarding warrants it.

### Trajectory

M cluster CLOSED leaves U cluster as the only remaining T+M+U arc
bucket. Post-U: full codebase review (parallel-review cycle per
`docs/reviewing.md`) + iOS UI polish cluster (4 buckets per
`project_ios_ui_polish_cluster_planned` memory).

## 2026-05-17 — U cluster (cap honesty) summary

Seven buckets (U-0..U-6) plus one in-cluster retro fix
(`7bb3caa`), eight production commits total, over ~2 days,
closing the last of the T+M+U arc: an operator who clicks
"connect" on a cap-saturated network now gets an honest 503 +
typed cic banner instead of a silent 200-OK with the row at
`:connected`, no Session.Server, and the next REST write 404-ing.

### Bucket summary

- **U-0** `f5a1d8e` — `NetworksController.spawn_session_after_connect/3`
  flipped to spawn-first / commit-second. Pre-U-0 the helper
  committed the DB transition to `:connected` BEFORE calling the
  spawn orchestrator and swallowed every spawn error while
  returning ok. Post-U-0 the controller bails on spawn failure
  and leaves the DB at the prior state; FallbackController
  surfaces the typed error.
- **U-1** `84388a7` + `313501f` (drift fix-up) — schema split.
  The single `max_concurrent_sessions` column became
  `max_concurrent_visitor_sessions` + `max_concurrent_user_sessions`,
  each NULL = unlimited. In-place RENAME + ADD + DROP/re-ADD
  to clear NOT-NULL drift from an earlier mis-applied migration.
- **U-2** `a68bc19` — subject-aware admission +
  three typed login-phase timeouts (`connect_timeout_ms` /
  `rpl_welcome_timeout_ms` / `probe_timeout_ms`) +
  five-bucket honest Bootstrap log. `Admission.check_network_total/1`
  splits visitor cap from user cap via `Grappa.Subject.t()`
  shape, so a saturated visitor pool never blocks operator
  login.
- **U-3** `c547a78` — `:client_cap_exceeded` 429 → 503 +
  `too_many_sessions` body atom; admin live_counts projection;
  cic `assertNever` exhaustiveness on the typed-error sum;
  AdminSessionsTab summary.
- **U-4** `aa82d97` — UD5.A+B+C device-identity-change
  test-debt closure. U-2 shipped the production code
  incidentally; U-4 added 7 tests + UD5.C e2e (`test.skip` per
  visitor-mint cold-start lesson). Zero deploy.
- **U-5** `010054d` — admin Networks tab per-network live cap
  counters. `:cap_counts_changed` typed event on session lifecycle
  telemetry; cic `liveCountsByNetworkId` signal; HOT deploy + cic
  bundle. 1/3 → 0/3 decrement smoked end-to-end.
- **U-6** this commit — docs sweep (README + this entry +
  project-story episode + CLAUDE.md "No silent-swallow at
  boundaries" rule per UD10).

### UD1-UD10 decisions

- **UD1** — Subject-aware admission via `Grappa.Subject.t()`. Two
  caps, two count queries (`Registry.select` filtered by subject
  shape), two error atoms.
- **UD2** — Audit ALL spawn call sites for swallowed errors:
  NetworksController (known bug, fixed in U-0); Bootstrap
  (acceptable: boot-time skip-and-log, but honest log per
  CLAUDE.md "Log honesty"); Visitors.Login (already honest);
  SpawnOrchestrator boundary verified.
- **UD3** — FallbackController maps the cap-exceeded atoms to
  **503 + `{error, retry_after?}`**, NOT 429. Resource exhaustion,
  not rate limit: 503 → "ask admin to bump cap or wait for slot";
  429 → "slow down" is the wrong operator action.
- **UD4** — Admin console cap UI: two side-by-side number inputs
  with help text + per-network live counts (`Visitors: N/cap,
  Users: M/cap`).
- **UD5** — Device disconnect/reconnect with different identity.
  UD5.A logout terminates live sessions for `(subject, client_id)`.
  UD5.B `Admission.check_client_cap/1` filters by
  `{client_id, current_subject}` so a different subject on the
  same client doesn't count against the old slot. UD5.C visitor
  `/quit` goes through the logout helper and frees the slot.
- **UD6** — Visitor `expires_at` + reaper already fixed by T-3;
  no U-cluster touch.
- **UD7** — Login probe timeout split. Pre-U-2: single 3s
  `login_probe_timeout_ms` covered TCP + TLS + NICK/USER +
  RPL_WELCOME. Bahamut's rDNS-blocking 001 emit (variable; the
  intermittent 504s tonight's session observed against
  `raccooncity.azzurra.chat` motivated UD7 in the plan)
  blew the budget. Post-U-2: three typed timeouts +
  three typed errors (`:connect_timeout` / `:welcome_timeout` /
  `:probe_timeout`), FallbackController maps each to its own
  503 + Retry-After header.
- **UD8** — Migration deploy class is **COLD** per
  `feedback_cluster_with_migration_must_cold`.
- **UD9** — Tests: 6 admission split cases + controller
  DB-unchanged-on-spawn-fail + cic banner vitest + Playwright
  fill-cap + Bootstrap honest-log + 3 timeout-phase typed-error
  cases.
- **UD10** — Codify CLAUDE.md "No silent-swallow at boundaries"
  rule. Generalized in U-6 to cover BOTH controller error-discard
  (the U-0 instance) AND wide `terminate/2` catch hiding raises
  from boundaries (the cleanup retrospective below). Lands as
  the rule body in CLAUDE.md "Engineering Standards →
  Code-shape rules".

### Swallow-bug retrospective + meta-lesson

Two swallow-bugs surfaced in the same cluster arc; both resolved
by boundary fixes, not safety-net widening.

**Bug 1 — controller error-discard (pre-U-0).** The pattern was
in `lib/grappa_web/controllers/networks_controller.ex:180-185`
(now the U-0 fix-comment): `Networks.connect/1` committed the DB
transition first, then `spawn_session_after_connect/3` discarded
the spawn orchestrator's `{:error, _}` and returned `ok`. The
operator-visible failure mode was "PATCH /connect returns 200,
row at `:connected`, no Session.Server, POST /messages 404s".
The fix is the pattern (spawn-first / commit-second + `with`
chain + FallbackController), not the specific instance.

**Bug 2 — wide `terminate/2` catch hiding raise from boundary.**
`IRC.Client.handle_call({:send, _}, _, _)` used `:ok = transport_send(...)`,
which raised `MatchError` on the closed-but-not-nil socket shape
and propagated `FunctionClauseError` from `:gen_tcp.send(nil, _)`
on the nil-socket shape. Both crashes cascaded into
`Session.Server.terminate/2`, whose narrow exit-catch list missed
the wrapped MatchError. Supervisor blocked 5s per dying child;
CI's `reset_session_supervisor/0` 15s registry-clear budget
exhausted on `BootstrapTest` + class siblings (run 25975442301).
The bug hid for **weeks** under a "shouldn't happen" exception
clause. Fix at the IRC.Client boundary: return
`{:error, :no_socket | :closed | _}` honestly; callers that don't
care (notably the best-effort QUIT in `Session.Server.terminate/2`)
`_ = `-discard the result. Commit `7bb3caa`; CI green on first
run after.

**Meta-lesson.** Both bugs were called out in code-comments as
follow-up cues long before they bit production. The U-0 comment
referenced "this is wrong but ship the bigger fix later"; the
IRC.Client `:ok =` was a load-bearing pattern-match nobody owned.
Per `project_no_silent_drops_closed`: a safety net that catches
an impossible exception silently absorbs the next class of bug.
**When a comment says "follow-up cue against X", file it as a
cluster candidate immediately** — the U cluster cleanup proved
TODO-comments are real signal, not noise.

### Deploy classes

- U-0: HOT (`Phoenix.CodeReloader` swap; sessions preserved).
- U-1: COLD (migration; deploy.sh preflight catches `priv/repo/`).
- U-2: COLD (config additions in `config/config.exs` triggered
  long-lived-module preflight).
- U-3: HOT.
- U-4: zero deploy (test-debt-only).
- U-5: HOT server + `scripts/deploy-cic.sh` for cic bundle hash.
- U-6: zero deploy (pure docs).
- U-Z: zero deploy (e2e + audit + docs only).

### U-Z cluster CLOSE — composed journey + audit

The U-Z bucket landed three things and explicitly did NOT land
five others; the "did not land" set is itself a finding.

**Shipped**:

1. `cicchetto/e2e/tests/u-z-cap-honesty-cluster-journey.spec.ts`
   — REST-only composed journey replaying the cluster narrative in
   one spec: park vjt → admin saturates user cap (=0) → user
   /connect 503 `network_busy` → assert DB row stays at `:parked`
   (U-0 spawn-first invariant via `GET /admin/networks/:slug` +
   `GET /networks/:slug`) → admin bumps cap to 1 → /connect
   succeeds 200 → admin sets visitor cap=0 / user cap=10 →
   /connect SUCCEEDS (UD1 independence). Mirrors M-Z's shape (one
   spec, one `try/finally` cap-restore via `afterEach`) and
   pairs the cluster's typed-error wire contracts with the
   spawn-first row-preservation invariant in a single
   reproducible run. Per `feedback_e2e_user_class_parity_matrix`:
   the cross-bucket compositional spec, not a re-run of per-bucket
   surfaces.
2. Audit per plan §U-Z item 7: code-grep for
   `{:error, _} -> :ok` patterns in
   `lib/grappa_web/controllers/` returned ZERO matches. The
   audit is a NON-FINDING — the swallow-class fix at U-0 +
   subsequent buckets cleaned the controller layer; no
   residual swallow surfaces remain. Per
   `feedback_mega_cluster_lessons`: empty audit IS the finding;
   document the grep explicitly so future readers don't re-run
   the same search.
3. Cluster-close docs (this entry, the project-story closing
   paragraph for S50, README "U — cap honesty" closed-clusters
   entry already in-step from U-6) + arc memory bump to
   "U cluster CLOSED 8/8".

**Documented but not driven** (per plan §U-Z items 4 + 5 + 6 + 8 +
the per-bucket coverage delegation):

- §U-Z item 3 (parallel-spawn independent caps): covered by
  U-2 arm 2 (`u-2-admission-split.spec.ts`).
- §U-Z item 4 (logout-as-visitor → login-as-user same client_id):
  covered by U-4 admission_test.exs + auth_controller_test.exs
  at unit level; the e2e arm is parked as `test.skip` in
  `u-4-device-identity-change.spec.ts` per
  `feedback_visitor_mint_e2e_cold_start` (bahamut-test
  visitor-mint 504s on cold start; same blocker as M-8).
- §U-Z item 5 (visitor /quit frees client_id slot): same
  visitor-mint blocker class as item 4; UD5.A production
  behavior is unit-tested.
- §U-Z item 6 (capacity_reject admin event lands live in
  Events tab): covered end-to-end by
  `m-z-admin-cluster-journey.spec.ts` (M cluster close already
  drives PATCH cap=0 → mint → assert `admin-event-capacity_reject`
  row visible in real time).
- §U-Z item 8 (iptables DROP → `:connect_timeout` phase smoke):
  infeasible in the e2e harness — `iptables DROP` requires
  `NET_ADMIN` capability inside the test container plus
  coordinated routing to the testnet leaf. The UD7 per-phase
  typed errors are unit-tested at
  `test/grappa/visitors/login_test.exs` (one assertion per
  phase boundary); the live observation is the
  raccooncity.azzurra.chat 504-no-longer-reproduces evidence
  from the U-2 deploy.

The "documented but not driven" set is non-empty by design:
e2e suites are not the right tool for every cluster invariant.
Where unit coverage + a sibling spec already pin the surface,
duplicating the assertion in the cluster-close spec adds noise
without adding signal — per the M cluster lesson
(`m-z-admin-cluster-journey` doesn't re-drive
`m8-admin-visitors-delete` either).

### U cluster status: **CLOSED 2026-05-17** (8/8 buckets + U-Z)

Total: 8 production commits across 7 named buckets + the U-Z
close. Two swallow-bugs surfaced and were fixed at the
boundary, not the safety net. The CLAUDE.md rule "No
silent-swallow at boundaries" codifies the pattern. The T+M+U
arc is closed.

### Trajectory

U cluster CLOSED closes the T+M+U arc. Next workstream per
`project_post_p4_1_arc`: nick-case-sensitivity bug fix (small
standalone per `project_nick_case_sensitivity_bug`) → iOS UI
polish cluster (4 buckets per
`project_ios_ui_polish_cluster_planned`) → full post-T+M+U+iOS
codebase review per `project_post_tmu_full_review_scheduled` →
bastille deploy workstream per
`project_bastille_deploy_workstream` (GitHub issue #8).

## 2026-05-17 — iOS UI polish cluster CLOSED

Four KISS buckets making cic on iPhone Safari feel like a native app.
cic-only — no server changes, no wire-protocol shapes, no
architectural touch. localStorage + CSS + Solid signals, that's it.

### Bucket summary

- **iOS-1** `7226cd9` — viewport lock. `<meta name="viewport">` gains
  `maximum-scale=1, user-scalable=no` + `html, body { overflow: hidden;
  height: 100%; overscroll-behavior: none }`. Kills pinch-zoom and
  rubber-band overscroll — both make cic feel like a website instead
  of an app. Browser-smoke screenshot evidence: no white scroll-area
  below the bottom bar on iPhone shape.
- **iOS-2** `3d59036` — safe-area insets. `padding-top:
  max(0.5rem, env(safe-area-inset-top))` on `.topic-bar`,
  `padding-bottom: env(safe-area-inset-bottom)` on `.bottom-bar`, both
  insets on `.shell-members` + `.settings-drawer`. TopicBar clears the
  Dynamic Island / notch; BottomBar clears the home-indicator. Desktop
  layout unaffected (env() resolves to 0 outside notched contexts).
- **iOS-3** `a439bb0` — bottom-bar tab close ×. Mobile BottomBar gained
  the close affordance that desktop Sidebar already had (channels +
  query windows; server tab remains non-closeable). Shared helper
  `lib/windowClose.ts` extracted so Sidebar + BottomBar call the same
  PART logic (one-feature-one-code-path). Playwright `@webkit` e2e
  proves the tap → PART → tab-gone roundtrip.
- **iOS-4** `241caa1` — font-size selector. SettingsDrawer gained a
  fieldset with 5 radios (S/M/L/XL/XXL = 12/14/16/18/20 px). Closed-set
  union type `FontSizeKey`, validated at the localStorage boundary
  (invalid stored value falls back to "M"). Boot-apply pattern mirrors
  `lib/theme.ts` — `applyFontSizeFromStorage()` runs in main.tsx BEFORE
  render so the first paint is at the right size (no FOUC). Default
  preserved (M = 14px = current behavior).

### iOS-Z — cluster CLOSE

`cicchetto/e2e/tests/ios-z-cluster-journey.spec.ts` — single `@webkit`
iPhone 15 spec replays all four buckets back-to-back so the cluster's
shipping reality is exercised in CI on every integration run, mirror
shape of `m-z-admin-cluster-journey.spec.ts`. Honest limitation noted
in the spec: Playwright webkit emulation doesn't simulate the OS-level
notch / Dynamic Island, so `env(safe-area-inset-top)` resolves to 0
there; real notch-clearance evidence is browser-smoke screenshots from
a notched iPhone shape.

### Lessons

- **Desktop browser-smoke can't validate iPhone-shape changes.** The
  iOS cluster scope existed because vjt hit the problems on his actual
  iPhone — desktop emulation in Chrome devtools renders something
  visually close enough but doesn't catch overscroll feel, notch
  clearance, or pinch-zoom mis-behavior. Playwright `@webkit` iPhone
  15 project + real iPhone smoke are the only test surfaces that
  catch this class.
- **KISS holds when scope is honestly bounded.** Four buckets, ~50
  lines each on average (the largest was iOS-3 with the shared helper
  extraction; iOS-1 was 6 lines of diff). No bucket creep, no
  surprise dependencies. The cluster plan + per-bucket reviewer-loop
  enforced the budget.
- **Closed-set type at the localStorage boundary.** iOS-4's
  `FontSizeKey` union literal + `isFontSizeKey` typeguard ensures a
  corrupted localStorage value (manual edit, schema migration miss,
  malicious extension) falls back to default instead of writing
  garbage into the CSS var. Mirror pattern from `theme.ts`.

### Next workstream

Per `project_post_tmu_full_review_scheduled`: full codebase review
(orchestrate parallel-review cycle + fix ALL CRIT/HIGH + most-
important MED) — vjt-driven start. After review: bastille deploy
issue #8 per `project_bastille_deploy_workstream`.

## 2026-05-17 — UX cluster CLOSED

Three small bugs vjt observed live on his own cic instance after the
iOS cluster shipped. Mini-cluster — KISS to the bone — no new
abstractions, one server-side context function (`Scrollback.delete_for_dm/3`),
one new lifted helper (`lib/archive.ts`), one CSS rule mirror, and a
new full-overlay modal for mobile archive.

### Bucket summary

- **UX-1** `f59264d` — archive close × + permanent scrollback delete.
  Sidebar archive `<details>` rows (channel + query both per vjt scope
  decision) gained an `InlineConfirmButton` (two-step: "×" → "really
  delete?" → DELETE). New server route `DELETE
  /networks/:network_slug/archive/:target` dispatched by sigil
  (`#name` → channel scrollback drop; `name` → DM scrollback drop).
  Broadcasts typed `:archive_changed` on the per-network user-topic
  so other connected clients re-fetch their archive. Smoking-gun e2e
  assertion: re-JOIN post-delete shows empty scrollback (rows ARE
  gone server-side, not just hidden in cic cache).
- **UX-2** `47e38e2` — BottomBar archive chip + ArchiveModal (mobile).
  Mobile users couldn't reach archive without re-joining via slash
  command. Lifted `visibleArchiveForNetwork` into `lib/archive.ts`
  (shared with Sidebar — one-feature-one-code-path). BottomBar
  renders `.bottom-bar-archive-chip` per network when archive is
  non-empty for that network; tap opens full-overlay
  `ArchiveModal` listing entries with per-row × (re-using UX-1's
  `InlineConfirmButton` + `deleteArchiveEntry`). Modal signal lives
  INSIDE `identityScopedStore` so token rotation closes any open
  modal alongside `archivedBySlug` flush (reviewer-flagged HIGH
  identity rotation leak, fixed in-amend).
- **UX-3** `a805fcb` + `ea446e4` — `.shell-empty-toolbar` Dynamic
  Island clearance. iOS-2 added `padding: max(0.5rem,
  env(safe-area-inset-top))` to `.topic-bar` but missed
  `.shell-empty-toolbar` (cold-load shell when no channel selected).
  One-line CSS mirror of `.topic-bar`'s rule. The follow-up commit
  fixed the Playwright spec: vite's CSS minifier merges rules with
  identical property values into a comma-list selector, so
  `selectorText === ".shell-empty-toolbar"` skipped past the merged
  `.topic-bar, .shell-empty-toolbar` rule in production. Switched to
  split-on-comma containment check — accepts both dev and prod
  selector shapes.

### UX-Z — cluster CLOSE

`cicchetto/e2e/tests/ux-z-cluster-journey.spec.ts` — single `@webkit`
iPhone 15 spec replays all three buckets back-to-back. Per
`feedback_e2e_user_class_parity_matrix`, the parity matrix is
asserted via a CLASSES loop (registered DRIVEN; visitor + nickserv
documented as `test.info().annotations` skips with the reason and
unit-coverage pointers). The loop structure is preserved so a future
operator unblocking `feedback_visitor_mint_e2e_cold_start` can flip
the visitor branch + add nickserv seeding without restructuring the
spec.

### Lessons

- **Operator dogfooding post-cluster catches what specs miss.** All
  three UX bugs surfaced inside vjt's first 24h actively using cic
  after the iOS cluster shipped. UX-1's "no delete affordance" is a
  feature-gap the spec didn't call out; UX-2's "archive unreachable
  on mobile" is a viewport bias that desktop-shaped specs ignored;
  UX-3's empty-toolbar inset miss is the kind of regression that an
  exhaustive grep would have caught but a CSS-rule diff didn't. Lesson:
  the post-cluster dogfooding window IS the cluster's final review
  pass; budget for a mini follow-up cluster after every UX-touching
  cluster.
- **Vite CSS minifier merges rules across selectors.** Spec assertions
  that key on `selectorText === "..."` exact equality break in
  production because vite's minifier joins rules with identical
  property values into comma-list selectors. Use split-on-comma
  containment checks instead. Live smoke against the deployed bundle
  (not just dev mode) caught this — yet another reason the per-bucket
  browser smoke at deploy time is non-negotiable.
- **Reviewer-loop catches identity-rotation leaks across signal
  scopes.** UX-2's first cut had `archiveModalNetwork` as a
  top-level signal — `identityScopedStore`-rotation would flush
  `archivedBySlug` but leave the modal open on a network the new
  identity might not have access to. Reviewer flagged HIGH; fixed
  in-amend by moving the signal INSIDE the scoped store. The
  pattern generalizes: any signal that REFERENCES identity-scoped
  data must itself live inside the scoped store.

### Next workstream

Per `project_post_tmu_full_review_scheduled`: full codebase review
(orchestrate parallel-review cycle + fix ALL CRIT/HIGH + most-
important MED) — **vjt-driven start. Do NOT auto-start review after
UX-Z without vjt confirm.** After review: bastille deploy issue #8
per `project_bastille_deploy_workstream`.

---

## 2026-05-18 — Channel names are case-folded (UX-4)

IRC channel names are case-insensitive, but the scrollback/window tables
were keying them case-sensitively, so `JOIN #Chan` vs `#chan` vs `#CHAN`
forked into separate windows. Fix: channel names are **lowercased on read
AND write** across every channel-keyed table (`messages`, `query_windows`,
`read_cursors`, `last_joined_channels`, archive, and later
`channel_directory`), with a one-time backfill migration
(`20260518120000_backfill_lowercase_channels`). They now all resolve to a
single window.

*Invariant (also in CLAUDE.md): any new channel-keyed table or query MUST
downcase the channel key, or it silently forks windows. Nicks are likewise
compared case-insensitively (`nickEquals` on the cic side).*

---

## 2026-05-18 — UX cluster reopened: keyboard saga + chrome-gesture saga + scroll-on-empty

The original three-bucket UX cluster closed 2026-05-17 cleanly. Within
twenty-four hours vjt resumed dogfooding on iPhone and hit a different
class of bugs: the iOS keyboard, the iOS Safari rubber-band /
chrome-gesture overlay, and the touch-pan event routing on empty
scrollback. The cluster reopened in the same orchestrator session and
shipped sixteen additional commits across three macro-problems and
one server-side delete-vs-list asymmetry, all on `main`. The
deliberate decision was to keep all sixteen under the `ux-3-*` commit
prefix (rather than open a fresh cluster mid-bug-hunt) — UX-4 opens
fresh once docs catch up.

### The keyboard-resilience saga (six commits, four reverts)

Bug shape: typing into the composer dismissed the iOS keyboard, OR
the viewport scrolled when keyboard opened, OR the BottomBar
disappeared, OR the topic bar disappeared. iOS Safari composes the
visual viewport differently from the layout viewport, the
`interactive-widget` viewport meta affects keyboard-show layout
shifts, and `100dvh` resolves differently depending on whether the
keyboard is open.

- **BIS** `87dbd13` KEEP — shell-level safe-area inset
- **TER** `e9d1fd3` REVERT — `100dvh` hid the top bar when keyboard opened
- **QUAT** `814bf6c` REVERT — `position: fixed` on shell broke BottomBar interaction
- **SEX** `e75714d` REVERT — `position: fixed` on body broke topic-bar
- **SEPT** `08c0def` KEEP — viewport-meta `interactive-widget=resizes-content`
- **PENT** `382aa31` KEEP — VisualViewport API drives `--viewport-height`
- **OCT** `0b12d7c` + `d7f988f` (e2e) KEEP — `window.scrollTo(0,0)` programmatic-scroll pin
- **NON** `bb939b8` KEEP — `preventDefault` on BottomBar `pointerdown`
- **DEC** `a360c57` KEEP — flat-flex BottomBar layout disentangle

The shipped stack: viewport meta `interactive-widget=resizes-content`
+ VisualViewport API → `--viewport-height` CSS var + `window.scrollTo(0,0)`
pin + BottomBar `preventDefault` on pointerdown + flat-flex BottomBar.
Each ingredient is necessary; four `position: fixed` / `100dvh`
attempts all REVERTED. The Playwright e2e at `d7f988f` locks the
stack against future regression on the OCT layer.

### The chrome-gesture rubber-band saga (UNDEC, three rounds)

Bug shape: dragging on the cic shell (anywhere, even on an empty
scrollback) showed the iOS Safari chrome bar at the top and dismissed
the keyboard. The browser thinks the user wants to scroll the
viewport, not the app. Three rounds:

- **UNDEC R1** `ee1961a` KEEP — `#root { height: 100% }` (kill real overflow on root)
- **UNDEC R2** `b597a25` KEEP — `overscroll-behavior: contain` on `.scrollback` + `.bottom-bar`
- **UNDEC R3** `ff65ad9` KEEP — `touch-action: none` on `.shell-mobile` blanket + `pan-y/pan-x` re-enable per scroll-container

`overscroll-behavior: contain` alone (R2) doesn't catch the
drag-from-non-scrolling-area case. `touch-action: none` on the
shell-blanket level + targeted `pan-y` re-enable per scroll
container (R3) is what finally rejects the gesture cleanly.

### Z-arch — archive open re-arms per-channel topic subscribe

Bug shape: opening an archive entry from sidebar or modal selected
the channel but did NOT subscribe to its Phoenix topic. Server
NOTICE 401 etc. arrivals went unreceived. Fix in `e0cdf4b` — both
`ArchiveModal` and `Sidebar` archive-row click now call
`openQueryWindowState(...)` BEFORE `setSelectedChannel(...)`.

**Lesson**: "selecting a channel" ≠ "subscribing to a channel". The
two operations are independent across the cic state. Callers that
expect live events from the new selection must do both — the
window-open IS the subscribe. Pre-existing main-flow JOIN paths do
both because the JOIN code path explicitly opens; archive-revival
was a side door that skipped half the work.

### Z3-R4 — JS-measured overflow gates scrollback touch-action

Bug shape: even with `touch-action: none` on `.shell-mobile`, dragging
on empty scrollback (no messages, or fewer messages than fit the
viewport) STILL scrolled the chrome. The R3 fix left `.scrollback` at
`pan-y` permanently, which means "this element is allowed to be
panned vertically" — and iOS interprets pan-y on a non-overflowing
element as "no scroll to do here, propagate to viewport."

Three rounds:

- **Z3** `2399272` SUPERSEDED — `touch-action: none` on empty scrollback by emptiness-test class
- **Z3-R3** `bc4088c` SUPERSEDED — `overflow-y: scroll` to force "always scrollable" semantics
- **Z3-R4** `8a49ea3` KEEP — JS DOM-measurement (`scrollHeight > clientHeight`) gates `.scrollback-overflowing` class which toggles `pan-y`

Z3 worked when scrollback was literally empty but broke when there
were 1-2 messages that didn't fill viewport. Z3-R3's `overflow-y:
scroll` made the inner element technically-always-scrollable but iOS
still treated it as non-overflow because content height ≤ container
height. Z3-R4 measures actual overflow on `messages-change ∪
window-resize ∪ visualViewport-resize` events and toggles the class
synchronously. This is the canonical fix; there is no CSS-only
`:has-overflow` pseudo-class.

### Z + Z2 — server-side delete-vs-list asymmetry + close broadcast

`db8650f` (Z) — `Scrollback.delete_for_dm/3` was using a strict
`channel = ? AND dm_with = ?` match, but `list_archive` used
`COALESCE(dm_with, channel) = ?` — so DM rows that the LIST
returned could not be DELETEd. The two functions are a read/write
pair on the same data and MUST share the predicate. Generalize:
**any read/write pair on the same column MUST share the same key
predicate.** When one side coalesces or normalizes, the other must
too.

`ca0acac` (Z2) — `ChannelsController.delete` + the equivalent
GrappaChannel `close_query_window` handler now broadcast
`archive_changed` on the per-network user-topic. Before Z2, closing
a window did NOT update the sidebar archive chip count or the
ArchiveModal contents until page reload. Reactive UI surface drift
from the source of truth = silent UX bug.

### Quart-DEC + TER-DEC + BIS-DEC — keyboard-preserve helper evolution

The "keepKeyboard" UX rule says: tapping certain buttons (scroll-to-
bottom arrow, archive-row entries, etc.) MUST NOT dismiss the iOS
keyboard. Three rounds of evolving the implementation:

- **BIS-DEC** `0c2c6de` SUPERSEDED — per-button explicit `onPointerDown` wiring on scroll-to-bottom arrow
- **TER-DEC** `8313681` KEEP — globalize via `document`-level capture listener (replaces per-button wiring)
- **Quart-DEC** `c433872` KEEP — switch `pointerdown` → `mousedown` (pointerdown blocks scroll-gesture dispatch on iOS, mousedown is focus-only)

The mousedown/pointerdown distinction is non-obvious: on iOS,
`pointerdown` is a gesture-start event that blocks scroll
propagation; `mousedown` is a synthesized focus-shift-only event
that doesn't. Using mousedown preserves the touch-scroll behavior on
the underlying scrollable area (archive modal scrollable list) while
still firing soon enough to capture focus before the keyboard
dismisses.

### Saga-wide lessons (carry forward)

- **Real-iPhone smoke is non-negotiable for iOS Safari work.**
  Playwright webkit emulation does NOT simulate the OS keyboard, the
  visual viewport, the chrome rubber-band, or the
  `touch-action`/`pan-*` interpretation. Sixteen commits worth of
  bug-hunt was all caught by vjt on his iPhone, none by webkit
  Playwright. Specs lock fixes once shipped; they cannot discover
  iOS-specific quirks.
- **CSS has no `:has-overflow` selector.** Conditional touch-action
  based on whether content overflows requires JS DOM-measurement
  toggling a class. A single CSS declaration cannot solve "reject
  pan gesture when no scroll work is available." Z3-R4 is the
  canonical pattern; reach for it any time a touch-routing decision
  depends on actual layout state.
- **Read/write pairs on shared columns MUST share the predicate.**
  `list_archive` used COALESCE, `delete_for_dm` used strict match;
  the asymmetry orphaned rows that LIST returned and DELETE could
  not touch. Generalize: when one side of a read/write pair
  coalesces, normalizes, lowercases, etc, the other side MUST do
  the same. Audit every context module pair.
- **Setting `selectedChannel` ≠ subscribing.** Two independent cic
  operations. Side-door entry points (archive revival, future
  deep-link, etc.) must explicitly call BOTH the window-open helper
  AND the channel selector. Pre-existing JOIN paths get it right
  because JOIN explicitly opens; sideways entries got it wrong
  silently. Z-arch is the lesson; future window-open code paths
  must follow.
- **`pointerdown` ≠ `mousedown` on iOS.** pointerdown is gesture-
  start (blocks scroll-gesture dispatch); mousedown is a synthesized
  focus-shift-only event. For "preserve scroll under tap" use
  mousedown; for "block all default touch behavior" use pointerdown.
- **Documented technical-debt carry: ArchiveModal silent-swallow
  catch.** `ArchiveModal.handleConfirmDelete` has a bare
  `catch {}` clause — CLAUDE.md UD10 "no silent-swallow at
  boundaries" violation, flagged during this cluster but left
  unfixed. Carried to UX-4 as discovered debt; first slot that
  touches ArchiveModal will close it.

### What this cluster taught about cluster scope

The original UX cluster shipped 2026-05-17 as three buckets, each
small and atomic. The reopened bug-hunt added sixteen more commits
in the same session. The decision to keep them all under `ux-3-*`
prefix (rather than open UX-4 mid-session) was right: it kept the
narrative coherent, reviewer cycles tight, and the deploy cadence
fast. The cost is docs-sweep load: this section is bigger than the
original UX cluster section because it covers more ground.

**Apply**: when a closed cluster reopens within hours-to-days, stay
on the original cluster prefix. Open the next cluster fresh only
once docs catch up and a new bug-class emerges. The cluster ID is
about narrative coherence, not commit count.

## 2026-05-21 — UX-6-L: foreground push → in-app beep (SW-suppress Option B)

Push notifications shipped in B2 (2026-05-14) with a focused-AND-URL-match
dedup in the service worker: when cic was foreground AND on the exact
deep-link target, the SW would suppress the OS notification and post a
`push.suppressed` message to the page. In practice cic never wired a
listener for that message — the suppression existed, but the page had
no replacement signal that a mention/DM had arrived. Operators on
iOS, accustomed to a sound cue from native chat apps, found the
foreground experience eerily silent: the badge updated but nothing
audibly confirmed it.

vjt's decision (2026-05-20 iPhone dogfood wave): broaden the SW gate
to suppress whenever **any** window is visible, regardless of URL,
and surface the foreground alert as an **in-app beep** wired off the
existing WS event stream rather than the push path.

**Why decouple beep from push:**
- The OS push path is best-effort + vendor-dependent; the WS path is
  always-live when cic is foreground. Using the WS as the alert
  trigger means the beep is independent of APNs/FCM latency,
  vendor-side dedup, or quota-bound delivery delays.
- The same `routeMessage` body that bumps the unread badge can fire
  the beep — one gate, one source. No second policy layer to drift
  from the badge gate (`feedback_silent_retry_anti_pattern` lesson:
  parallel state machines diverge).

**Surface 1 — SW broadened gate** (`lib/pushDedup.ts` +
`service-worker.ts`). New pure predicate
`shouldSuppressPush(clients): boolean` returning
`clients.some(c => c.visibilityState === 'visible')`. Extracted into
`lib/pushDedup.ts` so vitest can exercise it without instantiating
the SW global scope — same boundary precedent as `lib/pushPayload.ts`
(B2). Dropped the `push.suppressed` postMessage (dead letter, YAGNI
per CLAUDE.md "Don't design for hypothetical future requirements").
Kept `urlMatches` import because the `notificationclick`
handler's `focusOrOpen` still uses it.

**Surface 2 — WS-driven beep** (`lib/beep.ts` + wired in
`lib/subscribe.ts`). New `playBeep()` using Web Audio
`AudioContext` + `OscillatorNode` (sine 440Hz, 80ms, 0.1 gain).
Lazy-init the context, guard for SSR/older browsers, swallow
audio-context exceptions (non-fatal — the badge bump still surfaces
the event). Wired at three call sites:
- channel-mention path in `routeMessage` (after `bumpMention`),
  gated additionally on `sender !== ownNick` so own-sent self-echoes
  don't beep;
- DM-listener PRIVMSG/ACTION arm (before `routeMessage`), gated on
  `sender !== ownNick && !effectivelyFocused(slug, peer)`;
- DM-listener peer NOTICE arm (same gate; `sender !== ownNick` is
  already required by the surrounding branch).

The focus predicate `effectivelyFocused(slug, windowName)` is
extracted as a single source so the badge gate (in `routeMessage`)
and the beep dispatch (DM-listener call sites) read the same rule.
If the rule evolves (page-frozen check, last-seen-window heuristic,
etc.) it changes in one place.

**APNs/FCM quota caveat — accepted:** server still sends every push
(~50% wasted when foreground; the SW just suppresses display).
Acceptable at current scale; iOS APNs quota is generous and our
user count is low. **Follow-up if quota bites:** hybrid (server
consults WSPresence + a visibility-heartbeat fast-path skip when the
client is foreground; SW retains the defensive visibility re-check
as backstop in case server signal is stale). Not parked as a TODO —
re-evaluate when push volume justifies the engineering. This is
documented here in DESIGN_NOTES (not docs/todo.md) because it's a
deliberate design accept, not a pending task.

**e2e seam — `window.__cic_dmListenerReady` (Set\<string\>).**
Stamped in the DM-listener `onJoinOk` callback after successful
`phx.join()` ack. Added because the ux-6-l Playwright spec hit a
~20% flake where the peer's PRIVMSG arrived server-side BEFORE cic's
DM-listener subscription on the own-nick topic completed — server
broadcast landed at a topic nobody was subscribed to, silently
dropped, sidebar never auto-opened. The seam lets Playwright
`waitForFunction(...)` deterministically on the WS subscription
state. Same shape as `socket.ts:__cic_dropSocketForTests`.
Production never reads it. Aligns with
`feedback_silent_retry_anti_pattern`: surface internal state, don't
mask races with timeouts.

**Apply** (general lesson):
- Foreground alerts in PWAs should NOT ride the OS-push path. WS-
  driven beeps decouple from APNs/FCM and stay snappy regardless of
  push vendor latency.
- When a push surface drops a postMessage that has no listener,
  delete the postMessage — don't preserve "in case someone wires it
  later." Dead letters mask the design gap (the listener was never
  the plan; the WS path was).
- E2E specs against async WS subscriptions need an explicit
  readiness seam. DOM signals are unreliable proxies for "the
  socket join roundtrip completed."

## 2026-05-21 — UX-6-D CLOSED: iOS PWA keyboard saga (11 attempts, 4 research agents)

The cluster spans 11 iterations (D1-D12) over a single day and the
deepest research dive we've done. vjt's iPhone 15 PWA standalone
mode reported, after focusing the compose textarea: the topbar
scrolls out of view, the BottomBar floats away from the keyboard
top, scrollback content scrolls to a wrong position, and dragging
the scrollback to bottom locks for 1-3 seconds.

The first 8 attempts were CSS+JS band-aids that each missed because
the team kept reasoning about iOS keyboard behavior from inside the
web platform, not from the platform reality. Every fix worked in the
desktop CDP probe; none survived the iPhone.

After attempt 8 (D8), vjt said: "we are not there yet" + asked
"can we do research and rethink the entire thing?"

**Four parallel research agents** (real-world chat PWAs / WebKit
internals / interactive-widget status / Capacitor escape) returned
convergent ground truth:

1. **`visualViewport.offsetTop` is unreliable** — WebKit bug #297779,
   "appears to be a bug in a system component" per Apple engineer
   Wenson Hsieh. Gets stuck at 24px after keyboard dismiss.
2. **`installScrollPin` (window.scrollTo(0,0) on every scroll event)
   DOES cause the 1-3s scroll lock** — WebKit bug #226689 pattern:
   scrollTo during momentum re-triggers scroll, iOS quarantines
   further scroll for 1-3s as fight-detection. BUT: the pin is also
   load-bearing for clamping the visual viewport shift on focused
   input — proven by D9 (no pin → vvOT > 0 immediately) and D10's
   restoration.
3. **`interactive-widget=resizes-content` is NOT implemented in
   WebKit** — bug #259770 NEW unassigned, not on Interop 2026.
   Confirmed across iOS Safari, iOS PWA, all WebKit surfaces.
4. **`100dvh` ignores the on-screen keyboard by CSS spec.** Chrome
   violates spec for usability; iOS honors it.
5. **`focus({preventScroll: true})` has been baseline since iOS
   Safari 15.5** (mid-2022) — we'd never used it.
6. **WebKit's `_zoomToFocusRect` (the focused-input auto-scroll
   algorithm) runs at the UIKit layer BELOW the web platform** —
   the page is never asked; `focus({preventScroll: true})` doesn't
   propagate; the algorithm cannot be opted out of for tap-focus.
7. **Telegram Web K (tweb) is the ONLY production chat PWA that
   works on iOS PWA standalone**. Their pattern (in
   `src/scss/base.scss`):
   ```css
   html.is-ios { position: fixed; }
   body { height: calc(var(--vh) * 100); }
   ```
   where `--vh = visualViewport.height * 0.01` (px), updated on
   every `vv.resize` by JS. This is one ATOMIC change — neither
   piece works alone. They explicitly disabled their advanced
   tricks (`IS_STICKY_INPUT_BUGGED = false`, 100+ lines of scroll-
   sync code commented out). The rest of the chat ecosystem
   (Element, IRCCloud, WhatsApp, Slack, Signal, Threads, Discord)
   all punt to native iOS apps.
8. **The escape hatch is Capacitor** (or any native wrapper). Same
   WebKit engine, but UIKit `keyboardWillShow` notifications give
   exact pixel height + animation curve + duration; a native shell
   resizes the WKWebView frame directly. The web bug doesn't go
   away, but the native layer routes around it.

**The 11-attempt arc** (catastrophe → redemption):

- **D1** `:has(textarea:focus, input:focus) { padding-bottom: 0 }` —
  collapses safe-area inset when keyboard up, closes BottomBar gap.
  **LANDED** in D-partial. Removed in D9, restored in D11 after
  research speculation about double-counting proved wrong.
- **D2** `.scrollback { min-height: 0 }` — iOS WebKit flex-min-content
  fix. **LANDED**.
- **D3-D5** — `position: fixed` on html/body/#root variants,
  `translateY` pre-lift via cached keyboard height. All FAILED
  catastrophically. Reverted.
- **D6** — diag probe + `translateY(var(--vv-offset-top))` plan
  (cancel iOS layout shift). Held by reviewer on convergence
  question. Diag deployed; translateY held.
- **D7** — `installScrollPin` dropped on wrong hypothesis (claimed
  pin caused 1-3s lock, half-right but the pin was load-bearing
  for vvOT clamping). Reverted by D10.
- **D8** — `--vv-offset-top` CSS var + translateY cancel + preserve-
  distance-from-bottom scroll math. Catastrophic: broke layout in
  4 new ways. Reverted by D9.
- **D9** — adopted Telegram Web K pattern atomically after 4-agent
  research. `html.is-ios { position: fixed }` + body
  `calc(var(--vh)*100)` + `--vh` from vv.height. PARTIAL fix —
  test 2 (scroll lock) passed, but vvOT > 0 returned (no pin).
- **D10** — restored `installScrollPin` as smart-pin gated on
  touch-state. iOS programmatic shift (no touch) → snap; user
  drag-momentum (touch active or recently ended) → no-op.
  500ms grace shrunk to 50ms in D10b after diag proved iOS fires
  shift at +110ms post-touchend (inside the wider grace).
- **D11** — restored D1 (`:has(:focus){padding-bottom:0}`),
  added pre-emptive focusin snap + 300ms rAF burst. D1 fixed the
  BottomBar gap (test #1).
- **D11b** — `position: fixed; bottom: 0` on `.shell-mobile` to
  fix the visible topbar slide. Put shell UNDER the keyboard.
  Reverted in 5 minutes.
- **D11** per-frame rAF diag probe (focusin → 600ms 60Hz snapshot
  of vvOT/wy/dseT) **proved the visible topbar slide is iOS
  compositor animation BELOW JS visibility**: vvOT=0 + wy=0
  throughout the 250ms slide. We can't see it, we can't reach it.
  Accepted as iOS PWA limitation.
- **D12** — cleanup + Admin → Debug tab move (diag fieldset out
  of SettingsDrawer where it competed with the focus-state under
  investigation) + ux-6-d-keyboard-pattern.spec.ts e2e covering
  JS+CSS contracts + this DESIGN_NOTES entry.

**Final landed surfaces:**
- `lib/viewportHeight.ts` — `installViewportHeightTracker` writes
  both `--vh` and `--viewport-height` from `vv.height` on resize.
  `installSmartScrollPin` snaps window.scrollTo(0,0) on scroll
  events, gated on touch-state (no-snap if touch active or within
  50ms post-touchend grace).
- `lib/platform.ts` — `isIos()` UA detection + `applyIosClass()`
  applies `html.is-ios` class at boot pre-render.
- `themes/default.css` — `html.is-ios { position: fixed; inset: 0 }`
  + `html.is-ios body { height: calc(var(--vh, 1vh) * 100) }`
  PAIRED atomically. `.shell-mobile:has(textarea:focus, input:focus)
  { padding-bottom: 0 }`. `.scrollback { min-height: 0 }`.
- `ScrollbackPane.tsx` — `vv.resize` + `window.resize` →
  `scrollToActivation()` (reuses canonical UX-4-K marker-or-tail
  routine).
- `Shell.tsx` — keybinding-driven compose focus uses
  `focus({preventScroll: true})`.
- `DiagFloat.tsx` — flag-gated floating overlay via
  `localStorage.cic_diag`. Mounted via Portal to body so it
  escapes any shell transform.
- `AdminDebugTab.tsx` — Admin → Debug tab hosting the DiagFloat
  toggle + inline diag readouts. New 6th tab in AdminPane.
- `e2e/tests/ux-6-d-keyboard-pattern.spec.ts` — @webkit-iphone-15
  spec asserting the JS+CSS contracts (a-f).

**Accepted residuals:**
- The visible topbar slide during keyboard open is an iOS
  compositor animation below JS visibility. Not fixable in pure
  PWA. Escape via Capacitor (Tier B) if it ever becomes priority;
  documented research is in this entry.
- Scroll position interference between channels — deferred to
  next session (vjt 2026-05-21: "still happening but we tackle
  that in the next session").

**Apply** (general lessons that survive the cluster):

1. **When research contradicts an existing assumption, RE-READ the
   assumption.** D7's "pin causes the lock" claim was half-right but
   the wrong half got acted on. D9 dropped the pin entirely on the
   same wrong half. The whole half-right→catastrophe arc cost 4
   iterations.

2. **Telegram-style "atomic CSS pattern" means ALL pieces ship in
   the SAME commit.** D1-D8 piecemeal failed because each iteration
   broke a different ancestor in the cascade. The Telegram pattern
   only WORKS when html-position-fixed AND body-height-calc-vh AND
   --vh-write all land together. Partial adoption = catastrophe.

3. **Per-frame rAF diag panel is the right primitive when the bug
   may be an animation.** Snapshotting at 60Hz for ~600ms post-
   trigger reveals whether iOS animates gradually or jumps. Without
   this, you can't distinguish "iOS shifts the LAYOUT viewport
   visibly over 250ms" from "iOS shifts the COMPOSITOR layer
   invisibly to JS". D11's per-frame probe ended the saga — proved
   the visible motion was below JS, accepted as unfixable.

4. **DiagFloat must render OUTSIDE any focusable surface** — it
   moved out of SettingsDrawer (closed when keyboard was up) into
   AdminPane Debug tab. The diag readout must be reachable from
   a stable surface that doesn't compete with the focus-state of
   the investigation.

5. **Honor research evidence over speculation.** vjt's "let's do
   research" pivot after attempt 8 was the unlock. Four parallel
   agents returned 30+ citations with WebKit source paths, bug
   numbers, Apple engineer quotes, and Telegram source LOC. That
   evidence shaped D9-D12 and capped further iterations at four.

6. **Accept what cannot be fixed.** The visible topbar slide is
   iOS WebKit behavior we have no API for. Documenting the
   acceptance + the Capacitor escape route is more honest than
   shipping a 12th band-aid.

## 2026-05-22 — UX-6-E: narrow-mode BottomBar Server-tab dedup

vjt iPhone dogfood wave 2 noted the asymmetry: on wide screens the
network header IS the server-window entry (one clickable row per
network with emoji ⚙️ + slug + badges); on narrow the BottomBar
rendered TWO entries per network — a passive `.bottom-bar-network-chip`
text span sitting next to a standalone `.bottom-bar-tab` labelled
literally "Server". One-feature-one-code-path: narrow now mirrors
wide. The header IS the tab.

### What shipped

`.bottom-bar-network-chip` (span) + standalone `.bottom-bar-tab>Server`
(button) → single `.bottom-bar-network-header` button per network.
Same badge cells (server-window unread/event/mention), same selection
discriminator (`(slug, $server)` from `SERVER_WINDOW_NAME`), same
disconnect × affordance now mirrored as a sibling (was wide-only via
UX-4-D's `.sidebar-close` next to `.sidebar-network-header`).

`data-network-slug="<slug>"` on the header is the new stable e2e
contract — `hasText` filtering on the chip's bare text was
substring-fragile. The fixture's `sidebarWindow(slug, "Server")`
special-case routes legacy callers (ux-2 archive, ux-4-z journey,
ux-z journey) to the header without forcing a rename at every
call-site — ergonomics over purity, comment in the fixture explains.

### Selection feedback no-op-is-the-design

`.bottom-bar-tab.selected` flips `background: var(--border)` AND
`color: var(--accent)`. The header's baseline is already accent,
so only background shifts on selection. Identical shape to desktop's
`.sidebar-network-section li.selected .sidebar-window-btn` —
intentional parity. CSS comment warns "don't fix the color no-op."

### Pre-existing failures discovered during smoke

Both reproduced on `e53000c` baseline before any UX-6-E edits in 2
consecutive runs; NOT UX-6-E regressions but flagged in todo.md so
they don't keep eating reviewer attention every bucket:
- `ux-4-z-cluster-journey:141` — `members-pane` from
  `aside.shell-members.open` subtree intercepts pointer events when
  spec taps `.shell-drawer-backdrop.open`. Drawer doesn't actually
  close on backdrop tap on webkit-iphone-15.
- `ux-z-cluster-journey:86` — archive modal `#bofh` row never
  renders (`toHaveCount(1)` got 0 after 5s).

### Lessons

1. **Per-bucket discoveries belong in todo.md, not silently in
   commit messages.** Two pre-existing flakes surfaced; documenting
   them here AND in todo lets the next bucket pick them up without
   re-rediscovering. Origin: `feedback_no_silent_drops_closed`.
2. **`sidebarWindow` legacy-ergonomics shortcuts age fast.** The
   `"Server"` string-literal special-case is fine for one cluster,
   but the codebase has `SERVER_WINDOW_NAME = "$server"` as the
   single source. Migrating callers to import the constant is a
   small future-pass cleanup — flagged as L1 in reviewer notes.

## 2026-05-22 — UX-6-I: cic refresh banner single-press fix

vjt iPhone PWA dogfooding noted the cic bundle refresh banner needed
THREE button presses to actually pick up a new bundle. The CP23 S4
B5 ship of the banner solved the "operator manually DMs everyone"
problem but the click-handler itself was naively `window.location
.reload()`.

### Root cause

The SW (`cicchetto/src/service-worker.ts`) runs in `injectManifest`
mode and registers `precacheAndRoute(self.__WB_MANIFEST)` for
shell-only assets. The `NavigationRoute` it installs serves a
*precached* `index.html` for `request.mode === "navigate"` —
including the very reload triggered by clicking the refresh button.
The precached `index.html` still pointed at the OLD bundle-hash
`<script src="/assets/index-OLDHASH.js">` tag, so even though the
network had a NEW `index.html` ready, the SW intercepted the
navigate and returned the stale shell from cache.

The new SW (built by `compose run cicchetto-build`) eventually
installs + activates + claims, but only AFTER one full navigate
cycle finishes. So the empirical pattern was:
- Press 1 — OLD SW serves OLD index.html. Boot hash still matches
  what was loaded before. Banner re-renders.
- Press 2 — NEW SW now controller, but its precache hasn't been
  purged. May serve OLD or NEW depending on workbox internals.
- Press 3 — finally fresh.

### Fix

`performRefresh()` now (in order):
1. `await navigator.serviceWorker.getRegistration()`
2. `await reg.update()` — fetch new SW byte stream
3. Post `SKIP_WAITING` to `reg.waiting ?? reg.installing`
4. Await `controllerchange` with 2s ceiling
5. Purge ALL caches via `caches.keys()` + `Promise.all(caches.delete)`
6. `window.location.reload()`

Failure modes `console.warn`-logged so devtools captures evidence
when 3-press behavior reappears. The chain still proceeds best-effort
— a noted failure doesn't block the reload.

### Test-seam design

`window.__cic_bundleHash.__refreshProbe?: () => void` is the new
e2e seam. When set (only by Playwright), `performRefresh` calls the
probe instead of `location.reload()`. Reason: `location.reload` is
non-configurable on chromium so a prototype-patch is silently
ignored; the probe is the supported substitute. Production never
sets it. Mirrors `__cic_socketHealth`'s established hook pattern.

### Reviewer findings honored inline

- **H1** — original sequence purged caches BEFORE the new SW
  activated, relying on workbox's precache-miss network-fallback "by
  accident." Added `controllerchange` await with 2s ceiling so the
  activation contract is explicit.
- **H2** — silent swallow of `update()` rejection violated
  `feedback_silent_retry_anti_pattern`. Replaced with
  `console.warn`.
- **L1** — original `reg.waiting?.postMessage` was a no-op when
  install was still in flight (the new SW is in `installing` state
  at that point). Now `reg.waiting ?? reg.installing` covers both.
- **N3** — duplicate `Window.__cic_bundleHash` interface declaration
  in the e2e spec; replaced with a re-declaration that mirrors the
  prod type + adds `__refreshProbe`.

### Parked follow-up (reviewer M2)

The current e2e stubs `getRegistration` + `caches` + the probe seam
— proves the chain WIRING but not that the REAL SW + REAL precache
behave correctly. A meaningful e2e would deploy a 2nd bundle hash
mid-session (`compose run cicchetto-build` + `POST
/admin/cic-bundle-changed`) and assert single-press convergence.
Parked as UX-6-I.2; out of scope for I.

### Lessons

1. **Service workers are an invisible navigation layer.** The
   precache `NavigationRoute` is correct for offline shell-only
   apps but turns "user explicitly clicked Refresh" into a SW-
   mediated request that needs explicit invalidation. Future cic
   features that need a hard reset (clear local state, dev tools)
   should follow the same SW + caches discipline.
2. **Awaiting `controllerchange` is the right primitive** when
   sequencing actions that depend on a SW handoff. The
   `serviceWorker.ready` promise resolves on the FIRST registration
   activation but doesn't re-resolve on subsequent activations, so
   `controllerchange` is the right event for "wait for the NEW SW
   to take over."
3. **Surface failures even from best-effort chains.** `try`/swallow
   in a recovery action defeats the recovery — `console.warn` gives
   the operator something to grep for when the bug reappears.

---

## 2026-05-22 — UX-6-J: push notif tap opens source window (B5 carry-debt close)

vjt iPhone-dogfood Bug 10: tapping an OS push notification on the
home screen / lock screen opened cic to the LAST-viewed window rather
than the channel/DM the push referenced.

### Root cause

Push cluster B4 (2026-05-14) built the deep-link URL into push
payloads — `Grappa.Push.Payload`'s private `build_url/2` writes
`/?network=<slug>&channel=<percent-encoded>` and the SW carries it
through to `notificationclick`. B5 then half-shipped the cic side:
the SW handler ran `existing.navigate(url)` on the focused client,
but cic is an SPA — every route resolves to `index.html`, selection
state lives in the `selectedChannel` signal (NOT the router), so
`navigate(url)` reloaded the SPA at `/` and the deep-link query
params were dropped on the floor.

The payload.ex moduledoc actually admits the gap at lines 38-50:
> "cic itself does NOT parse `?network` / `?channel` on cold-load yet
> — B5 adds the SW notificationclick handler + the main.tsx URL-param
> reader together. Until then the URL ships in the payload but
> clicking the OS notification just opens `/`."

J finishes the other half.

### Fix — Option A (SW postMessage to focused client)

Two architectural choices were considered:

**A — postMessage SW→client.** SW posts the payload's target to the
focused client; cic listens on `navigator.serviceWorker` for
`message` events and routes through `setSelectedChannel`. SPA
architecture preserved; one extra global subscription.

**B — URL becomes the source of truth for deep links.** Boot-time
`location.pathname` parser feeds `setSelectedChannel`. Cleaner
long-term shape; bigger refactor, couples selection to history API.

A picked for J as minimum-surface, principle-aligned with the rest
of the UX-6 cluster. B remains a future Y/Z cleanup if richer
URL-driven navigation is ever needed.

### Implementation

* `service-worker.ts notificationclick`: after `existing.focus()`,
  call `existing.postMessage({type: "navigate", url})` instead of
  `existing.navigate(url)`. The dedup-by-URL check (`urlMatches`)
  becomes dead code (the postMessage IS the navigation) and is
  deleted with its vitest coverage.

* NEW `lib/pushTarget.ts`:
  - `parsePushTargetUrl` (in `pushPayload.ts`) extracts
    `{networkSlug, channelName, kind}` from the URL. `kind` follows
    RFC 2812 chanstring sigils `#&!+` → `"channel"`, otherwise →
    `"query"` (DM target). Mirrors `Grappa.Push.Payload`'s private `build_url/2`
    + `Grappa.IRC.Identifier.canonical_channel/1` on the server.
  - `applyPushTarget(rawUrl)` parses + calls existing
    `setSelectedChannel`. Same code path as a sidebar click — UX-4
    bucket D / E reactivity + UX-5 BU tuple-equality + subscribe.ts
    join effects all fire automatically off the signal. Parse
    failures `console.warn` per `feedback_no_silent_drops_*`.
  - `installPushTargetListener()` wires the SW → client `message`
    channel (warm path: cic was already running). Defensive against
    non-SW envs (vitest, privacy modes).
  - `applyPushTargetFromUrl()` cold path: when the SW called
    `openWindow(url)` on a not-yet-running client, the URL ships the
    deep-link params but there's no message handshake (page hasn't
    installed the listener yet). Reads `location.href` at boot, defers
    via `createEffect(on(networks, ...))` so `setSelectedChannel`
    doesn't fire against an empty store. Wrapped in `createRoot`
    because `main.tsx` calls it BEFORE `render()` — Solid warns +
    never disposes on `createEffect` outside a reactive owner. Cleans
    the URL via `history.replaceState({}, "", "/")` after apply so
    refresh doesn't re-trigger.
  - Test seam `window.__cicPushTargetApplied` lets the e2e cold-path
    spec prove the new reader fired (rather than a session-restore
    code path coincidentally landing the same channel).

* `main.tsx`: `installPushTargetListener()` + `applyPushTargetFromUrl()`
  at boot, alongside the other `applyXFromStorage` pre-render hooks.

### Reviewer-loop

General-purpose agent: SHIP-READY, 0 CRIT/HIGH. Four findings fixed
inline before commit:

* **M1 (createRoot wrap).** `createEffect` outside a reactive owner
  warns + never disposes. `main.tsx` calls `applyPushTargetFromUrl`
  before `render()`, so the cold-path effect was orphaned. Wrapped
  in `createRoot(() => createEffect(...))` — the root is intentionally
  never disposed since the cold-path is module-singleton and one-shot.
* **M2 (discriminating cold-path probe).** Without the
  `__cicPushTargetApplied` flag, the cold-path e2e could pass for
  the wrong reason (session restore lands on the same channel). The
  probe lets the spec `waitForFunction` on the flag, proving the
  new reader fired.
* **L1 (silent-swallow on parse fail).** Per
  `feedback_no_silent_drops_*`, added `console.warn` on
  `applyPushTarget(rawUrl)` parse failures. Future malformed-payload
  bug surfaces in devtools instead of degrading to "click did
  nothing."
* **L2 (URL residual).** `history.replaceState({}, "", "/")` after
  successful cold-path apply. Refresh doesn't re-trigger the cold-path
  read; URL stays clean for share-link ergonomics.

NON-FINDINGS covered placeholder URL base idiom, postMessage spoofing
(SW message channel is same-origin per spec), DM-kind discriminator
matching `Push.Payload.build/3`'s DM branch, `clients[0]` vs the
pre-J `urlMatches`-find regression risk (cic is PWA-shape, one tab
per UA; even multi-tab, focus-then-post routes selection identically),
and e2e `dispatchEvent` vs real-SW-post (`navigator.serviceWorker`
is an EventTarget — `dispatchEvent(new MessageEvent('message', …))`
exercises the same handler).

### Gates

* 1560 vitest passed (1542 baseline + 12 pushTarget + 11
  parsePushTargetUrl - 5 urlMatches dropped). Covers happy / malformed
  / missing-param paths + listener message filter + console.warn
  no-silent-drop discipline.
* `scripts/check.sh` EXIT=0 (2312 ExUnit + 0 Dialyzer/Credo/Sobelow +
  doctor green + bats 23/23 + 8 doctests + 32 properties).
* biome 21 warnings (baseline, diff adds zero) + 0 errors.
* 3/3 ux-6-j Playwright on chromium-desktop: warm-path postMessage
  flips selection, warm-path malformed URL is a safe no-op, cold-path
  goto with deep-link routes selection + cleans URL + sets probe flag.

### Deploy

HOT cic-only — no Elixir touched. Bundle deploy via
`scripts/deploy-cic.sh`.

### Lessons

1. **Half-shipped clusters bite later.** B4 + B5 (2026-05-14) shipped
   the server-side payload + the SW handler skeleton but stopped
   short of the cic URL reader. The moduledoc honestly flagged the
   gap, but the gap was easy to forget until vjt actually tapped a
   notification on iPhone. Cluster review discipline: when a moduledoc
   says "X is coming in a later sub-task", make sure the later
   sub-task actually lands before the cluster closes.
2. **SPA navigation state ≠ URL state.** cic is a route-less SPA —
   the selection signal IS navigation. Any push / deep-link /
   share-link feature has to either feed the signal directly OR
   pivot the architecture to URL-as-truth. The B5 SW handler tried
   to do URL-as-truth without committing to it; the result was a
   silent no-op. UX-6-J went with signal-as-truth + URL-as-input
   for the same reason BR + BC + BK in the UX-5 cluster did:
   minimum surface, principle alignment, no router refactor.
3. **`createEffect` outside `createRoot` is a silent footgun.** Solid
   warns, but the warning landed in our cold-path test pass because
   the e2e was loose enough to be non-discriminating. The reviewer
   probe pattern — explicit window-flag assertion — is reusable for
   any boot-time effect that conditionally fires.

---

## 2026-05-22 — UX-6-I.2: real-bundle-swap e2e (UX-6-I follow-up close)

Closes the M2 follow-up parked at UX-6-I (commit `22ce80e` shipped
the single-press refresh fix; UX-6-I's reviewer flagged "the e2e
proves wiring not behavior" and parked a real-swap fixture as
M2). UX-6-I.2 ships that fixture.

### The gap UX-6-I.2 closes

`cicchetto/e2e/tests/bundle-refresh-banner.spec.ts` (the UX-6-I e2e)
stubs `navigator.serviceWorker.getRegistration`, `caches.keys`,
`caches.delete`, and uses the `__refreshProbe` test seam to assert
that `performRefresh()` invokes the right chain in the right order.
This proves WIRING. It cannot prove the user-visible bug ("iPhone
PWA needs 3 button presses to pick up a new bundle") is gone, because
the stubs short-circuit the real SW + real precache race the bug
lived in. A green stubbed-spec is necessary but not sufficient.

UX-6-I.2 adds `bundle-refresh-real-swap.spec.ts`: drives the real
`BundleRefreshBanner` button against a real nginx-served swapped
`index.html`, asserts the script-src on the reloaded page carries
the new hash on the FIRST click. Discriminator: temporarily
downgrading `performRefresh` to a bare `window.location.reload()`
makes the new spec FAIL (post-condition: post-refresh script-src
mismatches the swapped hash because SW precache served the old
cached index.html). Negative-control was hand-run mid-development;
production `performRefresh` makes the spec pass at ~7-9s.

### Fixture shape — pre-prepared bundle-swap

Orchestrator decision (autopilot mandate, vjt asleep): chose
"pre-prepared bundle-swap" over "docker-compose-oneshot fidelity"
per KISS + e2e determinism + no-CI-retries alignment.

`cicchetto/e2e/fixtures/bundleSwap.ts`:
- `snapshotBundle()` — copies `runtime/e2e/cicchetto-dist` to a side
  directory for teardown restore. **Self-healing** (H1 reviewer fix):
  detects synthetic-bundle-B leftover from a crashed prior run
  (sentinel `Ux6i2Synth` in index.html) AND prior snapshot dir
  presence → restores snapshot over dist BEFORE taking THIS run's
  snapshot. Otherwise we'd capture the synthetic state as
  "baseline" and the spec restore would leave the dist permanently
  broken.
- `swapToBundleB()` — rewrites `index.html`'s `<script src>` to a
  fresh `/assets/index-Ux6i2Synth<timestamp>.js`, drops a minimal
  ES-module stub at that path. Atomic via `fs.rename` (POSIX
  guarantee on same-filesystem rename). M4 reviewer fix: tmpPath
  includes `pid` + `timestamp` defense-in-depth vs parallel-workers
  footgun (today blocked by playwright `workers: 1` config).
- `restore()` — wipes dist, copies snapshot back, deletes snapshot
  dir. L2 reviewer fix: per-entry try/catch + `console.warn` so a
  single unwritable leftover doesn't swallow the spec's primary
  assertion failure.

`cicchetto/e2e/tests/bundle-refresh-real-swap.spec.ts`:
- Boot → SW install + claim → assert no banner.
- Snapshot baseline → swap → `setServerHash(newHash)` → assert
  banner visible.
- Single click via `getByRole({name: /refresh|new version/i})` (L3
  reviewer fix vs literal `button` selector).
- `Promise.all([page.waitForEvent("framenavigated"), click])` (H2
  reviewer fix vs deprecated `waitForNavigation`).
- `waitForLoadState("load")` belt-and-braces post-nav.
- Read script-src from reloaded DOM (NOT via `__cic_bundleHash` —
  synthetic stub bundle doesn't bootstrap the SPA).
- `expect(reloadedHash).toBe(newHash)`.
- `finally { snap.restore() }`.

### Why a stub JS, not a real Vite rebuild

A real `cicchetto-build` mid-spec adds ~30s + depends on bun + node_
modules in the runner image. Out of scope. The behavior under test
is "post-purge reload converges to whatever index.html nginx now
serves" — a synthetic index.html pointing at a stub JS asset proves
the convergence without the build overhead. The spec asserts on the
script-src attribute, not on the bundled JS executing — fsync
ordering between the JS write and the HTML rename (M3 reviewer
concern) is therefore not a correctness boundary.

### Caveats accepted

- Spec runs against chrome on Linux (nginx-test stack). The iPhone
  PWA bug it descends from is platform-specific (iOS Safari
  throttles SW activation more aggressively than chromium). A green
  run here proves the convergence logic + cache-purge ordering hold
  under nominal SW timing; iPhone-specific timing must be hand-
  validated each release per the H2-reviewer wait-loop in
  `performRefresh()`. Spec moduledoc carries this banner.
- `BUNDLE_HASH_RE` is inlined in both `cicchetto/src/lib/bundleHash.ts`
  (production) and `cicchetto/e2e/fixtures/bundleSwap.ts` (fixture)
  with reciprocal "keep in lockstep" comments. Attempted shared-
  module extraction in M2 reviewer fix, but Playwright's native ESM
  loader doesn't see imports outside the `cicchetto/e2e/tsconfig.json`
  project root, and the e2e runner's bind-mount of `cicchetto/src`
  resolved but the export was not visible. Two-line regex with paired
  comments is cheaper than the build-system bridge that would
  unify them.

### Gates

- `scripts/check.sh` exit-0 (8 doctests + 32 properties + 2312 tests
  + 0 failures + bats 23/23).
- `scripts/bun.sh run check` exit-0 (biome + tsc clean, 21 baseline
  warnings — pre-existing default.css !important + BottomBar.test
  rot).
- `scripts/bun.sh run test` exit-0 (89 test files, 1560 vitest
  passed).
- Full integration suite: ran at `1e90554` baseline (files stashed)
  AND at this-bucket HEAD. Baseline 136 pass / 45 fail. This bucket
  136 pass / 46 fail (the +1 = the new UX-6-I.2 spec). Zero pre-
  existing specs regressed; the 45 baseline fails are the documented
  testnet flake set + the 2 known baselines from CP38.

### Deploy

NONE. E2e-only change + reciprocal comment on a production source
file. No runtime cic surface modified, no Elixir touched.

### Carry-forwards

- UX-6-M (channel scroll position interference) — still parked on
  vjt repro pattern. Likely ScrollbackPane reused via Solid `<Show>`
  non-keyed across `selectedChannel` changes.
- Baseline e2e fails surfaced via UX-6-E smoke (ux-4-z:141 +
  ux-z:86) — still parked for dedicated investigation cluster.

---



UX-6 ships in 11 production buckets (A–L minus H which merged into
D2; plus Z this docs sweep) across `57cd88b`→`7625e13` (chronological)
under autopilot mandate. UX-5 had closed two days
earlier (15 buckets, `205262d`→`38dc283`) but its README entry was
never written — per-bucket-update miss that the safety-net Z sweep
is exactly for (lesson `feedback_readme_currency`). This entry
documents (a) the cluster summary that README's "Closed clusters"
section now carries, and (b) the cross-cluster meta-lessons that
emerged.

### UX-6 bucket inventory

| Bucket | Commit | One-line |
|--------|--------|----------|
| A v1-v6 | `eeb551d` | mobile overlay scroll-leak + iOS PWA rubber-band — six iterations, final shape is custom 30-LOC touchmove handler walking ancestor chain |
| B1 + B2 | `61269eb` + `1b2687f` | embedded image uploader (server stack + cic adapter + admin Settings tab) |
| C | `31932b9` | admin button on mobile drawer footer |
| D1-D12 | `e53000c` | iOS PWA keyboard saga — Telegram Web K pattern (`html.is-ios position: fixed` + body `calc(--vh*100)` + smart-pin); 11 attempts + 4 research agents |
| E | `0867944` | narrow-mode BottomBar Server-tab dedup |
| F | `91cbc32` | send button → SVG paper-plane glyph |
| G | `a2de04e` | admin pane pan-x on mobile |
| H | (merged into D2) | scrollback follows viewport-shrink |
| I | `22ce80e` | cic refresh-banner single-press SW + caches saga |
| J | `7625e13` | push notif tap opens source window (B5 carry-debt close) |
| K | `dae54b8` | PM unread-marker advances on focus (cursor-validator divergence fix) |
| L | `eb07e4b` | foreground push → in-app beep (SW-suppress Option B) |
| Z | (this entry) | docs sweep + UX-5 backfill |

### Meta-lessons surfaced cluster-wide

1. **CSS-only iOS rubber-band fixes are systematically broken.**
   UX-5-BO + UX-6-A v1+v2+v3 all attempted `touch-action`-only
   solutions; all failed because `touch-action` is **non-inheriting**
   (CSS UI L4 gotcha). The chain bit three iterations before
   v4 introduced a JS layer (`body-scroll-lock-upgrade`); v6
   converged on a custom 30-LOC touchmove handler that walks the
   ancestor chain via DOM traversal. Lesson recorded:
   `feedback_research_before_attempt_9` — after 3+ failed
   iterations on platform-boundary bugs, STOP iterating and
   dispatch parallel research agents.

2. **Telegram Web K's iOS keyboard pattern works only when shipped
   atomically.** UX-6-D had eleven attempts; the eight failed
   variants partially adopted the Telegram pattern (e.g., `--vh`
   without `html.is-ios`, smart-pin without touch gating). v9
   `479b77d` adopted ALL pieces in one commit and the keyboard
   stopped fighting compose-focus. Lesson:
   `feedback_atomic_css_pattern` — Telegram-style patterns must
   ship ALL pieces in ONE commit; partial adoption catastrophic.

3. **B5 push deep-link carry-debt — half-shipped features hide in
   moduledocs.** UX-6-J's root cause was an honest moduledoc in
   `lib/grappa/push/payload.ex` that admitted "cic itself does NOT
   parse `?network` / `?channel` on cold-load yet — B5 adds the SW
   notificationclick handler + the main.tsx URL-param reader
   together. Until then the URL ships in the payload but clicking
   the OS notification just opens `/`." J finally shipped the
   other half. Lesson: a TODO in a moduledoc is a cluster
   candidate; file it immediately or it rots.

4. **Server-side predicate divergence is invisible until something
   reads BOTH paths.** UX-6-K root-caused a 422 on cursor write
   when inbound DMs were persisted at `channel = own_nick, dm_with
   = peer` (CP14-B3 shape). `Scrollback.fetch/6` used the OR-shape;
   `ReadCursor.message_belongs?/4` used the literal `channel`
   match. Fix: promote `channel_or_dm_where/3` from `defp` to
   `def` and delegate. Per CLAUDE.md "Implement once, reuse
   everywhere" — the duplication was the bug.

5. **APNs quota tax is the right tradeoff at current scale.**
   UX-6-L SW-suppress Option B (per vjt) sends every push even
   when foreground; SW just suppresses display when
   `visibilityState === 'visible'`. ~50% wasted at present;
   acceptable. Hybrid follow-up (server-side
   `WSPresence`-driven skip) NOT parked as TODO — re-evaluate if
   push volume justifies engineering.

### UX-5 backfill (15 buckets, closed 2026-05-20)

Mobile-polish wave on iPhone PWA. See README "Closed clusters"
entry for the per-bucket breakdown. The wave seeded UX-6: its
final two buckets (BV `4959c92` extending UX-3 PENT viewport
primitive; BD `38dc283` uniform safe-area-inset floor) tilled
the soil for UX-6-A's overlay scroll-leak universal fix.

### Carry-forwards (still open)

- **UX-6-M (channel scroll position interference on switch)** —
  parked pending vjt repro pattern. Likely related to
  `ScrollbackPane` being reused via Solid `<Show>` non-keyed
  across `selectedChannel` changes — `listRef.scrollTop`
  survives the switch (intentional per UX-4-K's
  `scrollToActivation`), but per-channel scroll position isn't
  persisted/restored.
- **UX-6-I.2 (real-bundle-swap e2e)** — current e2e stubs
  `getRegistration` + `caches` and uses the `__refreshProbe`
  seam; proves WIRING but not REAL SW + REAL precache behavior.
  Meaningful e2e would deploy a 2nd bundle hash mid-session via
  `compose run cicchetto-build` + `POST /admin/cic-bundle-changed`
  and assert single-press convergence. Out of scope for I.
- **Pre-existing baseline e2e failures** — `ux-4-z-cluster-journey:141`
  (members-pane intercepts backdrop tap on webkit-iphone-15) and
  `ux-z-cluster-journey:86` (archive `#bofh` row never renders).
  Reproduce on `e53000c` baseline before any UX-6-E edits; both
  flag mobile drawer + archive paths that may need a fix unrelated
  to the originating buckets. Surface for the next investigation
  pass.

### Two accepted residuals (do NOT chase)

1. Visible iOS keyboard slide-in animation (~250ms) — WKWebView
   compositor below JS, unfixable in pure PWA. Capacitor escape
   if priority rises.
2. UX-6-M parked above pending vjt repro.

---

## 2026-05-22 — REV-C: substrate preflight + healthcheck depth (C4 + H20 + H21 + H26)

Third bucket of the REV cluster (codebase-review-fixes 2026-05-22).
Single COLD-deploy bucket closing 1 CRIT + 3 HIGH — all live in
the deploy + boot + healthcheck substrate.

### C4 — `scripts/deploy.sh` ↔ `LongLivedModules` SoT decoupling

Pre-REV-C the bash preflight parsed the SoT module list with
`grep -E '^\s+Grappa\.[A-Za-z_.0-9]+,?$'` — matched ANY indented
line that LOOKED like a Grappa module reference. In the current
file this happened to pick up 14 lines: 12 real `@modules` /
`@state_helpers` entries + 2 typespec union lines. Today's bug is
benign (typespec lines duplicate real entries); tomorrow's would
be a CP28 rerun (add to typespec, forget `@modules`, false-COLD
on every change to a module not actually tracked).

The fix is **structural** rather than a tighter regex: the bash
script becomes a thin wrapper around `mix run --no-start -e
'Grappa.Deploy.Preflight.cli([from, to])'` (2026-06-10: the cli now
requires a third substrate arg, `"docker"` | `"jail"` — see the
substrate-scoped entry). The new module
`lib/grappa/deploy/preflight.ex` reads `LongLivedModules.all/0`
directly — no string parsing, no regex, no awk. The hand-rolled
brace-matching helper `scripts/_extract_state_block.awk` is
deleted; `Code.string_to_quoted/2` + AST walk handles the
state-block extraction now that an Elixir runtime is available
anyway. Two-line bash refactor → ~150-LOC awk file gone; the
SoT is the only definition.

Per CLAUDE.md "Implement once, reuse everywhere" + "use
infrastructure, don't bypass it": the SoT module was always the
right authority; the bash regex was the bypass.

### H20 — preflight path-class gaps

`Grappa.Deploy.Preflight.classify_paths/1` covers seven path
classes the pre-REV-C regex missed:
- `compose.override.yaml` + `compose.oneshot.yaml`
- `bin/grappa`
- `.dockerignore`
- Deeper `infra/snippets/*` paths
- ALL `config/*.exs`
- `priv/repo/migrations/*` (REV-B live-repro)

Each class has a dedicated test. The migration class was
*reproduced live during REV-B's deploy* — preflight returned HOT
despite the new migration file; operator forced `--force-cold`.
Three documented misses (UX-6-B1, REV-B, and the H21 motivation
itself) was enough — closed in this bucket.

### H21 — `SECRET_SIGNING_SALT` compile→runtime

Pre-REV-C: `config/config.exs:102` baked
`System.get_env("SECRET_SIGNING_SALT") || "build-time-placeholder…"`
into the Endpoint module's `@session_options` at compile time. An
operator rotating the salt via `.env` + `scripts/deploy.sh` saw no
effect until a full image rebuild — the `_build/<env>/lib/grappa/ebin/`
beams carried the old value.

The mechanical move (`config.exs` → `config/runtime.exs`
alongside `SECRET_KEY_BASE`) is straightforward. The interesting
bit is the Endpoint rewrite: dropped the `@session_options` module
attribute + `plug Plug.Session, @session_options`. New custom
`:session` plug calls `Plug.Session.call(conn, cached_session_opts())`.
`cached_session_opts/0` reads `Application.fetch_env!/2` on first
request, caches into `:persistent_term` for lock-free subsequent
reads. Per CLAUDE.md "Application.{put,get}_env/2: boot-time only"
— `:persistent_term` is the documented analog for "boot-once
readonly" and the cache is a first-request lazy init, not a
runtime config read.

The `config_change/2` override (round-2 reviewer HIGH-1 fix —
see below) invalidates the cache when `:session_signing_salt`
changes. `:persistent_term.put/2` not `erase/1` (avoids
process-wide GC scan).

### H26 — `/healthz` substrate depth

NEW `lib/grappa/health.ex` (`Grappa.Health` module). Three
substrate checks via `Grappa.Health.check/0`:
- `:ready` — Grappa.Application's `start/2` callback marks the supervision
  tree ready via `:persistent_term` AFTER `Supervisor.start_link/2`
  returns clean.
- `:repo` — `Grappa.Repo.query("SELECT 1")` round-trip.
- `:ets` — `:ets.info/1` on `Grappa.Session.Backoff.table_name()`
  + `Grappa.Admission.NetworkCircuit.table_name()` (REV-C reviewer
  LOW-1 single-sources the table-atom boundary).

`HealthController.show/2`: 200 `ok` on green; 503 + JSON
`{status: "fail", checks: [{name, reason}]}` on any failure. Per
`feedback_silent_retry_anti_pattern`: surface the specific failing
check.

Docker HEALTHCHECK + nginx healthcheck inherit the deeper check
for free.

### The 3-round reviewer-loop

Round 1 caught MED-1+MED-2 (Endpoint cache not invalidated on
`config_change`), LOW-1 (ETS table atom single-source), LOW-2
(Health moduledoc tightening), LOW-3 (parse-failure sentinel).
All fixed inline.

Round 2 caught HIGH-1: the round-1 `Endpoint.config_change/2`
override read the WRONG shape of `changed`. Application.config_change/3
delivers application-scoped keyword `[{Endpoint, [salt: ...]},
{OtherKey, ...}]` — NOT a flat keyword. The predicate
`Keyword.has_key?(changed, :session_signing_salt)` checked the
OUTER application-env key, which can never be
`:session_signing_salt`. Production salt rotation would have
silently no-op'd — the exact failure MED-1 was meant to close,
just one layer deeper. Tests passed because they bypassed the
real shape.

**Meta-lesson**: a wrong-shape predicate that "compiles fine" but
never matches in production is exactly the class of bug code
review is meant to catch. Reviewer caught it; tests had to be
rewritten to drive the realistic shape. CP39 + the
`feedback_reviewer_gate_evidence` discipline earned its keep.

Round 3: APPROVE clean.

### Deploy: COLD (with the meta first-deploy-after-script-change gotcha)

First `scripts/deploy.sh` invocation after the merge used the OLD
script's preflight (it ran BEFORE the new script could replace
itself). The OLD preflight didn't see `config/*.exs` or the new
modules as cold-required → false-HOT. `POST /admin/reload` then
500'd because `Grappa.Deploy.Preflight` + `Grappa.Health` didn't
exist in the live BEAM. Fix mechanical:
`docker compose run --rm -T grappa rm -rf /app/_build/prod` (per
`feedback_hot_deploy_corrupts_build_prod`), then
`scripts/deploy.sh --force-cold` re-ran clean.

**This is now a documented recurring lesson**: ANY cluster that
touches `scripts/deploy.sh` itself MUST first-deploy with
`--force-cold` because the OLD preflight ships in the OLD script
that still runs before the new one takes effect. REV-I (infra
simplification) is the next bucket to hit this.

### Smoke verifications post-deploy

```
$ ... Preflight.classify_paths(["priv/repo/migrations/99999999_smoke.exs"])
{:cold, [migration: [...]]}

$ ... Preflight.classify_paths(["config/runtime.exs"])
{:cold, [config: ["config/runtime.exs"]]}

$ ... Preflight.classify_paths(["lib/grappa/foo.ex"])
{:hot, []}

$ bin/grappa remote-shell --batch -e '... |> Keyword.fetch!(:session_signing_salt)
                                      |> String.length() |> IO.puts'
32

$ curl http://192.168.53.12:4000/healthz
ok
```

### Carry-forwards

- Meta first-deploy-after-script-change cycle (see Deploy section)
  — flag in REV-I briefing.
- `_build/prod` corruption from prior HOT — operator runbook
  STILL doesn't document the cleanup. Reproduced third time.
  REV-Z target.
- MED-2 from REV-B (`validate_target_name/1` pre-canonical) still
  open. REV-J or REV-Z.

### Lessons

1. **The reviewer-loop is not theater.** Round 2 caught a
   production-only HIGH bug that round-1 tests passed against
   because they bypassed the real call shape. The test was a
   mirror, not an oracle.
2. **`feedback_hot_deploy_corrupts_build_prod` keeps repeating.**
   Third time documented. The operator-side cleanup mechanic is
   identical every time. Documenting in CP is not enough; needs
   to live in the operator runbook (REV-Z scope).
3. **Cluster-scope clean-up rewards itself.** Deleting
   `_extract_state_block.awk` + the bash regex feels like
   "polishing" — but the AST oracle (`Code.string_to_quoted/2`)
   is the right authority and Elixir's tokenizer is genuinely
   stable. The shell was the bypass.
4. **Conservative bias = COLD always wins.** Two MEDs +
   `LOW-3` (parse-failure sentinel) all converged on "when in
   doubt, COLD." A 30s false-COLD is cheap; a deferred
   shape-mismatch crash is not.

---

## 2026-05-22 — REV-D: silent-swallow at boundaries (H12-H16 + M16/M17)

Bucket 4 of 11 in the 2026-05-22 codebase-review-fixes cluster
(`project_post_tmu_full_review_scheduled`). Closes 5 HIGH + 2 gating
MEDs that shared the silent-swallow-at-boundary theme — every
finding was a place where the codebase *had* an error path on
paper but the implementation absorbed, masked, or routed around it.
Single bucket; one COLD deploy.

### The shape

Five distinct failure classes that all look like the same bug from
a distance:

1. **Doc-vs-impl drift** (H12). `Backoff.record_failure`'s moduledoc
   claimed "called from `terminate/2` on any non-`:normal` exit."
   Actual call sites were `handle_info({:EXIT, client_pid, _})` +
   `do_start_client/2`. Non-Client crash classes (callback raise,
   mailbox overflow, link-death from a hypothetical non-Client
   linked proc) bypassed backoff bookkeeping. Counter stayed at 0
   → `:transient` respawn fired with no delay → tight crash loop
   exactly when the per-`(subject, network_id)` ladder mattered
   most.

2. **Sister-function asymmetry** (H13). `Accounts.Session.touch_changeset/2`
   got a backward-clock-skew guard in B5.4 L-pers-3 (NTP step or
   container reboot under wall-clock drift would otherwise move
   `last_seen_at` backward, breaking the idle-timer math). The
   structurally-identical `Visitor.touch_changeset/2` never got the
   port — backward-clock skew silently shrank visitor TTL → Reaper
   deleted a still-active row.

3. **Lookup-then-update race** (H14). `Visitors.commit_password/2`
   + `Visitors.update_nick/2` did `Repo.get` → `Repo.update` with
   no race protection. A peer caller (operator delete, Reaper
   sweep, `purge_if_anon` on session revoke) could vanish the row
   between calls, raising `Ecto.StaleEntryError` instead of the
   spec'd `{:error, :not_found}`. The 500 in the web layer
   silently violated the typed contract.

4. **Schema-vs-context cap drift** (H15). `last_joined_channels`
   was capped at 200 by the `Credentials` context helper only. Any
   bypassing writer — a future REST credentials surface, an
   operator mix task, a test helper — could grow the JSON column
   unbounded. Schema is the canonical bound; context-side cap is
   a convenience.

5. **Runtime config read** (H16). The lone surviving CLAUDE.md
   "boot-time only, runtime banned" violation in the codebase:
   `PushVapidController.show/2` did `Application.fetch_env!/2`
   per request. Mirror `Grappa.Uploads.boot/1`'s precedent — pin
   in `:persistent_term` at boot, lock-free runtime reads.

### Two MEDs in the same theme

- **M16** — `ChannelsController.delete/2`'s
  `remove_from_autojoin/3` logged a warning + returned 202 even
  when removal failed. Next reconnect re-joined the channel the
  user explicitly left, invisibly. M-9b silent-swallow pattern.
  Now propagates via `with` → FallbackController.
- **M17** — `ArchiveController.delete/2` strict-bound
  `{:ok, _} = Scrollback.delete_for_*` so any context error
  became `MatchError` → 500 bypassing `FallbackController`'s
  typed envelope. Routed through `with` arm.

### The H12 funnel pattern

Single-source the cross-cutting concern at the terminal door,
not at every spawn site that could trip it. Pre-REV-D: two call
sites (`handle_info` EXIT + `do_start_client`) each said
"I observe a failure → I tell Backoff." Post-REV-D: one call site
(`terminate/2`'s abnormal-reason clause) says "I am the funnel
through which every Session.Server abnormal exit passes — I am
the place where Backoff gets the news." Reasoning surface
contracts: instead of auditing every potential crash class to
verify it bumps the counter, audit the terminate clauses and
verify they cover everything. OTP's `terminate/2` contract
guarantees the funnel for every non-`:brutal_kill`,
non-BEAM-shutdown exit — which IS every failure class the backoff
ladder cares about (`:brutal_kill` is an OS-level signal, not a
network-instability symptom; if the bouncer is being SIGKILL'd
the operator has bigger problems than backoff).

The split that mattered: `terminate(:normal, ...)` (operator
intent — no bump), `terminate(:shutdown | {:shutdown, _}, ...)`
(supervisor-driven shutdown — no bump, graceful QUIT), catchall
(every other reason — bump). The catchall is the funnel; the
two earlier clauses are the "this is not a failure" exemptions.

### The H13 split-changeset pattern

`Visitor.touch_changeset/2` was overloaded for two different
semantics that happened to share a column write:
1. **Sliding extension** — `Visitors.touch/1`'s anonymous-visitor
   TTL bump (forward in time, conceptually).
2. **Forced expiry** — `Visitors.mark_failed/2`'s k-line response
   (write NOW over a future `expires_at`, conceptually backward).

The monotonicity guard correctly rejects backward bumps for case
(1), but case (2) IS legitimately backward by design. Splitting
into `touch_changeset/2` (guarded) + `expire_changeset/2`
(unguarded) made the two semantics distinct doors. The guard is
behavioral, not data-shape; the column write is identical. This
is the "different verbs, same noun" pattern from CLAUDE.md.

### Boot-time pinning convention

H16 added the second `:persistent_term`-pinned boot-time read to
the codebase (after `Grappa.Uploads.boot/1`). The pattern is now
stable enough to call out:

- `<Context>.boot/0` (or `/1` if it takes a path) reads
  `Application.fetch_env!/2` once at `Application.start/2` time,
  stashes the result via `:persistent_term.put(@key, value)`.
- `<Context>.<accessor>/0` returns `:persistent_term.get(@key)`.
  Raises if `boot/0` hasn't run (any caller reaching it pre-boot
  is a bug).
- `Application.start/2` calls each `boot/0` BEFORE the supervised
  Endpoint comes up.

The library may itself read from `Application.get_env/2` at
delivery time (web_push_elixir's signing path does this); we
can't influence the library, but OUR call sites observe the
boot-time pin.

### Deploy preflight FALSE-HOT trap

`feedback_deploy_preflight_empty_diff_after_merge` reproduced for
the **4th** time. Local `git merge --ff-only` had already
advanced HEAD to the deploy target BEFORE `scripts/deploy.sh`'s
`git pull --ff-only` ran → pull returned "Already up to date" →
`prev_sha == HEAD` → preflight's "same SHA = nothing to deploy"
shortcircuit returned HOT. The HOT reload silently no-op'd
`Application.start`, leaving the new `Grappa.Push.boot/0`
uncalled. Caught immediately by the H16 smoke; cleaned
`_build/prod` + `--force-cold` recovered.

Mitigation candidate (REV-J or REV-Z): preflight should compare
against the LIVE container's deployed SHA, not local
`prev_sha == HEAD`. The current logic is structurally fragile
to the "local merge advances HEAD before deploy.sh's pull"
race.

### Carry-forwards

- **Preflight empty-diff FALSE-HOT** — 4th repro. Mitigation in
  REV-J or REV-Z.
- **`_build/prod` cleanup procedure** — 4th repro. STILL
  undocumented in operator runbook. REV-Z target.
- MED-2 from REV-B (`validate_target_name/1` pre-canonical) still
  open. REV-J or REV-Z.
- REV-D reviewer LOW-1 (H14 narrow-window test name vs.
  behavior). Two-line rescue, both branches return same typed
  error. Documented; not fixed inline.

### Lessons

1. **Single funnels beat distributed checkpoints.** The H12 fix
   collapsed two crash-bookkeeping call sites into one
   `terminate/2` clause. The reasoning surface for "does every
   failure class bump the backoff counter?" went from
   "audit every potential crash site" to "audit the terminate
   clauses." Fewer doors = fewer places to forget.
2. **Sister functions are a red flag.** When two functions are
   structurally identical but only one has a load-bearing guard,
   the asymmetry is almost always a port-not-made (H13). Code
   search by signature shape before signing off on a fix.
3. **Spec-vs-impl drift is the silent killer.** H12's moduledoc
   was wrong; nobody noticed for months because the doc was
   right enough that nobody re-read it. Reviewer-loop's LOW-2
   spec-tightening (post-H13) caught the same shape at smaller
   scale — Dialyzer narrows the contract, future readers see
   the real story.
4. **Boot-time pinning is a stable pattern now.** Second instance
   (`Grappa.Push.boot/0` after `Grappa.Uploads.boot/1`); the
   pattern is documented above. Use it for any future
   per-request env reads.
5. **Preflight needs a live-state oracle.** The empty-diff
   FALSE-HOT trap will keep biting until the preflight compares
   against the deployed-container SHA instead of local
   `prev_sha`. Mark for REV-J/Z mitigation.

---

## 2026-05-22 — REV-E: `:ok = Client.send_*` strict-bind regression sweep (H11)

REV-E (bucket 5 of 11 in the post-2026-05-22-codebase-review REV
cluster). Closes the lone HIGH from the review's "Theme B —
`:ok = match` regressions" — eight+ bare `:ok = Client.send_*`
matches in `Session.Server` would crash the session on dead socket,
inverting the post-U-cluster boundary fix at `IRC.Client.send_line`
that widened the return shape from `:ok` to `:ok | {:error,
:no_socket | :closed | :inet.posix()}`.

The strict-bind matches predated the U-cluster fix and had been
silently incompatible since the day that fix landed — the only
reason they weren't crashing in production was that no live
session had actually hit a dead-socket SEND between the U-cluster
landing and the 2026-05-22 review noticing them.

Fix: replace every `:ok = Client.send_*` match with case-match
mirroring the post-U-cluster pattern at server.ex:1849-1859. Two
shapes emerged:

- **Propagate-path** (raw `:send_mode` handle_call + chunked-mode
  emission): convert to recursive `flush_mode_chunks/3`
  halt-on-first-error helper per CLAUDE.md collect-or-bail
  pattern. The pre-fix `Enum.each` over chunks ignored returns;
  post-fix the recursion returns `{:error, _}` on first failure
  so the caller's `with` chain surfaces it.

- **Fire-and-forget path** (apply_effects `:reply` arm,
  `flush_lines` ghost-recovery, 5 AWAY-internal sites): single
  consolidated `maybe_log_send_failure/2` helper.
  `Logger.warning` with structured metadata; no propagation
  because the caller is in the middle of a state mutation that
  must commit regardless (e.g. AWAY-state flip in
  `EventRouter.apply_effects/2`).

Reviewer round 1 caught a HIGH (`dispatch_ops_verb/3`'s
`with`/`else` was non-exhaustive — `{:error, :no_socket}` etc.
would have raised `WithClauseError` in the Channel pid post-
sweep, relocating the crash class from `Session.Server` to
`GrappaWeb.GrappaChannel`) + 3 MEDs (Session.send_* spec drift,
apply_effects reply/persist ordering comment lie, AwayState
recovery overstated — operator must re-issue `/away` post-
reconnect because Session crash wipes AwayState).

All fixed in commit `1980035` (over base sweep `b457efc`). New
typed public API: `t:Grappa.Session.send_transport_error/0`
typedoc'd union (`:no_socket | :closed | :inet.posix()`); all 22
`Session.send_*` wrappers widened to include it.
`dispatch_ops_verb/3` gains catch-all `{:error, reason}` arm
with `Logger.warning` + typed `upstream_unavailable` cic reply.

HOT-deployed via `Phoenix.CodeReloader.reload/1` (Path 2 manual
preflight against deployed SHA `4b33ae6` BEFORE running
`scripts/deploy.sh` to defuse the FALSE-HOT empty-diff trap).
Live-verified post-deploy via grep on `/app/lib/...`.

## 2026-05-22 — REV-F: IRC SASL combined-REQ fallback + dispatch_subject_verb catch-all (H9 + H10)

REV-F (bucket 6 of 11). Two-finding bucket, both server-side, neither
touches state-shape. Single-round APPROVE-clean reviewer pass.

### H9 — AuthFSM combined `CAP REQ :sasl labeled-response` fallback on NAK

The S4.2 cluster (early 2026-05) extended `Grappa.IRC.AuthFSM` to
request `labeled-response` opportunistically alongside `sasl` —
when CAP LS advertised both caps, the FSM emitted a single combined
`CAP REQ :sasl labeled-response\r\n`. Saves a round-trip and keeps
both caps coupled to the SASL handshake. Worked against IRCv3-
compliant ircd.

Bahamut and some Solanum variants advertise `labeled-response` in
their CAP LS output but NAK the combined REQ blob — they ACK `:sasl`
alone but not the combined form. Pre-REV-F a `:sasl`-required
credential against such a server saw the combined-NAK, declared
`:sasl_unavailable` immediately (line 438 `{:stop,
:sasl_unavailable, ...}`), and restart-looped permanently against
the exponential backoff ladder. The bug was latent for the duration
of S4.2's deployment — only surfaced because the codebase review
walked the auth FSM by hand and noticed the missing fallback shape.

Fix: split the post-REQ wait phase per-shape so the NAK clause can
discriminate.

- `:awaiting_cap_ack` — reserved for standalone REQs (`:sasl` alone
  OR `:labeled-response` alone). NAK on this phase still declares
  `:sasl_unavailable` immediately — there's nothing to fall back
  FROM (no labeled-response was bundled to be the offender).
- `:awaiting_cap_ack_combined` (new) — combined REQ in flight. NAK
  triggers the fallback: emit `CAP REQ :sasl\r\n` alone, transition
  to `:awaiting_cap_ack_sasl_only`.
- `:awaiting_cap_ack_sasl_only` (new) — fallback REQ in flight. NAK
  here genuinely means the server doesn't support SASL → existing
  `cap_unavailable/1` path (`:stop :sasl_unavailable` for `:sasl`
  auth; `:cont` PASS-handoff for `:auto`). ACK proceeds normally
  to AUTHENTICATE PLAIN.

ACK clause guard widened to match all three awaiting-ACK phases
— semantics are identical across them (SASL ACK → AUTHENTICATE
PLAIN + `:sasl_pending`; non-SASL ACK → `cap_unavailable`).
`maybe_send_cap_end/1` extended to recognise both new phases for
explicit teardown. `leave_cap_negotiation/2` docstring updated
with the new transition table; the
`AWAIT_COMBINED → AWAIT_SASL_ONLY` transition deliberately does
NOT route through `leave_cap_negotiation/2` because `caps_buffer`
was already cleared at the LS boundary.

`:auto` auth method also benefits as a side effect: pre-fix
`:auto` combined-NAK fell through to `cap_unavailable/1`'s
non-`:sasl` clause (PASS-handoff, no `:stop`), silently losing
SASL eligibility even when the server actually supported SASL
alone. Post-fix `:auto` exercises the fallback REQ first; only
the second NAK (genuine no-SASL) drops back to PASS-handoff.

C1 phase pin invariant preserved: the "SASL PLAIN reply only
legitimate in `:sasl_pending`" clause stays exclusively pinned
to `:sasl_pending`; new phases NOT included → no credential leak
via the new states. The C1 catch-all absorbs stray AUTHENTICATE
in the new phases silently.

### H10 — GrappaWeb.GrappaChannel.dispatch_subject_verb/3 catch-all

Sister of `dispatch_ops_verb/3`. REV-E HIGH-1 added a catch-all
`{:error, reason}` arm to `dispatch_ops_verb/3` after the H11
sweep widened `Session.send_*`'s return shape with
`Session.send_transport_error()`. The sibling subject-verb helper
— routing `whois`/`who`/`names`/`banlist` (the read-only verbs
visitors are entitled to issue) — wasn't audited at the same time
and still had the un-exhaustive `with`/`else`. Pre-REV-F a dead-
socket SEND from `Session.send_whois/3` (etc.) post-U-cluster
boundary fix would raise `WithClauseError` in the channel pid —
same crash class REV-E HIGH-1 closed at the ops sibling,
relocated to the subject-verb path. Consistency drift between
sibling helpers — the root cause REV-E HIGH-1 itself was.

Fix: verbatim mirror of REV-E HIGH-1's catch-all. Logger.warning
with `reason: inspect(reason)` + typed
`{:reply, {:error, %{reason: "upstream_unavailable"}}, socket}`.
Only the log message string differs (`"subject verb"` vs
`"ops verb"`, intentional). Comment cross-references REV-E HIGH-1
explicitly so a future audit knows the parity invariant.

### Procedural carry-forward

REV-F's reviewer pass was APPROVE-clean in a single round (no
fix-up needed). REV-E's was APPROVE only after round 1 caught a
HIGH + 3 MEDs. Both rounds had identical brief language —
"reviewer MUST run check.sh + dialyzer.sh directly and paste
literal gate-tail per `feedback_reviewer_gate_evidence`." The
literal-paste mandate is what distinguishes "real APPROVE" from
"implied APPROVE on trust." Standing rule for the rest of the
REV cluster (and every cluster after): every reviewer brief
specifies the literal-paste requirement explicitly, regardless
of how "small" the bucket looks.

---

## 2026-05-22 — REV-G: PWA SW denylist + Solid reactivity + admin WS (H22 + H23 + H24)

REV-G (bucket 7 of 11). Three-finding cic-only HOT bucket closing
H22, H23, H24 from the 2026-05-22 codebase review. Reviewer round 1
caught a MEDIUM that exposed an incomplete H23 fix; round 2 APPROVE
clean.

### H22 — PWA SW navigation-route denylist gap

The cic PWA service worker installs a `NavigationRoute` that
serves the precached SPA shell on top-level navigations. Workbox
`NavigationRoute` matches `request.mode === "navigate"`, so REST
fetches + WS upgrades pass through untouched — but explicit
top-level navigations (URL paste, tab open, deep link) hit the
denylist gate. Pre-REV-G the denylist was
`[/^\/auth/, /^\/me/, /^\/networks/, /^\/socket/, /^\/push/]` —
the five scopes the router exposed at the time the SW was first
authored. Three subsequent additions (`/api`, `/admin`,
`/uploads`) were never reflected back into the SW.

Concrete bug: a user posts a `📸 host/uploads/<slug>.png` URL in
IRC. A peer with the PWA already open taps the link, opening a
new tab to `host/uploads/<slug>.png`. The SW intercepts the
top-level navigation and serves the SPA shell → broken image in
new tab. Same failure mode for direct operator-console
navigation (`host/admin/visitors` → SPA shell instead of JSON
controller response) + the small `/api/*` REST surface.

Fix: broaden the denylist to include `/api`, `/admin`,
`/uploads`. `/healthz` is intentionally omitted — a single GET
that load balancers probe; if a probe URL gets opened in a tab
the SPA shell is harmless (no security oracle, no broken
attached resource).

Structural pin: `test/grappa_web/router_sw_denylist_test.exs`
walks GrappaWeb.Router.__routes__/0 (the authoritative compiled
router) + regex-parses the SW source file for `denylist: [...]`
tokens, asserts SW ⊇ router-prefix-set modulo a documented
whitelist (`/`, `/healthz`). Same M-9b-style boundary discipline
the nginx allowlist test established — adding a new top-level
route scope in `router.ex` without updating the SW now fails
this test before deploy. The router-side superset assertion is
the real defense; the per-baseline-prefix sanity test pins the
exact set REV-G adds so any silent SW edit dropping one of them
fails loudly.

`scripts/_lib.sh` `WORKTREE_VOLUMES` extended to mount
`cicchetto/src` RO so the new Elixir test (which reads the SW
source via `File.read!`) sees worktree state instead of main's
in oneshot mode. Scoped to worktree mode only; live container
sees main via the base `./:/app` bind unchanged.

### H23 — `markerRef` `<For>` ref leak in ScrollbackPane

`cicchetto/src/ScrollbackPane.tsx` had `let markerRef: HTMLDivElement
| undefined` used as the unread-marker DOM ref via JSX
`ref={markerRef}`. The unread marker is rendered inside a `<For>`
over the day-separator-marker-message row mix. When SolidJS
removed the marker mid-channel (cursor advance to highest
sessionTopId → marker disappears WHILE the operator stays on the
same window), the `let`-bound ref still pointed at the
now-detached DOM node.

Compensated for the CHANNEL-SWITCH case at the key-change effect
with an explicit `markerRef = undefined` reset. Mid-channel
removal had NO compensation. A subsequent `scrollToActivation()`
call (e.g. visibility-return after backgrounded tab) hit the
marker-present branch and called `scrollIntoView` on the
detached node — either a no-op (jsdom optional-chain) or a real
TypeError (production browser on certain detached-node code
paths).

Documented gotcha per `feedback_solidjs_for_ref_leak`. The
feedback memory pre-REV-G said: "convert to function-ref signal,
SolidJS calls the function with `undefined` on unmount." **That
assumption was wrong.** SolidJS function-refs are called ONCE on
mount; on unmount they are NOT auto-called with `undefined` the
way React refs are. That's the React contract, not Solid's.
Round-1 REV-G fix did exactly that — converted to a
`createSignal` function-ref — and shipped a test that didn't
actually exercise the regression code path (the smoke "no crash"
assertion was satisfied independently of the bug).

Reviewer round 1 (general-purpose agent) caught the test-pin
quality as a MEDIUM. Investigation while writing a real spy-based
pin (`Element.prototype.scrollIntoView` spy + 0-calls assertion
between cursor advance and visibility return) failed — the spy
fired on the marker div even with the function-ref signal "fix."
The signal STILL retained the stale node. The function-ref
hypothesis was wrong.

Correct fix: function-ref signal **plus** explicit
`onCleanup(() => setMarkerRef(undefined))` registered inside the
ref function. SolidJS's `onCleanup` fires when the parent
reactive scope disposes — for a `<For>`-rendered child, that's
at row unmount. Signal flips back to undefined; downstream
readers (`scrollToActivation`, length-effect) take the
marker-absent branch.

Test pin: the spy-based regression NOW genuinely discriminates
pre-fix from post-fix code. Without onCleanup the spy fires;
with it the marker-absent scrollTop-direct branch runs and the
spy stays at 0 calls. Module docstrings at both the declaration
site + the JSX site explain the SolidJS gotcha explicitly so a
future reviewer can't repeat the React-style auto-null
assumption. Commit body documents the wrong-hypothesis path
without papering it over.

Lesson for the `feedback_solidjs_for_ref_leak` memory: the fix
recipe needs both the function-ref signal AND the explicit
`onCleanup`. The memory should be updated.

### H24 — admin-channel WS narrower

`cicchetto/src/lib/adminEvents.ts` registered
`channel.on("snapshot", (payload: AdminSnapshotPayload) => ...)` +
`channel.on("event", (payload: WireAdminEvent) => ...)` —
TypeScript-only contract, zero runtime enforcement. Sibling
channels (per-channel topic + user-topic) adopted
`narrowChannelEvent` / `narrowUserEvent` as the WS-edge boundary
validators (bucket G H4+U3 + cic M1 respectively); the admin path
was missed when adminEvents.ts was originally authored at M-11.

A malformed admin push — version skew, server-side bug, hostile
push — would either crash `ingest()` via a missing-field read
(`recordCapCounts` reads `ev.visitors`/`ev.users` without guard)
or silently corrupt the `liveCountsByNetworkId` projection.

Fix: add `narrowAdminEvent` + `narrowAdminSnapshot` to
`cicchetto/src/lib/wireNarrow.ts` mirroring the sibling pattern.
Per-arm field-shape validation for all 13 `WireAdminEvent` arms
(every arm carries `at: string` + most carry `network_id: number`
+ `network_slug: string | null`; shared nullable-helpers
`isNullableString` / `isNullableNumber` keep the per-arm switches
compact). Atomic snapshot validation — a single malformed element
drops the WHOLE `{events: WireAdminEvent[]}` (avoids corrupting
the audit ring with partial state). `installAdminEvents` routes
both `channel.on` arms through the narrowers; `console.warn` +
drop on shape mismatch (no silent swallow per
`feedback_no_silent_drops_closed`).

60 new vitest cases in `wireNarrow.test.ts` exercise every arm +
edge case (null fields, missing fields, wrong-typed fields,
unknown discriminator). 4 new boundary regression tests in
`adminEvents.test.ts` pin the no-crash + atomic-drop +
console.warn contract using a raw-payload test seam that bypasses
the WireAdminEvent type cast.

### Procedural carry-forward

REV-G round-1 catching the incomplete-fix bug-in-the-bug-fix is
the strongest validation yet that the literal-paste reviewer
discipline pays for itself. Round-1 reviewer noted MED-1 ("test
doesn't actually pin the bug"), worker's investigation under that
finding exposed the production-code completeness issue. Without
the MED-1 catch the H23 fix would have shipped with a passing
smoke test masking a still-broken production path.

Standing reminder: when a reviewer flags test-pin quality on a
fix that "looks right" on inspection, treat it as potentially
signalling an incomplete fix, not just a weak test. The two are
correlated: a weak test often masks an incomplete fix that the
worker assumed would work.

---

## 2026-05-22 — REV-H: server-side type tightening Theme A + ServerSettings PubSub single-source (H2-H8 + H25)

Bucket 8 of 11 in the post-2026-05-22-codebase-review REV cluster.
Closes 7 HIGH findings — six wire-shape typespec tightenings
(H2, H3, H4, H5, H7, H8) + one cross-module PubSub single-source
restoration (H25).

### The pattern

Three findings (H3, H4, H8) share the same shape at the macro
level: the wire boundary received the post-converted-to-
presentation-shape value (string for atom, already-encoded ISO8601
for DateTime, hardcoded `parked + failed` sum for a closed-set
count breakdown) when the wire boundary SHOULD have received the
in-process value + done the conversion itself. The fixes move the
conversion INTO the Wire fn (or its derivation pipeline) mirroring
the proof-of-pattern that already existed elsewhere:
`Scrollback.Wire.to_json/1`'s `Atom.to_string(m.kind)` for H3,
`Session.Wire.channel_created/3`'s explicit `DateTime.to_iso8601/1`
for H4. Adding a 4th state to a closed-set atom union is now a
single-edit operation on both sides (server enum + cic
discriminator) instead of a hunt across N call sites.

Two findings (H2 + H5) are pure closed-set discipline at the
boundary: H2 introduces a top-level `ConnectionState` type union
in cic that mirrors the server's `Credential.connection_state()`
atom set, and an `isConnectionState` runtime narrower that's
applied to every arm that carries a connection-state value (both
the `connection_state_changed` user-event arm AND the
`home_network_state_changed` sibling arm). H5 tightens
`cap_counts_changed.network_slug` from `String.t() | nil` to
`String.t()` because the broadcaster already early-returns on a
missing network row — the nullable arm was dead code on both
sides. Surgical scope on H5: other admin event arms
(`circuit_open`, `capacity_reject`, `session_terminated`) keep
nullable slugs because the deleted-network race CAN reach those
paths.

H7 closes a different class — a `case` dispatch that hardcodes a
subset of a closed enum. `Bootstrap.spawn_with_admission` matched
3 specific capacity-error atoms + a `:network_circuit_open` tuple
without a catch-all clause. A 5th atom added to
`Admission.capacity_error_atoms/0` would crash-loop Bootstrap on
every boot via `CaseClauseError`. Fix is the standard
"`{:error, other} ->` + Logger.error + bucket as 'investigate'"
pattern: extracted `classify_outcome/3` as `@doc false` testable
seam so the regression tests can iterate
`Admission.capacity_error_atoms/0` and assert every CURRENT atom
routes to a known bucket + a fake atom lands in the catch-all
without crash.

### H25 — PubSub single-source restoration

The discrete cross-module finding. Pre-H25
`Grappa.ServerSettings` defined a private `@topic
"grappa:server_settings"` + called raw `Phoenix.PubSub.broadcast/3`
with a 2-tuple `{:server_settings_changed, view}` payload. This
predated the `broadcast_event/2` + `Grappa.PubSub.Topic` invariant
that landed for the channel-events surface (CLAUDE.md PubSub
section + the no-silent-drops B6 cluster). The topic was invisible
to `Topic.parse/1`'s grammar enumeration, so any tooling that
walks the documented topic surface (future codegen, future audit)
would miss it.

Fix:
- `Grappa.PubSub.Topic.server_settings/0` builder + `:server_settings`
  arm in `Topic.parsed`/`parse/1`. Grammar now enumerates the topic.
- `ServerSettings.broadcast_changed/0` routes through
  `Grappa.PubSub.broadcast_event/2` with the typed
  `Wire.server_settings_changed/1` payload (single source — the
  REST surface + the after-join push + the per-user-topic
  re-broadcast ALL use this Wire fn).
- Boundary `deps:` extended for `Grappa.PubSub` +
  `Grappa.ServerSettings.Wire` aliases.
- Test shapes flipped from the 2-tuple to
  `%Phoenix.Socket.Broadcast{event: "event", payload: %{kind:
  "server_settings_changed", ...}}` — matches every other
  context's WS-edge fan-out shape.

### The Elixir 1.19 set-theoretic-checker × FunctionClauseError-regression collision

Worth noting because it bit four times mid-implementation.
Tightening the typespec on a Wire fn from `map()` to a typed map
means intentionally-bad-literal tests (the `assert_raise
FunctionClauseError, fn -> Wire.channel_modes_changed("net",
"#c", %{}) end` pattern) now compile-fail under Elixir 1.19's
set-theoretic type checker:

```
warning: incompatible types given to Grappa.Session.Wire.channel_modes_changed/3:
   Grappa.Session.Wire.channel_modes_changed("azzurra", "#grappa", %{})
given types: binary(), binary(), -empty_map()-
but expected one of: dynamic(), dynamic(), dynamic(%{..., modes: term(), params: term()})
```

The compiler is correct — the call IS statically wrong. But the
test is pinning the RUNTIME boundary, which is exactly the
contract that needs to be tested. Workaround: `apply(M, :f,
[args])` defeats the static check (the function arity is opaque
to the type analyzer through `apply/3`). The runtime
`FunctionClauseError` is still the assertion.

Pattern recurred 4 times across REV-H (H3 string-input rejection,
H4 empty-map + bad-set_at rejection, H5 nil-slug rejection,
channel_modes_changed empty-map rejection). If it bites a 3rd
unrelated bucket it earns a `feedback_apply_3_*` memory and a
CLAUDE.md "Testing Standards" addition.

### Deploy classification — first server-side REV bucket auto-HOT

`Grappa.Deploy.Preflight.cli` returned `→ no unsafe markers →
HOT` for REV-H. The preflight's "unsafe markers" list (defstruct
/ @type t / migrations / mix.lock / application.ex / Dockerfile)
didn't fire — REV-H touched function bodies + typespecs +
moduledoc + new tests, none of which are state-shape changes.
`Session.Server` IS in `hot_reload/long_lived_modules.ex` but
the edit was `apply_effects/2` body only.

Validates the preflight's discrimination — REV-H is exactly the
class of server-side change that Phoenix.CodeReloader handles
cleanly. Future Theme A-style typespec tightenings can follow the
same path. (REV-I + REV-K + REV-Z are different — REV-I touches
nginx.conf which needs container restart, REV-K likely touches
cross-surface naming which may shift wire-shape, REV-Z is docs
only.)

---

## 2026-05-22 — REV-I: infra simplification (H19 + H27 + M3 + M6)

Bucket 9 of 11 in the REV cluster. Infra-only; no `lib/*` or
cic-side change. Closes 2 HIGH + 2 MEDIUM. The M-cluster triage:
M2 is SUBSUMED by H19's snippet hoist (same fix); M1 + M5 are
coupled to a single compose-anonymous-volumes refactor (preserve
image-baked `_build`/`deps`/cache through the bind-mount, drop the
180s `start_period` band-aid + the `WORKTREE_VOLUMES` explicit
include-list) and deferred to REV-J; M4 (compose merge-keyword
inconsistency `!override` vs `!reset`) is cosmetic + deferred to
REV-Z polish. The vjt mandate is "most-important MEDs," not "all
50 MEDs."

### H19 — nginx admin allowlist snippet extraction

The bug class: M-9b (2026-05-16) introduced the convention that
every new `/admin/<resource>` requires an nginx allowlist regex
edit. The allowlist lived in **three** places —
`infra/nginx.conf:136` (prod), `cicchetto/e2e/nginx-test.conf:86`
(e2e :80), `cicchetto/e2e/nginx-test.conf:153` (e2e :443). The
review's framing as a duplication issue is correct but understates
the impact: it's also a **discoverability** issue, because the e2e
:80 block subtly differed at points across the cluster history
(`/api` was added to prod first in UX-6-B1, mirror to e2e :80 was
a separate edit later) and the LLM was the only one tracking the
mirror.

Fix: hoist the entire location-block surface (not just the admin
allowlist regex) into `infra/snippets/locations-api.conf` —
`client_max_body_size`, `root`, `index`, the security-headers
include, `/socket` WS proxy with its Upgrade/Connection/access-log-
off shape, REST allowlist, admin allowlist, `/sw.js` cache override
with re-asserted security headers, SPA fallback. Both prod and e2e
configs `include /etc/nginx/snippets/locations-api.conf` from each
server block (1 server block in prod, 2 in e2e — three include
sites, one source file).

The snippet directory is mounted into both nginx containers via
`compose.yaml:163` (`./infra/snippets:/etc/nginx/snippets:ro`) and
`cicchetto/e2e/compose.yaml:299`
(`../../infra/snippets:/etc/nginx/snippets:ro`) — already in place
for `security-headers.conf`, no compose surgery needed. The old
"can't include inside server block" objection in the
`nginx-test.conf` moduledoc was incorrect; nginx absolutely
supports `include` inside `server { }`.

The hoist also covers the `:443` server block in e2e — the TLS
listener gets the same locations as the :80 listener. Same fix as
M2 (which was the per-protocol e2e duplication), shipped under
H19's banner.

### H27 — `in_container` replaces bare `docker exec grappa`

Two two-line swaps. The bare `docker exec grappa …` shape in
`scripts/deploy.sh:144` + `scripts/deploy-cic.sh:48` assumed
`container_name: grappa` literally, escape-hatch from the
`_lib.sh` discipline. Both scripts already sourced `_lib.sh`, so
the swap to `in_container curl …` was mechanical.

`_lib.sh in_container()` (`scripts/_lib.sh:141`) refuses to run
from a worktree (the live container has main's source mounted, not
the worktree's, so exec there would run the wrong code). Both
deploy scripts run from main + `cd $REPO_ROOT` first, so the
guard is appropriate.

### M3 — `bin/grappa` VERBS single-source-of-truth refactor

Pre-M3 `bin/grappa` enumerated verbs across five surfaces: per-verb
function defs, per-verb help function defs, dispatch_help switch,
dispatch switch, help_top heredoc table. The bats suite caught the
dispatch-switch shape (`grep -q 'mix.sh grappa.create_user'`) but
not the help-banner drift — adding a verb to dispatch without
adding to `help_top` would silently leave the verb undiscoverable
to `bin/grappa help` users.

Fix: single `declare -Ag VERBS` map keyed by kebab-case verb name
→ tuple `kind|target|group|description`. Three new generic
dispatchers: `dispatch_boot` (boot verb → mix task), `dispatch_rpc`
(nullary rpc verb → `Grappa.Operator.fn!()`), `dispatch_help`
(reads VERBS to pick boot-via-`mix help` vs bespoke
`verb_help_<snake>`). The `dispatch()` entry point uses a
`declare -F "verb_${snake}"` probe to **prefer** a bespoke handler
when one exists, falling back to the generic dispatcher otherwise.
Adding a future arg-taking RPC verb is ONE VERBS entry + ONE
`verb_<snake>()` function — no dispatch-table edit. Adding a
future nullary RPC verb is ONE VERBS entry (no function needed).

Bash 4 limitation: associative-array iteration order is undefined.
`help_top()` walks an explicit `VERB_DISPLAY_ORDER` array to
generate the help banner in stable order. This is two-source
(VERBS map + display order array) rather than one — the comment
in `help_top()` documents the limitation. No fix without dropping
bash 4 compatibility (the floor per CLAUDE.md "Bash 4+ required").

LOC delta: `bin/grappa` grew from 378 → 438 (+60). The refactor is
structural (single source for kind/target/group/description) not
size-reducing — the per-verb help heredocs + the VERB_DISPLAY_ORDER
array + the GROUP_HEADERS map account for the increase. The brief
said "−95 LOC" — that was optimistic; the reviewer caught it and
this entry corrects the record.

Bats: 24/24 pass (was 23/23 pre-REV-I). New regression test
`reap-visitors --extra → exit 64` catches the symmetric mistake:
arg-taking RPC verb added without a bespoke handler falls through
to `dispatch_rpc` which refuses with a clear "takes no arguments"
error.

### M6 — `+SDio` floor at BEAM's 10-IO default

`bin/start.sh` defaulted `GRAPPA_DIRTY_SCHEDULERS` to `$(nproc)`,
which sets BOTH `+SDcpu` (dirty CPU schedulers) and `+SDio` (dirty
IO schedulers). On a single-core deployment (current Pi 5 is
4-core, but a future container CPU limit could be `1`) the sqlite
WAL pool — which uses dirty-IO schedulers along with file watchers
+ any other dirty-IO workload — would serialize.

Fix: floor the default at BEAM's own 10-IO-scheduler default.
`nproc=1 → default_schedulers=10`; `nproc=20 → default_schedulers=20`.
`GRAPPA_DIRTY_SCHEDULERS` env var still wins if set explicitly,
so an operator who knows their workload can over- or under-ride
both knobs together.

Comment in `bin/start.sh` updated to reflect the new contract
(was "default: $(nproc)", now "default: max(nproc, 10)" with
inline rationale citing M6).

### The deploy-preflight false-HOT recurrence

Operator-side lesson, captured because it bit AGAIN in REV-I and
illustrates the limits of relying on documented memories.

Path: operator merged `rev-i` → `main` locally
(`git merge --ff-only rev-i`), then ran `scripts/deploy.sh` (no
flag). The script's `git pull --ff-only` said "Already up to
date" — `prev_sha == HEAD == 1539292` — so the preflight took the
same-SHA fast path (return 0, classify HOT). The deploy reloaded
the BEAM via `Phoenix.CodeReloader`. **nginx.conf was NOT live**;
the container still served the pre-REV-I config.

Recovery was instant: `scripts/deploy.sh --force-cold` ran the
full COLD cycle (deps.get → ecto.migrate → image rebuild → grappa
+ nginx recreate). Container IDs new; sessions reset; healthcheck
`ok`. The container in turn picked up the new nginx.conf via the
volume mount on the recreated nginx container.

This is exactly `feedback_deploy_preflight_empty_diff_after_merge`
(documented after V9 incident, 2026-05-15). The memory exists; the
LLM forgot. The cleanest fix is at the script level — `deploy.sh`
could detect `same-SHA + recent merge commit` and demand explicit
`--force-hot` to proceed, but the proposed fix surface is wider
than REV-I's scope (operator-workflow change, not infra-simplify).
Carry into REV-J or REV-Z as a script-layer improvement candidate.

What the LLM should have done: **manual preflight FIRST** with
explicit prev-SHA before running `deploy.sh`:
```
scripts/mix.sh run --no-start -e \
  'Grappa.Deploy.Preflight.cli(["399311b", "HEAD"])'
```
This would have returned "Cold-deploy required: nginx,
image_substrate" and made the `--force-cold` necessity obvious.
Captured for the REV-J + REV-K + REV-Z briefings.

### What changes about REV-J

REV-J is **cross-cutting smells** — cross-module (M14 +
`call_session/3` consolidation, M15 + double-broadcast fold),
lifecycle (M7-M11 EXIT catch-all + cancel_and_drain loop +
Reaper-tick monotonic-clock + NetworkCircuit.reset_sync +
session_disconnected gating), persistence (M12 + scrollback fetch
arity discipline, M13 + transition!/3 changeset routing). Plus
the deferred M1 + M5 — the compose-anonymous-volumes + start_period
collapse. Server-only; preflight-detect (likely HOT, M1 + M5 are
docker-shape so will preflight COLD).


---

## 2026-05-22 — REV-J: cross-cutting smells (M7-M15 + M18)

Bucket 10 of 11 in the REV cluster. Lib + test only — server-side
boundaries (lifecycle, persistence, cross-module, web). 9 MEDIUM
closed. M1 + M5 deferred to REV-J.5 (root cause: the
named-volume-init UID trap from `feedback_named_volume_uid_trap`
bit on first attempt; needs Dockerfile chown of the cache dirs to
1000:1000 before COPY layers, then re-attempt). M16 + M17 were
already closed in REV-D; the REV-J brief incorrectly re-listed them.

### Theme — "no convention-as-contract" applied across boundaries

Three sub-themes share one rule: when an invariant only holds
because the next call-site author remembers it, the rule lives at
the wrong layer. REV-J moves five separate invariants from "comment
+ convention" to "structure":

1. **M7 — exhaustive linked-process matching**
   `Session.Server.handle_info({:EXIT, _, :shutdown|:normal})`
   pre-fix caught any non-Client linked process's clean exit and
   propagated as a Session stop. Unreachable in production today
   (Client is the only `init/1`-linked spawn) — but the comment
   was the only defense against a future handler `Process.link/1`'ing
   a Task or sibling. Now raises so any escape from the design rule
   surfaces at the supervisor immediately instead of masquerading
   as planned park. Per CLAUDE.md "Crash boundary alignment."

2. **M8 — drain-all loop over single-shot drain**
   `cancel_and_drain/2`'s `receive ... after 0` single-shot drain
   pre-fix only worked because every call site re-armed the timer
   after canceling. Three slots (`:auto_away_debounce_fire`,
   `:pending_auth_timeout`, `:ghost_timeout`) carried the invariant
   by code-review discipline. New `drain_all/1` recursive shape:
   constant overhead when queue empty, zero correctness obligation
   on call sites.

3. **M12 — drop wrapper arities that default load-bearing params**
   `Scrollback.fetch/5` + `fetch_after/5` auto-passed `nil` for
   `own_nick`. CP14-B3 own-nick-leak fix could silently re-emerge
   through any future controller forgetting the threading. Per
   CLAUDE.md "No default arguments via `\\`" extends naturally:
   wrapper arities that default load-bearing parameters carry the
   same hazard. Callers now state `nil` explicitly — the nil-ness
   becomes a deliberate decision at the call site.

4. **M11 — gate event emission on actual outcome, not boundary return**
   `Operator.disconnect_session` user-branch pre-fix emitted
   `:session_disconnected` whenever `disconnect_user_session`
   returned `:ok`, including the already-`:parked|:failed` no-op
   branch — the admin events ring buffer falsely claimed "the
   operator disconnected this session" when nothing happened. Now
   `disconnect_user_session/3` returns `{:ok, :transitioned | :noop}`
   so the caller routes the emission. Symmetric with the visitor
   branch's `Session.whereis/2` pre-check (which has had this
   discipline since the operator-events cluster).

5. **M13 — narrow changeset over raw write**
   `Networks.transition!/3` pre-fix used `Ecto.Changeset.change/2`
   which skipped every validation including the `safe_line_token`
   guard on `:connection_state_reason`. Defense-in-depth today
   (reasons come from controlled internal sources) but the bypass
   meant a future schema validation would silently NOT fire. New
   `Credential.connection_state_changeset/2` casts only the three
   transition fields, applies `safe_line_token` to reason.
   Consistent shape with `Accounts.User.admin_changeset/2`.

### Theme — single-source-of-truth at the broadcast boundary

**M15** folds the two-event pattern (`connection_state_changed` +
co-emitted `home_network_state_changed`) into one event with a
`:network` field carrying the same `home_network_row` shape
HomePane consumed before. Pre-fix the two events on the same
topic created a temporal window where the first arm reflected the
new state and the second hadn't landed. One logical event, one
wire payload, one broadcast.

The fold required lockstep cic edits — `api.ts` `WireUserEvent`
arm extended with `:network`; `userTopic.ts` narrowing arm
extended; dispatcher arm folds `patchHomeNetwork` + `refetchNetworks`
into the `connection_state_changed` handler. Documentation across
`me_controller.ex` / `me_json.ex` / `wire.ex` updated in step.

### Theme — typed errors at the controller boundary

**M14** — `Session.call_session/3`'s implicit-5s timeout surfaced
as Phoenix 500 with no typed envelope; the sibling `/4` already
had `try/catch :exit, {:timeout, _} -> {:error, :timeout}`. /3
now delegates to /4 with explicit 5_000ms default; FallbackController
gains a `:timeout` arm → `:gateway_timeout` + `session_timeout` +
`retry-after: 10`. Every REST IRC-verb path on one shape per
CLAUDE.md "no silent-swallow at boundaries" + "fix at the
boundary that raised."

### Theme — spec compliance at the wire boundary

**M18** — `UploadsController.disposition_header/1` pre-fix used
`URI.encode_www_form/1` which is form-URL-encoded (space → `+`).
RFC 5987 `ext-value` inside `filename*=UTF-8''...` requires
percent-encoded UTF-8 per RFC 3986 — space MUST be `%20`. Now
`URI.encode/2` with the unreserved-char predicate. Single LOC fix;
spec-compliance regression that browsers exposed differently per
implementation strictness.

### Theme — synchronous variants at the public-API boundary

**M9 + M10** both retire `:sys` / cadence-drift behavior with
explicit public-API verbs:

- `Visitors.Reaper` schedules `:tick` BEFORE running `sweep/0` so
  cadence is interval-fixed under sweep load (the prior shape
  drifted as "interval + sweep_duration").
- `NetworkCircuit.reset_sync/1` is a new synchronous-call sibling
  of the existing `reset/1` cast. `Operator.reset_circuit/2`
  drops its `:sys.get_state/1` drain in favor of the public verb.
  A future Registry / `:persistent_term` / different-process
  refactor of NetworkCircuit no longer silently breaks Operator's
  post-reset snapshot.

### Deploy

Lib-only (no compose / mix.lock / migration / state-shape /
supervision-tree changes), so preflight HOT-classified correctly.
`scripts/deploy.sh` → `==> deploy mode: hot` → modules reloaded in
the live BEAM, sessions preserved, container ID unchanged.
Healthcheck `ok`. Push `57f7cca..e0b8b27`. Bucket-9-style
post-merge-preflight discipline (manual `Grappa.Deploy.Preflight.cli`
with explicit prev-SHA) followed; trap did not bite this time
because lib-only edits classify HOT regardless.

### Why M1+M5 deferred

The compose-anonymous-volumes refactor (overlay `_build`/`deps`/
`.mix`/`.hex`/`.cache`/`.local` so the image-baked compile cache
survives the bind-mount + collapse `WORKTREE_VOLUMES` 10-mount
include list to single `$SRC_ROOT:/app`) is mechanically right but
hit the named-volume root-init trap on first attempt: anonymous
volumes seed from the image as root-owned, container drops to UID
1000, `mkdir -p _build/test/lib/<dep>` denies on first compile.
`feedback_named_volume_uid_trap` is precisely this hazard.
`compose.yaml`'s pre-REV-J comment block explicitly documents why
the prior named-volume approach was abandoned in favor of bind
mounts — the bind mount sidesteps the UID problem by inheriting
host ownership.

Path to fix: Dockerfile chown of `/app/_build` `/app/deps`
`/app/.mix` `/app/.hex` `/app/.cache` `/app/.local` to 1000:1000
BEFORE the COPY layers, so the image already has UID-1000-owned
empty cache dirs that the anonymous-volume init step copies
verbatim. Then re-attempt M1+M5 as REV-J.5 (or fold into REV-K if
the latter has compose-shape changes already). Brief's documented
escape hatch: "ship (1)+(2) as REV-J + (3) as REV-J.5 if reviewer
flags the bundle as too large."


---

## 2026-05-22 — REV-K: cross-surface naming pay-down (M19 + M20)

Bucket 11 of 11 in the REV cluster (codebase-review-fixes,
2026-05-22). Per `project_post_tmu_full_review_scheduled`. CP42 S1
(rotated from CP41 at 447 lines). Both surfaces; COLD-deployed
(server-side wire shape change + cic bundle hash bump).

Closes 2 MEDIUM from
`docs/reviews/codebase/2026-05-22-codebase-review.md` § cross-
surface (S15 + S18).

### M19 — `mentions_bundle.messages[*].sender_nick:` → `sender:`

The mentions bundle's per-message wire shape historically used
`sender_nick:` while sibling `ScrollbackMessage` used `sender:` —
the server moduledoc explicitly flagged this as "deferred to the
next channel-client-polish cluster". REV-K is that cluster.

One-touch rename across:
- `lib/grappa/session/wire.ex` — typespec + project_bundle_message
  builder + moduledoc explaining the rename is paid down (was a
  "consistency or nothing" debt from arch review A8 — kept the
  divergence "small but EXPLICIT in one place" then; the explicit
  pin enabled the one-touch rename later)
- `lib/grappa/push/payload.ex` — doc-comment reference (title
  source = "sender" matches the storage field)
- `test/grappa/session/wire_test.exs` — payload assertions
- `cicchetto/src/lib/api.ts` — `MentionsBundleMessage` type
- `cicchetto/src/lib/userTopic.ts` — `narrowMentionsBundleMessage`
- `cicchetto/src/MentionsWindow.tsx` — render path
- 4 cic test files

Note: `Message.sender_nick/1` (the IRC parser helper for extracting
nick from prefix) is intentionally UNCHANGED. Different concern —
the parser helper is the source-of-nick from an IRC wire prefix;
the wire field is the projection into the mentions bundle. Same
NAME, different DOMAIN.

### M20 — WS Channel error envelope `%{reason: "<token>"}` → `%{error: "<token>"}`

REST `FallbackController` error envelope: `%{error: "<token>"}` —
the canonical A7 envelope shape used by every Phoenix-route error
path. WS Channel `handle_in` reply envelope: `%{reason: "<token>"}`
— same conceptual content (a tokenized error reason cic can
branch on) under a different key. cic's push helpers could not
branch on the WS error token because the receive callback received
an opaque `unknown` that stringified to `[object Object]`.

Unified on `error:` key in both surfaces. Across:
- `lib/grappa_web/channels/grappa_channel.ex` — all 36 error
  replies in handle_in dispatch arms + join/3 + with_body_check
- `lib/grappa_web/channels/admin_channel.ex` — join/3 forbidden +
  unknown-topic
- 33 channel test assertions across grappa_channel_test +
  admin_channel_test + user_socket_test

Cic-side adds typed `ChannelPushError` + `channelPushError/1`
extractor (`cicchetto/src/lib/api.ts:929-983`) mirroring
`ApiError`'s shape. Push helpers (pushAwaySet, pushAwayUnset,
pushWatchlist{Add,Del,List}) now reject with the typed error
carrying the wire `code` so callers can branch the same way they
do for REST `ApiError.code`. Per `feedback_no_silent_drops_closed`:
pushWatchlist's prior `reject(err)` of bare unknown was effectively
a silent-swallow at the cic boundary — the caller's `.catch` got
an opaque object with no surface to branch on. Typed error class
closes that gap.

The typed-class shape ENABLES future branching at consumers; the
current single consumer (`compose.ts:601`) still falls through to
a generic "send failed" string. Docstring softened post-reviewer
LOW-2 to honestly frame this as "FUTURE consumer pattern" so
future readers don't grep for branching that doesn't exist yet.
Wiring `compose.ts` to branch on `ChannelPushError.code` lands
independently (REV-Z or polish bucket).

### Reviewer round

Round-1: APPROVE clean with 3 LOW observations.
- LOW-1: `ChannelPushError` lacked direct unit test (transitive
  coverage in `socket.test.ts:210` would have passed even if
  extractor returned `new Error("anything")` — defeating the typed
  class purpose). Addressed in REV-K round-2: 5 focused unit
  tests in `api.test.ts` covering well-formed, sibling fields,
  object missing `error`, non-object payloads, subclass identity.
- LOW-2: Docstring claim "callers can branch on code" outpaced
  consumer reality. Addressed in round-2: softened to "FUTURE
  consumer pattern" + explicit note that current consumers fall
  through.
- LOW-3: `info` field duplicates `error` key in extractor return.
  Deferred as cosmetic (`info` IS the full server reply by
  design; the duplication is the "info captures everything" model).

Round-2: APPROVE — mutate-tested all 5 new tests, all real
assertions. REV-K ready to merge.

### Deploy — COLD (--force-cold)

Preflight `Grappa.Deploy.Preflight.cli(["e412c17", "HEAD"])`
classified HOT (no mix.lock / struct / supervision / Dockerfile /
compose / migration / nginx changes). However the BUSINESS rule
"wire-shape change to live connected cic sockets is risky"
applies: server hot-reload would emit the NEW shape (`sender:` +
`%{error:}`) while connected browser tabs run the OLD bundle
(narrowers expect `sender_nick:` + `%{reason:}`) until the cic
refresh banner is clicked. Conservative bias per the
`feedback_hot_deploy_preflight` discipline ("in doubt, COLD"):
forced cold via `scripts/deploy.sh --force-cold`. Sessions reset,
new image baked, container ID rotated.

`scripts/deploy-cic.sh` after: cic bundle rebuilt and hash
`34TrT3jr` broadcast to all live user-topics — refresh banner
auto-prompts on any tab that survived the reconnect with the
old bundle.

Healthcheck `ok`. Push `e412c17..8070551`.

### Carry-forwards into REV-Z

- **REV-J.5 still deferred** — Dockerfile UID prep prerequisite for
  M1+M5 anonymous-volumes refactor not bundled in REV-K (REV-K
  touched lib + cic only; no compose-shape changes). Standalone
  bucket REV-J.5 between REV-K and REV-Z if bandwidth permits, else
  carry forward to a future infra-polish cluster.
- **LOW-3 cosmetic** — `info` field duplicates `error` key. Polish
  opportunity for REV-Z or future.
- **compose.ts ChannelPushError branching consumer** — wire
  `compose.ts:601` to handle the typed class symmetrically with
  `ApiError`. Bucket-sized; REV-Z or polish.


---

## 2026-05-22 — REV-Z: REV cluster CLOSED — docs sweep + LOW liquidation

Final REV bucket (12 of 12) closing the post-2026-05-22-codebase-review
sprint. Docs-only by mandate. No deploy.

### Cluster summary

11 fix buckets (A → K) + 1 docs bucket (Z) shipped autopilot from
2026-05-22 morning through 2026-05-22 evening. The 2026-05-22 full
codebase review (8 parallel review agents) catalogued 4 CRIT + 29
HIGH + 20 gating MED + 27 LOW. Per `project_post_tmu_full_review_scheduled`
the wave fixed all CRIT + all HIGH + all gating MED; LOWs were
opportunistic.

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

### Meta-lessons from the cluster

1. **Per-bucket reviewer-loop earned its keep.** REV-G round-1 caught
   an incomplete-fix in the bug-fix itself (SolidJS function-ref
   gotcha); REV-K round-1 caught LOW-1 (`ChannelPushError` lacked
   direct unit test) + LOW-2 (docstring outpaced consumer reality).
   The reviewer-loop is friction worth paying every time.

2. **Wire-shape changes desync server emit from live cic narrower.**
   REV-K precedent: even when preflight classifies HOT, wire-shape
   changes that desync server emit from live cic narrower expectations
   should force COLD per `feedback_hot_deploy_preflight` conservative
   bias. Adds to the "in doubt, COLD" discipline.

3. **Hand-edits + lockstep cross-surface bumps are not the right
   long-term shape.** A third of HIGHs + both REV-K MEDs were
   shape-drift between server typespecs and cic types. The
   structural answer — emerged organically from the review wave —
   is `wireTypes.ts` codegen from server-side `Grappa.*.Wire`
   typespecs. Slotted as second post-REV cluster behind flakes-
   triage per `project_post_review_ordering_2026_05_22`. REV-A/H/K
   hand-edits become the SOURCE the codegen consumes; not wasted.

4. **Substrate fragility is the second-biggest emergent risk.** REV-C
   (preflight regex + healthcheck depth + `signing_salt` rotation)
   closed C4 + H20 + H21 + H26 — all neighbours in the substrate
   space. The CP28 incident-class fix landed here; preflight now
   has an AST oracle (`scripts/_extract_state_block.awk`) catching
   field-addition-inside-existing-block changes that the line-anchor
   regex missed.

5. **Silent-swallow class continues to be load-bearing.** REV-D closed
   five distinct silent-swallow boundaries (H12-H16 + M16-M17),
   each one a separate way for a failure to disappear before the
   operator (or CI) could see it. REV-K extended the pattern across
   the cic boundary via the typed `ChannelPushError` class —
   pushWatchlist's prior `reject(err)` of bare unknown was
   effectively a silent-swallow on the cic side.

### REV-Z scope (this bucket)

- **README closed-clusters entry** — REV cluster A→K + Z added to
  `## Closed clusters (recent)` per `feedback_readme_currency`.
- **DESIGN_NOTES sweep** — REV-G header normalised to the
  `## YYYY-MM-DD — TITLE` convention (was `## REV-G (DATE) — TITLE`).
  REV-A + REV-B chronological entries are NOT backfilled — kept as
  cluster-summary-only here at the close, since the cluster summary
  cites them with commit SHAs anyway. (Future REV reviewers can
  follow the cluster summary → commit → review-finding chain.)
- **CP43 opens** to host REV-Z + the flakes-cluster handoff brief.
  CP42 closed at 225 lines.
- **MEMORY.md compression** — over warn-threshold; index entries
  compressed/merged to one-line < 200 chars per entry.
- **LOW liquidation that fits** — chose the lowest-friction subset
  from the 27-item set: REV-K reviewer LOW-3 cosmetic dedup
  (`info` field duplicates `error` key in ChannelPushError
  extractor) DEFERRED — cosmetic only, no consumer impact.
  compose.ts:601 ChannelPushError branching consumer DEFERRED —
  REV-K's reviewer-fix patch softened the docstring already
  documenting that current consumers fall through.

### Carry-forwards

- **REV-J.5 (M1+M5)** — Dockerfile UID prep prerequisite for
  anonymous-volumes refactor. Standalone bucket between flakes
  cluster and codegen cluster if bandwidth permits, else future
  infra-polish cluster.
- **Compose.ts:601 ChannelPushError branching consumer** — wire to
  handle the typed class symmetrically with `ApiError`. Bucket-
  sized polish.
- **REV-K LOW-3 cosmetic** — `info` field duplicates `error` key in
  ChannelPushError extractor. Trivial dedup; not blocking anything.
- **REV-C carry-forward** — `_build/prod` cleanup procedure still
  undocumented in operator runbook (REV-D + REV-E + REV-F were
  HOT so it didn't recur; not closed in REV-Z). Future
  infra-polish target.
- **27-item LOW set** — mostly remains opportunistic for adjacent
  touches. Notable themes: dead-code clauses in
  `Identifier.services_sender?`, empty-reason `send_away/2`
  accepting `AWAY :\r\n`, `Push.subscription.id` as `string` vs
  branded UUID type, `linkify` regex `\S+` unbounded, image-upload
  bypass of `token()` signal, `bin/start.sh` env-fiddling vs
  trusting BEAM defaults, `register-dns.sh` placement.

### Post-REV ordering (vjt mandate, repeated for completeness)

Per `project_post_review_ordering_2026_05_22` — after REV-Z:
1. E2e flake triage + fix (45 baseline-fail testnet specs +
   AdmissionTest ETS-leak class + AdminEventsTest:197 class).
2. wireTypes.ts codegen.
3. Bastille deploy workstream (GitHub #8).

REV cluster: **CLOSED**.

---

## 2026-05-22 — FLAKE-A: e2e baseline triage manifest

First bucket of the FLAKES cluster (post-REV per vjt mandate
`project_post_review_ordering_2026_05_22`). Docs-only; no code.

Manifest at `docs/reviews/flake-triage-2026-05-22.md`.

Headline finding: brief said "45 e2e + 2 server-side classes";
re-baseline against current HEAD `bf3ba3a` measures **41 e2e + 0
server-side**. The two server-side classes (`Grappa.AdmissionTest`
ETS-singleton-leak + `AdminEventsTest:197` `assert_receive` race)
were closed earlier:

- ETS-singleton-leak — commit `7bb3caa` 2026-05-17, root cause was
  `IRC.Client.handle_call({:send, _})` raising on dead socket and
  blocking `Session.Server.terminate/2`'s narrow exit-catch (the
  `:tcp_closed` recv-loop nilling the socket pre-SEND). Boundary
  fix returns `{:error, :no_socket | :closed}` honestly. Per
  memory `project_network_circuit_ets_leak`.
- `AdminEventsTest:197` `assert_receive` race — folded into REV-D
  silent-swallow audit + U-cluster live-cap-counters work. No
  longer surfaces on current HEAD.

`scripts/test.sh` against `bf3ba3a` returns `8 doctests, 33
properties, 2424 tests, 0 failures` in 55.9s. Server-side baseline
= clean. Cluster scope shrinks to e2e only.

### e2e shape (41 fails, 33 distinct files)

Duration histogram is the diagnostic:

```
27 × 31.x s   → Playwright 30s test-timeout (Class C — load)
 9 × 5-6s     → assertion-fail @ default 5s/6s timeout (Class A)
 3 × <1s      → locator-not-found instant fail (Class A)
 2 × 10-11s   → bumped-timeout assertion fail (Class A/B)
```

27/41 (≈66%) cluster at 31s. These share the bahamut state-
corruption shape documented since 2026-05-15 in
`project_bahamut_load_flake` — `loginAs → selectChannel → IRC
interaction → assert on DOM`. After ~40-50 specs of sustained
sequential JOIN/PART/KICK traffic, bahamut accumulates orphan
state and new JOINs against fresh channel names don't get clean
handshakes. **One root cause, one fix bucket (FLAKE-B).**

The remaining 14 are real-shape Class A / Class B candidates with
proper concentrations: 3 in `ux-5-bc2-nick-render` (single
NickText cluster), 2 in `i2-image-upload` (privacy modal flow),
2 in `cp13-server-window` (server-window cluster), 2 in `ux-6-d-
keyboard-pattern`-area (iOS PWA kb carry-debt per
`feedback_ux_6_d_anti_patterns`), 5 singletons.

### Bucket plan

- **FLAKE-B** — testnet load isolation. Hypothesis 1 (docker
  compose restart between specs / N-spec windows via Playwright
  `globalSetup`) + Hypothesis 2 (per-spec channel-name
  uniquification — most specs use `AUTOJOIN_CHANNELS[0]`).
  Likely both, defense in depth. Target: 27 → 0 on two
  consecutive `scripts/integration.sh` runs.
- **FLAKE-C** — Class A NickText cluster (3 specs).
- **FLAKE-D** — Class A image-upload modal (2 specs).
- **FLAKE-E** — Class A server-window cluster (2 specs).
- **FLAKE-F** — Class A iOS-PWA kb cluster (3 specs).
- **FLAKE-G** — Class A/B singletons (5 specs).
- **FLAKE-Z** — closer; reconciliation; remaining quarantines
  with inline justification per `feedback_recurring_e2e_not_flake`.

### Hard rules carried from REV cluster

- No `gh run rerun --failed` (`feedback_no_ci_retries_on_first_failure`).
- No silent-swallow (`feedback_no_silent_drops_closed`); quarantines
  via `test.skip` + tracking memory acceptable, silent timeout-bumps
  not.
- Per-bucket reviewer-loop + LANDED gate-tail paste for code-
  touching buckets only; FLAKE-A + FLAKE-Z docs-only.

FLAKE-A: **LANDED**. Pushed to origin/main on commit alongside
manifest + CP43 update + this entry.


---

## 2026-05-22 — FLAKE-B Part 1: desktop fixture rot for `selectChannel(_, _, "Server")`

**Closes:** 6+ spec-rot cases (b0, b2, p0e, cp22-bnames, m2,
ux-2-mobile-archive + downstream cp13-server-window S8/S9 and
cp15-b6-pending-to-failed which share `SERVER_WINDOW_LABEL`).

**Does NOT close:** "Class C" testnet load class (FLAKE-A's manifest
mis-classified — see Part 2 below).

### Background

FLAKE-A's manifest listed 27 e2e specs at 31s timeout, all classified
as "Class C bahamut load class". Hypothesis-phase sampled 6 specs in
isolation (all passed) and inducted the rest were load class too.
The induction was wrong: the SPECIFIC 6 sampled (push-install et al.)
happen NOT to use `selectChannel(_, _, "Server")`. When other
"Class C" specs were tested in isolation, several failed alone too —
the failure was NOT load-class but fixture rot.

### Root cause

Post-UX-4-C the cic desktop sidebar collapses the per-network `<h3>` +
standalone Server tab into a single `<li class="sidebar-network-header">`
row whose visible text is `⚙️ <slug>` — never the literal word
"Server". The mobile fixture branch
(`cicchetto/e2e/fixtures/cicchettoPage.ts:167-171`) was updated for
this contract; the desktop branch (line 192) kept the pre-UX-4-C
fall-through `section.locator("li", { hasText: "Server" })` which
times out at 30s waiting for a row that doesn't exist.

### Fix

`cicchetto/e2e/fixtures/cicchettoPage.ts:190-204` (commit `c804208`).
Same callsite shape as the mobile branch:

```ts
if (windowName === "Server") {
  return section.locator("li.sidebar-network-header");
}
return section.locator("li", { hasText: windowName });
```

12-line addition; e2e-fixture-only (no `lib/` touched, no cic source
touched, no deploy needed).

### Failed hypotheses (do not retry)

1. **Per-spec session-bounce isolation** (`PATCH /networks/:slug park
   → connect` between specs via a `bounceVjtSession()` helper +
   `test.beforeAll` hook). Implemented, reverted on evidence:
   bounce HOOK succeeded but test BODY still stalled; late-suite
   specs cascaded to 0ms (the bounce helper itself broke under
   accumulated load); non-bounced cp15-b6-pending-to-failed ALSO
   failed (14.4s). The u-z-cluster-journey afterEach log line
   `vjt did not re-join #bofh on bahamut-test within 30s; next
   spec may flake on autojoin assumption` proves autojoin
   restoration ITSELF takes >30s at suite scale, exactly what the
   bounce relies on.
2. **Per-spec channel-name uniquification** — never implemented;
   would only have addressed at most 14 of 26 putative Class C
   specs.
3. **Autojoin-restore latency as primary root cause** — vjt mandate
   "find out why join takes 30s do not work around it" investigated:
   `Session.Server` autojoin loop is `Enum.reduce` over
   `state.autojoin` calling `IRC.Client.send_join` (fire-and-forget).
   The 30s is the gap between SEND and bahamut's JOIN/353/366 echo.
   `IRC.Client.do_connect/3` has `@connect_timeout_ms 30_000`;
   testnet has `THROTTLE_ENABLE` disabled
   (`cicchetto/e2e/infra/bahamut/options.h_hub:47-55`). No single
   mechanism explains the 30s universally — evidence pivoted to
   per-spec rot for the early specs.

### Evidence

- Pre-fix baseline (run `26299521755`): 41 e2e fails.
- Post-fix Run #1: 37 fails (−4 net).
- Post-fix Run #2: 48 fails (+11; 12 specs flipped pass→fail run-to-run).
- Suite-level flake (±10 specs per run) dwarfs the fix impact (±4).

**LANDED-with-two-green-runs DELIBERATELY NOT CLAIMED** per
`feedback_landed_claim_evidence` + `feedback_recurring_e2e_not_flake`:
fix is verified-correct in isolation (each unblocked spec <2s
post-fix, was 30.6s pre-fix) but broader suite too flaky to call
two green runs.

FLAKE-B Part 1: **LANDED on commit `c804208`**. Pushed to origin/main
alongside CP43 S2 update + this entry. No deploy (e2e-fixture-only).


---

## 2026-05-22 — FLAKE-B Part 2: per-spec true-isolation triage

**Documents the truth that FLAKE-A's classifications were FALSE
INDUCTIONS.** No code shipped this entry — pure triage that re-baselines
the manifest at `docs/reviews/flake-triage-2026-05-22.md`.

### Methodology

Two-pass approach to validate each of the 38 distinct failing spec
files post-FLAKE-B-Part-1:

1. **Pass 1 (batched)**: 38 files × 2 runs each, stack-reset
   between BATCHES of 5 files. Caught the obvious "always-fails-
   alone" cases but mis-classified m4/m5/m6/marker-target-window/
   message-replay as "REAL BUG?" — these contaminated by prior-
   spec state within their batch.

2. **Pass 2 (true isolation)**: All 11 Pass-1 "REAL BUG?" candidates
   re-validated with PER-SPEC stack cycle (`scripts/testnet.sh down
   && up` before EACH single spec). Authoritative result.

### Results

- **27 files** → PASS in true isolation = **SPEC-ROT (load class)**.
  Upstream isolation failure (NOT per-spec). Includes m4/m5/m6,
  marker-target-window, message-replay (reclassified from Pass 1),
  AND FLAKE-A's "Class A NickText cluster" (ux-5-bc2-nick-render
  × 3) AND "Class A iOS-PWA kb cluster" (ux-6-d × 2 +
  ux-5-bv-mobile-keyboard-react) which all pass cleanly when run
  alone. Same with `ux-z-cluster-journey`, `scroll-on-window-switch`,
  the push-* family, p0a/p0b/p0c, r6, refresh-on-join, cp14-b1/b2,
  cic-members-panel-scope, cp15-b6-pending-to-failed,
  m10-admin-networks-cap-editor (slow 38s but green),
  ux-2-mobile-archive.

- **7 files** → FAIL in true isolation = **REAL BUG candidates**
  needing per-spec evaluation:
  - `i2-image-upload` (vjt note: uploads WORK IN PROD → spec wrong)
  - `m9-cicchetto-part-x-click`
  - `members-prefix-regression`
  - `names-ux-n3-cold-load-auto-select`
  - `nick-case-sensitivity`
  - `p0d-lusers`
  - `p0e-invite-ack`

- **4 files** → mixed Pass-1 results (FLAKE class); not yet
  re-validated in Pass 2:
  - `cp14-b3-dm-history-bidirectional`
  - `ios-z-cluster-journey`
  - `m9b-admin-sessions-actions`
  - `ux-6-k-pm-unread-cursor`

### Lessons

1. **Batched isolation is unreliable.** `scripts/testnet.sh down +
   up` between batches does NOT fully reset state between spec
   runs on the same stack instance — grappa state (vjt's
   `Session.Server`, bahamut leaf state) leaks across `docker
   compose run` invocations against the same playwright-runner
   container. **Per-spec full stack cycle is the ONLY reliable
   isolation primitive.**

2. **Sampling-based inductions are dangerous.** FLAKE-A took 6
   passing specs as evidence for "all 27 are load class". The
   specific 6 were not representative (they all happened to be
   load-class clean). Per-spec validation is required for any
   classification claim.

3. **Most "real-product-bug" classifications in FLAKE-A were
   wrong.** The UX-4/5/6/7 sweeps moved enough DOM that specs
   assert on stale selectors. The bugs are spec rot in nearly
   every case — not regression.

### Next-session work (per vjt mandate)

"finish this round, we clear and we evaluate each one":

1. `/clear` + open per-spec triage on the 7 REAL BUG candidates
   with vjt collaboratively. Most likely outcome: most are SPEC
   ROT (stale selectors), fix by updating specs.
2. Re-classify the 4 FLAKE files in true isolation.
3. Design upstream isolation mechanism for the 27 SPEC-ROT (load
   class) files — NOT session-bounce per Part 1 evidence.

No code change in Part 2 — manifest update only. No deploy needed.


---

## 2026-05-23 — FLAKE-C + FLAKE-D: per-spec triage close

Pair of buckets that closes the FLAKES cluster opened at FLAKE-A
(2026-05-22). FLAKE-C tackled the 7 "REAL BUG?" candidates from
FLAKE-B Part 2; FLAKE-D tackled the 4 Pass-1-mixed FLAKE files.

### FLAKE-C (2026-05-23) — 7-for-7 SPEC ROT

Every "REAL BUG candidate" turned out to be spec rot driven by
UX-cluster refactor sweeps or M-cluster seed expansion. Zero real
product bugs surfaced. Commit map:

| # | Bucket | Commit | Root cause |
|---|--------|--------|------------|
| 1 | i2-image-upload | `2132bea` | UX-6-B2 flipped default upload host litterbox→embedded; spec stubbed wrong endpoint. Split into embedded + litterbox-with-admin-pin specs. |
| 2 | members-prefix-regression | `5562ae7` | M-cluster seed expansion (3 autojoined users); vjt-grappa no longer wins +o race. Asserted on any op tier instead. |
| 3 | p0d-lusers | `632148f` | UX-4-C "Server" selector — `.sidebar-channel-name "Server"` regex never matches post-refactor; routed through `sidebarWindow()` fixture. |
| 4 | p0e-invite-ack | `b05c88e` | Cascade from #2: vjt non-op on #bofh, Bahamut silently drops INVITE from non-op. Joined fresh `#p0e-invite-test` channel first (vjt = first joiner = +o). |
| 5 | m9-cicchetto-part-x-click | `1d17010` | UX-4-B/E empty-state assertion obsolete — cold-load lands on home, close-window redirects via MRU→server→home. Dropped the assertion. |
| 6 | names-ux-n3-cold-load-auto-select | `214fce6` | UX-4-B explicitly REPLACED N-3's first-joined auto-select with home cold-load. **Spec obsolete by design — deleted.** |
| 7 | nick-case-sensitivity | `0a9b7cd` | UX-5 BH dropped `.sidebar` wrapper class for `.shell-sidebar`. Pure selector drift. |

### FLAKE-D (2026-05-23) — 2 real races, 2 batched-only false-positives

The 4 mixed-Pass-1 files split cleanly under true isolation:

| Bucket | Verdict | Commit |
|--------|---------|--------|
| `cp14-b3-dm-history-bidirectional` | **Real race** (peer.privmsg arrives before cic's own-nick DM-listener subscribe → silent fan-out drop) | `64d6e0b` |
| `ios-z-cluster-journey` | Batched-isolation false-positive — 3-for-3 green iso | none |
| `m9b-admin-sessions-actions` | Batched-isolation false-positive — 4-for-4 green iso (destructive specs in other files corrupt ordering, file itself is sound) | none |
| `ux-6-k-pm-unread-cursor` | **Same race as cp14-b3** — peer-driven inbound DM | `0efa550` |

The 2 real-race specs shared the same root cause UX-6-L had already
diagnosed + fixed via the `__cic_dmListenerReady` test seam (set in
`subscribe.ts:742` from the DM-listener `phx.join()` `onJoinOk`
callback). Both predated the seam. Factored UX-6-L's inline
`waitForFunction` into a shared `waitForDmListenerReady(page, slug)`
helper in `cicchetto/e2e/fixtures/cicchettoPage.ts`; all three
peer-driven DM specs (UX-6-L + CP14-B3 + UX-6-K) now use it.

### Cluster-level verdict

- **0 product bugs surfaced.** All 11 candidates across FLAKE-C+D
  were spec rot (UX-cluster refactor drift, M-cluster seed expansion,
  selector renames) or batched-isolation false-positives.
- **FLAKE-A's manifest was 0-for-11 on real-bug calls.** Sampling
  induction killed it — the 6 sample passes were not representative.
- **Batched isolation = noise floor.** The 27 "load class" SPEC-ROT
  files (FLAKE-B Part 2) + the 2 batched-false-positives here all
  pass cleanly in per-spec full-stack cycle. The remaining suite-
  level flake is upstream isolation, not per-spec bugs.

### Open carry-forward

The 27 "SPEC-ROT (load class)" files from FLAKE-B Part 2 are
quarantined behind suite-level isolation noise — not bucketed for
fix in FLAKE-Z. The next iteration on this surface would be the
"upstream isolation mechanism" called out at the end of Part 2 — a
per-spec stack cycle inside `scripts/integration.sh` (slow, costly,
but the only reliable signal). Deferred until the suite-level pain
returns.

No deploy needed across FLAKE-C+D (pure e2e-only). FLAKES cluster
CLOSED on commit `0efa550`.


---

## 2026-05-23 — GREEN-CI: vjt overrides FLAKES "load class" defer

vjt mandate (mid-day, post-FLAKES-Z): *"is fucking ci green?"* → red
on 30 specs (CI run `26332299699`). *"do we need clear first?"* →
yes. *"i dont fucking care about the name. i want fucking ci green
and testing actual functionality."*

Critical reading: "test ACTUAL functionality" overrides
FLAKE-B-Part-2's "load class quarantine — deferred." `@skip` tags are
disallowed; specs must be deterministic AND exercise the real
contract. The orchestrate prompt enumerated 3 named specs but local
diagnosis surfaced a single root cause for 26 of 30 cascade failures.

### SPEC-1 (`AdminEventsTest:197`, `ee20035`) — SessionRegistry stale-entry race

`Grappa.AdminEventsTest`'s `setup` registers fake `{:session, _, _}`
keys under the test pid via `Registry.register/3`; the on_exit hook
calls `Registry.unregister/2` from a fresh pid (the test pid is
already dead by then), which is a **no-op** — Registry only
unregisters entries owned by the CALLING pid. Cleanup falls back to
Registry's monitor-DOWN of the dead test pid, which is asynchronous.

Sandbox rolls back the `networks` table between tests, so the next
test's freshly-inserted `%Network{}` gets the same auto-incremented
`id = 1`. Prior-test stale Registry entries on `network_id = 1`
inflate `Admission.live_counts_for_network/1` → the
`:cap_counts_changed` broadcast surfaces `visitors: 2` instead of
the expected `visitors: 1` after the `:terminated` lifecycle event
on a single live visitor.

Fix: drain `{:session, _, _}` entries at setup time via a bounded
poll (50× 10ms = 500ms ceiling, then `flunk/1` with the leftover
entries so a true hang surfaces clearly). Each test self-defends
against whatever sibling-test debris hasn't yet been cleared — also
covers the `Task.start_link` + `Process.exit/2` async-cleanup race
in `LiveIntrospectionTest`.

### SPEC-2 (`cic-members-panel-scope.spec.ts:107`, `31c7295`) — sub-test asserts unreachable state

The 4th sub-test ("parked channel suppresses MembersPane") was
written 2026-05-08 BEFORE UX-4 bucket E added the close-watcher
auto-redirect on `channels_changed`. Post-bucket-E: after REST PART,
the server's eager `cleanup_local` evicts the channel from
`state.members` synchronously + broadcasts `channels_changed`; cic
refetches, cbs loses the parted channel, close-watcher fires +
selection moves to MRU (the prior `#bofh` selection, which IS joined
→ MembersPane mounts on the new focus). Net: the operator cannot
be focused on a parked channel as an active selection.

The non-joined suppression contract is already covered by
cp15-b6-pending-to-failed-invite-only + cp15-b6-kicked (failed +
kicked states). The other 3 sub-tests in this file cover
non-channel kinds (Server window, DM). The parked sub-test
asserted a state cic intentionally prevents — deleted, not
quarantined.

### SPEC-3 (`m10-admin-networks-cap-editor.spec.ts:61`, `31c7295`) — two layers of rot

1. **U-1 testid drift.** U-1 (`84388a7`) split
   `max_concurrent_sessions` → visitor + user. Rendered testid
   moved from `admin-network-max-sessions-${slug}` to
   `admin-network-max-visitor-sessions-${slug}` (+ a `user`
   sibling), but this spec wasn't updated. `inputValue` waited 30s
   for a non-existent testid then timed out — and the 30s burn was
   the **head of the cascade timing window** (all subsequent
   serial-singleton-lane specs got their slot pushed back by 30s
   and ran into a state where m9b-victim had been parked but vjt's
   session was also gone). Renamed testid to the visitor cap (the
   historic single-cap successor per the U-1 migration note).
2. **NULL starting cap unhandled.** The e2e seeder binds
   bahamut-test via `mix grappa.bind_network` (no cap params), so
   the row started with `max_concurrent_visitor_sessions = NULL`
   (renders as "unlimited" / empty input). The `+1` sentinel
   became `NaN+1 = NaN` → `fill("NaN")` rejected on
   `<input type=number>`. Handle the empty case explicitly: when
   `current === ""`, use sentinel `"42"`; otherwise increment.
   Revert at end already round-trips back to whichever value was
   first read.

### SPEC-4 (cascade root cause, `2502d81`) — `.first()` lottery

The big one. `m9b-admin-sessions-actions` + `u5-admin-networks-
live-counts` both used
`[data-testid^='admin-session-{disconnect,terminate}-'].first()` to
pick a target. **Registry insertion order is non-deterministic;
"first" randomly resolved to vjt's session ~50% of runs.** After
vjt's session was Disconnected (parked credential, Bootstrap pid
stops) or Terminated (pid killed), every downstream spec that
logged in as vjt found an empty channels sidebar — `selectChannel`
waiting for `.sidebar-window-btn` inside `<li hasText="#bofh">`
timed out at 30s because the `#bofh` `<li>` no longer existed.

26 of 30 cascade failures in CI run `26335369551` shared this
exact locator. All p0a/b/c/d/e WHOIS / WHOWAS / LUSERS / INVITE
specs, push-trigger-*, scroll-on-window-switch,
marker-target-window, members-prefix, message-replay,
nick-case-sensitivity, refresh-on-join, r6-own-action — every cic
spec downstream of m9b. Same root cause, single class.

Fix shape:
  1. Seed a dedicated sacrificial user `m9b-victim` (bound to
     bahamut-test like vjt + m9b-test). globalSetup logs in as
     victim, captures UUID + token in env vars.
  2. **Bump bahamut-test `max_concurrent_user_sessions` to 10**
     (default 3 = exactly the seeded-user count after adding
     m9b-victim → reconnect PATCH hit `503 network_busy` until
     the parked registry slot released). Headroom for the
     reconnect-then-kill dance.
  3. Each destructive spec begins with a `/networks` PATCH (as
     the victim, using its captured token) to reconnect —
     idempotent if already `:connected` — guaranteeing a live
     row before firing the destructive verb. After: vjt + m9b-test
     stay alive for every downstream spec.
  4. `getSeededM9bVictim()` returns the composite session id
     (`user:UUID:1`) the `AdminSessionsTab` testids carry, so
     specs call `getByTestId('admin-session-terminate-{id}')`
     without re-deriving the shape.
  5. m9b "lists rows" assertion bumped from 2 → 3 (vjt + m9b-test
     + m9b-victim).

Local verification: 6-spec composite run
(m9b + u5 + marker-target + members-prefix + nick-case + p0a)
— 10 passed in 15.9s. Pre-fix the same composite failed ~6/10 at
30s timeouts.

### Cluster-level verdict

- **0 product bugs** across 4 buckets. All 4 were
  test-infrastructure rot: setup-time race (SPEC-1), unreachable-
  state assertion (SPEC-2), U-1 testid drift (SPEC-3), `.first()`
  lottery on non-deterministic Registry order (SPEC-4).
- **The "load class noise" framing from FLAKE-B Part 2 was wrong
  for 26 of 27 cascade specs.** Single root cause (SPEC-4 `.first()`
  lottery), single fix. Per-spec full-stack iso WOULD have masked
  it (each spec passes alone because `.first()` deterministically
  picks the only available row). Only the cross-file ordering
  exposed the lottery + cascade.
- **vjt's "test ACTUAL functionality" overrode the defer correctly.**
  The deferred "upstream isolation mechanism" was the wrong remedy
  for the wrong diagnosis — load was the symptom, `.first()` was
  the cause.

### Open carry-forward

- 4 newly-flaky specs in `26335369551` (b0-invite, ux-5-bc2:138/210,
  ux-5-bv-mobile-keyboard) are transient — distinct from the
  cascade class. To be verified in the post-fix CI run.
- The 27 "SPEC-ROT (load class)" files quarantine should be
  re-evaluated after the SPEC-4 fix: most likely ALL of them
  unbreak (cascade root was upstream of their failure window).
  Don't pre-emptively un-quarantine; let the next CI run reveal
  the actual remaining noise floor.

No deploy needed (e2e-only + sandbox-test-only). CI confirms cascade
cleared on `2502d81`: integration run `26336482344` went from
**154 passed / 30 failed (15.6m)** pre-fix to **177 passed / 7 failed
(5.3m)**. 23 specs unlocked by SPEC-4 alone. The 7 remaining failures
have NO shared locator signature — distinct individual flakes, not
cascade. iOS/webkit class (4 of 7) is platform-specific carry-forward.

## 2026-05-23 — GREEN-CI cluster batch 2 close (chromium-3 + webkit-iphone + admin-events)

Same-day continuation. vjt's "FUCKING FIX THE FUCKING CI" mandate
extended past batch 1. 7 residual failures + 1 latent CI flake
addressed in 3 commits.

### Batch 2 buckets

**chromium-3 (`45e69b3`)** — 3-way op-race latent flakes (post m9b-victim).
m9b-victim raised #bofh autojoin race for Bahamut +o from 2 → 3
candidates (vjt + m9b-test + m9b-victim), breaking 3 specs that
assumed vjt's op-status was deterministic:

- `b0-invite-from-server-window:30` — same shape as FLAKE-C bucket 4
  (`p0e-invite-ack`). Bahamut silently drops INVITE from non-op
  inviter → no 341 ack → no invite-ack row. Switched to dedicated
  `#b0-invite-test` channel where vjt joins FIRST → +o.
- `members-prefix-regression:48` — `.member-op` returns 0 nodes
  when m9b-victim won +o on #bofh AND a destructive admin spec
  killed m9b-victim's session → #bofh goes opless. Same fix.
- `ux-5-bc2-nick-render:52` — assertion was wrong by DESIGN. Spec
  asserted color on members-pane NickText, but `MembersPane.tsx:182`
  passes `noColor` to NickText (UX-6-A v2 — kept the mode-prefix
  sigil colored, removed per-nick hue noise from members pane).
  With `noColor` the `.nick-text` span resolves to `--fg` which is
  `#000000` in mirc-light theme → rgb sum = 0 → assertion fails.
  Switched probe to scrollback sender (canonical colored NickText
  site). Same file: 2 other latent 1/3 op-race flakes hardened by
  routing through peer-first dedicated channel.

**webkit-iphone (`85d2b1c`)** — iOS-3 close × PART cascade + ux-6-d bugs.

The webkit-iphone-15 quartet was actually two distinct root causes:

- **iOS-3 PART hole**: `ios-3-bottom-bar-close.spec.ts:40` +
  `ios-z-cluster-journey.spec.ts:99` tap the close × which PARTs
  vjt from #bofh on the bouncer with NO restoration. Downstream
  webkit-iphone specs (`ux-2-mobile-archive`, `ios-z`) couldn't
  selectChannel(#bofh) — the tab is gone, locator times out at 30s.
  Same SHAPE as batch-1 SPEC-4 cascade (one spec leaving destructive
  state for downstream), different mechanism. Fix: `afterEach` rejoin
  via REST in both specs.

- **ux-6-d two distinct bugs** (real iso failures, not cascade):
  - (d) line 105: `.compose-box textarea` not visible. Mobile boots
    into HomePane (UX-4-B `:home` default selection) which has no
    compose-box. Fix: `selectChannel(#bofh)` first.
  - (f) line 130-160: `promoteVjtToAdmin` hardcoded
    `const adminToken = "admin-vjt"` (literal string, NOT a bearer
    token) → /admin/users 401 → `.find` crashed. Plus drove admin
    via desktop shell-chrome cog which on mobile resolves the
    settings drawer with admin-console-entry OUTSIDE the viewport.
    Fix: replace helper with working `ux-6-g` pattern + swap admin
    entry to mobile members-drawer launcher (`mobile-panel-admin`)
    from `ux-6-c`.

**admin-events (`b17fd71`)** — CI ETS-contention poll-budget.
The SPEC-1 SessionRegistry-drain at AdminEventsTest setup polled
500ms; CI runner ETS contention regularly exceeded that, with 7 of
10 tests reporting "SessionRegistry never drained" with 4 stale
entries surviving. Bumped to 2s (200×10ms). Pure setup-timing,
no production code.

### Lessons

The chromium-3 bucket distilled a new memory:
`feedback_seed_expansion_audit.md`. When adding seeded users /
destructive sacrificial-targets to fix one cascade, audit every spec
assuming a deterministic position on a shared resource (op race for
first-JOIN, sidebar insertion order, autojoin race for color slots).
Position assumptions silently break.

The webkit-iphone bucket showed cascade-shaped poisoning isn't a
chromium-only phenomenon. Any spec that mutates shared state on the
bouncer (PART, MODE, etc.) MUST `afterEach` restore, regardless of
project. iOS-3's close × had been quietly relying on alphabetical
ordering not surfacing the cascade until m9b-victim made the
downstream specs strict enough about state preconditions.

The admin-events bucket showed CI runner ETS contention can push
past poll budgets that pass locally. 2s is the new floor for
SessionRegistry drains under sandbox + load.

### Final CI state

- **integration** at `85d2b1c`: 184 passed / 0 failed (4.4m)
- **ci** at `b17fd71`: 2m29s exit-0 (test+lint+audit+dialyzer)

vjt's mandate satisfied. 30 → 0 failures across batch 1 + batch 2.

No deploy needed (e2e-only + sandbox-test-only).


---

## 2026-05-23 — GREEN-CI-3 Tier 1 e2e suite hardening

Same-day continuation. Post-GREEN-CI-batch-2 vjt asked for a full
e2e suite review: *"ensure they are solid now and do not have an
occasion to regress. and further they do test actual features and
not stupid internals."* 4 parallel review agents covered 104 specs
+ 5 fixtures and surfaced ~50 findings spanning HIGH/MED/LOW
classes. Tier 1 (highest-leverage, fix-once-cure-all) was pulled
into this cluster; Tier 2/3 deferred to a future cluster.

### Tier 1 buckets

**B1 (`e2894c9`)** — DM-listener race fixes. 4 specs (m4, m5, m6,
p0b) fired `peer.privmsg(NETWORK_NICK, …)` or `/query` immediately
after `selectChannel`, racing the own-nick DM-listener `phx.join()`
ack. Same shape FLAKE-D fixed in `cp14-b3` + `ux-6-k` earlier in
the day; these 4 specs predated the factored
`waitForDmListenerReady` helper at `cicchettoPage.ts:321`. One-line
insert per spec.

**B2 (`243f471`)** — `sidebarWindow` substring → exact-match via
`data-window-name` attribute. Pre-fix fixture matched windows via
`hasText: windowName` substring — `#bofh` ⊂ `#bofh-test`, `peer`
⊂ `peer2`, etc. Combined with Playwright's default `.first()` on
ambiguous locators, the collision returned a non-deterministic
row (same class as GREEN-CI batch 1 SPEC-4, at the fixture layer).
Plan's regex approach (`^\s*${name}\s*(?:\[.*\])?\s*$`) won't work
because badge spans live as siblings of the name span inside the
same `<li>`/`<button>` — parent's textContent = `{name}{badge}...`
defeats anchored regexes (channel names contain digits too).

Cleanest fix: add `data-window-name` attribute on every sidebar
`<li>` + every `.bottom-bar-tab`. Mirrors existing
`data-network-slug` + `data-testid` + `data-kind` test-seam
attributes. Production behavior unchanged. Fixture locator becomes
trivial `[data-window-name="${name}"]` exact match. Server-window
legacy ergonomics (callers passing "Server" OR the slug) both
alias to SERVER_WINDOW_NAME = "$server" in the fixture.

**B3 (`4afa4e1`)** — `globalSetup` cold-start retry-with-backoff.
Per `feedback_visitor_mint_e2e_cold_start`: first `login()` call
against a freshly-spawned IRC session can hit
`login_probe_timeout_ms = 3s` before upstream IRC completes →
504. globalSetup runs FOUR logins back-to-back (vjt, admin,
m9b-test, m9b-victim); one 504 throws → entire Playwright run
aborts before any spec executes. Fix: `loginWithRetry` helper
wrapping each login (3 attempts, 2s/4s/8s backoff). Pattern matches
`assertMessagePersisted` / `awaitPushDelivery`.

### CI state at close

- **integration** at `4afa4e1`: 183 passed / 1 failed (4.4m).
- **ci** at `4afa4e1`: 2m38s exit-0 (test+lint+audit+dialyzer).

The 1 remaining integration failure is
`scroll-on-window-switch:141` (`channel → empty query →
channel-back: scroll lands at bottom on return`). Per vjt
confirmation 2026-05-23 evening, the scroll regression IS real
in prod — the spec is correctly detecting a true bug that
manifests intermittently depending on cic state. The spec passes
on a fresh stack (first run) but fails on consecutive re-runs
when the query window persists in cic state. Pre-existing class,
NOT caused by B1/B2/B3 — verified by isolated 3× run on the
exact same head (✓ ✘ ✘ pattern).

**This spec is the canary for UX-8 scroll cluster.** Per the
locked post-FLAKES roadmap (`docs/todo.md` ★ block), UX-8 starts
next with (a) channel-switch scroll position interference + (b)
read-cursor-on-scroll = new server contract. The scroll:141
spec turns green naturally as UX-8 ships. **No spec-side
afterEach cleanup added** that would mask the bug — the
assertion is correct, production has the regression.

### Lessons

- **Plan-vs-reality has to honor what production actually does.**
  Plan B2 prescribed a regex exact-match. Reading the rendered
  DOM showed badge digits in textContent break anchored regexes.
  Path correction (data-window-name attribute) is a deviation
  recorded in the commit body — CLAUDE.md "Directions over code"
  cuts both ways. Plans are inputs, not contracts.

- **A spec that passes 1st run + fails 2nd+ run on shared stack
  isn't always a spec-rot story.** Sometimes it's a real prod
  bug that manifests only after a state-leak path is taken. The
  cleanup that would "fix" the spec would mask the prod bug.
  `feedback_seed_expansion_audit` is right about test-side
  cleanup most of the time; this is the exception that proves
  the rule (vjt's dogfood confirmed the scroll behavior is
  broken end-to-user).

- **Tier 2 deferred work was the right call.** Tier 1 = 3
  buckets, ~30 min coding, fixes 6 of 17 HIGH findings. Tier 2 =
  11 MED, captured verbatim in the plan appendix for future
  cluster pickup. Resisting the urge to do everything kept the
  cluster atomic + reviewable.

No deploy needed (e2e-only + sandbox-test-only).


---

## What's *not* in this document (on purpose)

- Anything that was decided inside a private channel and hasn't been published elsewhere. The repo is public; private crew chatter stays private.
- Implementation scheduling ("I'll do X next week") — that belongs on the issue tracker, not in-repo.
- Anything that belongs in `CONTRIBUTING.md` or a future issue template — to be added when the project moves past spec-only.

## 2026-05-24 — UX-8 scroll cluster CLOSED

Two sub-clusters, one plan: (a) channel-switch scroll-position
interference + (b) scroll-settle read-cursor update. Sentinel
`scroll-on-window-switch:141` shifted from intermittent-red to
consistent-green; e2e count 184 → 187 (3 new scroll-settle
scenarios, all green).

### Sub-cluster (a) — DOM geometry race

`queueMicrotask` in `scrollToActivation` (line 959) and
`measureOverflow` (line 877) flushed BEFORE the browser's layout
pass — `listRef.scrollHeight` read stale geometry when called right
after a channel switch. Solid had committed the new `<For>` rows
(DOM nodes existed) but row box-heights weren't yet included in
`scrollHeight`. `scrollTop = scrollHeight` landed ~66px short of
true bottom; vjt dogfood-confirmed.

Plan said "swap to double-rAF, two sites." Reality:
1. Third call site (length-effect at line 1095) had identical race
   for the initial-mount tail-snap path; double-rAF needed there too.
2. Even rAF×2 wasn't enough on the channel-back path because the
   scrollback STORE reload (Solid signal flush from
   `scrollbackByChannel`) races the key-effect — the rAF callback
   can fire before messages signal flushes. Switched to
   `lastElementChild.scrollIntoView({block: "end"})` — browser
   walks the actual DOM element natively, layout-aware even
   mid-store-update. Fallback to scrollHeight math when scrollback
   is empty.

The sentinel spec assertion ("scroll lands at bottom on return")
was post-cluster STILL wrong because seed expansion (m1-m11 + WS
chatter peers) made unread messages non-deterministic at login.
cic's C7.3 contract CENTERS the viewport on the unread marker when
unreads exist — correct UX, but the spec assumed bottom-anchor
unconditionally. Spec rewritten to be marker-tolerant: PASS when
either bottom-anchored OR marker present AND scrollTop > 0. The
"didn't get stuck at scrollTop=0" failure mode (which motivated
the cluster) is what's actually pinned.

### Sub-cluster (b) — scroll-settle cursor write

Today's `Grappa.ReadCursor.set/4` fires from cic on focus-leave +
browser-blur, both write the scrollback tail id (monotonic). Added
scroll-settle as a third trigger: when the user scrolls and stops
mid-channel, POST the last-fully-visible row id.

**Forward-only client-side gate** at
`Grappa.cic.selection.setCursorIfAdvances/3` preserves the existing
monotonic invariant: POST only if candidate > current cursor. Server
supports backward moves via last-write-wins (per
`Grappa.ReadCursor.set/4` docstring) but cic does not exercise
them. Decision: keep client invariant intact — no operator UX
asking to "reset unread" on scroll-up.

**500ms client-side debounce** in `ScrollbackPane.onScroll` collapses
iOS momentum-scroll inertia (events fire for 1-2s post finger-lift)
into a single POST at the natural stop. Component-scope
`scrollSettleTimer` cleared on every scroll; `onCleanup` in
`onMount` drops any in-flight timer at component teardown so a
channel switch doesn't fire a stale settle for the previous window.

**Visible-row math**: `lastFullyVisibleRowId(listRef)` walks
`.scrollback-line` children, returns the highest `data-msg-id`
whose bottom edge is at-or-above viewport bottom. O(n=200)
sub-millisecond. Requires `data-msg-id={msg.id}` attribute on
`<ScrollbackLine>` (test-seam, no behavior change — same shape as
GREEN-CI-3 B2's `data-window-name`).

**No server change**. The read-cursor controller, the wire
contract, and `Grappa.ReadCursor.set/4` were all already
last-write-wins-tolerant. Three triggers (focus-leave,
browser-blur, scroll-settle) feed one endpoint.

### E2E (bucket D)

`cicchetto/e2e/tests/scroll-settle-cursor.spec.ts` — 3 scenarios:
scroll-to-middle advances cursor (loose match — WS arrivals race
exact equality), scroll-to-bottom advances cursor to tail,
scroll-up-from-bottom does NOT retreat cursor (forward-only gate).
The forward-only invariant is the load-bearing assertion.

### Process notes

- Cic-only cluster — all HOT deploys + cic bundle rebuilds (no
  server restart). Bundles `RPSS-xLQ` (a) → `CzM79hNe` (a2) →
  `DBM5AuWJ` (a3) → `B04jfbzh` (b+c).
- vjt confirmed visual prod correctness at bundle `CzM79hNe` ("tested
  live, looks great") despite CI sentinel still red — spec issue,
  not code issue (a3 + a4 closed the gap).
- 7 commits over ~3 hours. Bucket B + C bundled per
  `feedback_atomic_css_pattern` — biome rejects unused
  `lastFullyVisibleRowId` if B lands alone.
- Plan deviations recorded in commit bodies per
  `feedback_plan_vs_production_reality`.

### Next per locked roadmap

1. wireTypes.ts codegen — generate `cicchetto/src/lib/wireTypes.ts`
   from server-side `Grappa.*.Wire` typespecs (closes the cic↔server
   boundary drift surface STRUCTURALLY at compile time).
2. Bastille deploy workstream (GitHub issue #8) — FreeBSD jail prod
   runtime parallel to docker-compose.


## 2026-05-24 — wireTypes.ts codegen cluster CLOSED

4-bucket cluster (A→B→C→D) closing the cic↔server boundary drift
surface STRUCTURALLY. Plan + spec authored same day; bucket execution
end-of-day. Triggered by 2026-05-22 codebase review § "Direction
recommendation" — drift between server-side `Grappa.*.Wire` typespecs
and cic-side hand-rolled `api.ts` types was the root cause of 9 REV
cluster findings (C1, C2, H1-H4, H6, M19, M20).

### Architecture chosen

One mix task (`Mix.Tasks.Grappa.GenWireTypes`) walks every module
under `lib/grappa/**/wire.ex`, parses `@type` declarations via
Code.Typespec.fetch_types/1, emits ONE deterministic file at
`cicchetto/src/lib/wireTypes.ts`. Committed to git. CI gate
`mix grappa.gen_wire_types --check` (appended to `scripts/check.sh`)
re-generates in memory and diffs — fails CI on drift between
typespec source and committed file. cic side adds
`wireTypesAssert.ts` with `Equal<A, B>` TS type-level helper that
fails `bun run check` when api.ts hand-roll diverges from generated.

Two gates protect the server→cic contract at CI time:
1. typespec → committed-wireTypes.ts drift (bucket D)
2. generated-wireTypes.ts → api.ts hand-roll drift (bucket C)

Either gate fires on a single side drifting.

### Bucket roster

- **A** (`569dc41`): `session.ex` typespec sweep — 17 `kind:
  String.t()` → atom literals; constructors flipped in lockstep
  (PLAN DEVIATION: plan kept constructors as strings, Dialyzer
  caught the success-type mismatch).
- **B** (`d2fcf3f`): mix task + 558-line generated wireTypes.ts +
  24-test ExUnit suite. PLAN DEVIATIONS: WRITABLE_CIC=1
  escape-hatch (cic `:ro` mount); fully-qualified TS naming
  (avoids collisions on `T`/`Event`); transitive external-type
  resolution with depth-limit-8 cycle guard; biome-compatible
  output format.
- **C** (`d001282`): `wireTypesAssert.ts` — structural-equivalence
  asserts cic↔generated. ONE assert today (`ConnectionState`,
  closes H2). PLAN DEVIATION: full api.ts re-export migration
  deferred to future bucket (high-risk, low-incremental-value
  given the assert approach catches drift at compile time anyway).
- **D** (`330e7d4`): `scripts/check.sh` drift gate. Negative test
  confirmed exit 1 with "OUT OF SYNC" message; positive run exit 0.

### Findings closed structurally

- **H2** — `ConnectionState` cic↔server drift, both ends now pinned
  at compile time via `_Assert_ConnectionState`.

### Findings deferred (low-risk, scope-limited follow-ups)

- C1/H1/H3-H6/M19/M20 — each requires a server-side typespec
  tightening (flip `kind: String.t()` → atom literal in
  cic/scrollback/query_windows wire modules; tighten
  `capacity_reject.flow` from `atom()` to `Admission.flow()`;
  tighten `topic_changed.topic` + `channel_modes_changed.modes`
  from `map()` to proper record). Each is a one-line typespec
  edit + assert add; safe to do in follow-up buckets.
- Wholesale api.ts deletion of duplicated wire types — also a
  follow-up; the assert approach already prevents NEW drift.

### Lessons

- **Plan vs production deviation** — every bucket had at least one
  (Dialyzer success-type discipline, cic `:ro` mount safety,
  TS-name collision on bare `T`/`Event`, biome `lineWidth: 100`
  formatter rules, dead-code from union-rendering rewrites).
  `feedback_plan_vs_production_reality` paid off — each deviation
  recorded in commit body, no in-flight design questions surfaced
  to vjt.
- **AdminEventsTest registry flake** appeared in 2 of 5 local runs
  + bucket A's CI. Per `feedback_recurring_e2e_not_flake` "two in
  a row = real regression" but the recurrences came from a
  docs-only commit (codegen-plan) too — NOT cluster-introduced.
  Pre-existing isolation flake; chronic.
- **HOT deploy corrupted `_build/prod`** on bucket A first attempt
  (per `feedback_hot_deploy_corrupts_build_prod`). Force-cold-
  deploy recovered. Subsequent buckets B/C/D HOT-deployed clean.
- **Transitive external-type resolution** — bucket B's first
  codegen run hit `NetworksCredentialAuthMethod = IRCAuthFSMAuthMethod`
  where `IRCAuthFSMAuthMethod` itself unresolved. Fix: fixpoint-
  iterate the external-refs registry, depth-limit 8.

### Next per locked roadmap

1. ~~UX-8~~ + ~~wireTypes codegen~~ — both CLOSED.
2. **Bastille deploy workstream** (GitHub issue #8) — FreeBSD jail
   prod runtime parallel to docker-compose.

---

## 2026-05-24 — BUGHUNT-1 pre-bastille bug-hunt CLOSED

Two user-visible regressions vjt flagged during UX-8 dogfooding,
closed BEFORE bastille deploy so the new prod runtime doesn't
inherit them. Cluster shape: 2 buckets, brainstorm → spec → plan
→ autopilot exec (post-CP46 codegen precedent). Spec at
`docs/superpowers/specs/2026-05-24-bughunt-1-design.md`.

### Bucket A — server-side PRIVMSG auto-split

`Grappa.IRC.LineSplit.split_privmsg_body/3` is a new pure module
that splits a PRIVMSG body into fragments fitting the wire-frame
budget (`linelen - byte_size("PRIVMSG <target> :\r\n")`). UTF-8
safe (grapheme boundaries), CTCP ACTION envelope preserved on
every fragment (naive split would emit garbage `\x01ACTION
text\x01` envelopes), single-grapheme-oversize edge emits the
grapheme as its own best-effort fragment.

Wired into `Session.Server.handle_persisting_send/3` via a
`persist_and_send_fragments/4` recursive loop: each fragment is
its own `Scrollback.persist_event` + per-channel
`PubSub.broadcast_event` + `IRC.Client.send_privmsg` — matching
what every other IRC client renders and what other channel
members see (upstream relays each PRIVMSG as a separate row).
HTTP reply returns the LAST fragment so cic's scrollback view
aligns with the final row id.

`Session.Server` gains `:linelen` state field (default 512 per
RFC 2812; overridden by `005 RPL_ISUPPORT LINELEN=<N>` when the
upstream advertises). Parser mirrors the existing
`MODES=N` reduce_while shape — same defensive idempotency,
same garbage-value-keeps-prior behavior. State-shape change
forces COLD deploy via `lib/grappa/hot_reload/long_lived_modules.ex`.

**Why server-side, not cic**: per CLAUDE.md "one parser, on the
server" + "IRC is bytes; the web is UTF-8". Payload framing
belongs to grappa. cic POSTs an arbitrary-length string; grappa
fans out the wire fragments. Doing it cic-side would require
cic to know the upstream's LINELEN + the envelope shape (it
doesn't, by design — the Phoenix Channels surface is typed JSON).

**Out of scope**: TOPIC / NOTICE / AWAY auto-split (single-line
verbs, no vjt sighting). `RPL_ISUPPORT MAXTARGETS` comma-split
(different bug class).

### Bucket B — cic mobile Archive seed-on-open

Root cause confirmed by code-read: `ArchiveModal.tsx` opens via
`setArchiveModalNetwork(slug)` but never calls
`loadArchive(slug)`. The only `loadArchive` caller is
`Sidebar.tsx`'s `<details>` onToggle, which mobile operators
never reach (sidebar is hidden behind BottomBar). First open
shows "no archived windows" until the user archives a fresh
window, which fires `archive_changed` (re-fetch) and the bug
*appears* fixed.

Fix: dedicated `createEffect` in `ArchiveModal.tsx` that fires
`void loadArchive(slug)` on edge-trigger open. `lastSeededSlug`
guard prevents re-load on every reactivity tick — only
null→slug and slug-A→slug-B transitions trigger.
Same-slug re-open after close re-fires (refresh semantics per
`archive.ts:18-20`).

**Mount-component-owns-state pattern**: ArchiveModal seeds
itself rather than depending on every callsite (ShellChrome
chip today, future deep-link / push notification / etc.) to
remember the load step. The spec called this out as a
deliberate design choice: decoupling future surfaces from the
load contract.

### Process notes

- **Plan vs production deviation fired on every bucket**. Bucket A
  alone had 4: (1) inlined `flush_chunk/2` helper instead of
  plan's `emit_chunk_and_recurse/7` with arity marker;
  (2) Boundary `exports:` list needed `LineSplit` added
  (caught by boundary-warning); (3) Credo unused-arg style
  (`_target` → bare `_`); (4) Dialyzer success-typing rejected
  `pid() | nil` supertype, tightened to `pid()`. Each recorded
  in commit body per `feedback_plan_vs_production_reality`.
  Bucket B had 1: the chip lives in `ShellChrome.tsx` as
  `[data-testid="shell-chrome-archive"]` not in `BottomBar.tsx`
  as `.bottom-bar-archive-chip` — e2e selectors adjusted.
- **Hot-deploy preflight gap recurrence** — `scripts/deploy.sh`
  preflight mis-classified bucket A as HOT despite the
  state-shape change. Per
  `feedback_deploy_sh_preflight_field_addition_gap` (CP28
  lesson): the line-anchor regex doesn't catch field-additions
  INSIDE an existing `@type t :: %{...}` block. The AST oracle
  (`scripts/_extract_state_block.awk`) should catch these but
  didn't fire. Worth a dedicated bucket to audit during bastille
  post-mortem.
- **Hot-deploy on state-shape change corrupts `_build/prod`** —
  per `feedback_hot_deploy_corrupts_build_prod`. Recovery is
  `docker compose exec grappa sh -c "rm -rf _build/prod"` +
  `scripts/deploy.sh --force-cold`. Predictable + cheap to
  recover, but a sharp edge.
- **CI integration flake on bucket A** — 2 unrelated cic specs
  (`p0e-invite-ack` + `ux-5-bk-join-fail-dupe`) failed in
  bucket A's CI run; both pass locally + both pass in bucket
  B's identical-code CI run. Per
  `feedback_recurring_e2e_not_flake`: "single recurrence
  fine, two is real regression" — bucket B is the second
  observation, both green. Classified flake.

### Next per locked roadmap

1. ~~UX-8~~ + ~~wireTypes codegen~~ + ~~BUGHUNT-1~~ + ~~BUGHUNT-2~~ — all CLOSED.
2. **Bastille deploy workstream** (GitHub issue #8) — FreeBSD jail
   prod runtime parallel to docker-compose. No remaining known
   user-visible regressions blocking it.

## 2026-05-24 — BUGHUNT-2 unread-marker cursor-write contract CLOSED

Same-night follow-up to BUGHUNT-1 + UX-8: opening a window with
unreads flashed the unread marker for ~500ms then made it vanish
because UX-8(a3)'s `tail.scrollIntoView({block:"end"})` in the
activation routine + UX-8(b+c)'s 500ms scroll-settle debounce
combined to POST `last-fully-visible-row` (now the tail) on bare
window open. Cursor advanced → marker (just below the OLD cursor)
fell below the new cursor → vanished.

Worse, the broader contract was incoherent: window-switch +
browser-blur wrote `store-tail` (last id in scrollback store),
ignoring operator scroll position. Operator scrolling up to read
history then switching away lost the marker entirely on next visit.

### Contract rewrite

vjt's revised contract (2026-05-24):
- Window open / activate: **no cursor write** (was already correct).
- Switch away (cic→cic): `lastFullyVisibleRowId` of LEAVING pane,
  measured BEFORE the activation routine touches listRef geometry.
- Scroll-settle: `lastFullyVisibleRowId` of current pane, debounced
  500ms, gated on recent operator input event.
- Browser blur: `lastFullyVisibleRowId` of focused pane.
- Send: out of scope (deferred — narrow hole: send-while-scrolled-up-
  then-close-tab).

Cursor-write ownership moved from `selection.ts` → `ScrollbackPane.tsx`
(spec: docs/superpowers/specs/2026-05-24-bughunt-2-cursor-design.md
"each context owns its domain": the pane owns its DOM geometry).

### Bucket roster

* `076eb77 a1` — `lastInputEventAtMs` signal + listRef event handlers.
* `7886be0 a2.5` — Biome a11y + pre-existing lints for clean baseline.
* `ec6a5f6 a3` — onScroll settle-arm gated on recent operator input.
* `0c10888 a4` — leave-arm cursor write inside ScrollbackPane key-effect.
* `52616fb a4.5` — stale visibility-effect comment for blur-arm.
* `3d80f84 a5` — cursor write on unmount + on browser blur.
* `a9caa9e a5.5` — drop dangling setCursorForWindow reference.
* `992f248 a6` — delete cursor-write from selection.ts.
* `c589451 a7` — fix unit tests asserting the old selection.ts path.
* `0bdb353 a6.5` — update stale mock comment in selection.test.ts.
* `b5a1410 a6.6` — collapse vacuous blur-arm negative tests.
* `75e7048 b0` — wheel handler arms input-event gate (fix-up — see below).
* `e486e39 b1` — e2e sentinel: bare window open does NOT advance cursor.
* `077e2ea b2` — e2e sentinel: switch-away writes visible-tail cursor.
* `63ab010 b2.5` — wait past settle window before snapshot (fix-up).
* `c513953 b3` — e2e sentinel: real wheel-down advances cursor.
* `6a63a13 b4` — UX-8 scroll-settle e2e: switch to real PointerEvents.
* `1159867 b5` — vitest: input-event gate negative unit.

### Bucket A gap caught by B1

Bucket A's `onPointerDown` handler did NOT cover desktop mouse-wheel
rotation — per W3C the `wheel` event is a real user input but does
NOT fire a preceding `pointerdown` (pointerdown fires on button
press, not on wheel rotation). Without an `onWheel` handler, the
gate stayed null on wheel scroll and the settle timer never armed —
desktop operators scrolling with the wheel never advanced their
read cursor. Inline comment in A1 was factually wrong (`"pointerdown
covers wheel-with-mouse-over-element"`).

B1's e2e sentinel (which sets cursor baseline via real `page.mouse.wheel`)
caught this immediately: `cursorBaseline` returned null. Fix landed
as `bughunt-2(b0)` BEFORE the B1 commit. Comment updated; touch +
keyboard paths were correct already.

### Per-spec plan deviations

* **B1** — plan's `selectChannel(":home")` + fallback regex-Home-click
  blew the 30s test timeout (selectChannel waits for self-JOIN, never
  arrives for Home; regex matched multiple buttons → strict-mode
  flag). Replaced with `getByRole("button", {name: "Home", exact:
  true}).click()`.
* **B2** — `AUTOJOIN_CHANNELS` ships only `#bofh` (one channel) —
  plan's `CHANNEL_B = AUTOJOIN_CHANNELS[1]` fallback would have
  switched to itself. Switch destination is now the `$server` window
  (always present). Assertion adjusted for stack-persistence:
  `expect(cursor).toBe(max(cursorBeforeSwitch, visible))` because
  `setCursorIfAdvances` (cic) + `ReadCursor.set/4` (server) drop a
  candidate <= current; the load-bearing claim is
  `expect(cursor).not.toBe(store)`.
* **B2.5** — when B2 runs after B1, the leave-arm POST races the
  scroll-settle POST from the wheel-up (two cursor writes from one
  user gesture). Wait `SETTLE_WAIT_MS` (1000ms) after wheel-up so
  the settle POST lands BEFORE we snapshot the cursor baseline.
* **B3** — final `expect(cursor <= visible)` was brittle under stack
  persistence (forward-only gate drops POST when visible < prior
  cursor). Replaced with `expect(cursor).toBe(max(cursorAfterUp,
  visibleAfterDown))`. Load-bearing `cursor > visibleAtMidList`
  unchanged.
* **B5** — `lastFullyVisibleRowId` is module-local in
  ScrollbackPane.tsx (not exported), returns null in jsdom (no real
  layout). Per plan's "pragmatic path", negative-only test. Drive-by:
  extend `../lib/scrollback` mock to export `loadMore` (production
  imports as `loadMore as loadMoreScrollback`); without it the test
  passes but vitest flags an unhandled error post-run.

### Gates + deploy

* `mix test`: 2455/2455, 0 failures.
* `mix credo --strict`: 2413 mods/funs, no issues.
* `mix dialyzer`: 0 errors.
* `mix sobelow --config --exit Medium`: 0 findings.
* `mix deps.audit --ignore-advisory-ids GHSA-g2wm-735q-3f56`: 0.
* `mix hex.audit`: 0.
* `mix doctor`: 98.8% / 100.0% / 99.8% — PASSED.
* `mix format --check-formatted`: clean.
* Bats: 24/24.
* cic vitest: 1641/1641 (incl. new B5 test).
* cic biome: 17 pre-existing warnings (themes/default.css `!important`
  — not touched by BUGHUNT-2; diff-stat empty for that file).
* E2E sentinels (suite): 3/3 PASS at 16s. UX-8 scroll-settle
  (rewritten for real PointerEvents): 3/3 PASS at 14s.

Deploy: `scripts/deploy.sh` HOT (cic + cic-only e2e tests, no server
behavior change in bucket B; bucket A's server-side touches were
test-mock helpers already on main). `scripts/deploy-cic.sh` bundle
hash `C-Ph5y4M` broadcast to all live user-topics. Healthcheck `ok`.

### Lessons captured

* **Plan vs production reality fires on EVERY bucket** (recurrence
  from BUGHUNT-1). Bucket B had 5 deviations across 5 sentinels;
  every one documented in commit body per
  `feedback_plan_vs_production_reality`. Most material:
  (a) plan-suggested API surface that didn't exist
  (`selectChannel(":home")` semantics), (b) wrong assumption about
  Playwright input synthesis (`mouse.wheel` does not emit
  pointerdown), (c) stack-persistence across test specs invalidating
  exact-equality assertions on cursor values.
* **Sentinel-first development catches contract gaps** — B1's first
  run failed in a way that revealed a Bucket A oversight (missing
  `onWheel` handler). The sentinel did its job: a contract gap that
  would have surfaced as silent prod regression (desktop wheel scroll
  doesn't advance cursor) was caught + fixed BEFORE the cluster
  closed. The per-bucket "sentinel passes on first run" gate per
  `feedback_recurring_e2e_not_flake` was the right halt criterion.
* **W3C event-model gotcha worth a memory** — wheel events are
  independent user inputs from pointer events; they fire even when
  the pointer is not pressed. Future "real user input" detection
  must enumerate the full set: pointerdown, wheel, touchmove,
  keydown. iOS Safari's pointerdown ALSO fires on touch-start but
  not always reliably; touchmove covers the gap. Worth a
  `feedback_dom_input_event_complete_set` memory if a third bucket
  trips on this.

---

## Spec audit cluster (2026-05-26)

vjt mandate post-BUGHUNT-3: "in depth review of all specs ... drop the
ones that make no sense such as testing internals and keep all the
ones that test actual user behaviour ... lets make them robust and
faster." 109 Playwright specs surveyed by 5 parallel general-purpose
agents (~22 specs each), scored on REDUNDANCY / INTERNALS / ASSERTION
STRENGTH / SPEED / ROBUSTNESS / SCOPE. Per-spec verdicts
(KEEP / KEEP+REFACTOR / CONSOLIDATE / DROP) merged into a master
proposal; vjt sign-off gated on every hard-to-reverse move
(CONSOLIDATE / DROP / file-collapse).

**Shipped over 9 commits + cascade-fix:**

* **EZ bucket** — 4 strict-subset CONSOLIDATEs: `cp15-b4` → `cp15-b6-PAR`,
  `i2` → `ux-6-b-embedded-upload`, `ios-3` + `ios-4` → `ios-z`.
  Net −4 spec files, −286 lines.
* **R1 bucket** — cursor cluster 4 → 1 parametrized spec
  (`cursor-forward-only.spec.ts`): the 4 specs each tested one slice
  of the same BUGHUNT-2 forward-only-cursor contract via identical
  harness shape. Folded into 7 tests, shared helpers, single
  afterAll cascade-fix. 656 → 407 lines. One assertion strengthened
  during the consolidation (scroll-settle test-1's
  `validForwardOnly OR advancedToNewVisible` disjunction was
  swallowing out-of-band cursor jumps).
* **R3 bucket** — `ux-z` had a `CLASSES` parity-theatre loop iterating
  over `[registered, visitor, nickserv]` but `continue`d 2/3 with
  no side effects. Loop dropped.
* **R5 bucket** — `cp13-server-window` was bundling 5 unrelated tests
  in 218 lines; S5 (compose-driven 401 routing) + S10 (mIRC bold
  renderer) extracted to own files; cluster spec trimmed to the
  S6+S8+S9 server-window UX contract.
* **R6 bucket** — 4 hardcoded `waitForTimeout(500-2000ms)` replaced
  with event-driven gates (nick-case, ux-5-br, ux-6-j, ux-6-l).
  −3.75s of hardcoded waiting suite-wide.
* **R7 bucket** — 4 weak assertions strengthened
  (`p0d-lusers` body `toContainText(/\d+/)` → named-field;
  `cp22-bnames` SOFT-check → branch precondition; `m12-motd-server`
  kind-agnostic → kind=notice with leaf-name regex; `ux-5-b-home-emoji`
  text-only → boundingBox visibility).
* **Rename batch** — 19 weakest spec filenames got descriptive
  suffixes (`c2-whois` → `c2-whois-card-inline-render`, etc.).
  Cluster IDs preserved for chronological backtrace into checkpoints.

**Skipped per vjt call**: R2 (mobile CSS-shape consolidation —
"keep these alone") + R4 (bug7 fold + webkit-iphone-15 CI matrix
extension — "ship CI matrix extension SEPARATELY first").

### Cascade root-cause discovery (the real prize)

Mid-audit, the EZ commit landed `cp15-b6-part-archive-rejoin` with a
fold-in `$server-never-archived` invariant. Local integration suite
exit 0; CI integration ✘ on the same test, then CI ci ✘ on the next
commit with 10/11 cascade in `Grappa.AdminEventsTest` —
`SessionRegistry never drained — stale entries: [{:visitor, ...}]`.

**Root cause traced from CI back to prod**: `Grappa.Session.stop_session/2`'s
5-second `@stop_down_timeout_ms` ran out, the function `Logger.error`'d
+ demonitored + returned `:ok` WITHOUT actually killing the pid. The
visitor login_test's `stop_visitor_session` therefore returned `:ok`
despite the Session.Server still alive in reconnect-backoff
(`{:connect_failed, :econnrefused}`). The zombie pid then poisoned
SessionRegistry for the next singleton-lane test (AdminEventsTest's
`wait_for_empty_session_registry!`), cascading 10+ unrelated failures.

Local repro impossible (faster cores get the `:DOWN` within budget
every time); the fix has to be unconditional.

**Fix (commit `6980dc8`)**: on the `:DOWN` receive timeout, escalate
to `Process.exit(pid, :kill)` (unmaskable — bypasses `terminate/2`
entirely), then re-wait briefly for the kill's `:DOWN` before
returning. Post-condition is now "process WILL be dead" instead of
"process MAY still be alive (with Logger.error noise)." Memory:
`feedback_session_stop_must_force_kill.md`.

Lessons captured:

* **CI is a fuzzer for prod GenServer teardown latency.** The faster
  the dev machine, the harder it is to repro CI-only teardown bugs.
  When CI cascades on a singleton-lane test that does ANY
  Registry-draining setup, suspect a prod-side zombie leaked by some
  upstream test's "best-effort" cleanup that demonitored without
  killing.
* **"No silent-swallow at boundaries" applies to demonitor too.** Per
  CLAUDE.md "Use infrastructure, don't bypass it" — a function that
  promises to stop a process and returns `:ok` without proving the
  process is dead is a silent-swallow shape, even if it logs the
  failure. The next reader (test, controller, operator) treats `:ok`
  as "the post-condition holds" and racing the dead pid is the bug
  class that surfaces.
* **Spec audit returned more value than the consolidation itself.**
  The audit was scoped to "make e2e specs robust + faster"; it
  surfaced a prod GenServer lifecycle bug that had been latent for
  weeks (intermittent CI cascade prior session investigated +
  couldn't reproduce — recorded as folklore). The audit gave us the
  forcing function to trace it end-to-end.

### Next per locked roadmap

1. ~~UX-8~~ + ~~wireTypes codegen~~ + ~~BUGHUNT-1~~ + ~~BUGHUNT-2~~ +
   ~~E2E-ROBUSTNESS~~ + ~~spec-audit~~ — all CLOSED.
2. **Bastille deploy workstream** (GitHub issue #8) — FreeBSD jail
   prod runtime parallel to docker-compose. No remaining known
   user-visible regressions blocking it.

## 2026-05-26 — admin polish + X-Forwarded-For with peer-loopback bypass

Pre-bastille polish: vjt opened the admin panel and found five
distinct UX/correctness issues. Buckets A-D + a follow-up F shipped;
the planned manage-cluster (E: create/delete networks/users/creds)
was scrapped — `bin/grappa *` already covers the operator path and
bastille priority outweighs per-admin-UI parity.

### Trusted-proxy + the `RemoteIpFromProxy` wrapper

`conn.remote_ip` was surfacing the docker-bridge nginx IP for every
request behind the reverse proxy — `visitors.ip` audit + captcha
verify all saw nginx, not the client. The `Phase 5 will add` note in
`auth_controller.ex` moduledoc and the W2 captcha `remoteip` param
both flagged this gap for months.

Added `{:remote_ip, "~> 1.2"}` to `mix.exs`, wired
`GrappaWeb.Plugs.RemoteIpFromProxy` between `Plug.RequestId` and
`Plug.Telemetry` in `endpoint.ex`. `RemoteIp` package is mature
(v1.2.0 from 2024, pure Plug, zero Phoenix/Bandit coupling),
default reserved-range list already covers RFC1918 + docker bridge
ranges → no env-driven CIDR allowlist needed for the single-hop
nginx→Phoenix topology.

**The peer-loopback bypass** is the non-obvious security half. Bare
`RemoteIp` operates ONLY on the X-F-F chain + reserved-range
allowlists; it NEVER inspects `conn.remote_ip` (the TCP peer). That
means:

    $ docker exec grappa curl -H "X-Forwarded-For: 127.0.0.1" \
        http://localhost:4000/admin/reload

would rewrite `conn.remote_ip` to `{127,0,0,1}` and pass
`Plugs.LoopbackOnly`. The fix CANNOT live in the `RemoteIp` config
itself — the `:clients` option there means the *opposite* of what
the name suggests (it forces an IP *inside the header chain* to be
treated as terminal, not "trust this peer's headers"). Tests caught
this misconfig before the first commit landed.

`RemoteIpFromProxy` is a thin wrapper:

```elixir
def call(%Plug.Conn{remote_ip: {127, _, _, _}} = conn, _), do: conn
def call(%Plug.Conn{remote_ip: {0, 0, 0, 0, 0, 0, 0, 1}} = conn, _), do: conn
def call(%Plug.Conn{} = conn, opts), do: RemoteIp.call(conn, opts)
```

Peer is loopback → skip the rewrite entirely. Peer is anything else
(including docker bridge) → delegate to `RemoteIp`. The IPv4-mapped
IPv6 form `::ffff:127.0.0.1` is intentionally NOT in the bypass
match — per RFC 4291 it's an IPv4 address in IPv6 transport, not
loopback, and Bandit surfaces it as `{0, 0, 0, 0, 0, 0xffff, hi, lo}`
which doesn't pattern-match.

End-to-end controller tests assert both the legitimate nginx-shaped
path (peer = 172.x, X-F-F honored) and the container-shell spoof
path (peer = loopback, X-F-F ignored). LoopbackOnly's moduledoc
cross-references the wrapper so a future refactor sees the security
coupling.

**Rule for future Plug wrappers:** if a downstream gate keys on
`conn.remote_ip` (or any conn field a parser-style plug rewrites
upstream), the rewrite plug's config alone is rarely enough — the
peer-context behavior often needs to live one layer up. Test the
end-to-end gate, not the rewriter in isolation.

### Visitor IP staleness — refresh-on-relogin

Post-deploy vjt smoked the admin Visitors tab and saw `M\Grappa`
still showing `172.19.x` despite the wrapper plug. Root cause:
`Visitors.find_or_provision_anon/3` returned an existing row
verbatim, so `visitors.ip` was set ONLY at row creation. For
long-lived NickServ-identified visitors (V7 — `expires_at: nil`,
persist forever) the column froze on the row's birth IP indefinitely.

Added `Visitor.ip_changeset/2` + `maybe_refresh_ip/2` head in
`find_or_provision_anon/3`. Three heads:
- same ip → no-op (hot path, no UPDATE)
- nil ip → no-op (refresh is "fresher value," not "forget what you
  knew" — protects rows from mix-task paths with no remote_ip)
- different non-nil ip → Repo.update via the changeset

Existing stale rows heal on the next login. The bearer-token resume
path (`/auth/authenticate`) does NOT call
`find_or_provision_anon` — only explicit logout/login triggers the
refresh.

### `subject_label` pre-join + orphan-pid honesty signal

`/admin/sessions` rendered opaque `user:8f6a979b` / `visitor:792fc2a4`
labels. `LiveIntrospection.AdminWire.session_to_admin_json/2` now
takes a pre-resolved `subject_label`; the controller batches the
lookup via new `Accounts.get_users_by_ids/1` +
`Visitors.get_by_ids/1` helpers (one query per subject_kind
regardless of session count).

`subject_label: nil` is the **gemello** of the U-0 "live_state: null"
honesty signal on `/admin/visitors`: pid exists, DB row doesn't
(orphan pid — raw SQL delete, terminate race, or the ghost-session
class vjt observed pre-deploy with the M\Grappa visitor session).
Cic renders `<kind> <uuid8> (no DB row)` so operators see the
divergence without remsh-ing into the BEAM.

Composition site is the controller, not `LiveIntrospection` — that
module's boundary explicitly excludes `Accounts` / `Visitors`
(pure live-state). The pre-join pattern mirrors the M-6 users
controller's `count_sessions_by_user/0` join.

### Push.SenderTest flake near-miss

During F's diagnosis, `scripts/check.sh` reported `1 failure` —
push sender `pool_not_available`. Initial iso 2/5 fail on worktree
vs 5/5 pass on main almost led to a bisect chase. Per
`feedback_bisect_sample_size_required` ran 8x both sides:
1-5/8 fail BOTH sides. Pre-existing wallclock-dependent flake
(`req 0.5.18` surface, documented in `sender.ex:285`). Not a
regression of F.

**Confirms the discipline:** single-sample iso bisects on a flaky
test mis-attribute. The cost is 6 extra runs (~3 min) vs hours
of phantom-regression hunt. Per `feedback_recurring_e2e_not_flake`
the inverse rule (recurring fails ARE real) still applies — but
"recurring" needs the sample size to be load-bearing.

## 2026-05-27 — bastille deploy SHIPPED + log routing under runtime/

Two related ships closed the bastille workstream that's been
blocking ★ ROADMAP since cp50.

### Bastille deploy SHIPPED

Native Elixir release (`mix release --overwrite`) running inside a
FreeBSD bastille jail on m42 (10.66.6.7 + 6 IPv6 addresses for the
outbound rotation pool). irc.sniffo.org / irc.sindro.me both
serving live; Docker prod replaced. Tooling lives under
`infra/freebsd/` — `deploy.sh`, `jail_install_rcd.sh`,
`jail_git_pull.sh`, `jail_release.sh`, `jail_install_nginx.sh`,
`jail_db_*.sh`, `ndp_keepalive.sh`, `rc.d/grappa`,
`rc.d/grappa_ndp_keepalive`, `grappa.env.example`.

Operator workflow:
```
sudo bastille cmd grappa /home/grappa/grappa/infra/freebsd/deploy.sh
```
runs `git pull --ff-only` → `mix deps.get --only prod` → `mix
compile --warnings-as-errors` → `mix release --overwrite` → `npm
ci && npm run build` (cic bundle) → `Grappa.Release.migrate()` →
`service grappa restart` (with epmd-kill between stop + start —
old BEAM doesn't shut down epmd, next start sees `name
grappa@grappa in use`) → `/healthz` poll loop. No hot-reload —
release rebuilds always swap the BEAM wholesale; sessions reset on
every deploy.

Cluster `bastille_deploy_pipeline_hardened` memory captures the
pipeline post-recovery (root + run_as_grappa + epmd-kill + cic
vite build self-sufficient under `sudo bastille cmd grappa
deploy.sh`).

### Log routing under runtime/

Two-pass refactor settled the on-disk log layout:

**First pass (over-engineered, reverted)**: attached a
`:logger_std_h` handler in `Grappa.Application.start/2` writing
`runtime/log/grappa.log` AS WELL AS the rc.d-side `RELEASE_TMP`
redirecting run_erl's stdout tee to `runtime/log/log/erlang.log.*`.
Same lines on disk twice, two paths, two rotation sets. Revert
dropped the Elixir-side file sink (the run_erl tee covers the
prod role; in dev compose, Docker json-file driver covers it).

Two bugs surfaced during the first pass that earned commits even
after the revert:

1. **`runtime/log` as a relative path crashed prod** — `mix
   release` CWD is `_build/.../rel/grappa/`, not the repo root, so
   `File.mkdir_p!("runtime/log")` raised `:eacces` under the
   grappa user. `config/runtime.exs` now derives all on-disk
   defaults from `Path.dirname(database_path)` so anything new
   keys off an already-absolute path. (Footgun lives only in
   release builds — `mix phx.server` in dev hides it behind a
   sensible CWD.)

2. **`RELEASE_TMP='...' . envfile && cmd` doesn't persist** —
   POSIX `VAR=val cmd` syntax sets VAR only for the single `cmd`
   (here, the `.` source builtin). The subsequent `bin/grappa
   daemon` invocation saw the release's default `RELEASE_TMP`
   (`_build/.../rel/grappa/tmp`), confirmed via `procstat -e
   $BEAM_PID`. Fixed by switching to `export
   RELEASE_TMP='...';` as a separate statement in
   `infra/freebsd/rc.d/grappa`'s `grappa_runas/1`.

**Second pass (final layout)**: `RELEASE_TMP=runtime` (not
`runtime/log`) because run_erl ALWAYS creates its own `log/` and
`pipe/` subdirs under RELEASE_TMP. Setting RELEASE_TMP to
`runtime/log` produced the double-nested `runtime/log/log/`. The
final on-disk layout:

```
runtime/
├── log/erlang.log.*  ← run_erl tee of BEAM stdout
├── pipe/erlang.pipe.1.{r,w}  ← run_erl named pipe (bin/grappa remote)
├── grappa_prod.db (+ -shm + -wal)
├── uploads/
├── bun-cache/
└── cicchetto-dist/
```

`runtime/pid` would land here too if run_erl wrote one — the rc.d
declares `pidfile=$grappa_runtime_tmp/pid` but `service grappa
status` actually delegates to `bin/grappa pid` which queries epmd,
so the file is unused.

### CI flake side-fix

While the bastille work was landing, `admin_events_test.exs` setup
flunked with `SessionRegistry never drained — stale entries: [...]`
on 10 consecutive setups (run 26505322757). Same rotating-cascade
pattern as `feedback_ci_cascade_rotating_set` — green locally,
fails on GHA under coveralls load.

`Session.stop_session/2` returns once the worker pid is dead but
the Registry's OWN monitor-DOWN handler runs in its own process
and cleans the entry asynchronously. The setup's single 50ms
post-force-stop sleep was too tight on the loaded runner. Replaced
with a 200×10ms (2s) poll matching the upstream passive-wait shape.

### Lessons

- `mix release` and `mix phx.server` are NOT interchangeable boot
  paths for on-disk defaults — anything that mkdir_p's a relative
  path will silently work in dev and `:eacces` in prod release.
  Derive from already-absolute env-driven paths.
- Two parallel log sinks for the same stream is always a smell.
  When you find yourself with `app.log` AND `erlang.log` containing
  the same lines, pick the OTP-canonical one (run_erl tee in
  releases, Docker logs in containers) and drop the other.
- `VAR=val cmd` POSIX assignment is per-command. When `cmd` is
  `.` (source), the assignment dies with the source. Use `export
  VAR;` when the binding has to survive to a later command in the
  same line.

---

## 2026-05-27 — post-bastille runtime fixes: visitor rejoin, zombie respawn gate, VAPID-as-state

Three production-discovered classes, all caused by gaps that didn't
show up under pre-bastille operation. All fixed same day, all
cold-deployed to m42.

### Visitor channels rejoin: schema-parity with users

**Symptom:** visitor sessions respawn on bouncer restart but join
ZERO channels. Users rejoin correctly.

**Root cause:** `Grappa.Visitors.list_autojoin_channels/1` queried a
`visitor_channels` table that had been created back in
`20260502080806_create_visitor_channels.exs` but **never had a
writer**. The schema's own moduledoc admitted *"writes will land
when the visitor-rejoin-on-restart cluster lands a producer"* — that
cluster never landed. Independently, `Session.Server.persist_last_joined/4`
short-circuited visitor subjects via
`defp persist_last_joined({:visitor, _}, _, _, _), do: :ok` —
silent no-op.

**Fix:** schema-mirror parity with users. Migration
`20260527123810_visitors_last_joined_channels` adds
`visitors.last_joined_channels` (JSON array, same shape as the
existing `network_credentials.last_joined_channels`) and DROPs the
unused `visitor_channels` table. `Visitors.SessionPlan.build_plan/3`
now wires the canonical `last_joined_persister` closure pattern
that users have used since CP22. The visitor no-op in
`persist_last_joined/4` is gone — both subject classes route
through the same persistence code path.

**Apply rule:** when two subject classes (`{:user, _}` /
`{:visitor, _}`) share an architectural verb (autojoin
persistence, scrollback, read cursor), they MUST share a code
path. A discriminant `case` on subject_kind inside the verb is a
boundary violation — it lets one class silently degrade while
the other continues working.

### `Session.Server.init/1` subject-row-present gate

**Symptom (production incident):** `bin/grappa list-sessions`
showed a visitor pid alive WITHOUT a corresponding `visitors` row.
Operator-driven `Visitors.delete/1` + three admin DELETEs failed to
remove it. Backoff at 25 minutes (failure_count=9). No clean
shutdown short of full app restart.

**Root cause:** `Session.Server` is a `:transient` child of
`Grappa.SessionSupervisor` (DynamicSupervisor). When an upstream
failure (typical: 433 nick-in-use against a logged-in user with the
same nick) crashes the Server, the supervisor schedules a restart.
The operator-driven `DELETE /admin/sessions/:id` calls
`Session.stop_session/2` which races the supervisor's restart
window — `whereis → nil` between the dying pid and the new one,
`stop_session` returns `:ok`, and an instant later the new pid
registers itself with cached `init_opts` referencing a now-deleted
DB row. Loop continues at exponential backoff until cap.

Same mechanism that poisoned the CI singleton-lane
`AdminEventsTest` (see `feedback_session_fixture_on_exit_cleanup`),
but in production with no test-harness `on_exit` to save it.

**Fix:** `Session.Server.init/1` consults an optional
`subject_row_present?` closure at the top of init. When it returns
`false`, init returns `:ignore` — which is a NORMAL-shutdown signal
to `:transient`, so DynamicSupervisor drops the child PERMANENTLY
instead of looping. Both `Networks.SessionPlan.build_plan/4` and
`Visitors.SessionPlan.build_plan/3` supply the closure (calls
`Credentials.get_credential_by_ids/2` and `Visitors.get/1`
respectively). Boundary-clean: same opaque function-ref pattern as
`credential_failer` + `last_joined_persister`.

Plumbing extends through the spawn chain:
- `SpawnOrchestrator.spawn/4` adds `{:ok, :ignored}` outcome.
- `Bootstrap.Result` adds `subject_row_gone` counter + log line.
- `NetworksController` maps `:ignored` → `{:error, :not_found}`
  (likely a racing unbind during `PATCH /connect`).
- `Visitors.Login` maps to `:upstream_unreachable`.

**Apply rule:** any `:transient` GenServer whose `init/1` depends on
DB state MUST verify that state at init time — never trust cached
`init_opts` across restarts. The supervisor restart is a fresh
process; treat it as one.

### VAPID keys are state, not deployment config

**Symptom:** post-bastille migration, push notifications fail with
FCM 403 and Apple Web Push 400 on every subscription. Service
worker registered cleanly; subscriptions persist in the DB; sends
never arrive.

**Root cause:** during bastille deploy `mix grappa.gen_vapid` was
run to populate the new jail's env, generating a fresh ECDSA P-256
keypair (`BKSBT...`). The existing `push_subscriptions` rows had
been firmed by browsers against the Docker prod keypair
(`BFslT...`) and replicated verbatim by the DB migration. Push
services (FCM, Apple, Mozilla autopush) reject deliveries whose
VAPID JWT is signed by a different key than the one the
subscription was created against — that's the whole point of VAPID
identification.

**Fix:** swapped `VAPID_PUBLIC_KEY` + `VAPID_PRIVATE_KEY` in
`/usr/local/etc/grappa/grappa.env` with the Docker values; clean
restart of grappa. Existing subscriptions recovered immediately.

**Apply rule:** treat the VAPID keypair as application STATE
(alongside `GRAPPA_ENCRYPTION_KEY`, `SECRET_KEY_BASE`,
`RELEASE_COOKIE`), NOT as deployment configuration that can be
freshly generated per host. Cross-substrate migration must copy
the keypair verbatim. `mix grappa.gen_vapid` is a first-time-only
install primitive; running it against an existing DB invalidates
every push subscription with no recovery path short of forcing
every user to re-subscribe.

## 2026-05-27 — `refresh_plan` closure ends the zombie-respawn-with-stale-state class

**Symptom (Azzurra `kazamobile`/`kazam02` incident):** visitor
`31f1d0d9-…` connects to Azzurra with boot-time nick `kazam02`,
issues `/NICK kazamobile` → `visitors.nick` rotated to
`kazamobile`, joins `#sniffo` / `#sbiffo` → `last_joined_channels`
rotated. Upstream `:ssl_closed` 22 minutes later → Session.Server
crashes → `:transient` restart replays cached `init_opts` with
nick=`kazam02` + autojoin=`[]`. New session registers upstream as
`kazam02`, joins nothing. DB says `kazamobile`/3 channels; live
state says `kazam02`/0 channels. User's browser sees an empty
sidebar.

**Root cause:** `DynamicSupervisor.start_child/2` caches the
original child spec at spawn time. The `:transient` restart
replays the SAME `{Server, opts}` — no DB re-read, no plan
refresh. Documented as a known trade-off in `Session.Server`
moduledoc since Phase 1 ("`Session.refresh/2` if hot-reload is
needed" was the punt). Every persisted DB rotation
(`Visitors.update_nick/2`, `Credentials.update_last_joined_channels/3`,
operator config edits) freezes at boot until the operator forces
a respawn through the live BEAM.

**Fix:** generalize the prior `subject_row_present?` closure
(cluster cp51, S2 — operator-delete fail-fast) into
`refresh_plan` with strictly more informative shape:

```elixir
# Was: (-> boolean())   — "is the row still here?"
# Now: (-> {:ok, plan} | {:error, :not_found})
#      — "give me the fresh plan, or tell me the row is gone"
```

`Session.Server.init/1` runs the closure on EVERY init (boot AND
`:transient` restart). On `{:ok, fresh}`, `Map.merge(opts, fresh)`
so DB values win on shared keys (`:nick`, `:autojoin_channels`,
`:password`, `:host`, `:port`, `:tls`) while opts-only keys
(`:network_id`, `:notify_pid`, test fixtures) survive. On
`{:error, :not_found}`, `:ignore` → DynamicSupervisor drops the
child (same outcome as the prior false-branch, single mechanism
now). `Networks.SessionPlan` and `Visitors.SessionPlan` both
inject the closure; closure body re-fetches the row (by
`(user_id, network_id)` or `visitor.id`) and re-invokes
`resolve/1` so `pick_server!`, `Cloak`-decryption, and
`merge_autojoin` all run with current data.

**Why not a separate `Session.refresh/2` verb (the original Phase
5 punt):** that would be a manual operator action — the zombie
sits in production until someone notices and intervenes. The
closure runs on the supervisor's existing restart trigger, so
recovery is automatic on the very next crash cycle. Strictly
better, same surface area.

**Apply rule:** any future per-session state that derives from
DB rows (credentials, visitors, network config) should flow
through `refresh_plan` — never bake the value into the child
spec at spawn time. The pattern is reusable: producer modules
own the resolution, Session.Server consumes opaque closures, no
boundary cycle, no operator intervention required for staleness
recovery.

---

## 2026-05-31 — admin panel CRUD cluster CLOSED

Closes the M-cluster gap where `mix grappa.create_user`,
`mix grappa.bind_network`, `mix grappa.add_server`, etc. were the
ONLY mutation surface — admin REST was read-only-plus-narrow-PATCH.
Six buckets, all hot deploys, no migration. Mix tasks retained for
operator scripting; REST endpoints share the same context functions.

### Buckets

* **B1** — Network + Server CRUD context + REST (commit `00cfbf8`).
  `Networks.create_network/1` + `delete_network/1` (with
  `:credentials_present` + `:scrollback_present` refusals);
  `Servers.update_server/2`, `delete_server/1`, `get_server/2`.
  POST/DELETE `/admin/networks`; POST/PUT/DELETE
  `/admin/networks/:nid/servers/:id`. New `Servers.AdminWire`
  module + extended `FallbackController` (`:credentials_present`
  tuple + `:already_exists`).
* **B2** — User CRUD + last-admin guard + password rotation
  (commit `7157c2e`). `Accounts.delete_user/1` cascades to
  bearer-auth sessions + scrollback + credentials atomically;
  `update_admin_flags/2` extended with `:last_admin` guard at the
  context boundary; `update_password/2` + dedicated `PUT
  /admin/users/:id/password` endpoint. Self-rotation allowed; last-
  admin demotion / delete refused. FallbackController gets
  `:last_admin` → 422.
* **B3** — Credentials full CRUD + session-lifecycle wrapper
  (commit `fd33f81`). `Credentials.update_credential_with_session_lifecycle/3`
  wraps `update_credential/3` with an A-2 decision table: password
  / auth_method change ON a live session → `Session.stop_session/2`
  (operator re-`/connect`s); cosmetic-only fields → `:left_alone`.
  Wire field `session_action:` surfaces the side-effect.
* **B4** — AdminEvents broadcasts (commit `81dd7e7`). 11 new
  constructors in `Grappa.AdminEvents.Wire`: `:user_created`,
  `:user_updated`, `:user_password_changed`, `:user_deleted`,
  `:network_created`, `:network_deleted`, `:server_added`,
  `:server_updated`, `:server_removed`, `:credential_bound`,
  `:credential_updated`, `:credential_unbound`. All gated by
  `validate_admin_actor/2` (non-nil operator required —
  `:admin_authn` upstream guarantees it). Cic mirrors:
  `WireAdminEvent` union + `narrowAdminEvent` runtime narrower +
  `ingest()` dispatch + `renderEvent` human strings + regenerated
  `wireTypes.ts` codegen. `tsc`'s `assertNever` enforces 4-way
  parity (cic + server + narrower + renderer).
* **B5** — cic UI (commit `311faa3`). Three tabs:
  `AdminUsersTab` (list + header create-form + per-row
  Promote/Demote + Rotate password inline + Delete InlineConfirm),
  `AdminCredentialsTab` (triple-fetch on mount; bind form + edit
  with patch-diff + session_action toast + unbind), and extended
  `AdminNetworksTab` (header create-form + per-row Delete with
  409-aware "N bound credential(s)" message + Servers disclosure
  per-row that lazily fetches `GET /admin/networks/:nid/servers`
  + add-server form + per-server TLS toggle + delete). Typed API
  helpers in `cicchetto/src/lib/api.ts` mirror every endpoint.
* **B6** — Playwright e2e + docs + final deploy (this entry).
  Four new specs (`admin-users`, `admin-credentials`,
  `admin-network-crud`, `admin-server-crud`); each spec
  best-effort-cleans its created rows. Browser smoke = the
  Playwright walks themselves.

### Design decisions captured at plan time

A-1..A-9. The ones with durable WHY:

- **A-2 (credential update lifecycle):** a password / auth_method change
  kills + respawns the session; a `nick` change leaves the live
  `Session.Server` alone and returns `session_restart_required: true`
  (server-side rename is `/nick`-routed, not credential-routed); cosmetic
  edits leave it silently.
- **A-4 (last-admin invariant):** `Accounts.update_admin_flags/2` +
  `delete_user/1` refuse to demote/delete the SOLE admin (`{:error,
  :last_admin}` → 422) — else the deployment locks itself out of its own
  admin panel. Self-demotion is fine when another admin exists ("last
  admin", not "self"). The guard counts other admins BEFORE the update;
  SQLite's single-writer model serializes the demote-the-last-two race
  naturally — a future Postgres migration would need an advisory lock
  (caveat lives in the `update_admin_flags/2` moduledoc).
- **A-5 (network delete):** 409 when credentials are bound; no
  `?force=true` cascade (a footgun — same rationale as the bind-time
  wrapper note above).
- Rest — A-1 (PubSub admin-event broadcast), A-3 (split password
  endpoint), A-6 (leave the live session alone on server delete), A-7
  (per-resource `*.Wire` modules), A-8 (auth_method enum reuse), A-9
  (composite vs surrogate credential id) — are mechanical; they live in
  the controllers, schema, and `*.Wire` modules.

### Why two batched deploys instead of six

Buckets 1-3 + bucket 4 each deploy independently (REST + wire
extensions are backwards-compatible); buckets 5-6 ship together
because the cic UI (B5) only works against B4-emitted events and
the e2e specs (B6) exercise the full surface end-to-end. The
operator can roll back the cic bundle independently of the BEAM
release — `scripts/deploy-cic.sh` is decoupled — so the two-deploy
cadence preserves rollback granularity at the seam where it matters
most (server vs client).

---

## 2026-05-31 — Visitor session sharing via one-time link

Closing the multi-device gap for anonymous users. Pre-change: a
visitor opens cic on a second device, types the same nick → 409
`anon_collision` because `Visitors.Login` tries to provision a fresh
visitor row and hits the `(nick, network_slug)` unique constraint.
Registered users with a password just log in twice; visitors have no
password, so the link IS the auth mechanism.

### Mental model

Same as a user opening multiple browser tabs — both devices stay
connected, both subscribe to the same PubSub topics
(`grappa:user:visitor:<id>/...`), both see real-time fan-out. The
difference is the credential exchange: mint a signed token on
device A, redeem it on device B, both end up holding distinct
`accounts_sessions` rows pointing to the SAME `visitors.id`.

This is sharing, NOT transfer — device A's bearer stays alive.

### Architecture

Token storage: **Phoenix.Token + supervised ETS one-shot set.**
Zero migrations, HOT-deploy-friendly *at the schema level*. ETS
over DB because the threat model is benign (operator clicks own
link twice), TTL is short (10 min), and losing the consumed-set
on BEAM restart opens at most a TTL-bounded reuse window for
already-signed tokens — acceptable. Future DB-backed hardening
(`visitor_share_tokens` table with `consumed_at` + reaper) is a
mechanical migration if the threat model ever shifts.

Supervision: new `Grappa.Visitors.ShareTokens` GenServer owns
ETS table `:visitor_share_tokens_used`. Sits before Endpoint in
the boot order alongside the other ETS singletons (Backoff,
NetworkCircuit) — consume controller can never race a missing
table.

### Endpoints

* `POST /me/share-token` — authenticated (`:authn`), visitor-only
  (user subject → 403 `forbidden`). Returns `{token, expires_at}`.
  `token` is `Phoenix.Token.sign(endpoint, "visitor-share-v1",
  visitor.id)` with `max_age: 600`. `expires_at` is the absolute
  UTC ISO8601 timestamp for the cic countdown.
* `POST /auth/share/consume` — UNAUTHENTICATED (the signed token
  IS the credential). Body `{token}`. Flow:
  1. `Phoenix.Token.verify` — bad sig → 401, expired → 410
     `share_token_expired`.
  2. `ShareTokens.mark_consumed/1` — atomic `:ets.insert_new/2`;
     collision → 410 `share_token_consumed`.
  3. `Visitors.get/1` — visitor reaped mid-window → 404 `not_found`.
  4. `Accounts.create_session({:visitor, id}, ip, ua, client_id)`
     — fresh bearer minted for the SAME visitor row.

  Returns the same shape as `/auth/login`:
  `{token, subject: {kind: "visitor", id, nick, network_slug}}`.

The 410 wire-shape atoms split (`share_token_expired` vs
`share_token_consumed`) deliberately — both are "permanently
unusable" semantically, but cic copy + telemetry need to tell
them apart. Lifted at the controller boundary via a private
helper so the ETS module's `{:error, :already_consumed}` contract
stays oblivious to HTTP wire strings.

### cic side

* SettingsDrawer gains a visitor-only "share session" button
  (gated on `getSubject()?.kind === "visitor"`).
* `ShareSessionModal` mints on open, displays URL +
  copy-to-clipboard + live countdown. Refetches a fresh token per
  open transition (closing + reopening orphans the previous URL —
  acceptable; alternative would be silently invalidating a
  clipboard-only URL the operator may still be carrying).
* SPA route `/share/:token` (plain path, NOT hash — @solidjs/router
  v0.16 uses path mode by default; nginx falls back to index.html
  per `try_files $uri /index.html` in the shared
  `infra/snippets/locations-api.conf`). Auto-consumes on mount;
  on success writes `grappa-token` + `grappa-subject` via the new
  `installSharedSession()` helper in `auth.ts` (symmetric with
  what `login()` does, transactional pair) and navigates to `/`.
* Error paths surface the wire-shape atom inline (`share_token_
  expired`, `share_token_consumed`, `not_found`, `unauthorized`)
  so the user can tell "link expired" from "already used elsewhere."
  Both 410 server-side; the atom is the only distinguisher.

### Multi-device WS fan-out

Both devices hold tokens that resolve to the SAME visitor row →
both UserSocket connections assign the same
`user_name = "visitor:<id>"` → both subscribe to the same PubSub
topics → fan-out is automatic via `phoenix.js` fastlane. Channel
join authz in `grappa_channel.ex:200-207` compares the topic's
user prefix to `socket.assigns.user_name`; both sockets pass the
same gate. No channel-auth changes needed.

### Telemetry

`[:grappa, :visitor, :share_token, :minted | :consumed | :rejected]`.
`:rejected` carries `metadata.reason` so PromEx can bucket the
four failure modes (`:unauthorized`, `:share_token_expired`,
`:share_token_consumed`, `:not_found`) separately.

### Out-of-scope

* No rate limit beyond the global `Plug.Throttle` baseline. The
  bearer-protected `/me/share-token` is gated by `:authn`; the
  unauthenticated `/auth/share/consume` reaches a 401 / 410 with
  no DB-side work for invalid tokens (`Phoenix.Token.verify` is
  HMAC-only, no DB roundtrip).
* No "list active share tokens" admin surface. ETS lookup-by-token
  is the only access pattern; surfacing the set would require
  iterating + binding to the visitor it was minted for, which the
  signed-token-only design doesn't naturally support. If operators
  start needing this, that's the signal to switch to the DB-table
  variant.
* No PubSub broadcast on mint/consume. The visitor doesn't need
  to know "another device just joined" — both devices see the
  same scrollback, that IS the signal.

### HOT-vs-COLD deploy decision (load-bearing)

ETS + Phoenix.Token = zero migration, no `@type t :: ...` field
additions, no schema changes. The ONE supervision-tree change
(adding `Grappa.Visitors.ShareTokens` as a new child) is the
classic HOT-deploy footgun: `Phoenix.CodeReloader.reload!/1`
recompiles modules but does NOT call `Application.start/2` again,
so a newly-added supervised child is NOT spawned on a HOT reload.
The consume controller's first call would crash with `ArgumentError`
on the missing ETS table. Per
`feedback_hot_deploy_corrupts_build_prod`: this is a class of
diff that requires `--force-cold` despite passing the deploy.sh
preflight (which looks for `@type` field-add patterns + schema
files, not supervision-tree shape). Flagged to vjt at deploy time
per the bucket-8 plan — recommend COLD.


## 2026-06-02 — Scrollback scroll paths are INSTANT, never `behavior:"smooth"`

The cic `ScrollbackPane` `[data-testid="scrollback"]` <div> is the SAME
DOM node across `selectedChannel` changes (Shell.tsx bundles
channel|query|server into one non-keyed `<Match>`, required for the
BUGHUNT-2 leave-arm cursor write). Anything ASYNC on that node survives
a window swap and races the next window's `scrollToActivation` snap.

`scrollToBottom` (the C7.4 floating button) was the lone violator —
`scrollTo({behavior:"smooth"})` starts a browser animation that outlives
the tap. On real iOS Safari (`-webkit-overflow-scrolling: touch` +
momentum) the surviving animation failed to reconcile with the return
snap → blank pane, restored only by a manual scroll. vjt prod-reported
+ confirmed fixed on device.

**Apply rule:** every scroll write in ScrollbackPane is INSTANT
(`tail.scrollIntoView({block:"end"})` or `scrollTop = scrollHeight`),
never `behavior:"smooth"`. Instant completes synchronously, so nothing
is in flight when the node's content swaps. `scrollToActivation` and
the post-append effect already followed this; the button now does too.
Do not reintroduce smooth scrolling on the shared node.

NOTE: NOT reproducible in Playwright (chromium OR webkit-iphone-15) —
Playwright's bundled WebKit doesn't model real iOS scroll physics.
Verify scroll/touch fixes on a real device. See memory
`feedback_playwright_webkit_not_ios_scroll`.


## 2026-06-03 — Fresh-channel open baselines the read cursor to the backlog tail (RC2)

The unread-badge-from-cursor cluster derives a channel's badge purely
from the server-owned read cursor (`unread_count` = rows with
`id > cursor`; nil cursor = whole backlog). RC1 made the focused window
drop its badge on select; RC2 closes the last red integration spec
(`m2-irssi-to-chan-defocused`): a channel visited then DEFOCUSED before
its 200-row REST backlog hydrated left the cursor nil, so the badge
counted the whole backlog + the next inbound msg → "201" instead of "1".

Fix (`scrollback.ts` `loadInitialScrollback`): after merging the loaded
page, baseline the cursor to the page's MAX id when the channel has no
cursor yet (`getReadCursor === null`).

Two non-obvious constraints make this correct:

- **Tail comes from the loaded REST page, never the store-after-merge.**
  A live WS PRIVMSG can append to the store *during* the load; deriving
  the baseline from the store would mark that new message read (badge
  "0"). The REST page and the WS append are disjoint paths
  (`listMessages` return value vs `appendToScrollback`), so the page max
  excludes any concurrently-arriving message — it stays unread.

- **The baseline is load-bearing on "fresh open scrolls to the newest
  row."** Marking the ENTIRE backlog read is only honest because opening
  a channel auto-scrolls to the bottom (`scrollToActivation`), so the
  operator IS looking at the newest line. If a future change lands a
  fresh open mid-history (jump-to-first-unread, deep-link to an old
  message), this baseline would over-mark — revisit it together with any
  such scroll-position change. The cursor-honest invariant couples the
  two.

Gated on `=== null` (not the forward-only gate `sendMessage` uses) so a
channel that already has a read position keeps it — the in-pane
`── XX unread ──` marker survives a re-open. Fires on load COMPLETION,
so it beats the leave-race; and `loadInitialScrollback` fires only on
focus, so unfocused new DMs stay unmarked. Validated on the RPi local
e2e: m2 green + full chromium+webkit suite 215 passed.


## 2026-06-03 — Per-server fixed outbound source address

Adds a nullable `source_address` column to `network_servers` so an
operator can pin the outbound TCP source IP for a specific server entry.
Full spec at `docs/superpowers/specs/2026-06-03-per-server-source-address-design.md`.

### Why per-server, not per-network or per-credential

The IRC server is the TCP connect target. Source binding is inherently
a TCP-layer decision made at connect time, against a specific host:port.
A network (`networks` row) groups several server alternatives; a
credential (`network_servers_credentials`) is the auth identity. Neither
is the right granularity — the source IP is a property of the outbound
socket to a particular endpoint, so it lives on the server row. An
operator running two server entries for the same network can pin
different IPs to each (primary vs. fallback via different VPS
interfaces), or pin one and leave the other pool-delegated.

### Validation — literal IP only, stored canonical

`network_servers` changesets reject anything that isn't a strict literal
IPv4 or IPv6 address. `:inet.parse_ipv4strict_address/1` and
`:inet.parse_ipv6strict_address/1` are the validators — they reject
hostnames, CIDRs, zero-padded octets, and empty strings. The address is
stored canonical via `:inet.ntoa/1` so the same IP always has the same
DB representation regardless of how the operator typed it. NULL means
"no source binding; use the kernel default or the outbound IPv6 pool."

### Connect path — hard mismatch error, no silent fallback

When `source_address` is set, `IRC.Client` derives the address family
from the literal, then resolves the upstream host using
`:inet.getaddr/2` in that same family to confirm reachability. A family
mismatch — IPv4 source against a host that only resolves in IPv6, or
vice versa — returns `{:error, {:source_family_mismatch, source, host,
family}}` and routes through the existing connect-fail throttle. There
is no silent fallback to the unbound path; the misconfiguration is loud
and logged.

The NULL-source path for pool-assigned IPv6 addresses continues to use
`:inet_res.lookup/3` (pure DNS, skips /etc/hosts and numeric literals).
The fixed-source path uses `:inet.getaddr/2` instead, for a deliberate
reason: if the upstream host is a numeric literal or a /etc/hosts entry,
`:inet_res.lookup/3` returns an empty list — which would spuriously trip
the family-mismatch guard on every connect. `:inet.getaddr/2` resolves
numeric literals + /etc/hosts AND answers the "is this host reachable in
family F?" question correctly. The IPv4 source-bind path is new (the
prior codebase only had IPv6 pool binding); both paths now share the
`ifaddr:` option on the `:gen_tcp.connect/4` call.

### Visitor-pool exclusion — subtract, never assert

`Grappa.OutboundV6Pool.apply_exclusions/1` computes the effective pool
as `raw_pool − fixed_sources` (tuple-normalized, idempotent). Before
spawning any session, `Grappa.Bootstrap` collects every configured
`source_address` across all network servers, calls
`apply_exclusions/1`, and passes the reduced effective pool to
`OutboundV6Pool`. The subtraction is silent — an IP that appears as
both a pool entry and a fixed `source_address` is excluded from
rotation without noise, and an IP that is a fixed source but was never
in the pool is equally harmless. The boot log reports configured,
excluded, and effective counts, and flags any dedicated-not-in-pool
addresses. Pool-absent fixed sources are not an error.

The exclusion is computed once, at boot. Adding (via `mix
grappa.add_server --source` / `bind_network --source`) a fixed source
that *overlaps* `GRAPPA_OUTBOUND_V6_POOL` to an already-running node
writes the DB row immediately but does not refresh the live effective
pool — only `Bootstrap` refines it, so the overlapping IP leaves the
rotation on the next node restart. This is the unusual case (it requires
the dedicated IP to also be in the env pool, which the provisioning
notice already flags); the standard workflow is add-then-restart.

This means the visitor pool can never accidentally draw a dedicated
operator IP. However, the guarantee is scoped to the pool: the bind is
per-server, so any session that connects via a `source_address`-pinned
server row uses that IP regardless of whether the session belongs to a
registered user or a visitor. Keeping visitors off dedicated-operator
networks is the operator's configuration responsibility — point visitor
provisioning at networks whose server entries have no `source_address`.
The exclusion logic protects the pool; it does not stop an operator
from deliberately (or inadvertently) routing visitors through a
dedicated-source server.

### Config surface

`mix grappa.add_server --source <ip>` and `mix grappa.bind_network
--source <ip>` both accept and validate via the same changeset. Invalid
input halts loudly. The task emits an informational notice when
`--source` is also present in `GRAPPA_OUTBOUND_V6_POOL`, since that
configuration means the address will be excluded from the pool at boot
— not an error, but worth flagging to the operator at provisioning
time.

## 2026-06-04 — Prod deployment: vjt on a dedicated source (`::42`)

First real use of the per-server `source_address` feature in prod.
Goal: vjt's outbound IRC appears from a stable dedicated IP
(`2a03:4000:2:33c::42`, rDNS `m42.openssl.it`) while visitors keep
rotating `GRAPPA_OUTBOUND_V6_POOL`. Operator runbook for the mechanics
lives in `docs/OPERATIONS.md` (m42 section); this entry records the
decisions.

### Why a second `azzurra` network row (`azzurra-vjt`)

`source_address` is per-server and `Servers.pick_server!/1` picks ONE
server per network, so vjt and visitors — both on `azzurra` — could not
get different sources from the same network row. Visitors are
compile-pinned to `:visitor_network = "azzurra"` (`config/config.exs`,
`Application.compile_env!`), so changing the visitor side needs a cold
rebuild. The cheaper move (no rebuild): create `azzurra-vjt`
(network_id 2, same `irc.azzurra.chat:6697`, `source_address=::42`),
rebind vjt to it, leave visitors on `azzurra` (network_id 1, pool).

### Scrollback is per-subject, so the move is migratable

`messages`/`read_cursors`/`query_windows` are keyed by `network_id` +
`user_id`/`visitor_id`. vjt's history (17,237 msgs, 47 cursors, 1
window) was re-keyed `network_id 1 → 2` via `Repo.update_all` filtered
on `user_id`, leaving visitor rows on net 1 untouched. Message ids are
stable across the re-key so `read_cursors.last_read_message_id` FKs
survive. Done on the live node after `Session.stop_session` quiesced
vjt's net-1 session.

### `unbind_credential/2` can't drop the last user on a network with
scrollback

Removing vjt from `azzurra` via `unbind_credential/2` would hit the
cascade-on-empty path (no user-credentials left → try to delete the
network) and roll back with `:scrollback_present` (net 1 still has
visitor messages; `messages.network_id` FK is `:restrict`). It can't
remove *just* the binding. A network used only by visitors looks
"userless" to this check — a latent gap. Workaround used: delete the
credential row directly + `Session.stop_session`, keeping `azzurra`
alive for visitors. (Candidate follow-up: teach unbind that visitor
presence counts, or add a "detach user, keep network" verb.)

### Sharing the host's primary IP into a shared-IP jail is safe

`::42` is the host's primary (`/etc/rc.conf ifconfig_vtnet0_ipv6`,
`prefixlen 64`), not a pool `/128`. The grappa jail is shared-IP
(`ip6=new`, `interface=vtnet0`). Concern: a jail stop stripping `::42`
off `vtnet0` would kill host connectivity. **Validated empirically on a
throwaway address: `jail(8)` only removes addresses it ADDED at jail
start — an address the host already owned (present before the jail
starts) survives jail teardown.** Since rc.conf assigns `::42` at boot
before bastille starts jails, the jail never owns it → never strips it.
Added as `vtnet0|::42/64` (match host prefixlen — `/128` would collide
with the host's on-link `/64` route) via `jail.conf` + live `jail -m`.
The `exec.poststop` guard considered earlier was dropped as unnecessary.

### Incident: `service grappa restart` node-name race → ~2 min outage

The restart to spawn vjt's new session aborted boot with `the name
grappa@grappa seems to be in use by another Erlang node` — the stopping
node hadn't released the sname before the new one bound it. The BEAM was
down ~1–2 min until caught (status `stopped` + empty healthz). epmd was
already clean; a plain `service grappa start` recovered. Lesson logged
in OPERATIONS: prefer stop→verify-clean→start over `restart` on this
substrate. (Separately: a password rotation mid-session invalidated
vjt's cic token; the looping client tripped host fail2ban `http-404`,
which looked like a hung BEAM but was an IP ban — see OPERATIONS
fail2ban note.)

## 2026-06-23 — shottino: click-to-preview media (text-only rule lifted, scoped)

vjt asked for image (and video) link previews in `shottino`, the C/ncurses
terminal client. This intersects the **"IRC stays text only"** engineering
rule in `CLAUDE.md` (no in-scrollback thumbnails / preview cards / lightbox).
That rule is written for `cicchetto`'s scrollback and the broadcast-on-the-wire
model; per its own escape hatch ("without an explicit cluster spec lifting this
rule"), vjt explicitly authorized lifting it **for shottino only**. Scope of the
lift, and why it does not erode the invariant elsewhere:

- **Scrollback stays text.** Messages still render as text; image/video URLs
  remain clickable links exactly as before. Nothing is rendered inline, on
  arrival, or automatically. The preview is an **explicit, user-initiated
  modal** — you click a link, a full-screen frame is shown, any key dismisses
  it and the chat repaints. No autoplay, no on-arrival cards, no lightbox.
- **Nothing crosses the wire.** This is a pure client-side affordance over the
  same typed JSON shottino already consumes; no new server surface, no payload
  shape change, no PubSub event. The cic-side invariant is untouched.
- **No new client IRC parsing.** URL detection reuses the existing
  `find_url` / `looks_like_image_url` heuristics already used to colorize links.

Implementation (single-file `frontends/shottino/shottino.c`):

- **Render via external tools, not vendored decoders.** `ffmpeg` does the
  network fetch + decode + frame extraction to a temp PNG (one path for both
  images and video — video uses the `thumbnail` filter to skip leader frames);
  `chafa` renders the PNG and auto-detects the terminal graphics protocol
  (Kitty > iTerm2 > Sixel > symbols). Both are **optional runtime deps**,
  probed on PATH; if either is missing the click falls back to the existing
  `xdg-open` path with a one-line hint. This avoids linking libpng/jpeg/webp +
  three protocol encoders into the client, and avoids reimplementing an HTTP
  client for arbitrary hosts (a security surface). Subprocesses are spawned
  with `fork`+`execvp` (argv array, no shell) so the URL can't be injected.
- **Click, not passive hover.** shottino repaints the whole screen every 50 ms;
  passive xterm-1003 hover-to-render fights that repaint and smears real
  graphics, so the trigger is a left-click on a media link. Mouse motion still
  drives a lightweight "click to preview: <url>" hint on the chrome line as
  mouse-over feedback. Mouse reporting (1000/1003/1006) is enabled while
  shottino owns the screen and disabled around the modal and at shutdown.
  Trade-off accepted: 1003 motion reporting suppresses the terminal's native
  text selection while shottino runs (Shift-drag still works in most terminals).
- **Click→URL mapping without re-deriving layout.** `draw()` records the screen
  rectangle of each media link into `app->link_regions` (reset per frame); a
  mouse event maps `(x,y)` back to the URL. Coarse by design — clicking
  anywhere on a media message previews its first media URL.
- **Modal isolation.** The preview leaves ncurses (`def_prog_mode`+`endwin`) so
  chafa sees a real tty, reads one raw dismiss key, deletes any Kitty image
  placements, then restores ncurses with a forced full repaint.

If a future cluster wants the same in cic, it does NOT inherit this lift — cic's
text-only scrollback rule stands until separately specified.

## 2026-06-08 — Unread-divider freeze contract (cic) + read-cursor cadence relocated here

Relocated from CLAUDE.md (it was over-specified there and had gone
stale — it claimed settle = "focus-leave, browser-blur" only, omitting
scroll-settle and this freeze). CLAUDE.md now keeps just the durable
invariant (read state server-owned, per (subject, network, channel);
`last_read_message_id` FK; removing server-side cursor is breaking).
The **mechanics** live here.

### Read-cursor write cadence (cic ↔ server)

The cursor is server-owned. cic HYDRATES it from three sources: the
`/me` envelope at login (`applyMeEnvelope`), the per-channel Phoenix
join reply (`applyJoinReply` — refresh on every rejoin/reconnect), and
live `read_cursor_set` WS events (`applyReadCursorSet` — cross-device
sync). cic WRITES it forward-only (`setCursorIfAdvances` →
`setReadCursor` POST → `Grappa.ReadCursor.set/4`, last-write-wins) on
settle events: scroll-settle (500ms debounce, gated on recent operator
input), focus-leave (channel switch), browser-blur (tab hidden / app
switch), and send-in-focused-window. The server's `read_cursor_set`
broadcast feeds the new id back into the signal map for BOTH the
originating device and any peers — single applier path. Phase 6 will
expose the same cursor as `+draft/read-marker` MARKREAD on the listener
facade.

### The divider FREEZE contract (the actual decision)

Symptom (vjt): scrolling through an unread block yanked the in-pane
"── N unread ──" divider down under your eyes — the `rows()` memo read
the LIVE cursor, so a scroll-settle advance (or a cross-device
`read_cursor_set`) re-ran it mid-read and shrank/removed the marker.

Decision: the divider is FROZEN for the lifetime of a focus session.
It derives from a snapshot signal `markerCursorId` (the frozen BOTTOM
boundary), sibling to the pre-existing `sessionTopId` (frozen TOP
boundary). The snapshot re-latches to the live cursor on a focus
acquisition — channel-switch and tab/app visibility-return — AND on an
own send (the 2026-06-09 send-relatch entry below; a send is an explicit
caught-up action, so it hides the divider the same way a refocus does).
Chose option (b) "any step-away-and-back advances it" over (a)
"channel-switch only". The live cursor keeps advancing + POSTing as
above; only the DISPLAY is frozen, so sidebar badges + `selection.ts`
unread counts (which read the live signal map) stay current. PASSIVE
advances — scroll-settle echo, cross-device `read_cursor_set` — never
re-latch the snapshot; that is the freeze.

Asymmetry, deliberate: on visibility-return `sessionTopId` (top) is
PRESERVED — a brief blur is not "leaving the window", so messages that
arrived while hidden stay live-read, no fresh marker — while
`markerCursorId` (bottom) is RE-LATCHED so the divider settles to where
the cursor reached.

Why not suppress the broadcast instead (vjt asked): the server echo is
what keeps cic mirroring server-owned state (CLAUDE.md "cic never
originates state"). Killing it would break cross-device sync and re-focus
advance — the originating device's signal would go stale until reload, so
the divider would freeze *permanently*, not until refocus. The broadcast
is load-bearing: it is the server-owned source every device mirrors.
Freeze the display, not the transport. (Note: freezing the display does
NOT require suppressing the broadcast OR forgoing an optimistic local
write — the 2026-06-08 optimistic-advance entry below keeps the broadcast
and advances the originating device early on top of it; the two are
orthogonal.)

Cross-device tradeoff (accepted, vjt: "consistency"): cic cannot
distinguish an own scroll-settle echo from a peer's `read_cursor_set`
at the applier boundary (same wire bytes, no client_id tag), so the
freeze is uniform. A peer device reading the window no longer yanks
your divider live — it reflects on your next refocus. Distinguishing
the two would need client_id tagging on the broadcast (server + wire
change); rejected as heavier than the problem.

This REVISES the CP29 R-4 "Bug A" contract (which made the divider
disappear immediately on any live advance). Implementation +
freeze-safety reasoning: `cicchetto/src/ScrollbackPane.tsx` (the
`markerCursorId` signal doc + the cold-latch effect's read-guard-first
note); contract tests in `ScrollbackPane.test.tsx` (Bug A revised + the
three freeze tests; REV-G H23 updated to drive marker removal via a
focus-acquisition re-latch).

## 2026-06-08 — Optimistic forward-only read-cursor advance

Two unread bugs, one root cause. (1) Leaving a channel with nothing
unread flashed a sidebar badge for a frame. (2) An own-sent message
sometimes rendered above the `── N unread ──` divider after stepping to
another window and back.

Root cause: the local read-cursor signal (`readCursor.ts`) was
round-trip-only — `setReadCursor` POSTed, and the local map advanced only
when the server's `read_cursor_set` echo landed (`applyReadCursorSet`).
The interval between POST and echo is a stale-cursor window, and two
reactive readers fire inside it: the focused-window badge suppression in
`perChannelUnread` (drops synchronously when `selectedChannel` flips,
before the leave-arm's advance round-trips → briefly recomputes a
non-zero count) and the `markerCursorId` re-latch on focus acquisition
(reads the stale pre-send cursor when a return beats the echo → own
message counts as unread).

Fix: `setReadCursor` advances the local signal optimistically,
forward-only, before the POST — one place, every write path inherits it.
The advance lands in the same synchronous Solid flush as the
suppression-drop and the re-latch, so both read the fresh cursor and the
window closes.

This composes with the freeze-contract entry above; it does not reverse
it. The broadcast stays — it is the server-owned source every device
mirrors, the carrier for peer sets, and the only path that moves the
cursor backward (last-write-wins). The optimistic advance only lets the
ORIGINATING device skip its own round-trip latency, and the echo then
re-affirms the same id; cic is reflecting its own server-bound write
early, not originating a value the server never got. The display freeze
is untouched: the divider reads the frozen `markerCursorId`, never the
live signal.

One tradeoff: a failed POST leaves the local cursor ahead of the server.
It is not reverted — a revert would clobber a concurrent forward advance
(the race forward-only exists to avoid). Because cic only ever writes ids
it has already read, the drift is bounded to already-read rows (new
arrivals still satisfy `id > cursor`) and re-aligns on the next forward
write or on `/me` / join-reply hydration.

Implementation: `readCursor.ts` (`setReadCursor` optimistic block).
Tests: `readCursor.test.ts` pins the forward-only advance at the
primitive (the deterministic guard); `unread-cursor-cluster.spec.ts`
sentinel 3 covers own-message + fast away-and-back. The badge flicker is
a sub-frame paint event Playwright can't observe — the unit test guards
its root cause.

## 2026-06-08 — Multiline compose → one PRIVMSG per line

ComposeBox submits on Enter and inserts a newline on Shift+Enter, so a
draft (or a pasted block) can hold embedded line breaks. Pre-fix the
whole body went as one PRIVMSG and the server rejected it as
`:invalid_line` — CR/LF are the IRC frame delimiters, forbidden inside a
frame (`Identifier.safe_line_token?` = `not String.contains?(s, ["\r",
"\n", "\x00"])`). The operator saw an "invalid" error and nothing sent.

A multiline body is the operator asking for one message per line. cic
splits client-side: `messageLines.ts` `splitMessageLines` splits on every
line-ending form (CRLF, lone CR, LF — all forbidden on the wire, so all
must split, not just LF) and drops blank lines (an empty PRIVMSG is
itself invalid). A shared `sendBodyLines` in compose.ts applies it to the
three free-text send sites: privmsg, /me (one ACTION per line), /msg.

Division of labor, deliberate: the CLIENT owns newline splitting because
only it knows the operator meant separate messages; the SERVER keeps
owning 512-byte length splitting for a single long line
(`lib/grappa/irc/line_split.ex`) because only it knows per-target frame
overhead. The server's `:invalid_line` guard stays — it is the backstop
that guarantees cic can never smuggle a raw CR/LF onto the wire.

Accepted edges: (1) sends are sequential and non-transactional — a
mid-fan-out POST failure leaves earlier lines sent and surfaces the error
with the full draft preserved, so a retry re-sends the delivered lines.
IRC has no atomic multi-send; partial delivery is the honest outcome.
(2) An empty `/me` (no text) now sends nothing instead of a degenerate
empty ACTION — a content-free action is not worth a frame.

Tests: `messageLines.test.ts` (pure splitter — LF/CRLF/CR/embedded-CR,
blank-drop, single-line identity), `compose.test.ts` (privmsg/me
fan-out + CRLF/blank handling), `multiline-compose-fanout` e2e (the real
server accepts the per-line sends end-to-end — jsdom can't prove that).

## 2026-06-09 — Send-relatch: hide the in-pane unread marker on a focused send

vjt prod report: a "── 1 unread ──" divider that didn't disappear when
he sent a new message in the focused channel. NOT a regression — it is
the freeze contract (the entry above) doing exactly what it says. The
in-pane divider derives from the FROZEN `markerCursorId` snapshot, which
re-latched only on a focus acquisition (channel-switch / visibility-
return). A send is neither, so the divider held until the next window-
switch. The 2026-06-08 optimistic-cursor advance did not cause this; it
made the refocus re-latch more reliable.

The tension is real, and both halves are vjt's: "don't move the divider
while I read" (freeze, cp56) vs "hide it when I send" (now). They can't
both be served by watching the cursor, because a send and a passive
scroll-settle BOTH advance the live cursor through the same
`setReadCursor` — indistinguishable at the cursor. The send has to mark
itself.

Decision: a focused own send re-latches the marker, the same way a
focus acquisition does. `sendMessage` (scrollback.ts) publishes its
channel-key on a new `lastOwnSend` signal — the one fact not otherwise
represented ("this advance was a send"). `ScrollbackPane` watches it and
runs the identical `setMarkerCursorId(getReadCursor(...))` re-latch when
the key matches THIS pane. Keyed, so a `/msg` to another window can't
collapse this pane's divider. Fired ONLY from the own-send path, so
passive advances (scroll-settle echo, cross-device `read_cursor_set`)
never trigger it — the freeze holds for everything except the operator's
own send.

`lastOwnSend` is an EVENT signal (`equals: false`), not a state cell.
Two sends to the same channel write the same key string; the default
`Object.is` dedup would drop the second, and the marker wouldn't re-hide
after the real sequence: send in #foo (hides) → switch away → peer
messages #foo → switch back (marker re-shows) → reply in #foo (same key).
Every send must notify. Bare channel-key string (no `{key,id}` object):
the effect re-latches to the LIVE `getReadCursor`, never the send id, so
the id would be dead weight — one signal, one writer, one reader.

Why a signal and not a derivation (vjt pushed on this): the only
this-device cursor advances are leave-arm, blur, scroll-settle, and
send; the first three are the PASSIVE ones the freeze deliberately keeps
frozen, so "did the cursor just move" can't tell a send apart. Deriving
from an own-nick row at the tail would ALSO fire on a cross-device own
send (own content from another device), which the freeze keeps frozen by
choice — and needs prev-tail diffing to spot a fresh row. The signal is
the lean, faithful mark.

This REFINES the freeze entry above (which is amended to list the own
send as a third re-latch trigger); it does not reverse it. Passive
advances stay frozen; only the explicit send un-freezes.

Implementation: `scrollback.ts` (`lastOwnSend` signal + `sendMessage`
publish), `ScrollbackPane.tsx` (the keyed re-latch effect). Tests:
`ScrollbackPane.test.tsx` (focused send collapses the marker; keyed
isolation — a different-window send leaves it frozen; dedup repro — a
repeat same-channel send re-hides a re-shown marker), `scrollback.test.ts`
(publishes on send incl. the cursor-skip branch; null with no token;
notifies on EVERY send incl. same-channel repeats). The sentinel-2 e2e
in `unread-cursor-cluster.spec.ts` — which the 2026-06-08 freeze work
had flipped to assert "send keeps it frozen" — is flipped back to the
new contract: a focused send collapses the marker immediately, no
window-switch.

## 2026-06-09 — Own /me classified :action (issue #14) + full mIRC render

Two CTCP/formatting display fixes. Issue #14 ("CTCP frames incl. /me
ACTION surface as raw PRIVMSG text") was triaged as a cic display-layer
gap; it was not. The screenshot symptom — `<nick> ACTION prova` — is
cic's PRIVMSG render branch (the `<…>` brackets), which only fires for a
`kind: :privmsg` row. The `:action` branch renders `* nick body` and was
already correct (M10, peer ACTION, is green). So the offending row was
PERSISTED as :privmsg.

Root cause was server-side and outbound-only.
`Session.Server.persist_and_send_fragments/4` — the self-echo persist
path for the operator's OWN sends — hardcoded `kind: :privmsg` and never
looked at the CTCP envelope. cic transmits a `/me` as
`\x01ACTION text\x01` in a PRIVMSG body, so the operator's own action
round-tripped as :privmsg and rendered raw. The INBOUND path
(`EventRouter.privmsg_default`) had classified ACTIONs correctly all
along — the two halves of every ACTION had simply drifted. M10's green
status masked it because M10 exercises the inbound function, a different
code path; the bug lives only on the outbound one, which is
target-agnostic (so it broke own `/me` in both channels AND queries,
exactly as the issue reported).

The "is this a CTCP ACTION frame?" predicate existed as TWO private
copies — `EventRouter.ctcp_action?/1` (lenient, prefix-only) and
`LineSplit.ctcp_action?/1` (additionally required a trailing `\x01`).
They were already inconsistent: LineSplit's stricter check meant a
leading-only ACTION over the fragmentation budget took the NAIVE split
path — the "garbage on the wire" case its own moduledoc warns against.
Collapsed both onto one source, `Grappa.IRC.CTCP.action?/1` (the lenient
prefix-only form; CTCP's closing delimiter is optional), now called from
three sites: inbound classify, outbound classify (the fix), and
envelope-preserving split. Single source for a wire-format question that
the Phase 6 IRCv3 listener facade will also ask. `Scrollback.dm_peer/4`
gets the real `kind` too — `:action` is already a dm-eligible kind, so
own action-DMs thread their peer correctly.

Division of labor stays: the SERVER classifies the kind (it owns the
wire), cic renders by kind (it owns the display). The raw `\x01` stays
in the stored body (round-trip fidelity); cic's `:action` branch strips
the envelope at render, unchanged.

### Full mIRC inline formatting render (Part B)

`mircFormat.ts` already did the toggles bold/italic/underline/reverse +
the 16-color `\x03` palette (clamped to 15). Extended to the full
de-facto control set: `\x04` hex color (`\x04RRGGBB[,RRGGBB]`, bare or
partial-hex = reset), `\x1e` strikethrough, `\x11` monospace, `\x03`
extended palette 16-98 (the modern ircdocs table, no longer clamped),
and `\x03` code 99 = the explicit "default" (reset).

One design move: COLOR RESOLUTION MOVED INTO THE PARSER. Pre-fix a Run
carried `fg: number` (a palette index) and ScrollbackPane's `renderRun`
did `MIRC_PALETTE_16[fg]`. Adding `\x04` hex would have forced a second
color representation (index vs literal) and pushed the palette table into
the render layer. Instead a Run now carries an already-resolved CSS color
string in `fg`/`bg` regardless of source, so `renderRun` is a dumb
applier and the palette lives entirely in the parser (CLAUDE.md "no
leaky abstractions"). The 99-entry palette and `\x04` hex both resolve to
`#rrggbb` before they ever reach the DOM. Cost: the existing color
vitest assertions moved from `fg: 4` to `fg: MIRC_PALETTE[4]` — clearer
intent, and they read the production constant rather than a magic hex.

Underline + strikethrough both want `text-decoration`, which a single
property can't merge across two separate class rules (last wins), so a
higher-specificity `.scrollback-mirc-underline.scrollback-mirc-strikethrough`
selector composes them. Formatting composes with the existing linkify +
ACTION-strip render paths — all three are render-time-only transforms on
a body whose raw bytes stay in scrollback.

Implementation: `lib/grappa/irc/ctcp.ex` (new shared classifier),
`server.ex` + `event_router.ex` + `line_split.ex` (migrate/fix),
`cicchetto/src/lib/mircFormat.ts` + `ScrollbackPane.tsx` + `default.css`.
Tests: `ctcp_test.exs` (the predicate), `server_test.exs` (own ACTION
persists :action — the regression), `mircFormat.test.ts` +
`ScrollbackPane.test.tsx` (the parser + render), and two e2e —
`issue14-own-action-render` (own `/me` renders `* nick`, never a privmsg
row) and `mirc-full-format-render` (strike/mono/hex spans in a real
browser, since jsdom is blind to CSS).

## 2026-06-09 — cic build to zero warnings (vite 8 / rolldown)

`scripts/bun.sh run build` (tsc + `vite build`) emitted three warnings.
The Elixir suite, cic vitest, and every static gate (credo/dialyzer/
sobelow-Medium/format/audits/doctor/wireTypes/bats) were already green;
this was the only non-clean surface. Two were fixed at the source; the
third was deliberately left alone — see the toolchain note below.

1. **`INEFFECTIVE_DYNAMIC_IMPORT`** — `SettingsDrawer.tsx` statically
   imported `./lib/push` *and* did a second `await import("./lib/push")`
   in `removeDevice/2` for `deletePushSubscription`. A module already in
   the main chunk can't be code-split out, so the dynamic form bought
   nothing. Folded into the static import. Real defect in our code.

2. **`[PLUGIN_TIMINGS]`** — vite 8 bundles with rolldown, whose
   `pluginTimings` check prints "plugin `solid` spent significant time"
   only when the host is under load. A non-deterministic perf advisory
   about a third-party plugin's wall-clock — poison for a zero-warnings
   gate (it randomly flips red). Disabled the dev-only check via
   `build.rollupOptions.checks.pluginTimings = false`. It's one of ~18
   independent boolean toggles; every correctness check stays on.

3. **`inlineDynamicImports option is deprecated`** — left as-is, on
   purpose. `vite-plugin-pwa` (≤1.3.0, latest) hard-codes the
   service-worker rollup output as `inlineDynamicImports: true`. Under
   rolldown that option was renamed `codeSplitting: false`. The warning
   is emitted by rolldown's **module-level consola logger** during
   output-option binding — it bypasses the rollup `onwarn`/`onLog`
   pipeline entirely (an `onwarn` filter was tried and confirmed dead),
   and the plugin's `output` is a hardcoded literal we cannot override
   through `injectManifest.rollupOptions` (typed `Omit<…,'output'>`). No
   config path silences it; only patching the dependency does.

   A native `bun patch` (SW output → `codeSplitting: false`, the
   byte-identical successor — a SW must be a single file) WAS tried and
   verified to zero the warning. It was then **dropped**, because it only
   covers the bun build paths (local + e2e `cicchetto-build-test`). The
   **bun ≠ npm toolchain split** is the reason: prod is the m42 FreeBSD
   bastille jail, which has **no bun** (`pkg` has no port) and builds the
   bundle with **npm** via `infra/freebsd/jail_cic_build.sh`. npm ignores
   bun's `patchedDependencies`, and with no committed `package-lock.json`
   it resolves `^1.2.0` fresh → 1.3.0 — so prod neither applies the patch
   nor pins the version. Making prod clean too would mean a SECOND patch
   mechanism (patch-package + a `postinstall` hook + an exact version
   pin), heavier than a cosmetic deprecation in the deploy log warrants.
   CI doesn't build cic at all (ci.yml is pure Elixir; the cic build +
   vitest are local-only — see `feedback_cic_check_gate_masks_tsc`), so
   nothing gates on this. The deprecation is upstream, harmless (the SW
   builds identically), and will lift when vite-plugin-pwa migrates to
   `codeSplitting`. Accepted on all paths rather than carry a patch that
   can't reach the one place (prod) you'd most want it.

Sobelow's 8 Low-confidence Traversal findings (uploads.ex ×5, reaper.ex
×2, version.ex ×1 — all server-managed paths) were left as-is: they sit
below the project's configured `exit: "Medium"` gate (CI green by
policy), consistent with annotating only where churn warrants it.

### e2e full-suite reds: cp15-b6 + m6 `/msg` own-render (NOT a cascade)

The full-suite e2e run surfaced reds in `cp15-b6-archive-query-revival`
and `m6-cicchetto-to-priv-opens-query`. Both passed **3/3 in isolation**,
so the first read was "cascade" (docs/TESTING.md maps 3/3-iso-pass →
state-order pollution). A proper bisect disproved cascade, and a second
full run separated the two specs into **two different root causes**:

- cp15-b6 alone: 3/3 pass.
- chromium prefix #1–12 / #13–24 / full #1–24 + cp15-b6: all pass.
- full ~190-spec suite, run 1: cp15-b6 fails 7.5s, m6 fails 7.5s.
- full suite, run 2 (after a 5s→15s timeout bump): **m6 passes**;
  cp15-b6 **still fails at 15s** with the query window open but empty
  ("no messages yet") — the row is *absent*, not late.

Projects do not interleave (chromium runs fully before webkit), so no
cross-project poisoning either. Two distinct causes:

**m6 — first read "genuine timing", SUPERSEDED.** The initial diagnosis
was that m6's round-trip (cic `/msg` → bouncer persist → WS push → own row
renders) merely overran Playwright's 5s default under full-suite load on
the Raspberry Pi (7.5s observed), so the 15s bump "fixed" it. That was
wrong: the failure is the row being *absent*, not late — a genuine cic
production bug in scrollback recovery (own-send read-cursor poison). See
the 2026-06-09 entry "cic `/msg` to a new nick — own-send cursor poison"
below for the real root cause + fix (issue #50). The 15s bump is kept as
harmless slow-Pi headroom but was never the fix.

**cp15-b6 — the DM-listener race, and a bigger timeout never fixes it.**
`selectChannel` awaits the *channel* topic join, not the *own-nick* topic
join (sibling effects gated on `networks()` loading). Firing `/msg`
before the own-nick subscribe completes broadcasts the outbound PRIVMSG
to **zero subscribers** → query window never opens → row never renders.
This is the exact race `waitForDmListenerReady` exists to close (its
docstring cites ~20% suite flake), and 7 sibling DM specs already call it
(m4/m5/m6/cp14-b3/ux-6-k/ux-6-l/p0b) — cp15-b6 was the lone omission. A
bigger timeout is futile because the row is absent, not slow. The real
fix: `await waitForDmListenerReady(page, NETWORK_SLUG)` after
`selectChannel`, before the first `/msg`.

Fixes landed: (1) add the `waitForDmListenerReady` barrier to cp15-b6
(root cause); (2) bump the WS/REST round-trip assertion timeouts 5s → 15s
in both specs (cp15-b6 ×6, m6 ×2) for slow-host headroom — the assertion
still fails if a row never arrives, it just stops racing a 5s clock on a
loaded Pi. cp15-b6 is a *test* bug (the missing barrier; the bouncer
persists + pushes correctly once a subscriber exists). **m6 is NOT** — it
is a real cic production bug (the own-send cursor poison), fixed in the
next entry. The earlier "no production bug in either case" read applied
only to cp15-b6.

## 2026-06-09 — cic `/msg` to a new nick — own-send cursor poison (issue #50)

The m6 flake above turned out to mask a real cic bug: `/msg <new-nick>
<body>` to a nick with **no existing query window** could leave the
freshly-opened window stuck on "no messages yet" — the operator's own
outbound row never rendered — until a page reload. Intermittent, surfaces
under load (the Pi loses the race the CI ubuntu box usually wins).

**Root cause — own-send poisons the recovery cursor.** Three delivery
paths for the own row, all defeated for a brand-new window:

1. `loadInitialScrollback` fires from `setSelectedChannel` in the `/msg`
   handler (`compose.ts` `:msg` case) *before* the POST, gets an empty
   page, seeds an empty pane, marks the channel load-once.
2. The live WS append needs the `(slug, peer)` channel-topic
   subscription, which the query-windows loop in `subscribe.ts` joins
   *reactively* after the window appears in `queryWindowsByNetwork`. If
   the server broadcasts the row before that join completes, Phoenix
   drops it (no replay to late subscribers).
3. `refreshScrollback` (the CP29 R-5 join-ok recovery) is *supposed* to
   backfill — but `sendMessage` had already advanced the server read
   cursor to the **just-sent row's own id** (optimistic forward-only
   advance, `readCursor.setReadCursor` writes the local signal
   synchronously). `refreshScrollback` resolves its resume cursor via
   `getResumeCursor`, which falls back to the read cursor when
   `lastSeenIdByKey` is empty (nothing was ever `recordSeen`'d, because
   nothing rendered). So it fetches `?after=<own-id>` → empty → the row
   is never recovered.

The read cursor lied: it claimed "read up to row N" before row N was ever
rendered. Every *other* writer only advances the cursor to a row that IS
in the pane (`loadInitialScrollback` → backlog tail; scroll-settle →
visible row). `sendMessage` was the lone path that advanced **past** the
rendered tail.

**Fix — gate the advance at its source, not at the recovery.** In
`sendMessage`, only advance the read cursor when the local pane already
holds a rendered row (`scrollbackByChannel()[key]?.length > 0`). Empty
pane → leave the cursor put → `getResumeCursor` returns null →
`refreshScrollback` resumes from id 0 and recovers the send. Established
channels are unaffected: once any row has rendered, `lastSeenIdByKey`
shadows the read cursor in `getResumeCursor`, so the advance there is
already honest and never consulted as a poisoned resume point. Bucket D's
focused-send badge drop is preserved (a focused window with unread rows
has a non-empty pane); it is moot on an empty pane (no `── XX unread ──`
divider exists to collapse).

**Rejected the issue's own proposed fix** (clamp `cursor = 0` inside
`refreshScrollback` when the pane is empty). The channels loop
(`subscribe.ts`) joins *every* channel eagerly while
`loadInitialScrollback` is focus-only (`selection.ts`), so an unfocused
channel with a `/me`-hydrated read cursor R has an empty pane when its
join-ok `refreshScrollback` fires. The clamp would fetch `?after=0`
(oldest 200, ASC) instead of `?after=R` — pulling ancient history and
leaving an unreachable gap in the middle of the pane on later focus. The
source-gate touches only the own-send path, so it has no such blast
radius. (Spec inherited a bug; CLAUDE.md "challenge the spec".)

**Known narrow corner (accepted):** if device A `/msg`-opens a query
window that device B already has focused with content, A's own-send no
longer writes the cursor (A's pane is empty), so B's badge for that window
drops a beat later — on A's own join-ok `refreshScrollback` + the next
settle — rather than instantly. The pre-fix code "helped" B here only by
poisoning A's own recovery; prioritising A's row render is the correct
trade.

The m6 spec's 15s round-trip timeout bump is now redundant (the fix
renders the row) but kept as harmless slow-Pi headroom — reverting it
risks re-flaking on the genuine 7.5s round-trip observed under full-suite
load.

## 2026-06-09 — cic: split "log out" into "detach" vs "quit" (issue #43)

**Problem.** The single SettingsDrawer "log out" button was ambiguous
about the bouncer. `auth.logout()` revokes the bearer + redirects to
`/login` but never touches the upstream IRC session — by design, but it
surprised the operator (2026-06-04): "logged out" of cic, then watched
the IRC session keep filling scrollback.

**Fix — two affordances for registered users, gated on subject kind.**
The drawer now renders, for `getSubject()?.kind === "user"`:

- **`detach`** — today's `logout()` flow, relabelled. Revokes the web
  bearer, leaves the IRC session connected; reconnecting cic later picks
  it back up.
- **`quit`** — a destructive two-tap `InlineConfirmButton` (`quit` →
  `really quit IRC?`) wired to the **pre-existing** `quitAll(null)`
  composite (`lib/quit.ts`: park every `kind === "user"` network via
  `PATCH /networks/:id {connection_state:"parked"}`, then `logout()`).
  Parked persists across restart (Bootstrap skips `:parked` rows) — the
  correct "stays off until I reconnect" semantic for a Quit affordance.

This was **wiring, not new infra**: `quitAll` already backed the `/quit`
compose verb and the visitor sidebar ×. Server side unchanged.

**Visitors + the not-yet-loaded null subject keep the single `log out`.**
Visitors have no persistent bouncer binding (logout tears the session
down server-side), so the split is a meaningless distinction; gating on
`kind === "user"` (not `!isVisitor()`) also keeps the loading/`null`
subject on the safe single button.

**Disarm-on-close.** The drawer stays mounted across open/close (CSS
`.open` toggle, not `<Show>`), so an armed `quit` would survive a
close→reopen one stray tap from killing the bouncer. A
`createEffect(() => { if (!props.open) setQuitArmed(false) })` disarms on
every close. The armed flag lives in the parent per the
InlineConfirmButton contract.

**Tests.** vitest pins the wiring with a mocked `quitAll`
(`SettingsDrawer.test.tsx`: detach→logout-not-quitAll, single-tap arms
without firing, two-tap→quitAll, disarm-on-close, visitor single
button). The Playwright spec (`issue43-split-logout.spec.ts`) owns the
real-browser render + arm-guard + disarm surface and **deliberately does
NOT fire** the destructive confirm or a real detach — vjt's seeded
token + IRC session are shared suite-wide, so parking the session or
revoking the bearer would cascade-fail downstream specs. The quitAll
park-all+logout composite already has full-stack coverage in
`u-4-device-identity-change` + `ux-4-z-cluster-journey`; this spec is the
NEW render/guard, not the pre-covered composite. The `m7-admin-gate`
spec's registered-user positive twin moved from `log out` → the
`detach-btn` testid.

## 2026-06-09 — video + document uploads (uploads-2 cluster)

The upload pipeline generalizes from image-only to three categories —
image / video / document — across server caps, MIME admission, the cic
host abstraction, and a client-side video transcode. Spec:
`docs/superpowers/specs/2026-06-09-video-doc-uploads-design.md` (8
tasks). Emoji prefixes on the wire: 📸 / 🎬 / 📄 — IRC stays text only;
the emoji is the whole media-type signal.

**Per-type caps + key migration, no read-fallback.** The single
`upload.per_file_cap_bytes` becomes
`upload.{image,video,document}_per_file_cap_bytes` (10/50/10 MiB
defaults) — one 50 MiB ceiling for video must not gift 50 MiB to raw
images. A DML migration renames the existing row; there is deliberately
NO read-fallback on the old key, so a missed migration surfaces as the
compiled-in default instead of a silent legacy read. An admin PUT still
using the old key lands in the existing unknown-key warning clause:
logged, rejected, not silent.

**Server MIME→category map.** The flat image allowlist becomes
`@mime_categories` in `UploadsController`: video (mp4 / quicktime /
webm) and document (pdf / txt / odt / ods / docx / xlsx — no
macro-enabled variants) join the five image types. The category is
derived from the declared MIME per request and picks which cap applies;
it is never stored — no schema change, nothing to backfill.

**cic: ImageHost → UploadHost.** Per-category `acceptedMimeTypes` plus
`maxFileSizeBytes(category)`; `categoryOf()` (`uploadCategory.ts`) is a
1:1 ordered mirror of the server map — adding a MIME touches both files
in the same commit. One orchestrator with a pre-upload transform hook
(video → transcode, image/document → identity); no per-type orchestrator
forks. The spec originally typed `maxFileSizeBytes` as a
`Record<UploadCategory, number | null>` — amended during implementation
to a function of category after review caught a latent bug in the
pre-cluster embedded host: its cap pre-check captured `serverSettings()`
once at module init while the comment claimed admin-tuned caps applied
reactively. The comment was a lie. A literal can't be reactive; the
function shape reads the signal at call time, so an admin cap change now
reaches the ComposeBox pre-check without a reload.

**mediabunny for the transcode.** One dependency, MPL-2.0, no wasm
blob: demux + mux + WebCodecs orchestration + audio passthrough.
Rejected: ffmpeg.wasm (25 MB download, COOP/COEP isolation
requirements, mobile memory death) and a hand-rolled mp4box.js +
WebCodecs frame loop + mp4-muxer stack (three deps and we own the frame
loop + manual audio passthrough — exactly what the library already
does). Two non-obvious findings are encoded in code + tests:
`Conversion.init` COPIES input metadata tags unless given an explicit
empty `tags: {}` — that one line is load-bearing for the
"transcoded output is metadata-free by construction" guarantee — and
mediabunny scales to the requested box unconditionally, so the target
height is clamped to the source's display height to never upscale.

**Transcode-always + adaptive resolution + policy ceiling.** When the
capability gate passes (WebCodecs present + avc encodable), every video
is transcoded — uniform mp4 out, GPS/creation-time dead with the
container. Bitrate budget = (0.95 × video cap × 8) / duration − 128
kbps audio reserve; budget ≥ 2 Mbps → 720p target, else 480p. The
2-minute ceiling is POLICY, not capability: duration is read via a
`<video>` element's `loadedmetadata` (works without WebCodecs), so it
binds on every path.

**Fallback-to-original decision trail.** vjt initially chose
strict-reject on unsupported platforms; reverted to fallback-to-original
for compatibility (an iPhone-shot clip from a WebCodecs-less browser
should still send). Capability failures (`unsupported` / `failed`) fall
back to uploading the original under the same policy gates, reason
`console.warn`'d; `too_long` hard-rejects everywhere. The fallback
original keeps its metadata — a known, accepted leak, documented in the
spec; #39 (server-side metadata stripping) will generalize.

**#49 root cause + fix.** The stale-retry bug: `lastAttempt` (the
retry payload) was written only after the pre-checks passed, so an
oversize rejection left the PREVIOUS file as the retry buffer and
"retry" after picking a smaller file re-uploaded the rejected one. Fix:
record the user's latest selection unconditionally, before any gate —
retry now always retries what the error box shows.

**Plug.Parsers latent 8 MB bug (Task 1).** The multipart parser's
`:length` default is 8_000_000 bytes — a 9 MB upload 413'd at the
parser while the admin-tuned cap said 10 MB was fine. Raised to a 64 MB
ceiling scoped to `:multipart` only; a top-level `:length` would also
have raised the JSON body ceiling 8× on memory-constrained prod. Policy
stays in the per-type caps; the parser ceiling is just headroom above
every cap.

**Lazy-chunk split.** mediabunny was 60%+ of the cold-start main
bundle for a feature most sessions never touch. `videoTranscode.ts`
(the only mediabunny importer) sits behind a dynamic `import()` at the
orchestrator's video branch; `videoPolicy.ts` (duration ceiling, budget
math, `<video>` probe) is the static, mediabunny-free policy surface.
Main chunk 799.59 kB → 304.41 kB (gzip 208.26 → 84.97 kB); the
494.58 kB transcode chunk loads on first video upload.

**e2e.** `uploads2-video-doc-upload.spec.ts`: document happy path
(upload.txt → 📄 row + byte round-trip) and a chromium-only video test
(tiny.mp4 → 🎬 row), deliberately transcode-agnostic — Playwright's
chromium build may lack an avc encoder, in which case the documented
capability fallback uploads the original and the same PRIVMSG lands.
Harness gotcha encoded in the spec: `VideoEncoder` is
`[SecureContext]`-gated, so the skip-probe must run on the app origin —
probing `about:blank` false-skips.

## 2026-06-10 — uploads Range/206 + the lost-'self' CSP rule (playback saga, layer 4)

The prod video pipeline saga continued past the host-nginx body cap:
uploads landed and transcoded correctly (faststart moov, H.264
High + AAC-LC, coherent container) but the 🎬 link never played on
the dogfood iPhone. Two independent delivery-layer defects:

**1. No byte-range support.** `GET /uploads/:slug` answered every
request — including `Range:` — with a 200 full body via
`send_file(200, path)`. iOS/macOS Safari hard-require 206 from a
media origin; without it the media document refuses playback
entirely. Fix: `GrappaWeb.ByteRange` (RFC 9110 §14 single-range
parser, three-way verdict `{:ok, {offset, length}}` /
`:unsatisfiable` / `:ignore`) + controller wiring (206 +
`content-range`, 416 without the freshness grant, `accept-ranges:
bytes` advertised, full 200 for ignorable headers — RFC-sanctioned).

*Altitude decision*: BEAM-side serving via `send_file/5` over
nginx-native (X-Accel-Redirect to an internal location). The nginx
route would get Range + edge caching for free but costs a
per-substrate uploads-path config (jail vs Docker volume vs e2e vs
dev-without-nginx, which still needs the Phoenix path as fallback —
two code paths for one resource). One controller path works on all
four substrates, and `send_file/5` is still zero-copy: Bandit hands
offset+length to `:file.sendfile/5` on the plain-TCP upstream hop.
Multi-range (`multipart/byteranges`) deliberately unimplemented —
browser media players never send it, full-200 is the spec fallback,
and the encoder would be mechanism heavier than the problem.

**2. The lost-'self' CSP regression class.** The same-day `media-src
blob:` fix (duration probe) silently REVOKED self-hosted media:
declaring a fetch directive replaces the `default-src 'self'`
fallback rather than extending it, and direct navigation to an
/uploads mp4 renders in a media document whose synthesized `<video>`
is governed by the response's own CSP. Fix: `media-src 'self'
blob:`, plus the general rule hoisted to the top of
`security-headers.conf`: every new fetch directive must restate
'self' unless its absence is deliberate and commented (frame-src is
the documented exception). e2e ships green on this whole mistake
class until the CSP-parity todo lands — the planned integration run
should also pin a ranged-fetch 206 through the nginx chain, since
ConnTest can never see a proxy-layer Range strip.

## 2026-06-10 — server-side metadata strip (#39): privacy is a server guarantee

vjt's architectural call closing the iOS-picker "double processing"
discussion: **privacy = server guarantee, client transcode decision =
pure performance.** GPS/metadata presence must never sit in the
client's transcode-or-not decision path, because the server strips
metadata ALWAYS. This supersedes the uploads-2 spec's
"always transcode when supported … metadata-free by construction"
constraint (amended at the source, see
`docs/superpowers/specs/2026-06-09-video-doc-uploads-design.md`):
the transcode was carrying a privacy job it can't actually own — the
fallback path uploaded originals with GPS intact, and litterbox
uploads never saw a strip at all. A guarantee that holds only on the
happy path is not a guarantee.

**Where.** `Grappa.Uploads.MetadataStrip.run/2`, called inside
`Uploads.create/3` before the file write — context-level so every
door (REST today, any future facade) inherits it. The row's `bytes`
is the STORED (stripped) size, keeping `live_bytes_sum/0` cap
accounting honest against the disk.

**Tooling (verified empirically, not from docs).** `exiftool -all=`
for images (jpeg/png/gif/webp/apng) and QuickTime video (mp4/mov):
lossless container rewrite — ffmpeg would RE-ENCODE jpeg (quality
loss), which is why "one tool for everything" was rejected. Verified
on GPS-tagged samples: EXIF APP1, PNG `eXIf`, `udta` `loci`/`©xyz`,
`mdta` Keys (`com.apple.quicktime.location.ISO6709`) all removed;
moov-before-mdat (faststart) preserved — a reordering would have
silently broken iOS progressive playback (the layer-4 saga's hard
lesson). webm is the one allowlisted type exiftool cannot write
("Writing of WEBM files is not yet supported") → ffmpeg stream-copy
remux (`-map_metadata -1 -map_chapters -1 -c copy`), encoded streams
untouched.

**Fail-closed.** Strip failure (garbage bytes, missing binary,
image/video mime without a tool mapping) rejects the upload —
`{:error, {:metadata_strip, reason}}` → 422 `metadata_strip_failed`.
Reason is logged server-side, never echoed (tool stderr leaks tmp
paths). The unmapped-mime clause is deliberate: a future allowlist
addition without a strip mapping must break loudly in tests, not
store-with-leak. Documents pass through byte-identical (vjt scope:
images + videos; PDF/office metadata is a known accepted class).

**Deps.** Dockerfile `apk add exiftool ffmpeg` (dev/CI/e2e inherit);
jail needs `pkg -j 6 install p5-Image-ExifTool ffmpeg` BEFORE the
deploy (OPERATIONS "Jail package dependencies") — fail-closed means
missing binaries reject every media upload.

**Fixtures.** Committed GPS-tagged binaries
(`test/support/fixtures/uploads/` + `generate.sh` provenance):
marker-string assertions (`Exif`, `eXIf`, `com.apple.quicktime`,
coordinate strings) pin presence in the fixture AND absence in the
stored artifact, tool-independent. Lifecycle/byte-arithmetic tests
moved to `text/plain` (passthrough keeps size constants exact);
media-path coverage moved UP into dedicated strip tests + door-level
tests with real bytes — the old `"PNG-FAKE-BYTES"`-labeled-png tests
exercised zero image semantics and cannot survive a fail-closed
boundary.

## 2026-06-10 — substrate-scoped preflight classes (the Dockerfile-colds-the-jail defect)

**Trigger.** The metadata-strip deploy (2026-06-10) cold-restarted
prod — ALL IRC sessions dropped — because the diff touched
`Dockerfile`. The jail never reads the Dockerfile: its substrate is
`mix release` + rc(8), and the jail-side equivalent of that diff
(`pkg install`) had already been done by hand. Second needless
restart in one day ("TOO MANY COLD DEPLOYS PORCO DIO"). On an
always-on bouncer every cold deploy is incident-grade, so a
false-COLD is not "30s of downtime", it's every user's IRC session.

**Decision.** `Grappa.Deploy.Preflight` classifies per-substrate.
`classify_paths/2`, `classify/5` and `cli([from, to, substrate])`
take an explicit `substrate :: :docker | :jail` — no default
argument (CLAUDE.md ban): a missing substrate at the CLI is a usage
error (exit 2) and an unknown atom raises `FunctionClauseError`.
Guessing a substrate would silently re-introduce the cross-substrate
restart class this argument exists to kill.

The flat Class-4 COLD list split into substrate-scoped classes:

- **4a `:image_substrate`** (`Dockerfile`, `.dockerignore`,
  `compose.*` as a PREFIX class, `bin/start.sh`, `bin/grappa`) —
  COLD only when classifying for `:docker`. The jail sees them as
  HOT. `compose.*` is a prefix, not an enumeration: H20 already
  proved the enumeration failure mode twice (compose.override.yaml
  and compose.oneshot.yaml were both missed by the prior allowlist);
  diff paths are repo-relative so the prefix anchors at the root.
- **4b `:rc_d`** (`infra/freebsd/rc.d/grappa`) — COLD only for
  `:jail`. Docker sees it as HOT. New reason atom because reporting
  a jail rc script under `:image_substrate` is a lying label. Scoped
  to the grappa wrapper deliberately: the sibling
  `rc.d/grappa_ndp_keepalive` is a DIFFERENT rc(8) service —
  cold-restarting the BEAM (dropping every IRC session) would not
  refresh it, so it stays HOT and its bytes ride the cold-path
  installer below.

Everything else (deps, supervision tree, migrations, nginx, config,
state-shape) stays substrate-independent. Deploy orchestrators stay
excluded from COLD on both substrates (d8f354c reasoning unchanged).

**Exit-code contract at the shell boundary.** Both orchestrators
previously collapsed every non-zero preflight exit into COLD
(`if cli…; then hot; else cold; fi`) — which would have turned the
new "loud usage error, exit 2" into a silent session-dropping
restart on every future deploy, the exact class this change kills.
Both now case on the exit code: 0 → hot, 3 → cold, anything else
aborts the deploy loudly. COLD moved from 1 to 3 because a crashed
mix oneshot exits 1 — a crash must never be readable as a verdict.

**The jail preflight had NEVER produced a verdict.** Found by live
probe right after the hot deploy: `mix run` under `MIX_ENV=prod`
evaluates `config/runtime.exs`, which raises on missing
`DATABASE_PATH` — the daemon gets its env from rc.d, but
`run_as_grappa`'s `su -l` login shell does not, so the jail's
auto-mode preflight crashed with exit 1 on every invocation since
the day it shipped, indistinguishable from a COLD verdict. Every
"classified COLD" jail deploy was actually "preflight crashed".
(Past cold deploys also contained legitimately-COLD diff classes,
which is why nobody saw it.) Fixed: the jail deploy sources
`/usr/local/etc/grappa/grappa.env` for the preflight oneshot (same
`set -a` flow as `jail_release.sh`, abort-if-unreadable), and the
1-vs-3 split above makes any future crash class abort instead of
silently colding. The shipped-today re-exec guard is what lets the
NEXT deploy pick all of this up before its preflight runs.

**rc.d refresh.** The jail cold path (`infra/freebsd/deploy.sh`)
now runs `jail_install_rcd.sh` — the existing idempotent installer,
not a new inline copy — BETWEEN stop and start: the old daemon is
stopped through the wrapper that started it, the new one boots
through the new wrapper, and both rc.d wrappers get refreshed on
every cold deploy. Closes the loop that bit the same day: the rc(8)
PATH fix shipped in the repo but prod kept 422ing until the wrapper
was hand-copied. No manual step left (OPERATIONS updated at the
source).

**Re-exec guard fixed (was dead code).** The 2026-05-31
self-modifying-script guard compared
`${REPO_ROOT}/infra/freebsd/deploy.sh` against `$0` — the SAME path
under the documented bastille invocation, so it could never fire
while /bin/sh kept executing pre-pull bytes from the renamed-away
inode. It now re-execs when the pulled diff range contains
`infra/freebsd/deploy.sh`, threading the original pre-pull SHA via
`DEPLOY_PREV_SHA` (the re-exec'd run re-pulls a no-op and would
otherwise see prev==new and exit "nothing to do" — the old guard had
that second latent bug too).

**Deploy completion marker + reload honesty (same-day follow-up,
live-repro'd shipping THIS cluster).** The shipping deploy was
killed mid-flight (operator-side SIGPIPE) between `mix release` and
the reload POST: fresh beams on disk, stale BEAM live — and every
re-run exited "no commits since last HEAD — nothing to do", because
the fast path equated "pull was a no-op" with "deployed". Recovery
was manual (rpc soft-purge + load). Three fixes:

- The jail deploy writes `runtime/last-deployed-sha` as the FINAL
  step of both paths; nothing-to-do now requires same-HEAD AND
  marker==HEAD, else it re-drives (an idle re-run costs one no-op
  release rebuild).
- `POST /admin/reload` returning HTTP 200 with `"failed":[...]` no
  longer prints "✓ hot deploy complete" — the hot path greps for
  `"failed":[]` and aborts otherwise.
- The reload endpoint itself couldn't reload a module TWICE between
  restarts: `:code.load_file/1` fails `:not_purged` when the old
  slot is full (hit live: the second hot deploy of
  `Grappa.Deploy.Preflight` in one day). Logic moved to the new
  `Grappa.HotReload` context (controllers thin):
  `:code.soft_purge/1` then load. soft, not hard — hard purge KILLS
  processes still executing old code (= dropped IRC sessions from
  the endpoint that exists to avoid restarts); the refusal surfaces
  as `{mod, :old_code_in_use}` in `failed` and the deploy aborts
  honestly. Pinned by `test/grappa/hot_reload_test.exs` incl. the
  double-reload repro and a held-old-code refusal test.

**Hot deploys that ADD a module (third live repro, same day).** The
deploy shipping `Grappa.HotReload` itself proved the next gap:
`:code.modified_modules/0` only compares LOADED beams against disk,
so a brand-new module is invisible to the reload walk; releases run
embedded mode (no lazy loading), so the reloaded `AdminController`'s
first call into the new module 500'd `:undef`. And the recovery rpc
showed a second trap: OTP's cached code path (OTP 26+) does not see
files added to a directory after boot — `:code.load_file/1` reports
`:nofile` for a beam that is demonstrably in a path member dir.
`reload_modified/0` now also walks the app ebin for never-loaded
beams and loads them via `:code.load_abs/1` (bypasses the path
cache). Recovery one-liner for a node in this state:
`jail_release.sh rpc ':code.load_abs(~c"<ebin>/Elixir.Mod.Name")'`.

**Acceptance.** The fix's own deploy is the test — with one caveat
found in review: the deploy that SHIPS this change still runs the
old deploy.sh bytes (the old guard is the dead one), whose 2-arg
`cli` call against the new 3-arg module exits 2 → old `if`/`else`
reads that as COLD. So the shipping deploy goes out `--force-hot`
(after verifying the range classifies HOT via the new classifier
locally); the NEXT auto deploy exercises the full pipeline
end-to-end. The prior Dockerfile-only diff now classifies
HOT-on-jail / COLD-on-docker, pinned by the substrate-matrix tests
(`test/grappa/deploy/preflight_test.exs`).

## 2026-06-11 — cic text selection dead (two stacked causes, one per platform)

vjt: text selection doesn't work in cic, neither desktop nor mobile.
One symptom, two independent root causes that happened to overlap:

**Desktop: keepKeyboard's mousedown preventDefault.** The UX-3
preserve-keyboard listener (document-level capture, `lib/keepKeyboard.ts`)
preventDefaults every mousedown that lands outside an input while an
input has focus. The module header claimed "No-op on desktop browsers" —
false: the install was unconditional, and mousedown's default action is
not just the focus shift, it is ALSO the start of a text-selection
drag. With the compose box autofocused (the normal cic state), every
attempt to drag-select scrollback text was cancelled at the capture
phase. Fix: gate the handler on `isIos()` — the on-screen keyboard the
listener exists to preserve is an iOS concern (the whole UX-3 arc was
iOS dogfood), so anywhere else the preventDefault is pure loss. The
gate sits in the handler (not at install) for test isolation: the
document-level capture listener has no uninstall path, so an
install-time gate would leak an ungated listener from an iOS-UA test
into later desktop-UA tests. Pinned by
`src/__tests__/keepKeyboard.test.ts` (desktop UA: mousedown survives;
iPhone UA: preserve still fires, focus transfer to other inputs still
allowed).

Two scoping decisions made consciously, not by omission. Android also
has an on-screen keyboard, and the old unconditional preventDefault
plausibly preserved it too — but Android keyboard behavior was never
validated (no Android dogfood; every UX-3/UX-6 iteration was iOS), so
the gate scopes to the documented target rather than freezing an
untested side effect; if Android dogfood shows keyboard drops, the
gate widens by one clause. And iPad-with-trackpad stays imperfect:
`isIos()` is deliberately true there (platform.ts iPadOS detection),
so a hardware-pointer drag still gets preventDefaulted while compose
is focused — fixing that properly needs on-screen-keyboard-visibility
detection, which the UX-6 D arc showed is a tar pit. Touch long-press
selection on iPad works via the CSS half; the trackpad edge waits for
an actual complaint.

**iOS: the half-copied Telegram pattern.** UX-6 D9 (479b77d) adopted
Telegram Web K's keyboard pattern wholesale, including
`html.is-ios { -webkit-user-select: none }`. Telegram pairs that global
kill with a selective re-enable on message text; the copy took the kill
and skipped the re-enable, making ALL of cic unselectable on iOS — and
no DESIGN_NOTES entry ever recorded user-select as a deliberate
decision, confirming it rode along unexamined. Fix: complete the
counterweight as a single policy block in default.css (`html.is-ios
.scrollback, .topic-modal-text, input, textarea { user-select: text }`)
— new copyable surface = one selector added there, no scattered
re-enables. Channels, queries and the server window all render through
`.scrollback`; the topic modal is where users copy topics (the topic
BAR is clickable chrome and stays dead); editable fields get an
explicit re-enable because WebKit honors inherited `user-select: none`
inside inputs in some version ranges. Deliberately excluded: mentions
rows (navigation buttons — the target message is selectable in its
channel) and the `[Join]` invite CTA inside `.scrollback` (re-excluded
explicitly so long-press doesn't pop the magnifier over a control).
App chrome stays unselectable, which is the global rule's actual point
(no selection magnifier mid-scroll-gesture).
`-webkit-touch-callout: none` stays — link long-press callout is a
separate, deliberate native-app-feel decision, untouched by this bug.

Review caught the fix's own near-miss: the day-separator and
unread-marker labels declared only UNPREFIXED `user-select: none`,
which iOS Safari <18.4 doesn't parse — under the new prefixed `text`
re-enable on the ancestor they'd have become selectable exactly where
the comment promised they weren't. Both label rules now carry both
forms. General rule for this theme file: any `user-select` declaration
ships prefixed + unprefixed, or the iOS cascade splits from the spec
one.

e2e guard: `e2e/tests/text-selection-restored.spec.ts` — chromium test
drives the actual drag-select gesture with compose focused (the exact
dead path); the @webkit test asserts the computed-style cascade on the
iPhone-15 emulation surface (real long-press selection isn't
emulatable — same limitation class as
feedback_playwright_webkit_not_ios_scroll). Device-level dogfood on a
real iPhone remains the final verification for the iOS half — include
a SHORT channel (few lines, no overflow): non-overflowing `.scrollback`
carries `touch-action: none` (UX-3 Z3 R4 default-deny), and whether
WebKit starts long-press selection inside a `touch-action: none`
container is exactly the class of thing emulation can't answer.

Lesson (recurring shape): copying a reference pattern partially is
worse than not copying it — the kill switch arrived without its
counterweight. Same family as the "read the reference implementation
COMPLETELY" rule.

## 2026-06-11 — media links: in-app viewer modal (the in-scope navigation trap)

vjt live-tested link behavior in the iOS standalone PWA (2026-06-10):
plain website links are FINE — out-of-scope, so iOS opens the Safari
view with full controls. Only MEDIA links misbehaved: a bare window
with no controls, and returning to cic forced a full reload. Root
cause, verified in code before fixing: own upload URLs are SAME-ORIGIN
(`embeddedHost` resolves `Endpoint.url() + /uploads/<slug>`), the PWA
manifest has no `scope` key and `start_url: "/"`, so the entire origin
is in-PWA-scope — and iOS standalone navigates in-scope links IN PLACE
regardless of `target="_blank"`. The PWA window itself became the raw
media document: no browser chrome by definition (display: standalone),
no back control, and the "reload on return" is just cic cold-booting
after its window was navigated away. Out-of-scope links never had the
bug, which is why only media links (= own uploads) hurt.

Decision (vjt, 2026-06-10): on-CLICK in-app viewer modal for media
URLs — X-close + "open in browser" — NOT a generic iframe modal for
all links (X-Frame-Options blocks most of the web, iframe history is
unreliable, and it would need a `frame-src` CSP loosening). Plain web
links stay untouched. This does NOT lift the "IRC stays text only"
invariant: that rule bans on-ARRIVAL rendering (previews, thumbnails,
lightbox-on-arrival); a click is the user opening the resource — the
modal is just WHERE it opens.

Mechanics. `lib/mediaLink.ts` (pure, linkify-style) classifies a URL
given the text segment preceding it: same-HOST `/uploads/<26-char-
base32>` + trailing 📸/🎬 → image/video (the slug carries no
extension — the uploadOrchestrator's emoji prefix is the only type
signal on the wire); same-host media-extension URL → kind by
extension; cross-host → null, ALWAYS. Two independent reasons for
the cross-host exclusion: the CSP (`img-src 'self' data:`,
`media-src 'self' blob:`) would block the modal's media element — the
viewer ships with ZERO CSP changes — and cross-host links don't
have the bug in the first place (litterbox URLs open correctly in the
Safari view today). 📄 document uploads are excluded: rendering a PDF
in-modal needs `<embed>`/`<iframe>`, which is the rejected design; a
same-origin 📄 link still navigates in place on iOS standalone —
known residual, waits for a complaint before earning machinery.

HOST-equality, not full-origin equality — the e2e spec's first run
caught why. The harness anchor rendered `http://localhost:4000/
uploads/<slug>` against a `https://nginx-test` page: the e2e server
minted URLs from its listen socket, not the public origin. Checking
prod (live rpc, `GrappaWeb.Endpoint.url()`) showed the SAME defect:
`http://irc.sniffo.org` — runtime.exs declared `url: [host: phx_host,
port: 80]` with no scheme key, so every upload link ever posted is
http:// on an https PWA. A strict origin check would have dead-
lettered the entire upload history. Fix, both ends: (a) runtime.exs
now roots `url:` at `https://PHX_HOST:443` in an env-agnostic block
gated on PHX_HOST presence (empty-string-guarded — local dev compose
passes `PHX_HOST: ${PHX_HOST:-}` and Elixir treats `""` as truthy);
the e2e harness sets `PHX_HOST: nginx-test` and gains origin
fidelity, prod mints honest https links from its next (cold —
preflight class 7, config/*.exs) deploy, batched into a future
restart window since (b) makes it non-urgent: the classifier matches
on host (http/https only — linkify also admits ftp) and the click
handler re-roots the href on the page origin via `normalizeMediaHref`
before handing it to the viewer, so historical http:// bodies render
without mixed-content blocks. The `--cic` deploy path doesn't move
`runtime/last-deployed-sha` (only the server deploy.sh does), so the
pending runtime.exs change stays inside the next server deploy's
diff range — the marker machinery from this morning's deploy-honesty
cluster is what makes "commit now, cold later" safe.
`lib/mediaViewer.ts` is the two-verb signal store (archive-modal
pattern; the click originates in module-scope renderRun where no
component callback can reach); `MediaViewerModal.tsx` mounts at Shell
root in both branches (PrivacyModal pattern) with the refcounted
overlay scroll-lock, document-level Escape, button-backdrop close.
The scrollback anchor KEEPS its href + `target="_blank"` — copy-link,
middle-click, long-press all behave; only plain click is intercepted
(`preventDefault` + open viewer). "Open in browser" inside the modal
is a plain `target="_blank"` anchor: on desktop/Android a real tab;
on iOS standalone it deliberately leaves the PWA — an explicit user
choice, unlike the bug where a plain click did so.

e2e (`media-link-modal-viewer.spec.ts`) rides the UX-6-B embedded-
upload journey end-to-end and asserts the modal `<img>` reaches
`naturalWidth > 0` — proving the bytes rendered through nginx, but
NOT through the CSP: e2e nginx-test.conf serves no CSP header (the
e2e-CSP-parity todo, High, predates this cluster and is what would
make that assertion CSP-load-bearing). The iOS-standalone navigation
behavior itself is not emulatable
(feedback_playwright_webkit_not_ios_scroll class); vjt device dogfood
is the final verification there.

Review fixes (same session): modifier/aux clicks (cmd/ctrl/shift/
middle) bypass the intercept — browser-native new-tab semantics keep
working on media links; the classifier returns `{kind, href}` with
the page-origin-rooted href (path+query+hash — `#t=` media fragments
survive) instead of a separate `normalizeMediaHref` step a future
call site could forget, which would have shipped the exact
mixed-content block the normalization prevents; `mediaViewer.ts`
joined `identityScopedStore` (token rotation closes a lingering
viewer, archive-modal precedent); the document-level Escape listener
registers only while the viewer is open (the component is permanently
mounted — an unconditional listener would run on every keystroke
forever); and the third verbatim copy of the modal overlay-lock
boilerplate triggered its extraction into
`createOverlayLock(isOpen, selector)` in overlayScrollLock.ts —
which also fixed a latent leak ALL the copies shared: a same-task
open→close popped (clamped at zero) before the microtask-deferred
push fired, stranding the refcount at 1 with no drain path —
permanent iOS scroll-lock until reload. ArchiveModal and PrivacyModal
migrated in the same commit (total consistency or nothing). On the
server side, PHX_HOST is now mandatory in prod (raise, same contract
as DATABASE_PATH): the old `|| "grappa.bad.ass"` fallback minted
equally-dead links, just quietly, and PHX_HOST was previously read
three times with three different empty-string semantics
(`PHX_HOST=""` produced a `check_origin: ["//"]` entry) — one read,
one nil-or-host binding now feeds both roles.

Known residual (recorded, deferred): the 📸/🎬 type signal lives in
message TEXT, read from the linkify segment preceding the URL within
one mIRC formatting run — a body that interleaves control codes
between emoji and URL (colorizing relay bridge) splits them into
separate runs and the link falls back to the plain anchor (the
navigate-in-place behavior returns for those rows). cic's own mints
are always plain `📸 <url>`, so today's real surface is zero; the
durable fix is server-side minting of `/uploads/<slug>.<ext>` so the
URL itself carries the type (todo).

## 2026-06-11 — media viewer dogfood: the escape hatch had the bug it escaped

First device dogfood of the media-link viewer came back same-day with
two defects, and the first one is an indictment of un-dogfooded
comments: the modal's "open in browser" anchor — the deliberate
leave-the-PWA affordance — NAVIGATED THE PWA IN PLACE. The shipped
header comment claimed `target=_blank` "deliberately leaves the PWA"
on iOS standalone; that claim was never device-verified and is false
by this cluster's own verified root cause: iOS standalone ignores
`target` for in-scope (same-origin) links, full stop. No anchor
attribute escapes in-scope navigation.

The only same-origin escape that exists is the `x-safari-https://`
scheme handoff (real Safari, iOS 17+, inert on 16; the
`window.open(url, '_system')` advice floating around is Cordova
folklore, not WebKit). Mechanism matters as much as the scheme, and
the v1 fix in this very session got it wrong before review caught it:
rewriting the anchor's HREF breaks long-press → Copy Link (yields a
dead x-safari URL) and contradicts the click-intercept-preserve-href
contract ScrollbackPane's media links established one commit earlier.
Final shape: href stays the live URL + `target=_blank` (right on every
non-iOS-standalone platform), plain primary clicks delegate to a
shared `maybeEscapePwaClick` — modifier guard, gate, preventDefault,
SAME-WINDOW `location.assign` (a scheme handoff needs no new browsing
context, and the new-window path is the one WebKit popup policy can
swallow).

The review panel's altitude finder then made the real catch: the bug
CLASS is "any same-host link tapped in the standalone PWA", not "the
modal's anchor". 📄 document uploads (deliberately rejected by
`classifyMediaLink` — the modal can't render PDFs) and the
emoji-split-run fallback rows documented one entry above were carrying
the identical defect, waiting to be re-filed as a fresh dogfood bug.
ScrollbackPane now routes plain clicks on same-host NON-media links
through the same escape handler; `sameHostHref` is the extracted
host-match + origin-re-root half of `classifyMediaLink`, so there is
exactly one implementation of "is this ours and what URL do we
actually use". The composed gate lives once in platform.ts as
`escapePwaHref` — the `isIos()` half is load-bearing (Android/desktop
installs are standalone too; an x-safari URL is inert there), which is
exactly the kind of recomposition mistake a second call site would
have made from the exported halves.

Dogfood defect two — no loading feedback — grew three corrections in
review: (a) media state transitions only leave `loading` (a transient
mid-playback MEDIA_ERR_NETWORK must not unmount a playing element; a
late `suspend` must not resurrect a failed one); (b) `suspend`
terminates the spinner — iOS Low Power Mode / Data Saver downgrades
`preload=metadata` and fires neither `loadedmetadata` nor `error`
before a play gesture, so without it the spinner spun forever on
exactly the platform the fix targets; (c) `pointer-events: none` on
the spinner overlay, which otherwise sits precisely on the video's
centered native play control and swallows the tap that would have
started the deferred load.

Testing boundary worth recording: jsdom's `window.location` is
unforgeable AND unimplemented — `location.assign` can be neither
spied nor allowed to run. The split that works: decision logic pinned
pure (`escapePwaHref` gate matrix), component wiring pinned via a
partial module mock of `maybeEscapePwaClick`, and the assign line
itself owned by device dogfood. The x-safari handoff is likewise not
e2e-able (the gate is false in every Playwright project, and webkit
emulation doesn't do standalone navigation) — pending vjt device
verification, again.

## 2026-06-11 — #39 round 2: the strip ate Orientation (whitelist, not blanket wipe)

Dogfood of the metadata strip found the over-reach: `exiftool -all=`
removes EVERY tag, and EXIF Orientation is a tag — so every portrait
phone photo uploaded since the strip shipped renders sideways
(browsers honor the tag via `image-orientation: from-image`; the
pixels are stored unrotated). Privacy tags and presentation tags died
together.

Fix shape per vjt: an explicit ALLOWLIST of presentation-critical
tags copied back after the wipe — exiftool's own idiom,
`-all= -tagsfromfile @ -Orientation` (wipe, then copy the named tags
from the original; no-op when absent). `@kept_tags` starts with
Orientation only. The bar for an entry: rendering data with no
provenance payload, AND a committed fixture pinning both directions
(privacy markers die / kept tag survives) — ICC_Profile (wide-gamut
color; iPhones shoot Display P3, stripping the profile washes colors)
is the named next candidate but stays OUT until a profiled fixture
exists, because an untested whitelist entry is a privacy hole nobody
pinned (recorded in todo).

Video rotation needed no entry and that asymmetry is worth recording:
QuickTime rotation lives in the tkhd track display matrix — container
STRUCTURE, not metadata — so `-all=` never touched it; and webm
uploads come out of MediaRecorder with pixels already upright. The
image-only scope of the bug is why vjt saw sideways photos but normal
videos.

Already-stored sideways uploads are NOT migrated: the strip ran at
upload time, the Orientation bytes are gone, and reconstructing them
from pixel content is guesswork. Re-upload is the fix for the handful
that exist.

Review addenda (same session): the copy-back is gated to image/*
mimes — mp4/mov go through the same exiftool dispatch, and a bare
`-Orientation` resolves against ALL groups of the original (XMP,
EXIF blocks embedded in QuickTime atoms), so on the video path the
flag was a believed no-op nothing pinned and a latent surprise for
future @kept_tags entries; video keeps the blanket wipe its
rationale already argued for. The whitelist test gained an exiftool
GPS read-back on the stripped output — byte markers cannot see EXIF
GPS (binary rationals), so without the probe a copy-back widened
beyond the allowlist would pass the suite green. Rejected
alternative, recorded so it isn't re-proposed: physically
auto-rotating pixels (jpegtran) then stripping everything. It's
jpeg-only (PNG/WebP Orientation would still need the tag path, so
the whitelist survives anyway), "lossless" rotation requires
MCU-aligned dimensions (else edge trim or failure), and it adds a
fourth binary dependency for zero privacy gain over a 1-8 integer.
Also recorded: a stripped JPEG that kept Orientation carries
exiftool's mandatory IFD0 companion defaults (YCbCrPositioning=1 —
fixed default, NOT copied from the source); a privacy audit grepping
stripped output should expect that minimal APP1 shape.

## 2026-06-11 — prod outage (~15 min): three stacked deploy defects, found live

Applying the parked runtime.exs PHX_HOST cold change surfaced defects
#7–#9 of the deploy-honesty saga, each one forcing the workaround
that tripped the next:

**#7 — preflight diffs the wrong range.** `infra/freebsd/deploy.sh`
classifies `prev_sha..new_sha` where `prev_sha` is the PRE-PULL jail
HEAD — not `runtime/last-deployed-sha`. But `jail_deploy_cic.sh` ALSO
`git pull`s: every `--cic` deploy advances the jail HEAD without
applying server changes, so any server-side commit that lands between
two cic deploys vanishes from every future server deploy's preflight
range. The runtime.exs commit (8244df3) entered the jail via a cic
pull and the next server deploy honestly classified a range that no
longer contained it → HOT verdict, cold change silently skipped. The
cp63 assumption "the cold change rides the next server deploy's diff
range automatically" was false — the marker exists precisely to be
that base and isn't used for it (only for the nothing-to-do check).
Fix shape: preflight base = marker when present, pre-pull HEAD as
fallback. The deploy.sh self-modification re-exec guard correctly
keeps pre-pull HEAD (running-bytes semantics, different question).

**#8 — `--force-cold` can be silently swallowed.** The nothing-to-do
fast path (same HEAD + marker match → exit 0) runs before the force
flag is consulted. An operator explicitly demanding a restart got
"nothing to do". Fix shape: fast path applies in auto mode only.

**#9 — rc.d restart races the drain.** With #8 broken, the manual
fallback was `service grappa restart`: stop returned while the old
node was still DRAINING WebSocket connections, the new BEAM hit
`the name grappa@grappa seems to be in use by another Erlang node`
and died at boot — and rc.d printed "Starting grappa." and walked
away. That unsupervised boot failure WAS the outage; recovery was a
plain `service grappa start` once the old node was gone. Fix shape:
stop must wait for BEAM exit + epmd name release before returning
(or start must retry on name-in-use), and a boot that dies within
seconds must be loud.

Net state after recovery: PHX_HOST applied (Endpoint.url() now
https://irc.sniffo.org — prod mints live upload links), 8/8 sessions
respawned, marker honest at HEAD. Fixes handed off as the next
dispatch.

## 2026-06-11 — deploy defects #7–#9 fixed: marker range, force wins, stop means stopped

The fix dispatch for the outage above. All three shapes follow the
incident entry's spec.

**#7 — preflight base = `runtime/last-deployed-sha`.** When the
marker exists and is a real commit (`git cat-file -e`), it is the
range base; the pre-pull HEAD remains the fallback ONLY when no
marker exists (fresh install). A garbage marker (truncated write,
rewritten history) aborts the deploy loudly with a fix-it hint —
deliberately NOT a silent fallback to the pre-pull HEAD, which would
re-open the exact range hole the marker closes. The re-exec guard
keeps the pre-pull range: it answers "did THIS run's pull change the
bytes I'm executing?", and a deploy.sh change that entered via an
earlier cic pull is already the file the operator invoked. The
Docker substrate (`scripts/deploy.sh`) is explicitly NOT ported in
this pass — it has no marker infrastructure at all (no
`last-deployed-sha` write anywhere), so the port is the whole marker
mechanism, not one line; folded into the existing REV-I todo entry
(same-SHA guard port) as one coherent future bucket. Docker drives
the LOCAL dev stack only — nothing production rides that gap.

**#8 — the nothing-to-do fast path applies in auto mode only.** An
explicit `--force-hot`/`--force-cold` is an operator order; the skip
log states what was observed (same HEAD + marker match) and, when
forced past, which flag overrode it. The "re-driving" message now
also names the common benign cause (cic deploys advancing HEAD)
instead of implying every marker gap is a died-mid-flight deploy.

**#9 — `infra/freebsd/jail_beam_wait.sh`, one implementation of the
stop/start race lore.** Two verbs: `wait-stopped <node> <timeout>`
(blocks until beam.smp exits AND epmd drops the name; escalates —
SIGKILL after timeout, epmd restart only AFTER the BEAM is confirmed
dead, preserving the 2026-05-31 lesson that pkill'ing epmd under a
live BEAM re-races the registration) and `wait-name-free <node>
<timeout>` (pre-start guard, NO escalation — the name's owner may be
a live draining node that must not be shot). Call sites: rc.d
`grappa_stop` (stop now means STOPPED), rc.d `grappa_start` (refuses
a registered name, then polls the release `pid` RPC and treats a
vanished beam.smp as an immediate loud boot failure — the outage's
"Starting grappa."-and-walk-away is dead), and deploy.sh's cold path
(replacing its inline pgrep loop + unconditional `pkill epmd`). The
deploy.sh call site is load-bearing forever, not just for the
transition: rc.d wrappers are refreshed BETWEEN stop and start, so
any deploy shipping an rc.d fix stops through the PREVIOUSLY
installed wrapper. New rc.conf.d knobs: `grappa_node`,
`grappa_stop_timeout`, `grappa_start_timeout`,
`grappa_name_wait_timeout`, `grappa_beam_wait`.

**Testing**: new `test/infra/*.bats` (scripts/bats.sh now scans
`test/bin/ test/infra/`) pin the decision logic — marker-vs-fallback
range, garbage-marker abort, force-past-fast-path, re-exec range
choice, cold-path stop/wait/refresh/start ordering, and the helper's
escalation/no-escalation split — against a throwaway upstream+clone
with PATH-stubbed `su`/`mix`/`curl`/`service`. The rc.d wrapper
itself needs rc.subr (FreeBSD-only): its verification is the next
real cold window on m42. The shipping deploy goes `--force-hot` +
manual `jail_install_rcd.sh` — the wrapper install touches nothing
live, and the BEAM already cold-booted once today (minimize
restarts).

## 2026-06-14 — user@host on join/part/quit (irssi-style presence lines)

Real IRC clients show `nick [user@host] has joined` — Grappa rendered
only the bare nick. The fix carries the sender's user@host (already
fully parsed by `IRC.Parser` into the `{:nick, nick, user, host}`
prefix tuple) through to the scrollback row and into cic's render.

**Where the data was dropped, and where it's now caught.** The parser
decomposes the prefix; `EventRouter`'s JOIN clause already lifted
user@host into the in-memory `userhost_cache` (S2.4, for ban-mask
derivation) but `build_persist/6` was called with `meta: %{}` for all
three presence verbs, so the components never reached the DB or the
wire. New `prefix_userhost/1` helper reads `msg.prefix` directly (NOT
the cache — the cache exists for a different lifecycle, and PART/QUIT
prefixes carry user@host on the wire regardless) and returns
`%{sender_user: u, sender_host: h}` when BOTH are present, `%{}`
otherwise. The both-or-neither guard mirrors the existing
`userhost_cache` half-populate rule: a `+x`-cloaked prefix that strips
either half yields no mask rather than a misleading partial one.

**Storage = meta, deliberately not a column.** `:sender_user` /
`:sender_host` join the `Scrollback.Meta` `@known_keys` allowlist
(+ `@type t`, `@spec`, per-kind doc). This is the lightweight path: no
migration (meta is a serialized column), so the server half is
hot-deployable on an always-on bouncer. `Meta.dump/1` REJECTS
non-allowlisted keys, so the keys MUST be in `@known_keys` for the
insert to succeed — and the A18 sync test (`meta_test.exs`) forces the
mirror addition to the Logger `:metadata` allowlist in
`config/config.exs`. That config touch is what makes
`Grappa.Deploy.Preflight` classify the diff COLD (Class 7: all
`config/*.exs` → cold, conservative SECRET_SIGNING_SALT-class bias).
The classification is correct-by-rule but over-conservative for THIS
diff: the Logger allowlist governs only which keys a log line may
print, and the feature never emits these as Logger metadata — it reads
them off the scrollback `meta` map. So the change is functionally
hot-safe and shipped `--force-hot` (server code reload) + `--cic`
(bundle), both session-preserving.

**cic.** `ScrollbackPane.tsx` gains `userhostSuffix/1` rendering the
irssi-style ` [user@host]` between the nick and the verb for join/part/
quit; empty string when meta lacks it, so a cloaked or pre-feature row
renders the plain line unchanged. Forward/backward compatible across
the two-deploy window in either order.

**Tooling self-heal (same branch, separate commit).** Two fresh-worktree
landmines hit during this work, fixed at the root: `scripts/bun.sh`
auto-runs `bun install` when `cicchetto/node_modules` is absent (it's
per-worktree, not shared like the bun cache — first `run test` died
`vitest: command not found`), and `scripts/bats.sh` auto-inits the
`vendor/bats-core` submodule when missing (was a hard `die` with a
manual incantation). Mirrors the testnet.sh submodule auto-init pattern
so `check.sh` + vitest work first-try from any new worktree.

## 2026-06-14 — IRC-centric custom keyboard (opt-in, in-page, replaces the native iOS keyboard)

Shipped as 17 commits
(subagent-driven TDD, two-stage review per task). Phone-portrait MVP;
landscape/iPad, channel-switch keys, emoji search, skin tones deferred.

**Why a custom keyboard at all.** An on-screen, IRC-first keyboard:
arrows wired to input history (Up/Down → `recallPrev`/`recallNext`) +
caret (Left/Right), a Termius-style accelerator pill (`Tab` / `/` / `#`
+ arrows + close), and an emoji layer — affordances the native keyboard
can't give. Opt-in per device (`localStorage`, `lib/keyboardPref.ts`,
mirrors `theme.ts`); NOT server-backed `userSettings` (that's
cross-device IRC prefs — keyboard is a per-device display choice).

**`inputmode="none"` is the load-bearing decision.** While enabled,
Shell sets `inputmode="none"` on the compose `<textarea>`, so tapping it
focuses without summoning the native keyboard; our in-page keyboard div
renders separately. An in-page keyboard NEVER shrinks the visual
viewport, which is why it SIDESTEPS the `--vh`/visualViewport/
`position:fixed`/smart-scroll-pin machinery (UX-6 D9, 8 failed
iterations) — that machinery exists for the NATIVE keyboard and stays
dormant in IRC-kb mode. The `--vh` height calc was NOT touched.

**The reservation caveat the spec missed.** The naive plan was
`.shell-mobile { padding-bottom: var(--irc-kb-height) }`. But the
in-page keyboard is ALWAYS docked when enabled AND the textarea stays
focused under `inputmode=none` — so the existing
`.shell-mobile:has(textarea:focus) { padding-bottom: 0 }` rule (which
collapses the home-indicator inset when the NATIVE keyboard is up) would
zero the reservation exactly when we need it. Fix: fold `--irc-kb-height`
into BOTH bottom-inset declarations —
`padding-bottom: max(env(safe-area-inset-bottom), var(--irc-kb-height,0px))`
on the base rule and `padding-bottom: var(--irc-kb-height,0px)` on the
`:has(...)` rule. `--irc-kb-height` is `0px` unless the keyboard is
enabled (set in Shell), so with it off both resolve byte-for-byte to the
prior values — native layout is unchanged. This is the only edit to
`default.css`'s mobile machinery; the keyboard's own slide/animation CSS
lives in `keyboard.css`.

**Extraction boundary (a hard invariant, guarded).** Everything under
`cicchetto/src/keyboard/` is a standalone component tree that imports
ONLY from within `src/keyboard/` — no cic imports. The boundary type is
`KeyboardIntent` (renamed from the spec's `KeyboardEvent` sketch to
avoid the DOM global). The SOLE cic-coupled file is
`cicchetto/src/KeyboardHost.tsx`: it resolves the live compose textarea
(`.compose-box textarea`, same selector Shell uses), applies intents via
the EXISTING `compose.ts` paths (`setDraft`/`recallPrev`/`recallNext`/
`tabComplete`, submit via `form.requestSubmit()`), and gates mounting on
opt-in + mobile + coarse-pointer. Tab-complete is a byte-for-byte mirror
of `Shell.tsx`'s `cycleNickComplete`. `keyboard.css` uses only `.kbd-*`
selectors; the `--irc-kb-height` reservation rule lives in cic
(`default.css`), not in `keyboard.css`, to keep the module pure. A grep
guard (plan Task 18 step 1) enforces this: `from "../…"` in
`src/keyboard` production files must return nothing.

**Locked gesture semantics (iOS-exact).** Long-press opens the variation
strip; the highlight tracks the finger's X at the key Y-band OR over the
strip, FREEZES when the finger rises above the strip top, and
sticky-CANCELS when it drops below the pressed key. Release commits the
highlighted variant (or the base on a tap). The engine (`gesture.ts`) is
pure/DOM-free; the long-press TIMER lives in `KeyCap`. Strip-cell
highlight is passed Keyboard → `VariationStrip` as `s().highlight()`,
which Solid compiles to a reactive getter so the active cell tracks the
drag — pinned by a regression test.

**Plan deviations made during execution (and why).** (1) Plan Tasks 4
(gesture core) + 5 (variation `move`) were MERGED into one commit: under
this repo's `noUnusedLocals` (`tsc` TS6133) a core-only commit can't
pass the type gate — the `cfg`/`strip`/`cancelled` fields exist solely
to serve `move()`, so "declare fields" and "use fields" can't be
separate clean commits. (2) `KeyboardHost.applyIntent`'s `moveCaret`
collapses an active selection to its near edge (`start`/`end`) instead
of stepping ±1 past it (native iOS text-selection persists under
`inputmode=none`). (3) Every task finished with `scripts/bun.sh run
build`, not just `vitest` — the plan's test snippets repeatedly tripped
`noUncheckedIndexedAccess`; the fix is optional chaining on indexed
array access, the repo convention. (4) The EmojiPicker test mocks the
emoji dataset down to a few entries: rendering all ~1900 buttons took
~9s in jsdom and timed out under full-suite parallel load on the Pi (it
passed in isolation at 4.99s). The full dataset is covered by
`emoji-data.test.ts`.

**On-device dogfood — OUTSTANDING (Playwright webkit ≠ real iOS; must
test on device).** Two items need real-iPhone verification before this
is trustworthy: (1) **Caret under `inputmode=none`.** `applyIntent`
sets the caret synchronously then calls `setDraft`; the compose textarea
is Solid-controlled by `draft()`, so the re-render MAY clobber the
caret. It might survive because `applyIntent` imperatively pre-sets
`ta.value` (Solid's value binding may no-op when unchanged) — but this
is browser-dependent and unverified. If the caret jumps, mirror Shell's
`cycleNickComplete`: capture the intended caret and restore it in a
`queueMicrotask` in the production `onIntent` handler (NOT in the pure,
unit-tested `applyIntent`). (2) **Height reservation + layout:** confirm
the composer clears the docked keyboard and tune `KB_HEIGHT_PX` (≈290)
against the rendered keyboard; pixel-tune the `--kbd-*` greys/radii/
shadow against the reference PNGs in `assets/`. Note
`.kbd-key--active` reuses `--kbd-magnify-bg`, so in mirc-light a pressed
key shows no rest/active distinction (the magnify balloon is the primary
feedback) — revisit during grey-tuning.

**Known follow-up (not blocking).** `CELL_WIDTH = 44` is duplicated in
`KeyCap.tsx` (drives strip geometry) and `VariationStrip.tsx` (renders
cells) with a "keep in sync" comment; if they drift the highlight
misaligns. Consolidate into one `src/keyboard` metric during the
on-device tuning pass (the natural moment the dims change).

## 2026-06-14 — IRC keyboard: on-device dogfood fix round (real iPhone)

vjt dogfooded the shipped keyboard on a real iPhone (Playwright webkit ≠
iOS, as predicted) and it was a shit show. Six fixes across two
deploys (cic-only, hot). Supersedes the "OUTSTANDING" caveats above where
they conflict (notably: the reservation is now MEASURED, not a tuned
`KB_HEIGHT_PX` constant).

**The critical one — native keyboard appeared on focus.** `inputmode=
"none"` was poked imperatively by a Shell `createEffect` keyed on
`ircKeyboardEnabled()`. It only ran when the opt-in CHANGED, so a textarea
re-created on channel switch / ComposeBox re-render carried no attr → iOS
summoned the native keyboard AND woke the dormant `--vh`/visualViewport
push-up machinery. Fix: bind it DECLARATIVELY + reactively on the
ComposeBox `<textarea>` (`inputmode={ircKeyboardEnabled() ? "none" :
undefined}`), so every render carries it. General rule: a one-shot
imperative attr-set on a reactively re-created element is always a latent
bug — make the attr part of the render.

**Magnify + variation strip were invisible (but the gesture worked).**
`.kbd-root` carries `transform` (the slide animation); a transformed
element is the containing block for its `position:fixed` descendants, so
the magnify (KeyCap) and strip (Keyboard) — positioned in VIEWPORT coords
from `getBoundingClientRect` — anchored to `.kbd-root` and rendered
off-screen. The gesture math (viewport coords) still committed variants,
hence "swiping inserts but nothing shows." Fix: render both via Solid
`<Portal>` to `document.body`, escaping the transform. The `--kbd-*`
palette still cascades (vars on `:root`); `VariationStrip` stays a pure
component (the Portal wraps its USE in Keyboard) so its isolation test is
untouched.

**fn-key white borders / minuscule spacebar.** The fn keys + space are
`<button>`s, the letters are `<div>`s; the buttons inherited the UA
border + appearance + system font. Added a button reset to `.kbd-key`
(`appearance:none; border:0; margin/padding:0; font-family:inherit` —
not the `font` shorthand, which would clobber the explicit font-size).
Spacebar had no rule → inherited the one-unit basis; now fills the bottom
row's slack.

**Key-sizing model was wrong.** Rows used `flex:1`, so fewer-key rows got
WIDER keys (row2's 9 letters wider than row1's 10). Stock iOS keeps the
LETTER width constant and centers short rows. Replaced with a key-unit
model: `--kbd-key-w = (row − 9 gaps) / 10`, letters span 1u, fn keys
span `1.5u + ½gap` (makes row3 = shift+7+⌫ line up exactly with the
10-unit rows), spacebar `flex:1 1 auto`. `justify-content:center` then
insets short rows. Exact spans/greys still get pixel-tuned on-device.

**Arrow order** ◀ ▲ ▼ ▶ (was ◀ ▶ ▲ ▼) — vjt preference; intents
unchanged (◀▶ caret, ▲▼ history).

**Emoji layer overflowed the channel bar.** It was a fixed `260px`,
taller than the letter body. Bound to `--kbd-body-h` (4 rows + 3 gaps) so
it occupies the SAME bounded area; grid scrolls, category bar pins.

**Focus-driven show/hide replaces always-docked (vjt's design call).**
The old `show()` had no focus dependency, so ✕ (which only blurred) left
the keyboard docked. New model in `KeyboardHost`: a `wantKeyboard`
open-intent set on compose-textarea `focusin`, cleared on ✕ (which also
blurs) or when a different text field gains focus. `visible = mountable &&
wantKeyboard`; the Keyboard stays mounted so the slide animates both ways.
Per vjt: tapping the compose box re-opens; a channel switch keeps it open
by re-focusing the re-created textarea (so the caret returns).
`keepKeyboard.ts` already pins compose focus across taps on non-input
chrome, so normal use never drops it — only ✕ / focusing elsewhere does.

**Reservation is now MEASURED, not guessed.** `--irc-kb-height` moved
from Shell to `KeyboardHost` and is set to the keyboard's live
`offsetHeight` when visible (0 when hidden). The BottomBar + composer lift
by exactly the rendered height on any device — the `KB_HEIGHT_PX ≈ 290`
constant (which undershot and let the keyboard overlap the channel bar) is
gone. `.shell-mobile`'s existing `max(env, var)` base rule +
`:has(textarea:focus) { var }` rule consume it unchanged; keyboard-off
layout is still byte-for-byte the prior values (var resolves 0).

**Still to verify on the next dogfood pass:** the iOS lollipop magnify
SHAPE (now visible but a plain rounded rect — the neck is unbuilt); exact
key spans / greys / radii vs the reference PNGs; caret stability under
`inputmode=none` while typing (untouched this round — `applyIntent`
pre-sets `ta.value`, may survive; the `queueMicrotask` caret-restore
escape hatch is still the fallback if it jumps). `CELL_WIDTH=44`
duplication (above) also still pending.

### Round 2 (same day) — four more dogfood fixes

The reactivity gamble above lost: typing fast DID drop characters. Fixed
along with three other defects.

- **Dropped keys → edit through the draft store, not `ta.value`.** The
  editing path read the current text from the live textarea, but it's
  Solid-controlled by `draft()` and a fast keystroke burst leaves it
  mid-re-render, so `ta.value`/caret were stale and inserts landed at the
  wrong offset. Split the math into a pure `editText(intent, text, sel) →
  {text, caret}` and a host `applyEdit` that reads `getDraft` (synchronous,
  authoritative), writes `setDraft`, and restores the caret on the next
  microtask after Solid flushes — the same shape tab-complete already used.
  `applyIntent`/`HostCallbacks` are gone; the unit test now exercises the
  pure `editText`. **General rule: never read a controlled input's `.value`
  as the source of truth — read the store that drives it.**

- **Variation strip never closed.** A cancelled long-press never calls
  `onCommit`, and strip teardown was glued to the commit path
  (`Keyboard.commit → setStrip(null)`), so dragging below the key and
  releasing left the strip stuck on screen. Gave `KeyCap` an
  `onCloseVariants` callback, called both mid-drag the instant the gesture
  cancels (highlight → null, closes immediately like iOS) and
  unconditionally in `finish()`. Teardown now has ONE owner; the gesture
  engine is untouched.

- **Emoji layer still overflowed → `min-height:0` on the grid.** Bounding
  `.kbd-emoji` to `--kbd-body-h` wasn't enough: `.kbd-emoji-grid` is a flex
  item, and `min-height:auto` (the default) refuses to shrink below its
  content, so the ~1900-cell grid grew to full height, pushed the ABC bar
  off, and spilled over the channel bar. `min-height:0` lets it shrink to
  its flex basis and scroll. The classic flexbox-overflow trap.

- **Send button collapsed the keyboard (#59).** Tapping the `type=submit`
  send button moved focus off the textarea (Android native kb collapse;
  also dropped the IRC-kb focus model). `onPointerDown` preventDefault on
  the button stops the focus steal — the click still submits. Same trick as
  the keyboard keys + image-picker. Enter-to-send never had the bug.

Still deferred to a visual pass: the lollipop magnify SHAPE, and exact key
spans / greys / radii vs the reference PNGs. `CELL_WIDTH=44` dedup still
pending.

## 2026-06-19 — #62: visitor `/away` un-gated + channel-push errors get human copy

Two defects, one report. Visitor `/away` returned a bare `Send failed`;
authenticated users worked.

**Defect A — the gate had a bogus rationale.** The channel
`handle_in("away", ...)` arms short-circuited every visitor subject with
`{:error, %{error: "visitor_no_away"}}`. The moduledoc justified it as "the
`set_explicit_away/3` facade only routes to user sessions" — factually
wrong. `Session.set_explicit_away/3,4` is guarded on `is_subject/1` and
routes via `call_session(subject, …)`; it accepts `{:visitor, id}` exactly
like `{:user, id}`. And each visitor owns a PRIVATE, isolated
`Session.Server` + upstream IRC connection with a unique nick (Bootstrap
`spawn_visitor` → unique `{:visitor, id}` registry key), so a visitor's
`away_state` is per-connection — AWAY can't clobber anyone else. The gate
conflated explicit `/away` (a per-connection user action) with the
WSPresence-driven AUTO-away, which genuinely stays user-only because
visitor sessions don't subscribe to `WSPresence`. Fix: delete the gate,
make the away dispatch subject-aware via the existing `resolve_subject/1`
(the same C3 WHOIS carve-out pattern). Net simplification — one code path
replacing the `if visitor? … else` fork; `safe_get_user` →
`resolve_subject`; the `dispatch_set_away`/`dispatch_unset_away` helpers
now take `Session.subject()` instead of `Accounts.User.t()`.

**Defect B — `compose.ts` swallowed every channel-push code into "send
failed".** The submit catch only ran `friendlyApiError` for `ApiError`
(REST); a `ChannelPushError` (the `/away` push reject shape) fell through
to the generic `"send failed"` string, hiding the real reason. Violates
the CLAUDE.md "no silent-swallow at boundaries" rule. Fix: a sibling
`friendlyChannelError.ts` — same closed-union-token → human-copy
discipline as `friendlyApiError` (loud `err.message` fallback for unmapped
arms, exhaustive vitest matrix). Wired into the catch:
`ApiError → friendlyApiError`, `ChannelPushError → friendlyChannelError`,
else `"send failed"`. The now-dead `visitor_no_away` token is deliberately
NOT mapped — a dead arm is silent UX rot (cf. the
`captcha_provider_unavailable` history). Channel coverage note: there were
ZERO channel-level `/away` tests before; the handler boundary AND the gate
were untested, which is why this shipped.

## 2026-06-20 — #31: visitor `/invite` un-gated (third carve-out, C3 lineage)

Same shape as #62, third instance of the same root. The channel
`handle_in("invite", ...)` arm routed through `dispatch_ops_verb/3`, which
short-circuits every visitor subject with `visitor_not_allowed` before the
verb dispatches. INVITE is a write verb — it was filed under the
"state-mutating ops" bucket alongside op/kick/ban — but it does not mutate
channel/server state the way those do: it sends an *invitation* the target
may ignore, and the upstream IRC server is the real authority on whether
the issuer may send it (must be on the channel; op for `+i`). A visitor is
on the channels their own session joined, so inviting a friend to a channel
they're in is exactly as legitimate as the WHO/NAMES they can already
issue. `Session.send_invite/4` already accepts `t:Session.subject/0`
(`is_subject/1` guard + `call_session/3`), so the fix is the mechanical C3
migration: `dispatch_ops_verb/3` → `dispatch_subject_verb/3`, thunk takes
`subject` instead of `user`. A visitor without a live `Session.Server` now
gets `no_session` (the real reason) instead of the gate's
`visitor_not_allowed`.

The recurring lesson (C3 WHOIS → #62 `/away` → #31 `/invite`): the
"ops verb = visitor-rejected" bucket conflated *transport entitlement*
(does this subject own a session that can emit the line?) with
*IRC-protocol authority* (will the server accept it?). The second is
upstream's job, not the channel boundary's. The moduledoc blanket
"all ops verbs reject visitor sockets" was the source of the drift — now
rewritten to enumerate the state-mutating set explicitly and name the
read-only + `/away` + `/invite` carve-outs, so the next visitor-eligible
verb isn't mis-bucketed by pattern-copying. Tests mirror the C3 WHOIS trio:
live-session → INVITE upstream, no-session → `no_session`, malformed-nick →
`invalid_nick` (the inbound `Identifier` gate fires before the facade, so
that one passed pre-fix — belt-and-braces).

## 2026-06-21 — PWA home-screen icon badge (one predicate, three doors)

Design approved 2026-06-12, implemented 2026-06-21.
The badge shows "how many unread messages did the operator choose to be
notified about" — capped at 99, fully derived from read cursors + the
notify predicate, **no new persisted state**.

**One predicate, never reimplemented.** The count is the EXACT set Web
Push fires on: rows passing `Grappa.Push.Triggers.should_notify?/4`. So
the badge and the OS notification can never disagree by construction.
`Grappa.Push.BadgeCount.count/1` fetches the bounded unread tail per
cursor (`Scrollback.unread_content_tail/6`, capped, early-bail at 99) and
maps the REAL predicate over it — NOT a second SQL-shaped copy of the
notify logic, which is the predicate-divergence bug class CLAUDE.md
forbids. The design sketched a SQL-COUNT fast path for the all/whitelist
branches; we chose uniform predicate-reuse instead because the cap keeps
it cheap and a single source of truth beats a micro-optimisation. The cic
foreground mirror (`pushTriggers.ts` `shouldNotify`) and the Elixir
original are pinned together by a SHARED truth-table JSON fixture both
ExUnit and vitest consume — add a branch, add a row, both suites catch a
drift.

**Boundary inversion (the load-bearing structural call).** BadgeCount
deps `Networks`/`ReadCursor`/`Visitors`, all of which transitively reach
`Session`, and `Session` deps `Push`. Folding the counter into the `Push`
context would close `Push → Networks → Session → Push`. So BadgeCount is
its OWN `top_level?: true` boundary that sits ABOVE Push and deps DOWN
onto it for `should_notify?` (same pattern as `Visitors.Reaper`). Doors #2
and #3 call it from the web layer (already at the top). Door #1 — the
push-payload badge, dispatched deep in `Session → Push.Triggers` — would
re-open the cycle with a static `Push → BadgeCount` edge, so it resolves
the counter at RUNTIME through a `Grappa.Push.BadgeSource` behaviour wired
in `config/config.exs` (never a module literal in Push source). Dependency
inversion, not a hack: Push owns the seam, config owns the wiring. Deploy
corollary: a HOT module reload swaps the new code in but does NOT re-run
`config.exs`, so `:badge_source` is briefly absent on the live node.
`BadgeSource.count/1` returns `nil` (not a crash, not a wrong `0`) in that
window and door #1 omits the badge field — the push still fires, the SW
just leaves the icon untouched; badges resume the moment the config is
live (cold restart / rpc `put_env`).

**own_nick is the configured nick, off-Session.** The mention branch
needs the operator's IRC nick. BadgeCount resolves it from the credential
nick (users) / `visitor.nick` (visitors) via
`Networks.configured_nick_index/1`, NEVER the live `Session.current_nick`.
Door #3 runs on every read-cursor settle (focus-leave) — a GenServer
round-trip per network on that hot path is unacceptable, and `/me`
already takes the same off-Session stance. Accepted staleness: after a
`/nick` rename the mention match uses the configured nick until the next
reconnect rewrites the credential. Documented, bounded, self-correcting.

**Three doors, one signal.** (1) push payload gains `badge` (computed at
dispatch, after the triggering message is persisted so the count includes
it); (2) `/me` gains `badge_count` (boot seed); (3) `read_cursor_set`
gains `badge_count` (reading anywhere refreshes every live client). cic's
`badge.ts` is a single signal → effect driving `navigator.setAppBadge`
(feature-detected) + the `document.title` mirror `(n) <base>`. The SW
stamps the icon on push receipt EVEN when the foreground toast is
suppressed (a badge is non-intrusive).

**Increment scope (honest limitation).** The foreground optimistic bump —
so the desktop title moves the instant a notify-worthy message lands on an
unfocused tab — reuses the existing mention path (`subscribe.ts`,
focus-gated + own-echo-gated). It covers the channel-MENTION case (the
default-prefs notify trigger). Non-mention triggers (channel-all / DM-all
/ whitelist) are NOT bumped optimistically because cic has no global
notification-prefs signal to feed the full `shouldNotify` predicate at
message-arrival; they surface on the next server sync (`read_cursor_set` /
`/me`). The count is server-authoritative throughout, so any transient
under-count self-heals. `shouldNotify` stands as the parity-locked
contract for a fuller increment once prefs get globalised.

**Verification surfaces.** The `document.title` mirror is the only
badge surface a headless browser can see (Playwright e2e:
`pwa-badge-title-mirror.spec.ts` asserts the title prefix increments on an
unfocused mention). The home-screen ICON badge (`setAppBadge`) lives on
the OS launcher, needs granted notification permission on an installed
PWA, and is invisible to Playwright — so the icon itself is **device
dogfood** only.

## 2026-06-21 — empty `/away` reason rejected (un-away footgun closed)

An explicit-away reason of `""` built `AWAY :\r\n` upstream, which RFC
2812 §4.6 defines as the bare-AWAY *un-away* line: setting away with an
empty reason silently CLEARED away instead. `safe_line_token?/1` only
screens CR/LF/NUL, so `""` slipped every guard. The channel boundary's
`with_body_check` only screens `body_too_large`, so a crafted WS push
`{action:"set", reason:""}` reached the wire.

Fixed at two layers, deliberately:

- **`Session.set_explicit_away/3,4`** (primary boundary) now guards
  `reason != "" and safe_line_token?(reason)` → `{:error, :invalid_line}`.
  This is the single chokepoint covering BOTH internal byte paths (the
  labeled `@label= AWAY :` send_line and the plain `Client.send_away`),
  and it rejects early — before the `whereis` lookup, ordered like the
  other facade injection guards.
- **`Client.send_away/2`** (byte boundary, defense-in-depth) now also
  guards `reason != ""`, completing the symmetry its siblings already
  had: `send_privmsg`/`send_part`/`send_oper`/`send_pong`/`send_raw` all
  reject empty at this door precisely so a non-cic caller (test harness,
  Phase 6 listener facade) can't slip a malformed frame past even if the
  facade is bypassed. `send_away` was the lone exception — and the facade
  docstring already *claimed* it mirrored `send_pong`. Now it does.

The guard is `!= ""`, NOT `String.trim/1`: a whitespace-only reason is a
valid (if blank-looking) `AWAY :   ` set, not the un-away line, and the
`!= ""` shape matches `send_pong`. Pinned with a facade test so a future
change can't tighten to trim-semantics and start rejecting spaces.

cic side (`slashCommands.ts`): the `/away` parser mapped `/away :` (colon
then nothing) to `{action:"set", reason:""}` — pre-fix a silent un-away,
post-fix a "Send failed" alert. Collapsed both empty-reason cases (bare
`/away`, `/away :`) into one `reason === "" → unset`, removing the now-
redundant `rest === ""` early-return. The existing test asserted the
buggy `set`/`""` shape; re-pointed to `unset`. Also fixed a pre-existing
(CI-invisible — cic vitest is local-only) red in `compose.test.ts`: the
`vi.mock("../lib/api")` block omitted `ChannelPushError`, so #62's
`e instanceof ChannelPushError` threw for every non-ApiError rejection.

## 2026-06-21 — login 433 surfaces as `:nick_in_use` (#40)

Picking a nick already on the upstream at the landing page returned
"handshake didn't complete" (cic's `connect_timeout` copy) — the visitor
waited out the welcome budget and got a generic timeout instead of the
actual reason. Root cause: `Visitors.Login` blocks on the
`{:session_ready, ref}` (001 RPL_WELCOME) signal; a 433
ERR_NICKNAMEINUSE never reaches 001. For a passwordless/anon session
AuthFSM has no ghost-recovery path, so it stops the Client with
`{:nick_rejected, 433, _}`; `Session.Server` traps the linked exit and
re-raises it as its own stop reason `{:client_exit, {:nick_rejected,
433, _}}`. That term already rode the monitored DOWN to the login
waiter — Login just *discarded* it (`{:DOWN, …, _}`) and flattened every
crash to `:upstream_unreachable`.

Fix is pure classification, no new state: capture the DOWN reason and
`classify_down/1` maps `{:client_exit, {:nick_rejected, 433, _}}` →
`:nick_in_use`, everything else → `:upstream_unreachable` (unchanged).
The 409 `nick_in_use` envelope already existed (visitor `/nick` rename
collision, V9) so the controller + FallbackController + cic only needed
the login surface wired to it: an explicit `visitor_error_response`
allowlist arm (the catch-all would 500 it) and a `friendlyApiError`
case. 432 ERR_ERRONEUSNICKNAME is deliberately NOT mapped — `validate_nick/1`
already gates nick shape, so a 432 reflects upstream-specific rules and
the generic surface stays honest.

Registered visitors (cached NickServ password) are unaffected: their
433 drives `GhostRecovery` (underscore-NICK + GHOST + IDENTIFY), whose
FSM stays `:cont`, so the exit reason is never `:nick_rejected` and
won't be misclassified.

## 2026-06-21 — single NickServ IDENTIFY site on login (#27)

A registered visitor logging in saw NickServ's "Password accettata …
risulti identificato" NOTICE **twice**. Not a cic render bug — grappa
put `PRIVMSG NickServ :IDENTIFY <pw>` on the wire twice:

1. `IRC.AuthFSM.maybe_nickserv_identify/1` emits it at 001 RPL_WELCOME
   for any `:nickserv_identify` plan. This is the canonical site: it
   fires for **every** such spawn, including `Bootstrap` crash-respawn
   where `Visitors.Login` never runs. The emission happens inside
   `IRC.Client`, so it bypasses `Session.Server`'s `{:send_privmsg, …}`
   call path (and therefore `NSInterceptor`); the password is instead
   staged for the +r MODE observer via
   `Session.Server.maybe_stage_pending_password/1`, fed from
   `pending_password` (set at init from the `:nickserv_identify` plan).
2. `Visitors.Login.preempt_and_respawn/4` then sent a **second**
   IDENTIFY post-readiness through `send_post_login_identify/3`.

The second send was pure redundancy. A case-2 visitor (row with
`password_encrypted`) is *always* `:nickserv_identify` — visitor
`auth_method` is only ever `:none | :nickserv_identify`
(`Visitors.SessionPlan`, no SASL path) — so path (1) had already
produced the same NOTICE and the same +r MODE before Login's send ran.
The login.ex docstring's stated rationale ("so NickServ + the +r MODE
observer can reconfirm registration") was satisfied entirely by path
(1).

Fix: delete the post-readiness send and its now-dead helpers
(`send_post_login_identify/3`, `error_tag/1`, the `require Logger` they
needed). No new state, no behavioural change beyond removing the
duplicate. Side benefit: the deleted path was the one place login
threaded the cleartext password through `Session.send_privmsg`, so
dropping it removes a cleartext-handling site.

Regression guard: `login_test.exs` now asserts IDENTIFY appears on the
wire **exactly once**. Counting needs a TCP-order barrier — the
post-readiness send was synchronous on grappa's side by the time
`Login.login/2` returned, but the `IRCServer` fake reads the socket
asynchronously, so a naive count races. The test pushes one more wire
line (`PRIVMSG NickServ :HELP`) and waits for it; `packet: :line` +
`active: :once` deliver in order, so once the barrier line is buffered
every earlier line is too. The assertion fails against the old code
(`got 2`) and passes after.

## 2026-06-21 — orphaned PWA icon badge reconciled on foreground

The home-screen icon badge could stick at a stale non-zero count after
the operator had read everything. Prod rpc against the live node
(`Grappa.Push.BadgeCount.count/1` for the operator subject) returned
`0` — the server count was correct; the drift was purely the OS
icon-badge SURFACE.

Root cause: the OS badge has TWO writers that share no state. The
service worker's push handler (`cicchetto/src/service-worker.ts`
`applyIconBadge`, push door #1) calls `navigator.setAppBadge` directly
from the SW context while the app is backgrounded — it never touches the
in-page `badgeCount` signal. The in-page `mountBadgeSync` effect
(`cicchetto/src/lib/badge.ts`) only re-applies the surface when the
signal *changes value* (Solid `===` equality). So on a warm foreground
where the server count already equals the signal (typically 0-over-0
once everything's read), `setBadge` is a no-op, the effect never
re-fires, and the SW-set badge is orphaned. Cold launch was always fine
— the `/me` seed + the `mountBadgeSync` mount reconcile — but a warm
resume (the common iOS PWA case) had no reconcile point.

Fix: `mountBadgeReconcile` registers a `visibilitychange` listener that,
on every visible event, re-pulls the authoritative `/me` `badge_count`
and `reconcileBadge` force-applies it to both surfaces, bypassing the
signal-equality short-circuit. Reconciling to the SERVER count (not a
blind clear-to-0, which was the first instinct floated) is load-bearing:
a mention that genuinely arrived while backgrounded must KEEP its badge,
so a clear-to-0 would wipe a real signal. The `badgeCount` signal stays
the single source of truth — the reconcile just refreshes it from the
server and forces the surface, closing the SW-writes-around-the-signal
gap the badge.ts moduledoc now documents.

Accepted tradeoffs (the fix is strictly better than a permanently-stuck
badge, so these stay):

  * A `/me` round-trip in flight when a fresher `read_cursor_set` lands
    can resolve stale and briefly clobber the newer count. Transient —
    it self-heals on the next `read_cursor_set` / visible event, same
    eventually-correct tolerance the optimistic `incrementBadge` path
    already documents. A request-sequencing guard would be heavier than
    a one-round-trip flicker on an icon badge.
  * Relies on `visibilitychange` firing on iOS standalone-PWA
    background→foreground. True on iOS 16.4+ (the floor for the Badging
    API anyway). Not reproducible in Playwright webkit (its visibility
    model ≠ real iOS) — verified by on-device dogfood after deploy.

The listener is app-lifetime (registered bare in `main.tsx`, disposer
intentionally dropped — production PWA updates full-reload, so listeners
never accumulate; the disposer exists for unit-test cleanup). No
`createRoot` wrapper: it's a raw `addEventListener`, not a Solid
reactive primitive, so there is no computation owner to scope.

## 2026-06-21 — own nick change surfaces on $server (#61)

Changing your own nick produced no visible confirmation in cic when you
shared no channel with your old nick, and even with channels the rename
only appeared in those channel views — never the always-reachable server
tab. `EventRouter`'s `:nick` clause fans out a `:nick_change` scrollback
row per channel the renamer is a member of; for a self-rename with zero
shared channels that fan-out is empty → zero effects → no feedback. The
separate `own_nick_changed` STATE event (broadcast by `Session.Server`,
consumed by cic's `userTopic.ts` to patch the displayed nick) applied
the change silently — the nick rotated, the operator saw nothing.

Fix: in the `:nick` clause, when `old_nick == state.nick`, emit one
additional `:nick_change` persist on the synthetic `"$server"` window,
independent of channel membership. `$server` always exists, so the
confirmation is guaranteed even with zero channels. Reuses the existing
typed `:nick_change` event + the `$server` convention — scrollback stays
server-owned, cic renders it via the existing `:nick_change` line, no cic
change. The row is gated on the self check (NICK-other never reaches
`$server`); visitors get it too (subject-agnostic check) alongside the
unchanged `{:visitor_nick_changed, _}` persist.

Behaviour note (reviewer-surfaced, kept on purpose): the `$server`
nick_change row counts as a cic "event" (not a message) in the
cursor-derived unread until the server tab is viewed — the same way the
per-channel self-rename rows already do (cic appends the row to
scrollback BEFORE the `isOwnPresenceEvent` gate, and the gate only skips
the mention/title bump path, not the cursor count). The `$server` window
handler is installed with `ownNick = null` (`subscribe.ts`), so
`isOwnPresenceEvent` can't suppress there anyway — but passing the live
nick wouldn't help either, since the row's sender is the OLD nick while
the live own-nick is already the NEW one post-`own_nick_changed`. The
events indicator IS the always-visible confirmation #61 asked for, so it
stays; the OS/notify badge ignores it (presence kinds fail
`should_notify?`).

## 2026-06-21 — sender grade glyph snapshotted at send time (#25)

A user's `@`/`%`/`+` channel-grade glyph was applied RETROACTIVELY to
their past scrollback lines the instant their grade changed: cic's
`prefixFor` derived the glyph at RENDER time by joining the row's sender
against the LIVE members store, so an op/deop re-prefixed every old line
of that nick. The glyph must reflect the sender's grade AT SEND time.

Fix (snapshot — the issue's fix-direction a, not a flag-history
timeline): the server captures the sender's grade into
`meta.sender_prefix` at PERSIST time; cic renders content-row senders
from that frozen value instead of live members.

Server — one capture rule, both doors:
  * `EventRouter.build_persist/6` merges `sender_prefix` into meta for
    content kinds (`:privmsg`/`:action`/`:notice`) on a sigil-shaped
    channel where the sender is a tracked member with a non-plain grade.
    Centralising it in `build_persist` covers every inbound content row
    (privmsg/action/notice, services-`$server` reroute and DM targets
    correctly excluded by the channel-shape + member-lookup guards).
  * `Session.Server.persist_and_send_fragments` mirrors it for the
    operator's OWN outbound messages (`own_sender_prefix_meta/2`).
  * `Grappa.IRC.Identifier.member_prefix/1` is the shared sigil-precedence
    reducer (`@` > `%` > `+`), matching cic's `memberSigil` so server
    snapshot and client render agree.
  * `Scrollback.Meta` allowlists `:sender_prefix`. Per the
    `known_keys ↔ Logger :metadata` sync test (architecture review A18),
    `config/config.exs` must list it too — and because that's a
    `config/*.exs` edit, the deploy preflight forces a **COLD** deploy
    (sessions drop + respawn). Accepted with vjt; batched as the one
    cold change of the session.

cic: `ScrollbackPane.prefixFor` returns `nickColor.snapshotSenderPrefix(meta)`
for the content row's OWN sender (`isContentKind && nick == msg.sender`);
presence-row senders (join/part/quit/mode) and the kick TARGET keep the
live members join — those describe a "now" event, not a frozen send. An
absent snapshot (plain sender, or a row persisted before this landed)
renders NO glyph, never a live-derived guess — so old rows lose their
(wrong) glyph rather than show a stale one. The `meta` value is the
untyped wire bag, validated against the three glyphs in
`snapshotSenderPrefix`.

Snapshot timing is genuinely "send time": `state.members` is updated by
the MODE / 353-NAMES handlers that the session's FIFO mailbox processes
before the next PRIVMSG is routed, so the grade read at persist reflects
the grade in force when the line arrived. e2e `ux-5-bc2-nick-render`
unaffected — it asserts nick colour, plain-sender-no-glyph, and bracket
shape, never a live opped glyph.

## 2026-06-23 — +k autojoin: dismissable stuck tab (#38) + members-seed guard (#16)

Two related +k-channel bugs, both run to ground with a deterministic e2e
against the real testnet bahamut (the static investigation in CP67 could
not reproduce either from prod state).

**#16 — members pane stuck "loading…" after a keyed JOIN — already fixed
in the tree.** Prod rpc confirmed bahamut sends the 353/366 burst on a
keyed JOIN, and the cold-subscribe race is covered by CP15 B3's after_join
`push_members_if_seeded`. The new e2e
(`issue16-keyed-join-members-seed.spec.ts`) proves it and guards the
class: a peer founds a +k channel, cic `/join`s with the key, and the
member list is present BOTH on the live JOIN and after a page reload — the
deterministic cold WS resubscribe that exercises the after_join push
rather than the one-shot live `members_seeded` broadcast. Closed as
already-fixed; no production change.

**#38 — a +k autojoin channel can't be dismissed with ×.** grappa
deliberately does NOT persist +k keys: `state.autojoin` is channel names
only and the 001 RPL_WELCOME autojoin loop sends
`Client.send_join(client, channel, nil)` (server.ex:1633, "UX-4 bucket F:
explicit nil"). So every (re)connect re-JOINs a +k autojoin channel with
no key → bahamut 475 → not joined. That lights up BOTH cic sidebar sources
for the same channel: GET /channels' autojoin merge returns it
`{joined:false, source:autojoin}` (→ `channelsBySlug`) AND the 475 emits a
`join_failed` typed event (→ `windowStateByChannel = :failed`). The render
dedup (`pseudoChannelsForNetwork` skips names already in `channelsBySlug`)
makes it render via the LIVE branch, so its × routed through
`closeChannelWindow`, which only `postPart`'d.

Root cause: that DELETE drops the channel from `channelsBySlug` (server
de-autojoins + broadcasts `channels_changed` → refetch), but for a
never-joined channel the upstream PART is a 442 no-op, so NO self-PART
scrollback echo arrives — and that echo (`subscribe.ts` own-PART arm) is
the ONLY caller of `setParted`, the verb that clears `windowState`. The
orphaned `:failed` entry then re-emerges as an un-dismissable greyed
pseudo-row the instant `channelsBySlug` drops the name. (The sibling
pseudo-row × `handleClosePseudo` does call `setParted`, but the dedup
means the LIVE-branch × is the one shown for a both-sources channel.)

Fix: `closeChannelWindow` now also clears the local windowState
(`setParted`) alongside `postPart`. The close action's local effect must
not depend on a server PART echo that only fires for actually-joined
channels. Idempotent with the echo for joined channels; clearing (vs.
adding) a windowState key can only emit FEWER pseudo-rows — the OPPOSITE
direction from the reverted PHASE-1.1 ghost-row regression (which added a
joined arm to the render projection). Shared helper → the mobile BottomBar
× is fixed too. General class, not just +k: any channel present in both
`channelsBySlug` and a non-`:joined` windowState.

Escape hatches after this fix: × dismisses the stuck tab, and
`/join #chan KEY` re-joins with the current key (cic forwards it,
`compose.ts` → POST /channels `{name,key}`). Making autojoin rejoin +k
channels *automatically* (persisting the key, Cloak-encrypted like
NickServ/SASL, captured on a successful keyed `/join`, with a stale-key
path) is a deliberate follow-up feature — deferred (vjt 2026-06-23), not
folded into this bugfix, because storing channel passwords warrants its
own design pass.

## 2026-06-23 — Nick completion: irssi-exact + keyboard-free (double-tap)

Goal: make nick completion usable on a STOCK mobile keyboard (no Tab
key), so the custom IRC keyboard becomes optional rather than the only
way to complete a nick.

**Scope decision.** Rejected an `@`-mention tooltip popup: `@` is the op
sigil in NAMES, not a mention trigger in IRC — importing Slack/Discord
muscle memory. Picked the minimal path: a touch trigger on the existing
`compose.ts` `tabComplete` cycle, plus a semantics fix.

**`tabComplete` rewritten to irssi-exact semantics** (`compose.ts`):
- Positional suffix: `": "` when the completed word is the first token on
  the line, `" "` mid-sentence (`input.slice(0, anchorStart).trim() === ""`).
- Cycle space is `[match0 … matchN-1, <typed>]`: forward past the last
  match restores the originally-typed text (original case, no suffix),
  THEN wraps to match0. The old code wrapped forever with no revert.
- Continuation is detected by an anchor RANGE (`cursor ∈
  [anchorStart, anchorEnd]` AND the anchored span equals the last
  insertion), not by word equality. Word equality broke the instant a
  suffix landed after the caret (the "word at cursor" became empty); the
  range also lets a re-tap landing the caret INSIDE the inserted nick
  count as the same cycle — load-bearing for the double-tap path.

**Latent bug fixed in the same pass: in-app cycling never worked.**
`setDraft` nulls the cycle anchor `tabCycle` (correct — a real edit must
break the cycle), but BOTH callers (`Shell.tsx` `cycleNickComplete`,
`KeyboardHost.tsx` Tab branch) called `setDraft(result.newInput)` right
after `tabComplete`, nulling the anchor every time. So the 2nd Tab always
re-entered fresh: the prefix became the full last nick, matches collapsed
to that one nick, output never changed. The old unit tests "passed" only
because they called `tabComplete` directly and bypassed `setDraft` —
mirror tests on the wrong path. Fix: `tabComplete` now writes the draft
itself via `writeState` (which does NOT null `tabCycle`); the callers drop
their `setDraft` and only place the caret. The IRC-keyboard note's
"tab-complete is a byte-for-byte mirror of `Shell.tsx`'s
`cycleNickComplete`" still holds — both shed `setDraft` identically.
Discard-on-keystroke needs no new code: every real keystroke already
flows `onInput → setDraft`, which nulls the cycle.

**Double-tap trigger** (`ComposeBox.tsx` + pure `lib/doubleTap.ts`).
**[SUPERSEDED 2026-06-24 by swipe-right — see the next entry. Kept for the
record: this shipped to prod 2026-06-23, then dogfood confirmed the
word-select collision below was a real problem in practice, not just a
theoretical one, so the trigger was swapped. The completion semantics
above are unchanged.]** Two taps within 300ms / 24px on the textarea fire
`tabComplete(…, selectionEnd, forward=true)`. We do NOT fight the OS native
word-select `preventDefault` (unreliable on iOS) — we let the OS select,
then override value + caret (`selectionEnd` is the cursor, so the
OS-selected word is the completion target). `e.isPrimary` guard drops
secondary multi-touch pointers. The pure tap reducer is unit-tested; the
gesture itself is dogfood-only — Playwright webkit ≠ iOS gesture physics
(prior burn).

**Dogfood checklist (device-only, cannot be automated).** iOS, stock
keyboard, IRC keyboard OFF, channel with ≥2 prefix-sharing nicks:
1. Prefix at line start, double-tap → `nick: ` (colon+space).
2. Double-tap again → next match; again → reverts to the typed text.
3. Prefix mid-sentence → `nick ` (space, no colon).
4. Prefix mid-sentence WITH trailing text after the caret
   (`hey al world`, caret after `al`) → confirm the cycle continues on a
   2nd double-tap
   (code-review flagged a theoretical caret-vs-microtask ordering edge
   here that could not be reproduced in jsdom; the real-browser flush
   order should make it harmless — verify on metal).
5. Type any character → next double-tap starts a fresh cycle.

## 2026-06-24 — Nick completion trigger: double-tap → swipe-right

Same-day dogfood of the double-tap trigger (prev entry) confirmed the
collision we'd flagged as theoretical: on a focused textarea, the OS
recognizes the double-tap as word-select before our handler runs, so the
completion fought the selection — exactly the failure mode the original
brainstorm warned about. We considered (a) preventing the selection, but
on iOS double-tap-select is a system gesture recognizer that can't be
reliably `preventDefault`'d (the documented reason the double-tap path
*overrode* selection instead of preventing it), and (b) broadening to the
scrollback — rejected, that's `user-select: text` for copy by the
Dispatch-1 decision and completion targets the compose draft, not
messages. vjt's call: **swipe-right instead** — a gesture the OS does not
overload with selection.

**Implementation** (`ComposeBox.tsx` + pure `lib/swipe.ts`; `doubleTap.ts`
deleted). Swipe-right across the textarea fires `tabComplete(…,
selectionEnd, forward=true)`. Two pure, unit-tested reducers:
`isSwipeRight(start, end)` (rightward, horizontal-dominant, ≥40px on
touchend) and `isHorizontalDrag(start, cur)` (cleared 8px slop + horizontal
axis, direction-agnostic). **TOUCH events, not pointer:** only
`touchmove.preventDefault` reliably suppresses iOS's native scroll AND
drag-to-select. **Crucial Solid gotcha (caught in code review):** Solid
*delegates* `touchstart/touchmove/touchend` to a single listener on
`document` (they're in its `DelegatedEvents` set, web.cjs:120), and a
document-level touch listener is `passive: true` by the WHATWG
intervention — so a JSX `onTouchMove` handler's `preventDefault()` silently
no-ops and nothing is suppressed. We therefore bind the three listeners on
the textarea element directly via a `ref` + `addEventListener`, with
`touchmove` explicitly `{ passive: false }` (and `onCleanup` to remove
them). Element-level touch listeners are non-passive by default, so
`preventDefault` takes. Once the in-progress drag commits to the horizontal
axis (`isHorizontalDrag`) we claim it and `preventDefault` every subsequent
`touchmove`; on `touchend` a qualifying swipe completes. The caret was
placed at `touchstart` (we never preventDefault that), so it sits where the
swipe began → `selectionEnd` is the completion target. Stays gated to
`!ircKeyboardEnabled()` (custom keyboard owns the caret + has a Tab key).
Forward-only: the revert slot already lets you cycle all the way round;
swipe-left-for-back is a trivial later add. NB: vitest/jsdom does NOT
enforce passive-listener semantics, so the delegation bug passed the unit
suite green — it's only catchable by reading the framework or dogfooding.

The completion semantics (irssi-exact suffix, revert slot, range
continuation, internal draft write) are untouched — only the trigger
changed. The double-tap dogfood checklist above still applies with "swipe
right across the input" substituted for "double-tap"; the gesture remains
dogfood-only (no Playwright iOS gesture physics).

**Same-day regression + fix (touch-action).** First dogfood of the swipe
build: dragging from the input dragged the WHOLE shell. Root cause was a
latent hole the swipe exposed — `.compose-box textarea` was the one
touchable control with NO explicit `touch-action`, so it defaulted to
`auto`. The shell's chrome-gesture block (`.shell-mobile { touch-action:
none }`, UX-3 UNDEC R3) is the documented defense against "drag from a
non-scroll area → iOS chrome/overscroll reveal," and inner scroll
containers re-assert their axis (`.scrollback`/`.bottom-bar` → `pan-y`/
`pan-x`). The textarea, being chrome (not a scroll container), should have
been `none` all along; with no listener it never mattered, but the
swipe's non-passive `touchmove` routed the gesture main-thread and the
`auto` default let iOS drag the chrome. Fix: `touch-action: none` on
`.compose-box textarea` (matches the shell policy; tap/focus/caret are
pointer events, unaffected; the JS swipe still reads touch events).
Lesson: any new touchable surface in the mobile shell MUST declare its
`touch-action` — `auto` is a chrome-drag hole.

**Vertical swipes added (2026-06-24).** Extended the gesture from right-only
to all three keyless affordances a stock mobile keyboard lacks: swipe RIGHT
= Tab (nick complete), swipe UP = ArrowUp (older history, `recallPrev`),
swipe DOWN = ArrowDown (newer history, `recallNext`). The pure reducers were
unified to a direction classifier — `swipeDirection(start, end)` →
`right|left|up|down|null` (dominant axis; perfect diagonal → null) and
`dragAxis(start, cur)` → `horizontal|vertical|null` (mid-drag claim) —
replacing the right-only `isSwipeRight`/`isHorizontalDrag` booleans (one
classifier beats a pile of per-direction predicates). The touch handler
locks to ONE axis on the first move past the slop, so a gesture is either a
horizontal complete or a vertical recall, never both. `left` is classified
but unmapped (reserved — swipe-left-for-back-cycle is the obvious future
use). The vertical swipes are free of browser conflict precisely because of
the `touch-action: none` fix above (no native vertical pan to fight).
Completion + recall semantics are the existing key paths (`tabComplete`,
`recallPrev`/`recallNext`); the swipe is just a third dispatch surface for
them. Still dogfood-only.

**Synthetic windows must not fetch `/messages` (2026-06-25, grappa-irc#81).**
The selection effect fired `loadInitialScrollback(slug, name)` for *every*
focused window. For the identity-scoped `$home` status buffer that became
`GET /networks/$home/channels/$home/messages` — a 404, because `$home` is
not a real `(network, channel)`. Harmless on its own; lethal in production.
The m42 jail's fail2ban `http-404` filter counts each one, installs a pf
block on the client IP, then the `pf` jail re-bans on the blocked packets
and escalates the IP into `recidive` (long ban). Net: a real operator got
locked out at the network layer from one IP while the same account still
worked from another. A server-side `ignoreregex` stopgap was deployed to
protect users during rollout; this is the client root-cause fix.

The reported symptom was `$home`, but the bug is a *class*: the same
unconditional fetch 404s for `$admin` (sentinel slug+name) and for
`mentions` (empty `channelName` → `/networks/<n>/channels//messages`).
The fix gates on the **positive** set, not a sentinel blacklist:
`kindHasScrollback(kind)` (in `lib/windowKinds.ts`) is true only for
`channel` / `query` / `server`. Note `$server` IS scrollback-backed (the
`NumericRouter` writes its rows), so the issue's suggested "skip any
`$`-prefixed window" heuristic was wrong — it would have suppressed real
server-pane history. The discriminator is "backed by a real server
scrollback channel," which reduces to "has a real `(network, channel)`
identity" — the same property that makes a window restorable across reload.

The predicate is an exhaustive `Record<WindowKind, boolean>` so a new
`WindowKind` fails to compile until it is explicitly classified — no silent
default. It is the single source of truth for three call sites that
previously each carried the literal `channel || query || server` triple:
the scrollback-fetch gate and the `saveLastFocused` restore gate (both in
`selection.ts`, same effect body) and the two `ScrollbackPane` mount guards
in `Shell.tsx`. If a future kind ever needs scrollback-backed-but-not-
restorable (or vice versa), split the restore gate back to its own
predicate rather than letting the two literals silently diverge.

*Lesson: a client-side 404 is not a client-side problem. On a host with an
edge security stack (fail2ban/pf/recidive), a bogus repeated request is an
amplification primitive that turns one mis-routed GET into a network-layer
self-DoS against the real user. The web client never parses IRC, but it can
still DoS an IRC user by lying to the proxy.*

**Channel directory `/list` — server-side populating snapshot (2026-06-26, #84).**
Upstream IRC `LIST` discovery is a *server-owned* per-`(subject, network)`
snapshot, not a client concern — same posture as scrollback. A new
`channel_directory` table (subject-XOR FK like `query_windows`, keyed
`(subject, network, channel)`) holds the rows; `captured_at` is NULL until
`RPL_LISTEND (323)` finalises, so "has a snapshot" reduces to "any row has
a non-nil `captured_at`." `Grappa.ChannelDirectory` owns the lifecycle
(`replace_start` → `ingest` → `finalize`) and a server-side
sort/search/keyset-paginated `list/3`; `DirectoryController` serves it.
cic stays a lean shell — it never sorts, filters, or paginates.

**Why per-`(subject, network)`, not a shared network-global snapshot.** A
shared snapshot would force a secret-channel-leak apparatus: an opered
session sees `+s`/`+p` channels it isn't in, and `RPL_LIST` carries no
modes, so they can't be filtered out of a shared cache (plus a just-joined
race and stripping the issuer's own memberships). Per-subject isolation
deletes that whole class by construction. Accepted cost: LIST no longer
dedups across users (~1 LIST / 48h / user — fine at small scale).

**Why no background / periodic refresh.** Upstream `LIST` is widely
throttled / abuse-flagged, and a periodic refresh would need an elected
issuer per network. So: lazy 48h TTL — auto-refresh fires ONLY on an empty
snapshot; a `>48h` snapshot serves stale rows with an indicator but does
NOT auto-refresh; the manual refresh button always nukes + restreams.

**LIST is intercepted only while a refresh is in flight.** `Session.Server`
gains a `directory_refresh` in-flight tracker; `refresh_directory/2` issues
`LIST`, nukes the old snapshot, and arms a watchdog. A dedicated
`handle_info` for numerics 321/322/323 sits ABOVE the generic numeric
handler, guarded by `%{directory_refresh: %{}}` (a map ⇒ in-flight). When no
refresh is in flight the guard fails and 321/322/323 fall through to the
generic handler → `$server` scrollback, so a manual `/LIST` is undisturbed.
322 rows batch into the snapshot (`ingest_batch`); 323 flushes the tail,
finalises, cancels the watchdog (via the shared `cancel_and_drain/2` that
also drains a late timer message), and clears the tracker. The buffer is
reversed before ingest to keep DB insertion order matching wire order, but
`list/3` always re-sorts, so insertion order is not user-observable.

**Populating-window model.** Progress is three tiny pings on the user topic
— `directory_progress` / `directory_complete` / `directory_failed` (atom
`kind`, the `Session.Wire` convention; Jason serialises to the JSON-wire
strings the cic narrower matches). cic re-GETs its current page on each
ping with scroll preserved, reusing the existing `"list"` `WindowKind`. No
new streaming surface — the directory rides the same `Topic.user` fan-out
as `channels_changed`.

**Why the watchdog timer and its handler ship together.** `Session.Server`
has no catch-all `handle_info`, so arming `:directory_refresh_timeout`
without its handler would crash the session on the first timeout. The timer
(arm) and the timeout `handle_info` (clear + emit `directory_failed`)
therefore land in one commit, not split across the plan's C2/C4 boundary.

**Config + Boundary.** TTL (48h, the sliding-scrollback horizon), refresh
timeout, progress throttle, and ingest batch are
`config :grappa, Grappa.ChannelDirectory` keys; `ttl_ms/0` reads them via
`Application.compile_env` and is spec'd `:: unquote(@ttl_ms)` to satisfy
`:underspecs` (the `Session.Backoff.base_ms/0` precedent). A `config/*.exs`
change ⇒ forced COLD deploy. `Session.Server` calling `ChannelDirectory`
would close a `Networks → Session → ChannelDirectory → Networks` Boundary
cycle, so `ChannelDirectory` declares `Grappa.Networks.Network` as a
`dirty_xref` (schema-only; no `Networks.*` calls), mirroring `Scrollback`.
New `Session.Wire` payloads required regenerating
`cicchetto/src/lib/wireTypes.ts` (the `gen_wire_types --check` drift gate).

*Lesson: a "discovery" feature is a snapshot-plus-stream, not a request/
response. Modelling `LIST` as a server-owned snapshot that a fast
`GenServer.call` arms and the 322/323 burst fills asynchronously — with the
window populating live over the existing user-topic fan-out — keeps the GET
non-blocking, the client dumb, and the whole thing a mechanical reuse of the
scrollback/query-window patterns rather than a new subsystem.*

## 2026-06-26 — visitor PART tab never dismisses (#87): the snapshot the leave path forgot

Reported again as #87 (alk parted `#italia` on the `azzurra` visitor pool;
prod confirmed: `last_joined_channels = ["#italia", "#sniffo"]` while live
members were only `["#sniffo"]`). The cic × sent the PART, the server echoed
it, yet the `#italia` tab stuck — re-× re-PARTed an already-left channel and
drew a 442. The #38 fix (dismissable stuck +k tab) made this go away for
**users** and we assumed it was closed; it never was for **visitors**.

**Root cause — the leave path bypassed the only snapshot persister.**
`GET /channels` is `union(autojoin-source, live members)`. The autojoin
source diverges by subject: user → `Credential.autojoin_channels`, visitor →
`Visitor.last_joined_channels` (the snapshot is also the visitor's only
rejoin list — see the channel-surface notes). The snapshot is written in
exactly one place, `Session.Server.maybe_broadcast_channels_changed/2`, on
every organic membership change. But the explicit leave path —
`handle_cast({:send_part, _})` (the cic × / `DELETE /channels`) — cleaned
local members and called `broadcast_channels_changed/1` **directly**,
skipping that function and therefore the persist. So after a PART the
snapshot stayed stale. For users it was masked: their `GET /channels` source
is `autojoin_channels`, which the controller prunes on DELETE. For visitors
the source IS the stale snapshot → the parted channel kept rendering as
`source: autojoin, joined: false` and the tab never left. Same staleness
also made **both** subjects rejoin the parted channel on the next reconnect
(`state.autojoin` is seeded from the snapshot at boot via `merge_autojoin/2`).

**Fix — one root, two doors, no second-class visitor.**
1. *Session (subject-agnostic).* Extracted `maybe_persist_last_joined/2`
   (+`channels_keyset/1`) as the single persister call site and routed BOTH
   the organic path and the `send_part` cast through it. The cast keeps its
   UNCONDITIONAL `broadcast_channels_changed/1` (forces cic's refetch even on
   a no-op eager wipe, per #38/UX-4-H) but now also persists when the keyset
   actually changed. This closes case (a) — leaving a channel you are
   live-joined to — for users and visitors identically, and kills the
   reconnect-rejoin.
2. *Controller (symmetric leave).* `remove_from_autojoin/3`'s visitor branch
   was a no-op ("visitors have no persistent credential"). It now removes the
   channel from `Visitor.last_joined_channels` via a new
   `Visitors.remove_autojoin_channel/2` — the exact mirror of the user-side
   `Credentials.remove_autojoin_channel/3`. This closes case (b) — dismissing
   a stale autojoin entry the visitor is NOT live-joined to (e.g. all
   autojoin channels 475'd on connect, so there is no live membership for the
   session to snapshot away). The leave intent now removes from the same kind
   of source for both subjects.

`maybe_persist_last_joined/2` gates on a real keyset change, so case (a) for
one channel never clobbers a sibling channel still in the snapshot.

*Lesson: when one struct field doubles as two concepts (visitor
`last_joined_channels` is BOTH the live snapshot AND the autojoin/rejoin
source), every write path to it must be funnelled through one function —
a second, hand-rolled mutation path (`broadcast_channels_changed` without
the persist) silently drifts the half nobody is looking at. The #38 fix
treated the symptom on the user surface; the bug lived one layer down in
the persister the leave path skipped. "We fixed it" is only true for the
subject whose source you happened to prune.*

## 2026-06-26 — `/msg` to a channel-shaped target rejected (#12)

`/msg #x hello` opened an unclose-able phantom window whose sent message
never rendered. Root cause: `compose.ts` `case "msg"` routed a
channel-shaped target through the QUERY path — `openQueryWindowState`
keyed by a CHANNEL name + `setSelectedChannel(kind:"query")`. cic's
own-send render is WS-driven on the per-channel topic (no optimistic
append) and cic only subscribes to channel topics for JOINED channels, so
a `"#x"` query window heard nothing — the message never rendered, live or
post-restore. `/msg` is for nicks (queries); grappa does not relay a
PRIVMSG to a channel addressed by name.

**Fix — cic-only parser reject.** The `msg:` parser in `slashCommands.ts`
now rejects any IRC channel sigil (`# & ! +`, per `channelKey.ts`) up
front with `err(verb, "/msg to a channel is not supported")`. `err()`
yields `kind:"error"`, and compose.ts's switch hits `case "error"` (which
returns `{error: message}`) before `case "msg"` — so no phantom window
opens and the user gets an inline error. The reject covers the whole
channel-sigil class, not just `#`. Services shortcuts (`/ns` `/cs` …) are
unaffected: they rewrite to `{kind:"msg", target:<ServiceNick>}` via a
separate code path with non-sigil targets.

**Why cic-only (vjt).** Heavier options were floated — a one-shot send +
`$server` echo store, or a server-side reject ("può anche esser grappa a
rifiutare"). Both rejected as too much code for a dead corner case on a
single-client system: a cic parser guard is the same user-visible result
with ~4× less code. Server `send_privmsg` is left as-is (it still happily
sends + persists to scrollback for a non-joined channel); the cic reject
means cic never originates the channel-shaped `/msg` in the first place.

*Lesson: a window keyed by the wrong kind of name is a silent dead end —
the query render path keys off channel-topic subscriptions that a
channel-named query window never has. Reject the malformed intent at the
parser boundary rather than letting it open a window the render path can
never feed.*

## 2026-06-27 — audio uploads + non-modal mini-player (GH #115)

Audio joins image/video/document as a fourth upload category: grappa
hosts the bytes, IRC carries only a `🎵 <slug-url>` link (text on the
wire, clickable in cic), cicchetto plays it. Four decisions are durable.

**A fourth `:audio` category, not "map audio → document" (vjt).** Own
per-file cap (25 MiB — above image's 10, below video's 50; lossless
flac/wav are large but a shared clip is not a movie), own `🎵` wire
emoji, own player. MIME set is "what modern browsers reliably play":
mp3 (`audio/mpeg`), m4a/m4r (`audio/mp4` + `audio/x-m4a` + `audio/aac`;
AAC and Apple-Lossless both ride `audio/mp4`), wav (+ `x-wav`/`wave`),
flac (+ `x-flac`). **opus/ogg are deferred OUT** — Safari support is
patchy and vjt dogfoods on iPhone. Exact playable set is finalised by
device dogfood, not this entry.

**octet-stream → canonical-MIME extension sniff (scoped breach of the
closed MIME-only allowlist).** iOS/macOS routinely upload `.m4a`/`.flac`
as `application/octet-stream`, which a MIME-only allowlist 415s.
`validate_mime` now normalises a generic octet-stream upload to its
canonical audio MIME *by file extension* (the audio set ONLY — every
other octet-stream still 415s, so the closed model holds for non-audio).
The motivation is serve-side, not just accept-side: the controller stores
the derived MIME and `GET /uploads/:slug` serves `row.mime` as
Content-Type, so normalising at the door makes the *served* Content-Type
one the browser actually plays — "ensure grappa emits the right mime"
(vjt). This is the one place the allowlist consults extension, and it is
deliberately narrow.

*Follow-up (vjt iPhone dogfood): the server rescue alone was not enough.*
cic gates uploads on `categoryOf(file.type)` BEFORE the request ever
reaches the server — so a file the browser couldn't MIME-type (iOS gives
the rare `.m4r` ringtone extension empty/`octet-stream`, not `audio/mp4`)
was rejected client-side and never hit the server rescue. The mirror has
to extend to cic: `normalizeUploadFile` (uploadCategory.ts, mirroring
`@audio_ext_canonical_mime`) re-labels such a File to its canonical audio
MIME at `triggerUpload`, so the category gate AND the uploaded
Content-Type are `audio/mp4`. The server rescue stays as belt-and-braces
for non-cic clients (curl, the API). *Lesson: a leniency added on one
side of a mirrored boundary is dead code if the other side rejects first
— extension-rescue had to live on BOTH the cic gate and the server.*

**Audio is NOT metadata-stripped in v1 (accepted ID3/iTunes leak).**
Audio rides `MetadataStrip`'s generic pass-through, same as documents —
the image/video strip lockstep only pins `category in [:image, :video]`.
Audio carries ID3/iTunes tags (artist/album, sometimes device/recording
metadata); accepting that leak is the documented v1 scope, pinned by a
`metadata_strip_test` so a future "strip audio too" (exiftool handles
m4a/mp3/flac) is a conscious edit, not silent inheritance.

**No seed-row migration — born from the code default.** The plan asked to
"follow the video-doc cap migration pattern"; that pattern does not exist
(`20260609204800_rename_per_file_cap_setting_to_image.exs` states video +
document caps are born from code defaults, no rows needed). Audio follows
suit: `read_cap` returns `@default_upload_audio_per_file_cap_bytes` when
no row exists. A migration would only force a needless COLD deploy
(Deploy.Preflight Class 5) to write a row the default already returns.

**Docked non-modal mini-player reconciles "mini-player" with "IRC stays
text only".** The invariant bans inline render / preview cards in
scrollback, and the image/video modal is wrong for audio (you want to
keep reading while it plays). Resolution: clicking a `🎵` link routes
`kind:"audio"` to a single docked transport bar (`AudioMiniPlayer.tsx` +
the `audioPlayer.ts` identity-scoped store, mirror of `mediaViewer.ts`)
pinned above the compose box — NOT inline, NOT modal. One `<audio>`
singleton; a new audio click swaps the source. Mounted inside the
`kindHasScrollback` Match so playback survives channel↔query↔server
switches; leaving chat for home/list/mentions stops it (acceptable v1 —
a Shell-root mount + fixed-dock is the upgrade for full cross-pane
persistence). image/video keep `openMediaViewer`. Placement + controls
(play/pause + scrubber + elapsed/duration + close) are vjt-approved. A
`⬇` download affordance was added after: a same-origin `<a download>`
forces a save (overriding the server's `inline` Content-Disposition)
AND inherits the server-sent filename — so the file lands as "voice.mp3"
not the extensionless slug, with no server change. cic has no filename
on the wire (slug only), so the `download` attribute carries no value;
the browser falls back to the response's Content-Disposition filename.

**The mirror is type-enforced.** Adding `"audio"` to cic's
`UploadCategory` turned every exhaustive `Record<UploadCategory, …>`
(host accept lists, per-category caps, the emoji map, the settings
signal) into a compile error until each grew an audio arm — `bun run
build` (tsc, the real cic type gate) flagged the surfaces grep missed,
including the WS-payload narrower in `userTopic.ts` that would otherwise
have silently dropped `audio_per_file_cap_bytes` off the reactive cap.

*Lesson: when a closed allowlist must bend (octet-stream → audio), bend
it at exactly one named, extension-scoped door and say why in the
moduledoc — a blanket "sniff everything" would have dissolved the model
the upload boundary depends on.*

## 2026-06-27 — Visitor NickServ identify capture: full grammar + single choke point

A prod visitor (anon, `expires_at` still set, `password_encrypted` NULL)
had successfully identified to NickServ yet never upgraded to the
infinite-TTL identified tier (the CP32 two-tier model above). Root cause
was two independent gaps in the `+r`-observed commit rendezvous:

1. **`NSInterceptor` matched only three verbs.** The outbound-line matcher
   was `^PRIVMSG NickServ :(IDENTIFY|GHOST|REGISTER)`. The visitor
   identified with **`ns id <pass>`** — cic routes `/ns id` → a `NickServ`
   PRIVMSG of `id pass`. `ID` wasn't in the alternation → `:passthrough` →
   no `pending_auth` staged → the `+r` MODE arrived with nothing to commit
   (`commit_password/2`, the only writer that both persists the password
   AND nulls `expires_at`, never fired).
2. **The `{:send_raw}` / cic `/quote` path bypassed capture entirely.**
   Capture ran only inside `{:send_privmsg}`; `/quote PASS …`,
   `/quote identify …`, `/quote PRIVMSG NickServ :id …` went straight to
   `Client.send_raw` with no interception.

**Fix.** `NSInterceptor` now covers the full, source-verified azzurra
identify-channel set, anchored at line start (`^`) so a channel PRIVMSG
body merely *containing* "identify"/"pass" can't false-capture; and all
three outbound-line paths (`{:send_privmsg}`, `{:send_raw}`,
`flush_lines/2`) funnel through one choke point in `Session.Server`
(`stage_if_ns_identify/2`, renamed `capture_outbound_ns_secret/2` in #131
once it also committed SET PASSWD) — `NSInterceptor.intercept/1` is now
called from exactly one site, so no identify form can bypass capture again.

**Source-verified identify inventory** (azzurra `bahamut-azzurra` ircd +
`services`):

| Wire form | Path |
|-----------|------|
| `PRIVMSG NickServ[@host] :IDENTIFY\|ID\|SIDENTIFY\|GHOST\|REGISTER …` | direct to services |
| `NS\|NICKSERV IDENTIFY\|ID\|SIDENTIFY\|GHOST\|REGISTER …` | services command alias |
| bare `IDENTIFY\|ID\|SIDENTIFY …` | ircd `m_identify` (`m_services.c`) builds `IDENTIFY <pass>` → `m_ns` |
| `PASS <pass>` / `PASS <nick> <pass>` (post-connect) | ircd `m_pass` (`s_user.c`) → `m_identify` |

services `nickserv.c` command table: `IDENTIFY` (201), `ID` (203),
`SIDENTIFY` (247) all → `do_identify`. Password is the **last** whitespace
token for IDENTIFY/ID/SIDENTIFY/GHOST/PASS; the **first** token for
REGISTER (`REGISTER <pass> <email>`). The args group requires a leading
non-space (`(\S.*?)`) so a verb-only line with no password is
`:passthrough`, never an empty/`nil` capture.

**`+r` MODE stays the commit trigger — NOT the "Password accettata"
NOTICE.** `do_identify` emits the `+r` SVSMODE **only when `sameNick`** —
you must be wearing the registered nick you identify for. Identifying for a
protected nick while services have force-renamed you to `Guest…` fires the
acceptance NOTICE *but no `+r`*; the `+r` lands only once you wear the nick
and identify. Keying on `+r` is therefore correct: the NOTICE
false-positives on a foreign-nick identify, the `+r` does not.

**RECOVER/RELEASE are deliberately NOT captured; GHOST is in the grammar
but does not itself commit.** RECOVER/RELEASE/GHOST take a password but do
**not** set `+r` (they aren't identifies) — the user re-`IDENTIFY`s on the
reclaimed nick afterward, and *that* IDENTIFY's `+r` is what commits. GHOST
is matched (it carries a password) but its staged capture simply times out
unless the follow-up IDENTIFY restages — latest-wins via the FIFO mailbox.

**The 10s `@pending_auth_timeout_ms` is unchanged.** The `+r` SVSMODE is
emitted synchronously inside `do_identify`, sub-second after the identify
on the worn nick. The timer was never the blocker — the missing `id` alias
and the `/quote` bypass were.

*Lesson: a capture that lives on one of several equivalent code paths is a
capture that doesn't exist — the wire has more than one door to the same
service, so the interception has to sit at the single choke point every
door funnels through, not on the door the happy-path test happened to use.*

## 2026-06-28 — Autojoin recovers +i / +k channels via ChanServ self-INVITE (GH #116)

When session bring-up autojoin hits an invite-only (`473 ERR_INVITEONLYCHAN`)
or keyed (`475 ERR_BADCHANNELKEY`) channel, `Session.Server` now sends
`PRIVMSG ChanServ :INVITE #chan` and records the channel in a new per-session
`awaiting_invite` MapSet. If ChanServ relays an inbound `INVITE` — which it
does only when the bouncer's identified account holds ≥VOP access on the
registered channel — `EventRouter`'s inbound-`:invite` clause emits
`{:rejoin_invited, ch}` and `Session.Server` re-JOINs **keyless**. One invite
attempt per channel per session (`awaiting_invite` is monotonic; never cleared).

**A keyless JOIN works after INVITE (source-verified `bahamut-azzurra/src/channel.c`
`can_join` ~:1919).** `if (invited || IsULine || IsUmodez) return 0;` is the
FIRST check and short-circuits BOTH the `+i` test (:1940) AND the `+k` key
test (:1968). One mechanism — ChanServ INVITE — therefore covers both 473 and
475; no stored key is needed.

**ChanServ INVITE wire (source-verified `services/src/chanserv.c`).** Send
form is `PRIVMSG ChanServ :INVITE #chan` — exactly one arg, the channel
(`:6205` reads it; a second token → `CS_INVITE_ERROR_PARAM_GIVEN`); the caller
invites *themselves* (no nick arg). Channel must be registered (`:6219` else
`ERROR_CHAN_NOT_REG`) AND caller must hold ≥VOP (`:6250` else
`ERROR_ACCESS_DENIED`). On success ChanServ emits `:ChanServ INVITE <ournick>
#chan` (`:6239/6269/6289`) → params `[ournick, #chan]`, channel at param 1.
No access / unregistered → a NOTICE (no INVITE) → window stays `:failed`.

**Autojoin-vs-manual is derived, not flagged.** The invite-retry path triggers
only when the failing channel is a member of `state.autojoin` (set once at
boot, never mutated). No new origin flag or parallel state structure was added
— membership in the existing boot set is the condition. A manual `/join` of a
+i/+k channel hits the same 473/475 numerics but is NOT in `state.autojoin`,
so it follows the existing path: window stays `:failed`, cic shows the
`[Join]` CTA.

**`awaiting_invite` HOT-reload safety.** The set is read via
`Map.get(state, :awaiting_invite, MapSet.new())` and written via `Map.put` —
so a HOT code-reload of a pre-#116 `Session.Server` process (whose state map
lacks the key) does not crash. Same defensive contract as `in_flight_joins`.

**Inbound `:invite` routing.** `EventRouter`'s inbound-`:invite` clause checks
the awaiting set: if the channel is present, it emits `{:rejoin_invited, ch}`
(which calls `Client.send_join/3` keyless and `record_in_flight_join/2`,
flipping the window `:failed → :pending`; the self-JOIN echo then lands
`:joined`). Channels not in the awaiting set are delegated to the existing
`:server_event` persist path — the cic `[Join]` CTA (b2 behavior) is
preserved for non-autojoin INVITEs, and the now-redundant CTA for an awaiting
channel is suppressed.

**Scope boundary vs #113 and #38.** The no-access / unregistered-+k case —
where the bouncer cannot be invited because it lacks ChanServ access and there
is no stored key — is issue **#113** (key storage / `/cs info` key-fetch),
deferred as low-priority/niche. This change supersedes issue **#38**'s "stuck
+k autojoin row" problem for the *has-access* case: the channel now
auto-recovers instead of sitting `:failed` indefinitely. The `×`-dismiss UX
from #38 remains the answer for the *no-access* case.

*Lesson: when the underlying ircd source shows that one mechanism short-circuits
multiple lock types (invited-list beats both +i and +k in `can_join`), resist
the temptation to handle 473 and 475 differently — collapse them to one code
path at the point that knowledge is encoded, and document the source reference
so future maintainers don't re-derive it.*

## 2026-06-28 — Login attaches to an existing live session for the same identity (GH #117)

When a **registered** (NickServ-identified) visitor logs in via the grappa
login screen and a live `Session.Server` already serves their identity,
`Grappa.Visitors.Login` now **attaches** the new login to that session instead
of stopping it and respawning a fresh one. This is the natural bouncer model —
one persistent session, N attached clients — and makes the manual share-session
flow unnecessary for identified users (share-session stays for unidentified
guests, who have no password and so use the link as their auth mechanism).

**The attach verb already existed; #117 just routes to it.** Attaching a client
to a running session is exactly what the share-token consume endpoint and
`Login.issue_token/2` do: mint a fresh `accounts_sessions` row for the *same*
visitor and return. The new client subscribes to the visitor's user-rooted
PubSub topics (`grappa:user:visitor:<id>/…`) and rides the live session; the
`Session.Server` is untouched. No new mechanism, no new noun — `Login`'s Case 2
(registered visitor) gained a `Session.whereis/2` branch ahead of the existing
`preempt_and_respawn`.

**Session key = identity = `{:visitor, visitor.id}`.** `visitor.id` is per
`(nick, network_slug)`, so the same NickServ account (same nick) re-resolves to
the same registry key from any client/host. The identity key is *derived* from
the visitor row that already represents the identity — no account/identity
table was added.

**Attach is routed BEFORE the capacity gate (whereis-first), and password-first
before both.** The capacity verbs (`Admission.check_capacity`) gate *new session
spawns* — `check_network_total` counts live `Session.Server`s, `check_circuit`
gates dialing a fresh upstream. An attach spawns nothing, so gating it on those
is wrong: a returning identity whose session is ALREADY counted would be blocked
when the network is at its visitor cap, and a circuit-open would block an attach
even though the live session proves the upstream is reachable — both contradict
#117. So Case 2 now (1) checks the password (auth gate — prove identity first,
leaking no cap/circuit state to a wrong-password attempt), then (2) branches on
`whereis`: live pid → attach (ungated, like share-consume); `nil` → capacity
gate + `preempt_and_respawn` (the fresh-spawn path, unchanged). All pre-existing
capacity tests are Case 1 (fresh nicks), so the reorder changes no covered
behavior.

**Attach does NOT revoke prior tokens; the respawn path still does.** Multi-client
semantics require the other attached clients' tokens to stay valid, so attach
only *adds* a token. The no-live-session respawn path keeps revoking stale tokens
that pointed at a now-dead session (`revoke_sessions_for_visitor` inside
`preempt_and_respawn`).

**#116 autojoin is not re-run on attach — automatically.** Attach spawns no
`Session.Server`, so `init/1` (and the boot autojoin set it builds) never fires.
The "don't re-autojoin on attach" requirement is satisfied by the absence of a
spawn, not by a flag — derived state, no parallel structure.

**Users already attached.** `GrappaWeb.AuthController.mode1_login` only mints a
token (no respawn); user sessions are Bootstrap-managed. #117's scope was
therefore purely the visitor `Login` Case 2 path that had been doing
preempt+respawn.

*Lesson: when a second use case ("attach a client to a session") already has a
verb in the codebase (share-token consume, the user-login path), the feature is
a routing decision, not a new mechanism — find the branch point (`whereis`) and
make sure the gates that belong to the *old* path (capacity = spawn-gate) don't
leak onto the new one.*

## 2026-06-28 — Multi-file paste/drag-drop upload: sequential queue (GH #118)

**The finding first.** #118 ("paste & drag-and-drop image upload in compose")
was already shipped. Commit `8f1a76b` (2026-05-15, the image-upload I-2 surface)
wired `onPaste` (textarea) + `onDrop`/`onDragOver` (form) → the shared upload
pipeline, six weeks *before* #118 was filed. Both surfaces already: multi-
category (image/video/document/audio), in-flight `<progress>` + cancel,
inline `role="alert"` retry/dismiss, non-uploadable payloads ignored, and the
documented auto-send model (`📸/🎬/📄/🎵 <url>` PRIVMSG). The issue text's "splice
the URL into the draft at the cursor" *contradicts* that shipped invariant — vjt
confirmed **auto-send stays, no draft splicing** (which also keeps this work
clear of the in-flight `fix/compose-draft-recall-stash` branch — it only edits
`compose.ts`; #118 only edits `uploadOrchestrator.ts` + `ComposeBox.tsx`).

**The one real gap:** every entry point uploaded the **first file only**
(`dataTransfer.files[0]`, `clipboardData` `return`-after-first, `input.files[0]`
with no `multiple`). The orchestrator is **single-slot per channel**
(`inflight: Map<ChannelKey, ActiveUpload>`) and a re-trigger *aborted* the
in-flight one — so multi-file is not "loop the handler".

**Decision (sequential queue, not parallel).** Added a per-channel FIFO `queue`
to `uploadOrchestrator.ts`. A batch of files uploads one at a time through the
*unchanged* `dispatchUpload` pipeline; each settle pumps the next; each success
auto-sends its own emoji-URL (N files → N messages). Parallel multi-slot was
rejected — it needs a per-channel inflight list + multi-row progress UI +
per-row cancel/retry addressing, heavier than the problem (paste/drop of a few
files). New surface: `triggerUploads` (plural entry; `triggerUpload` kept as a
single-file alias), `pumpQueue`, `startUpload`, `isActive`, a reactive
`(index,total)` counter (`uploadBatch` → cic shows `(i/N)` only when total > 1),
`resetUploadsForTests`.

**Settle semantics** (the 20% that needed deciding):
- success → pump the next;
- upload **error** → *pause* the batch (dismiss = skip-and-continue, retry =
  re-run the failed file at the queue front then continue);
- **cancel** (progress button) → stop the whole batch (clear the queue);
- **decline the privacy modal** → cancel the whole batch (never silently
  re-dispatch the queued files — `dismissUpload` branches on modal-open).

**Behavior change, deliberate:** re-triggering during an in-flight
upload/transcode now **queues** behind it instead of abort-and-replace — the
first upload is never lost. Two existing orchestrator tests (image new-selection,
video re-trigger) were updated from the abort-replace assertion to the queue
one. The #49 contract still holds: a fresh selection *after a failed upload*
supersedes the error and starts a new batch — so an error entry does NOT count
as "active" in `isActive` (counting it both broke #49 and leaked a stale batch
total into the next selection).

**Privacy gating stays per-file** (not per-batch). In production the ack is
persisted in localStorage on first-ever upload, so a multi-file batch never
re-prompts; a user who deliberately did NOT "remember" is asked per file — which
honors their explicit ask-every-time choice. No new "this batch is acked" state
to housekeep.

*Lesson: "challenge the spec" caught a feature that was already built — the
issue post-dated the code. The actual work was the 20% the brief got right
(multi-file) wrapped around an 80% that already existed. Reuse the verbs
(`dispatchUpload`, the privacy gate, the auto-send), add only the queue.*

## 2026-06-28 — One rfc1459 nick casemapper everywhere (GH #121)

**Bug:** a visitor reconnecting with a different-case nick (`Mezmerize` →
`mezmerize`) was NOT recognised as the same identity. The visitor lookup was a
case-SENSITIVE `Repo.get_by(Visitor, nick: ...)`, so it missed, provisioned a
SECOND visitor/session, and the orphan kept holding the nick — a later
`/nick Mezmerize` then bounced with 433 "nickname already in use". P0,
requested on channel.

**Root class, not the instance.** The codebase folded nicks THREE
inconsistent ways: (a) the visitor table didn't fold at all; (b)
`query_windows` + the WHOIS/userhost/whowas caches + `dm_peer` + numeric_router
folded ASCII-only via `String.downcase`; (c) event_router's self-detection used
exact `==`. None handled azzurra's actual casemapping. Azzurra runs **bahamut =
rfc1459**: besides `A-Z` it folds the four national chars `[ ] \ ~` →
`{ } | ^`. The fix unifies **every** server-side nick comparison on one
casemapper — "total consistency or nothing".

**`Grappa.IRC.Identifier.canonical_nick/1`** — the single source of truth.
**ASCII-only** byte-level fold (A-Z + the four brackets), deliberately NOT
Unicode `String.downcase/1`, for two reasons: rfc1459 is defined over ASCII and
bahamut compares byte-wise; and the migration backfill computes the same fold in
pure SQL via `replace(...lower(x)...)` where SQLite `lower()` is ASCII-only — a
Unicode Elixir fold would diverge from the stored index for non-ASCII nicks.
UTF-8 multibyte passes through untouched (continuation/lead bytes never collide
with `0x41..0x7e`).

**Storage: derive, don't denormalise.** First cut added a `nick_folded` column;
vjt (correctly) rejected the parallel state — every nick-write path would have to
keep it in sync (the drift CLAUDE.md warns against). Final shape mirrors how
`query_windows` already indexed `lower(target_nick)`: a UNIQUE **expression
index** on the rfc1459 fold of the existing column. SQLite can't express the
bracket fold in `lower()`, but it CAN in an expression index via the same nested
`replace()`s. Both `visitors` and `query_windows` got the expression-index
treatment; lookups fold at query time through `Identifier.nick_fold/1` — an Ecto
fragment macro that is the query-side twin of `canonical_nick/1`, kept
**character-identical** to the migration SQL so SQLite keeps the query
index-eligible. The two migrations dedup any pre-existing case-variant rows
before swapping the index (visitors: keep identified > permanent > newest;
query_windows: keep MAX(id)). Two new migrations → COLD deploy.

**In-memory sweep.** `EventRouter.normalize_nick/1` (userhost/whois/whowas cache
keys), the paired `Session.Server` key sites
(send_whois/send_whowas/lookup_userhost/derive_ban_mask), `PartCleanup`'s
userhost eviction, `numeric_router.nick_eq?/2`, `Scrollback.dm_peer/4` +
self-DM + `delete_for_dm`, and the ghost_recovery/chanserv service-nick checks
all route through `canonical_nick`. event_router self-detection vs `state.nick`
moved from exact `==` to a nil-safe `nick_eq?/2`; the self-nick MODE clause
stopped using an exact-match dispatch **guard** (you can't fold in a guard) and
branches in the body instead.

**Scope boundary (deliberate, documented).** The in-memory **members map** keys
(`state.members[ch][nick]`) and `state.nick`-as-identity are NOT folded. They are
identity preserved from the authoritative upstream stream — which is
self-consistent about a given user's nick case within a session — not
case-insensitive MATCH sites where different-source variants meet. Folding them
is a separate members-map restructure (a `{folded => {display, modes}}` shape),
filed as follow-up, not smuggled into a P0.

**Reattach (#117).** Once `lookup_visitor` folds, a different-case reconnect
resolves to the same `visitor.id`, so the existing #117 attach-to-existing-session
path reattaches instead of provisioning a duplicate — no new code, the fold is
the whole fix.

*Lesson: the cleanest "store the key" instinct was the wrong one — when the key
is a pure function of a column you already have, an expression index derives it
with zero drift. The existing `lower(target_nick)` index was the pattern to
copy; I just had to read it before reaching for a column.*

## 2026-06-28 — GH #105: unbind never deletes the network (cascade-on-empty removed)

`Credentials.unbind_credential/2` now ONLY detaches the user's credential
row and stops the live `Session.Server`. It no longer computes "is this
the last binding?", no longer deletes the network on empty, no longer
consults scrollback, and no longer wraps anything in a transaction — a
single scoped `delete_all` is the whole write. The return type narrowed
from `:ok | {:error, :scrollback_present}` to just `:ok`.

This **reverses the cascade-on-empty + scrollback-gate** of the 2026-04-26
entry (which is annotated as superseded). `Grappa.Networks.delete_network/1`
— added later by the admin-panel B1 cluster — remains the single, explicit
operator verb that drops a network row, still refusing on
`{:credentials_present, n}` and `:scrollback_present`. Unbind and delete
are now cleanly separated: unbind is per-user detach, delete is
deployment-wide teardown.

**The bug it fixes.** Visitor scrollback lives under `messages.network_id`
with a `:restrict` FK (S29 C2). When the LAST *user* credential was
unbound from a network that still carried *visitor* scrollback, the
cascade-on-empty path tried to delete the network, the `:restrict` FK
blocked it, `maybe_cascade_network/1` called `Repo.rollback(:scrollback_present)`,
and the WHOLE unbind aborted. The user could not be detached — the
cascade insisted on deleting a network the visitors still used. Worked
around in prod with a direct credential-row delete; this removes the
conflation at the source.

**Why drop it rather than fix the gate (vjt).** Simpler. No presence
computation, no `:scrollback_present` plumbing through the unbind spec +
controller + FallbackController, and — the real win — no conflation of
"no user credentials remain" with "delete the network." Those are
different questions. A network with an empty binding list is a perfectly
valid state: it's shared per-deployment infra, and visitor scrollback
follows the visitor lifecycle (purged with the visitor row), not the
credential lifecycle.

**Invariant dropped on purpose.** The 2026-04-26 "schema honest: `networks`
rows exist iff ≥1 binding" property is gone. Zero-binding "ghost
networks" are now an accepted state, not dead weight to garbage-collect.
The operator who wants one gone runs `delete_network/1` deliberately.

**Removed:** `Credentials.maybe_cascade_network/1`, the private
`list_users_for_network/1` (its sole consumer was the cascade gate), the
unbind transaction wrapper, and the `:scrollback_present` branch of
`AdminCredentialsController.delete/2`'s spec.
**Kept:** `Scrollback.has_messages_for_network?/1` and the
FallbackController `:scrollback_present → 409` clause — both are still
the live machinery behind `delete_network/1`, not dead code.

## 2026-06-28 — Featured channels: on-display read, not a /me snapshot (#85)

Operator-curated **featured channels** per network (`network_featured_channels`,
mirroring `network_servers`) surfaced read-only to users (HomePane
one-click-join) and visitors, plus a `featured` label on `/list`
directory rows. Admin CRUD under `/admin/networks/:id/featured_channels`.

**Delivery decision (vjt, brainstormed).** The original #85 wording said
"deliver in `/me` for both shapes — users get `home_data.networks[].featured`."
Rejected at design time. Two reasons compounded:

1. **`home_network_row/2` is shared by the cold `/me` AND the live
   `connection_state_changed` broadcast** (one builder, by design —
   `networks/wire.ex`). Putting featured in that row means the broadcast
   must preload + re-send it on every connect/park/fail, or cic's
   full-row overlay (`home.ts`: `live[slug] ?? row`) **wipes** featured
   on reconnect. Static operator curation would ride a dynamic
   connection-state heartbeat.

2. **Config has its own lifecycle.** A `/me` snapshot is taken at login;
   an operator editing the featured list afterwards would not reach a
   connected user until their next login. The fix is not a PubSub push
   (overkill for rarely-changing config) — it is **re-reading current
   config when the surface displays.**

**What shipped instead.** Featured is delivered by **on-display read**,
never baked into `/me`, never on the connection-state event:

- **HomePane** fetches `GET /networks/:network_id/featured` on home
  display (per network row for users; the single `network_slug` for
  visitors). Component mount = re-read, so operator edits land on the
  next render.
- **`/list`** directory response (`GET /networks/:id/directory`, already
  re-fetched on display) gains `featured: boolean`, re-derived
  server-side from the network's **current** enabled set on every fetch.
  `ChannelDirectory.Wire.index_payload/2` takes a downcased name
  `MapSet`; match is `String.downcase` (channel fold == downcase, the
  `ChannelDirectory` boundary has no `IRC` dep). No top-pinning — sort
  order (user-count desc) is unchanged.

`home_network_row` and the `connection_state_changed` broadcast were
left **untouched**. The public read endpoint rides `:resolve_network`
(cross-user iso) + the existing `networks` nginx allowlist alts (public
`^/(…|networks|…)(/|$)` and admin `…|networks|…`) — **no nginx change**
on either surface.

**No admin PubSub events** for featured CRUD (unlike `ServersController`,
which emits `:server_added/updated/removed` to the admin console).
Featured config never touches a live `Session.Server` — there is no
session-count to surface on delete and no live-state another admin must
see mid-edit; the admin panel refetches on its own action. Deliberate
divergence from the servers pattern, not an omission.

**Case-fold.** `network_featured_channels.name` is stored lowercased
(`Identifier.canonical_channel/1`) per the channel case-fold invariant;
`(network_id, name)` is unique on the stored fold, so `#Chan`/`#chan`
collapse to one row and match one directory entry.

## 2026-06-28 — `/list` directory rework: overlay back, shared topic render (#125)

Cic-only rework of the `DirectoryPane` (`$list`) shipped in #84. Four
decisions worth keeping:

**Topic colors ride the ONE mIRC renderer.** `MircBody` (+ its private
`renderRun`) moved out of `ScrollbackPane.tsx` into a new
`cicchetto/src/MircText.tsx`; ScrollbackPane imports it back and
DirectoryPane now consumes it for the topic. The directory `topic` wire
field is the raw server string (with `\x03` color bytes) — cic styles it
through the same `parseMircFormat` → `renderRun` path as message bodies.
This is the **one-parser invariant** at the display layer: cic never
parses IRC *framing*; `parseMircFormat` only expands already-received
wire bytes into typed runs. A second display-time mIRC renderer would
have been a divergence; there is exactly one module.

**`$list` is a transient overlay with a one-deep back pointer.** The
directory has a close button (#125) that must restore *the window active
when it opened*, not blank the pane and not guess via MRU. `selection.ts`
keeps a single `backTarget: SelectedChannel`, captured **only** on the
genuine non-list → list transition (inside `setSelectedChannel`, after
the idempotency guard) so background selection churn while browsing can't
clobber it. `closeToPreviousWindow(fallbackSlug)` restores it iff
`selectionIsRestorable` (channel/query must still be live; home/server/
admin/mentions always; `list`/`null` never), else falls through the
shared fallback chain. NOT a history stack — one pointer, reset on
identity rotation. The directory is deliberately excluded from MRU
(`mru.ts`), so MRU never sees `$list`; the back pointer is the only
"return here" state.

**One fallback chain, shared.** The close-window picker (UX-4 bucket E)
already computed MRU → the network's server window (if connected; visitor
networks always count as connected) → home. That logic was extracted into
`resolveFallbackWindow(excludeKey, fallbackSlug)` and is now called by
BOTH bucket E and `closeToPreviousWindow` — DRY, one place owns the
chain. Bucket E's eviction + transition-detection are unchanged.
Deliberate divergence: `selectionIsRestorable`'s `server` case is NOT
`connection_state`-gated (unlike the server *fallback*) — restoring the
prior window beats bouncing to home, and bucket D pre-empts the parked
case anyway.

**Responsive layout, zero horizontal scroll.** `.directory-row-join` is a
CSS grid: mobile a 2-row layout (name-head + count on row 1, full-width
wrapping topic on row 2) with featured/joined labels BESIDE the name;
desktop (`min-width: 40rem`) a 3-column row (name-head | topic | count)
with the labels stacked BELOW the name. The responsive label placement is
just `.directory-row-head` flipping `flex-flow: row wrap` → `flex-
direction: column`. No-h-scroll is structural: `minmax(0, …)` track +
`min-width: 0` on grid children + `overflow-wrap: anywhere` on name/topic
+ `overflow-x: hidden` backstop on the list. Topic wraps fully (no
truncation). Sort stays user-count DESC; featured rows are labelled, not
pinned. Joined rows are tappable-to-open (consistent with the HomePane
featured-link from #85), no longer disabled.

## 2026-06-28 — register→auth-code +r promotion: untimed second capture slot (#129)

A NickServ-identified visitor is promoted from ephemeral to permanent
(`expires_at = NULL`) by correlating the secret captured from the user's
outbound `IDENTIFY`/`REGISTER` with the inbound self-`MODE +r`
transition. The capture was held in `pending_auth` for `~10s`
(`@pending_auth_timeout_ms`) and committed on `+r` only if still staged.
That window is correct for **identify** (services grant `+r` synchronously,
sub-second) but wrong for **register**: services email an auth code and
flip `+r` only minutes-to-hours later when the user submits `/ns AUTH
<code>`. The 10s timer discarded the register secret long before `+r`
arrived, so a freshly-registered nick stayed an ephemeral visitor forever.
(The original issue framing — "register doesn't trigger capture" — was
wrong: `NSInterceptor` already captured `REGISTER`; the secret *expired*.)

**In-memory hold, no DB / no schema / no migration.** An unconfirmed
register password is in-flight work, not truth — it becomes truth only on
`+r`, at which point the **existing** commit path
(`Visitors.commit_password` → `expires_at = NULL`) persists it. So it is
held in GenServer state, never written unconfirmed. The DB invariant
`password_encrypted set ⟺ permanent` stays pristine; there is no
unconfirmed-secret column to reason about.

**Two slots, one commit verb (reuse the verbs, not the nouns).** The
shared verb is "commit the captured secret on the `+r` transition." The
20% that differs is the **retention lifecycle**:

- **identify** → `pending_auth` + 10s timer. **Unchanged.** Still the
  wrong-password guard — a wrong identify never gets `+r`, times out, never
  commits.
- **register** → a new, **untimed** `pending_registration_secret`. Held
  until the `+r` transition (commit + clear) or `terminate` (GC with the
  session). No second timer.

That lifecycle difference (10s auto-discard, wrong-password possible vs
hold-until-`+r`, correct-by-construction) is the domain boundary, so it
earns separate state. A timed/untimed type-flag on one field would be the
"shared data model with a type flag" anti-pattern. `NSInterceptor` now
returns `{:capture, :identify | :register, password}` — it reports the
verb class; `Session.Server` maps verb → slot.

**One `+r`-observation primitive, register wins.** `EventRouter` emits
`:visitor_r_observed` from a single `+r` site
(`event_router.ex` user-MODE-on-self clause) reading **both** slots; if
both are populated, **register wins** (correct-by-construction: a wrong
register never gets `+r`, whereas a stale wrong identify could still be
inside its 10s window). `apply_effects/2` commits the winner and clears
**both** slots; `:pending_auth_timeout` clears **only** the timed slot.
This is the same primitive #90 (post-registration `+r` fallback) must
share — one detector, not two.

**Known limitation (transition, not state).** Promotion fires on the `+r`
**transition**, not the `+r` **state**. If the connection drops (or grappa
restarts) between `/ns register` and `/ns auth`, the in-memory register
secret is lost and `+r` (which arrives later) is not auto-persisted.
Recovery is **not** in-place: after `/ns auth` the user is already `+r`, so
an in-place `/ns identify` hits services' `do_identify` guard
(`sameNick && !UMODE_r && !NI_AUTH`), emits **no new `+r`**, and grappa
observes nothing. The user must **quit and log back in via the cicchetto
login form** with their NickServ password → the form-driven
identify-at-001 makes services set `+r` anew (a real transition) → captured
in the 10s window → persisted. Accepted: the in-memory cost is one nullable
field; a DB-backed cross-restart hold would reintroduce the
unconfirmed-secret-at-rest problem this design deliberately avoids.

## 2026-06-28 — activation scroll flicker: hide-until-settled, NOT remove the double-rAF (#130)

Cic-only. On window/channel activation the scrollback content briefly
painted at the wrong scroll offset, then snapped — the user saw a jump.
The `.scrollback` container is the SAME DOM node across the swap
(non-keyed `<Match>` in `Shell.tsx`), so its `scrollTop` carries over
from the leaving pane; the correcting scroll runs inside
`scrollToActivation`'s **double-rAF**, i.e. after the browser has already
painted the new rows at the stale offset.

**The double-rAF is load-bearing — do NOT "simplify" it away.** The
obvious fix (scroll synchronously pre-paint) does not work and has been
tried: the activation `createEffect` runs BEFORE Solid's `<For>` commits
the new rows (effect creation order — the For is created later, in the
JSX return), so a synchronous read sees stale geometry; `queueMicrotask`
likewise fires before layout settles. Both were observed leaving the pane
~66px short of true bottom (CI sentinel + vjt prod dogfood, 2026-05-23).
The rAF×2 is the only reliable "rows committed AND layout settled" point.
There is no Solid `useLayoutEffect`; that is a React concept.

**So fix the *visibility*, not the *timing*.** A new `activating` signal
sets `visibility: hidden` (NOT `display: none` — layout/`scrollHeight`
must stay readable for the deferred geometry read) on the container
synchronously at activation (pre-paint) and clears it only inside the
rAF body once the scroll has landed. The wrong-scroll frame is never
shown; the cost is a ~2-frame hidden window on switch (reads as "loading
the window," far less jarring than a content jump). Guards: cold/empty
windows skip the hide entirely (nothing to scroll — the length-effect
owns their first snap; they can't strand hidden), the reveal runs in
EVERY rAF-body exit path, and both activation triggers (key-change +
visibility-return) share `scrollToActivation` so both inherit it.

## 2026-06-28 — bare /whois /w in a channel window self-whoises (#132)

Cic-only follow-up to #122. #122 gave bare `/whois` (and the `/w` alias)
a context default of the active QUERY window's partner and errored
elsewhere. A channel window has an equally obvious default — the
operator's own nick — so the consumer-side resolver (renamed
`resolveBareWhoisNick` in `compose.ts`) now branches: query → partner;
channel → **self** via `ownNickForNetwork(net, me)` (the canonical
per-network own-nick resolver, NOT re-implemented); any other window kind
→ inline error (out of scope, deliberately). The context default has
always lived in the compose consumer, never the parser — `slashCommands.ts`
still just emits `{nick: null}` for the bare form, so `/w` and `/whois`
inherit the behaviour through the shared handler with zero parser change.

## 2026-06-28 — in-session NickServ SET PASSWD kept in sync (#131)

When a user changes their NickServ password **through cicchetto** (an
in-session `SET PASSWD`), grappa must capture the new password and update
its stored credential, or the next auto-identify on reconnect fails with a
stale password. This is the **capturable slice** of #124 (split-brain on
stale password); #124 stays the record for the **uncapturable** cases
(`RESETPASS` email recovery, a change made entirely outside grappa), which
grappa never sees on the wire and which the re-auth-on-identify-failure
prompt recovers. This issue handles only what grappa observes: the
in-session change.

**Capture — one parser, extended not forked.** `NSInterceptor` already is
the single source of truth for outbound NickServ-secret framing (#129's
choke point). It gains a third verb class, `:set_passwd`, matching the
three wire forms (`PRIVMSG NickServ :SET PASSWD <new>`, `NS|NICKSERV SET
PASSWD <new>`, bare `SET PASSWD <new>`). Two Azzurra-specific facts are
load-bearing and source-verified against `services`:

- The verb is `SET PASSWD`, **not** `SET PASSWORD` — `do_set` only routes
  `PASSWD` (`PASSWORD` errors). The regex matches the literal `PASSWD`, so
  `SET PASSWORD …` falls through untouched (a unit test pins this).
- The new password is **rest-of-line**, not a token — Azzurra parses it
  with `strtok(NULL,"")`, so it may contain spaces. The capture group is
  the whole trimmed remainder; we never split on the first space.

cic needs **zero changes**: its existing `/ns set passwd …` shortcut
already emits a `PRIVMSG NickServ` body, which the server captures (the
one-parser invariant — cic sends the command, the server is the only IRC
parser). A dedicated pre-validating cic affordance (settings/compose) was
scoped OUT for v1 (server-only) — the raw-command capture is the must-have
and the discoverable UI can land later without touching this server path.

**Commit — optimistic on-send, NOT a +r rendezvous (the design crux).**
`SET PASSWD` from an already-identified session emits **no `+r`
transition** (the nick is already registered), and NickServ
success-NOTICE scraping is **banned** (#91 — fragile per-network text
parsing). So there is no positive confirmation signal to stage against.
The capture is therefore committed **immediately** when the well-formed
line leaves the wire: the user is authenticated, it's their own
deliberate change, success is the common case. This is the 20% that
differs from #129's `:identify`/`:register` slots — same capture machinery,
a different action (commit-now vs. stage-against-`+r`), so `:set_passwd` is
a distinct kind rather than a flag on an existing slot.

**Reuse the commit verbs, both homes — but NOT the +r promotion verb for
visitors.** "Write the captured NickServ secret to the stored credential"
splits per home. Users: a new `Credentials.commit_password/3` (the bound
`Networks.Credential`, via a narrow `Credential.password_changeset/2` that
touches only `password_encrypted` — and keeps the same `safe_line_token`
wire-hygiene guard the wide changeset applies, since the value is
re-interpolated into the next IDENTIFY/PASS). Visitors: NOT the +r path's
`commit_password/2`. That verb also flips `expires_at = NULL` (promotes the
row to permanent), which is only safe behind the `+r` *proof of identity*.
A SET PASSWD carries no such proof — services reject it unless the nick is
already identified — so an optimistic commit reusing `commit_password/2`
would pin an **unidentified anon visitor permanent and un-reapable** on a
line services never accepted (an unauthenticated self-promotion / table-
pollution vector; flagged in review). Visitors therefore get a new
**identity-gated** `Visitors.rotate_password/2`: it rotates the password
only for a row already identified (`password_encrypted` set), and no-ops
(`{:error, :not_identified}`) for an anon row. The Session.Server choke
point (renamed `stage_if_ns_identify` → `capture_outbound_ns_secret` for
honesty — it now commits as well as stages) dispatches on subject: visitors
via a new injected `visitor_password_rotator`, users via a new injected
`credential_committer` — both the same Boundary-cycle-avoiding
function-reference indirection as `credential_failer` (the producing
context deps Session, so Session can't statically alias it). Both id-keyed
commit verbs carry the H14 `Ecto.StaleEntryError → {:error, :not_found}`
guard: they run synchronously inside the send handler, so a concurrent
unbind/delete between lookup and update must NOT crash the session.

**Backstop for the stale-stored-password window.** An optimistically
committed change that didn't actually take leaves the stored password
ahead of what services have. Two ways in: Azzurra *rejects* it (insecure /
over-`PASSMAX` / same-as-current per `do_set_password`), or grappa's own
send fails after the commit (the choke point commits before
`Client.send_*`, the documented "on-send" semantic). Both are the same
stale-password case #124's re-auth-on-identify-failure prompt already
recovers — the accepted, bounded cost of having no positive confirmation
signal. (cic length pre-validation was deferred with the UI; Azzurra's
`PASSMAX` is the authority, not a fabricated client constant.)

## 2026-06-28 — whois/lusers cards float in an overlay, not the scroll flow (#133)

**The bug.** WHOIS / WHOWAS / LUSERS cards (and the peer-away banner)
rendered as flex siblings BEFORE `.scrollback` inside `.scrollback-pane`
(a flex column where `.scrollback` is `flex: 1`). Mounting one shrank the
scroll list, which moved the reader's `scrollTop` and lost their place in
the channel buffer. chan-reported.

**The fix — one overlay layer, not the named two.** All four affordances
move into a single absolutely-positioned `.scrollback-overlay` (`top/left/
right: 0`, `z-index: 5` — above the scroll list, below the C7.4
scroll-to-bottom button at 10). The scroll list keeps its full height and
`scrollTop`; the cards paint on top. The issue named only whois/lusers,
but the **general class** was "top-pinned ephemeral affordance rendered
in the scroll flow shifts the reader's anchor" — all four shared it, so
all four moved. Reuse the verbs, not the nouns.

**Boundary — what stays inline.** Invite-ack rows are NOT chrome: they are
message-stream content interleaved by wallclock into `rows()`, so they
stay inline in `.scrollback`. The overlay holds only the four top-pinned
lookup/context affordances. A new such affordance belongs in the overlay;
a new stream row does not.

**Click-through + bound.** Container is `pointer-events: none` so taps fall
through to the uncovered scrollback below; each direct child re-enables
them for its own box (`> * { pointer-events: auto }`). `max-height: 100%`
bounds the layer to the pane — the ComposeBox is a sibling OUTSIDE
`.scrollback-pane` (the pane is compose-free since P4-1) — so a
pathologically tall card (a WHOIS with dozens of channels on a short
viewport) can at most cover the whole scroll list, never spill over and
intercept compose taps; `overflow-y: auto` scrolls such overflow rather
than clipping the header-anchored close affordance.

**Close (×) tap target.** Enlarged from the original ~14px glyph to the
project's existing **44px Apple-HIG** touch standard (the same `44px` used
by `.topic-bar-*`), via one shared rule over all four `*-close` classes.
Negative block margins pull the tall button's contribution back out of the
compact card header (margins don't shrink the pointer hit area);
`margin-left: auto` from each per-card rule survives to keep it
right-aligned.

**Test shape.** jsdom computes no layout, so the structural contract (card
inside `.scrollback-overlay`, scroll list outside — the separation is what
holds `scrollTop` stable) is the unit assertion; the real-geometry claims
(overlay containment in a live DOM + the 44px tap-target box) are pinned in
the c2 Playwright spec, which measures `boundingBox()` in chromium.

## 2026-06-28 — route channel-scoped traffic by channel reference; inbound INVITE opens an `:invited` window (#78, folds #128)

**The bug as filed was misdiagnosed.** #78 framed cic as routing
channel-scoped traffic "by the sender (is the sender in the channel?)"
and called for a contained `subscribe.ts` fix. cic does no such thing —
it routes purely by the **subscription topic**, a faithful mirror of the
server's persisted `message.channel`. The actual "lands in status/network
instead of the channel" behaviour was two **server-side** routing
decisions in `EventRouter`, and the channel reference was destroyed
before cic ever saw it. So the fix is server-side, not cic-only.

**Case (a) — services PRIVMSG to a channel.** `privmsg_default`
re-keyed *every* services-sender PRIVMSG to `$server`
(`route_channel = if services_sender?(sender), do: "$server", else:
channel`). That override exists to suppress cic's dm-listener
query-auto-open for **NICK-targeted** (DM-shaped) services traffic — a
channel target can't auto-open a query window, so the override must not
apply there. Now gated on `not channel_target?(channel)`: services
PRIVMSG to `#chan` lands in `#chan`, symmetric with the channel-NOTICE
arm (which already routed to the channel). `channel_target?/1` is a pure
prefix predicate kept byte-identical to the NOTICE arm's inline `when`
guard (Regex is illegal in guards, so the two "is-channel" decisions
can't share `Identifier.valid_channel?/1` — they share the prefix shape
instead).

**Case (c) — inbound non-awaiting INVITE → a new `:invited` window
state.** Previously a peer INVITE we did not request fell through to the
`:server_event` catch-all on `$server` (#128's complaint). The decision
(vjt) was NOT "stay in $server clickable" (that already shipped) but to
**open the invited channel's own window**: the server now persists the
INVITE row AT the channel (`persist_raw_event(msg, state, channel)` — the
`route_unhandled_command` body extracted + parametrized on the target)
and emits `{:invited, channel}`. `Server.apply_effects` flips
`window_states[channel] = :invited` and broadcasts `window_invited` on
`Topic.user/1` — the SAME chicken-and-egg user-topic origination as
`window_pending` (cic only joins the per-channel topic AFTER seeing the
state). The guard skips the flip + broadcast when already `:joined` (a
stray INVITE to a room we're in must not grey its tab), though the
persist row still lands as a legitimate in-channel event.

`:invited` is a genuine **new window state**, not a reuse: `:pending`
implies our own JOIN in flight, `:failed`/`:kicked` carry
reason/kicker, `:parked` is the T32 idle placeholder — none model "a
not-joined channel someone invited me to." Per the load-bearing
"window state lives on the server, cic mirrors" invariant, it's threaded
server→cic: `WindowState.set_invited/2` (+ the type), `Wire.window_invited/2`,
`apply_effects`; then cic `windowState.ts` (`setInvited`), `api.ts`
`WireUserEvent`, `userTopic.ts` dispatch, and the `subscribe.ts`
pre-subscribe loop (which now joins on `"invited"` as well as
`"pending"`). The Sidebar greyed pseudo-row + the existing
`renderRawEvent` INVITE `[Join]` CTA are inherited for free — the row
just rides the channel topic now instead of `$server`.

**UX shape (vjt):** NO foreground on receipt — the window opens silently
as a greyed tab, carrying the single persisted INVITE row as its one
unread item; the operator joins on their own time via `[Join]`.
`to_wire/3` returns `:not_tracked` for `:invited` (same as `:pending`):
the state is learned via the user-topic broadcast, not the cold-reconnect
per-channel snapshot. Durability across a page reload / session restart
is bounded — the invite row persists in scrollback and surfaces via the
archive section if the live `:invited` tab is lost; a durable
invited-set was judged out of scope for v1.

**Deploy note:** the reframe makes this a server change (EventRouter +
Session.Server + WindowState + Wire), so it ships via a full prod deploy,
not the cic-bundle-only path #78 assumed.

---

### 2026-06-28 — #140: /names is a client modal over a buffered names_reply, not a scrollback dump

`/names [#chan]` used to drain the upstream `353`/`366` burst into TWO
persisted `:notice` scrollback rows (the nick-list + an `End of /NAMES`
terminator), routed to the originating window. That was the "raw numerics
as unrendered junk" problem: a stale snapshot persisted as bouncer wire
history, replaying as noise on reconnect.

**Decision:** `/names` joins whois (#133) and `/list` (#84) as an
**ephemeral query response** — buffered server-side, emitted as ONE typed
event, rendered client-side, NEVER persisted. The server already had the
buffer: `names_pending` mirrors the `whois_pending`/`whois_bundle`
accumulator. The change is purely the emission tail — the `366` drain now
emits one `{:names_reply, channel, roster}` effect broadcast on
`Topic.user/1` (ephemeral, like `whois_bundle`), instead of the two
`build_persist` notices. `format_names_row` + `pick_names_route` deleted;
`origin_window` (only the persisted-row routing needed it) removed
end-to-end from `pushNames` → channel handler → `Session.send_names/3` →
the accumulator.

**The gate (load-bearing):** grappa consumes `353`/`366` on EVERY JOIN to
seed the channel member map (`members_seeded`). The names accumulator is
GATED on a pending explicit `/names` request — `drain_names_pending`
no-ops unless `names_pending[downcase(chan)]` exists. One parser, two
consumers: seeding ALWAYS fires on JOIN; `names_reply` fires ONLY when the
operator asked. `members_seeded` is untouched and authoritative for the
sidebar; `names_reply` is a parallel VIEW carrying the same `member/1`
roster shape, tier-sorted via the same `member_sort_tier` as the
`members_seeded` arm. cic never parses IRC — prefixes are split server-side
(`split_mode_prefix` → `%{nick, modes}`).

**Render — overlay modal, NOT a message-area row (vjt, against #140's
literal wording).** #140's text said "render in the message area as a
client-only row." vjt overruled toward an overlay modal: injecting a row
into `ScrollbackPane`'s `rows()` memo is exactly the scroll-anchor problem
the #133 whois card *fled* (a flex sibling before `.scrollback` shrank the
list and lost the reader's place). So `NamesModal` is a centered,
backdrop-dimmed, scrollable, dismissable dialog (mounted once per Shell
branch, mirrors `ArchiveModal`/`ShareSessionModal`), fed by a per-network
last-write-wins store (`namesModal.ts`, mirrors `whoisCard.ts`). It groups
the roster into **Operators / Halfops / Voices / Users** sections (empty
hidden, per-section count like `Operators (4)`), heads with
`#channel — N people`, foots with `End of /NAMES list: N`, and a nick
click opens a query + dismisses (the MembersPane left-click verb pair).
"Consistent with whois #133" means consistent in *ephemerality*, not in
*placement* — whois is a passive top-pinned card, names is an interactive
centered modal because the roster is large and clickable.

**Deploy:** server code is hot-deployable (new effect + `apply_effects`
clause + `Wire.names_reply` + a `handle_call` arity change — pure module
swap, no migration, no config). Ships HOT + a cic bundle. The dead
`:names`/`:names_target` Logger-metadata allowlist keys (only the deleted
persisted path emitted them) are RETAINED for now: removing them touches
`config/config.exs`, which forces a COLD deploy — batched into the next
cold window rather than dropping every live IRC session for two dead atoms.

## 2026-06-29 — NamesModal mobile fixes: overlays anchor to the visible viewport, not `inset: 0` (#143)

Three mobile defects on the #140 `NamesModal`, all cic-only (no server
change).

**Keyboard occlusion (the real one).** With the iOS keyboard up the modal
rendered half-under it. Root cause: `.names-modal-backdrop` was
`position: fixed; inset: 0`, filling the full LAYOUT viewport, while the
VISIBLE region (`visualViewport.height`) is shorter when the keyboard is
up — so `align-items: center` parked the modal's centre at the
layout-viewport midpoint, dropping its lower half behind the keyboard.
The `max-height: min(var(--viewport-height), 100%)` cap was already there
(it bounds the modal's height) but says nothing about where the modal is
ANCHORED. Fix: the backdrop now spans only the visible region —
`top: 0; height: var(--viewport-height, 100dvh)` instead of `inset: 0` —
so centring happens within what the user can see.

**No `offsetTop`, deliberately.** The obvious "re-anchor with
`visualViewport.offsetTop`" is the exact approach UX-6-D (2026-05-21)
buried after 11 attempts: `offsetTop` is WebKit-broken (#297779, stuck at
24px post-dismiss) and the `translateY(offsetTop)` cancel failed
catastrophically across D6/D8. UX-6-D's `installSmartScrollPin` already
clamps `vv.offsetTop`→0, so anchoring to `top: 0` + `--viewport-height`
is both sufficient AND landmine-free. This is the reusable mechanism for
any keyboard-aware overlay (e.g. the #66 message-list): consume the
existing `--viewport-height` var; do NOT reintroduce an `offsetTop` track
or the `vv.scroll` listener D9 dropped.

**Two cosmetic fixes alongside.** Denser roster rows (per-row padding
0.25→0.1rem, min-height 32→28px, inter-row grid gap 0.1→0rem — irssi
columnar, vjt: "too much padding between nicks"); and the close × bumped
to the project-standard 44px Apple-HIG tap target (the #133 card-×
precedent), up from a ~26px glyph.

**Test honesty.** chromium's layout viewport == its visual viewport (no
OS keyboard), so it cannot reproduce the real iOS divergence (Playwright
webkit ≠ iOS). The e2e (`names143-modal-mobile.spec.ts`) asserts the CSS
CONTRACT instead — with `--viewport-height` pinned to a keyboard-shrunk
value (what `installViewportHeightTracker` writes from `vv.height`,
unit-covered in `viewportHeight.test.ts`), the modal stays inside that
region; and the close × measures ≥44×44. Real on-device occlusion still
needs Mezmerize dogfood before final close.

**Deploy:** cic bundle only (`deploy-m42.sh --cic`) — no server change.

---

## 2026-06-29 — #78 redo: the `:invited` e2e gate was vacuous; pin it to a `data-window-state` seam

**The reopened complaint was that the inbound-INVITE `:invited` window
"does not work in practice," with `b2-inbound-invite-cta` suspected a
false positive.** Investigated empirically before touching the
derivation: the full chain (server `do_route(:invite)` → `{:invited, ch}`
→ `window_invited` on `Topic.user/1` → cic `setInvited` → Sidebar greyed
pseudo-row) is intact and was never gutted — the `:invite` clause dates
to the original #78 ship (834204b), and #140's EventRouter refactor
(7b5541d) touched only the PRIVMSG/NOTICE sender-presence routing, not
the INVITE clause. Run in isolation on a fresh testnet the spec is GREEN
and genuinely drives the real bahamut INVITE relay → greyed tab → [Join]
→ joined. **There was no broken derivation to fix.**

**Where b2 actually was weak — the gate, not the feature.** The
greyed-tab assertion checked only `.sidebar-window-greyed`, a class the
Sidebar pseudo-row shares across EVERY not-joined state
(`pending`/`invited`/`failed`/`kicked`/`parked` — see
`pseudoChannelsForNetwork`). So the spec would have ridden to green on
any greyed row, including one greyed for an unrelated reason or by the
wrong state — it could not distinguish `:invited` from the rest. That is
the genuine "passes while the specific derivation is unverified" hole.

**Fix — expose the discrete state as a DOM test seam.** The pseudo-row
`<li>` now carries `data-window-state={row.state}` (same stable-seam
pattern as `data-window-name` / `data-kind`; production rendering
unchanged). `b2-inbound-invite-cta` asserts
`toHaveAttribute("data-window-state", "invited")` BEFORE the generic
greyed check, so the spec now goes RED unless the `:invited` link of the
chain specifically fired. Unit-covered in `Sidebar.test.tsx`. Mobile
`BottomBar` renders no pseudo-rows at all (a separate pre-existing gap —
pending/failed/kicked are equally absent there — out of scope here); the
seam lives only on the desktop `Sidebar`, which is its sole renderer, so
nothing is half-migrated.

**Deploy:** cic bundle only (`deploy-m42.sh --cic`) — no server change.

---

## 2026-06-29 — #146: a tapped DM notification must OPEN the query window, not just select it

**P0 regression report: tapping an OS push notification stopped landing
the operator on the conversation that fired it — for a channel highlight
OR a nick/query PM.** Investigated empirically with a real chromium e2e
before touching code (the prior push-tap gate, `ux-6-j`, was a suspected
false positive — it only ever drove a CHANNEL deep-link).

**Channels were fine; the DM/query branch was broken.** The push deep-link
routes through `pushTarget.ts` — warm path `applyPushTarget` (SW→page
`{type:"navigate",url}`) and cold path `applyPushTargetFromUrl`
(`openWindow` boot reader). Both did the same thing: `setSelectedChannel`
on the parsed `{networkSlug, channelName, kind}`. For a channel that is
correct — a highlight implies the operator is already joined, so the
channel is in `channelsBySlug` and the sidebar renders + selects it. For
a DM it is NOT: the server never auto-creates a `query_windows` row for
an inbound DM (only cic's `open_query_window` push does, from
subscribe.ts on receive). So a DM notification tapped when no query
window exists yet — the canonical case, a DM that arrived while cic was
closed, then a cold load — selected a window that was never opened: dead
selection, no sidebar row, "tap did nothing."

**Root cause = a skipped verb, not a broken one.** Every OTHER DM-open
site (compose `/msg` + `/query`, NamesModal, UserContextMenu,
subscribe.ts inbound-DM) opens the window via `openQueryWindowState`
(server upserts the row + broadcasts `query_windows_list`, which renders
it) BEFORE `setSelectedChannel`. The push-target path was the one site
that selected without opening. **Fix: reuse the verb.** A shared
`routePushTarget/1` now handles both call sites — for `kind:"query"` it
resolves the network, canonicalises the nick, `openQueryWindowState`,
then selects; `kind:"channel"` is unchanged. DRY across warm + cold so
the open-then-select contract can't drift. (The cold-path open push is
safe pre-WS-join: `joinUser` sets `_userChannel` synchronously from
token+subject — earlier than the REST-sourced `networks()` seed that
gates the cold reader — and Phoenix buffers the push until the join ack.)

**The e2e gate — and the harness ceiling.** New
`cicchetto/e2e/tests/notif-tap-focus.spec.ts` covers BOTH a channel and a
DM on BOTH drives, asserting the user-visible outcome
(`li[data-window-name].selected`). The DM cold-path case reproduced the
regression RED before the fix. The IDEAL drive — dispatching the real SW
`notificationclick` handler — is **not achievable under headless
Playwright** (proven, not assumed): `registration.showNotification`
rejects with "No notification permission has been granted for this
origin" even after `grantPermissions(["notifications"])`, so a real
`NotificationEvent` can't be constructed; and `WindowClient.focus()` /
`clients.openWindow()` inside `focusOrOpen` require transient activation a
synthetic dispatch doesn't grant. So the faithful drives the harness
allows are: COLD = `page.goto(deepLink)` (exactly the SW's
`openWindow(url)` branch → real `applyPushTargetFromUrl`, no MessageEvent
shortcut), and WARM = replaying the SW→page navigate message onto the real
`installPushTargetListener`. Both go RED if the routing breaks. Unit
coverage: `pushTarget.test.ts` asserts the query branch now fires
`openQueryWindowState` before selecting.

**Deploy:** cic bundle only (`deploy-m42.sh --cic`) — no server change.

---

## 2026-06-29 — #148: `/oper` is visitor-eligible (the gate relaxes for oper ONLY)

**P0 ask: let a VISITOR socket issue `/oper`.** Pre-#148 the verb
short-circuited with `{:error, :visitor_not_allowed}` before it ever
dispatched — `GrappaChannel`'s `oper` clause routed through the shared
`dispatch_ops_verb/3`, whose `with` chain runs `check_not_visitor/1`
(`visitor?/1` = `String.starts_with?(user_name, "visitor:")`). Live
repro: Mez was `+r` (NS-identified) but still got `visitor_not_allowed`
because IRC-side identify does NOT swap the cic WS token visitor→user
(that promotion gap is grappa-irc#129). This issue sidesteps #129 by
relaxing the gate at the visitor socket directly — no token promotion
needed.

**Why a visitor opering is safe — the per-visitor-session isolation
argument.** Sessions register in `Grappa.SessionRegistry` under
`Session.Server.registry_key(subject, network_id)` = `{:session, subject,
network_id}` — the key carries the FULL subject tuple, so `{:visitor,
uuid}` gets its OWN `Session.Server` (the "visitor pool" in ops notes is
an IP/connection pool, NOT a shared IRC session). A visitor opering
therefore authenticates ONLY its own upstream IRC link; there is no
cross-visitor or shared-session leak. And the upstream ircd's O:line is
authoritative — a visitor becomes oper only if it presents creds the
server accepts. The bouncer gate was belt-and-suspenders; relaxing it for
`oper` just lets the upstream be the authority, exactly as the read-only
verbs (whois/who/names/banlist) already trust `resolve_subject/1`.

**Fix = reuse the verb, don't widen the gate.** The `oper` clause now
routes through the visitor-eligible sibling `dispatch_subject_verb/3`
(resolves the socket identity via `resolve_subject/1` into a
`Session.subject()` and hands the thunk the SUBJECT, not an
`Accounts.User`), with the executor `fn subject -> Session.send_oper(
subject, network_id, name, password) end`. `Session.send_oper/4` already
accepted a `subject()` under `is_subject/1` and routed via
`call_session/3` — NO change needed there or in
`Session.Server.handle_call({:send_oper, ...})` (subject-agnostic,
password-redacting). The `:oper_token` field validator (rejects
empty/space/CRLF) is unchanged. **The gate STAYS for every other
state-changing verb** (raw/op/deop/voice/devoice/kick/ban/unban/invite/
umode/mode/topic_set/topic_clear) — `dispatch_ops_verb/3` and its
`check_not_visitor/1` are untouched. Only `oper` moved.

**Tests — RED→green, security boundary pinned.** Server ExUnit
(`grappa_channel_test.exs`): a NEW test drives a VISITOR socket bound to a
live `{:visitor, _}` session pushing `"oper"` and asserts it ships
`OPER testoper testoperpass` upstream (reply `:ok`) — RED pre-fix
(`visitor_not_allowed`, no OPER on the wire). The existing
`"visitor socket: op returns visitor_not_allowed"` stays GREEN as the
boundary regression (only oper relaxed), and the existing user-oper test
survives the switch (both helpers resolve a user by name). E2E
(`cicchetto/e2e/tests/issue148-visitor-oper.spec.ts`): boots cic as a
visitor, opers from the `$server` window, and asserts the upstream 381
RPL_YOUREOPER (`:You are now an IRC Operator`, azzurra/bahamut
`src/s_err.c` — grappa's numeric router :scan-routes 381 → `$server` and
persists the trailing verbatim) renders as a `:notice` row, with the
`visitor_not_allowed` inline error absent. Reproduced RED on the unfixed
server (the success assertion has no 381 to match).

**Deploy:** server change (`grappa_channel.ex`) — NOT a hot cic-only
bundle; `deploy-m42.sh` auto-classifies hot/cold.

**→ Superseded 2026-07-01 by #153 (below).** The "gate STAYS for every
other verb / only oper moved" scope above no longer holds: #153 removed
the identity gate for ALL verbs and DELETED `dispatch_ops_verb/3` +
`check_not_visitor/1` entirely (every verb now routes through
`dispatch_subject_verb/3`). The `"visitor socket: op returns
visitor_not_allowed"` boundary test cited here was flipped to assert the
verb ships upstream.

---

### 2026-06-29 — #142: every user-text surface routes through the one mIRC renderer

mIRC formatting control bytes (`\x02` bold, `\x03`/`\x04` color, `\x0f`
reset, `\x1d` italic, `\x1f` underline, `\x1e` strike, `\x11` monospace,
`\x16` reverse) were leaking RAW into the DOM on several cic render paths
— a colored QUIT reason or a bold whois `realname` showed as unprintable
garbage. The channel buffer (PRIVMSG/NOTICE/ACTION) already routed text
through the shared renderer; the presence/system lines and the inline
cards did not.

**Invariant established — one renderer, no raw `{body}`.** Every
user-originated text surface in cic MUST render through `MircBody`
(`cicchetto/src/MircText.tsx`), which expands `parseMircFormat`
(`cicchetto/src/lib/mircFormat.ts`) runs into styled `<span>`s. A new
text-emitting surface MUST use `<MircBody body={…} />`, never a bare
`{body}` / `{reason}` / `{trailing}` interpolation — a raw drop silently
re-opens this bug. Chrome around the text (parens, "changed topic:"
prefix, the `· ` away separator) stays plain text; only the
user-originated part is wrapped. The four paren-wrapped reason/trailing
sites (PART/QUIT/KICK reason, KILL trailing) share one `reasonSuffix`
helper in `ScrollbackPane.tsx` — same chrome, one implementation.

**This was purely a cic render-layer sweep — VERIFIED, not assumed.** The
server preserves IRC bytes verbatim end-to-end: `IRC.Parser`'s
`parse_params(":" <> trailing)` takes the trailing param raw, and
`strip_unsafe_bytes/1` removes ONLY `\x00 \r \n` (the RFC-2812-illegal
framing bytes) — every mIRC formatting byte survives. The whois/whowas
risk surface (#133) was the open question: do `realname` / `away_message`
arrive raw, or does the server normalise them? Traced the wire path —
`event_router.ex` `whois_trailing/1` is `List.last/1` (no transform), the
bundle wire (`session/wire.ex`) is a plain `Map.get`, so the trailing
control bytes ride the identical byte-preserving path as a PRIVMSG body.
**They arrive raw; cic was the only gap.** No server change.

**Surfaces wrapped:** `ScrollbackPane.tsx` — KILL trailing, INVITE/default
raw-event fallbacks, PART/QUIT/KICK reasons, TOPIC change body,
server_event fallback. `TopicBar.tsx` — topic strip + modal body (the
`title` tooltip is a plain-text-only attribute surface, so it gets the
new `mircPlainText/1` parser projection — de-formatted via the ONE parser,
NOT a second/lossy stripper, so the "no silent stripping" rule holds).
`WhoisCard.tsx` — realname, away_message, AND (follow-up below) umodes,
actually_host/actually_ip, server_info. `WhowasCard.tsx` — realname.
`MentionsWindow.tsx` — mention row body + the operator's own away reason
(found by the defensive grep, NOT on the original gap list; same
user-text class as the whois away field).

**Follow-up (same day, vjt prod report) — the "structured" exclusion was
wrong.** The first pass excluded WhoisCard `umodes` ("modes"),
`actually_host`/`actually_ip` ("connecting from") and `server_info` as
"structured server-identity, not user free text". Prod whois showed
control codes still leaking there: on azzurra a services-set **colored
vHost / swhois** and a formatted **server description** carry mIRC color
bytes, and the ircd passes them straight through (`\S+` host capture, the
`is using modes ` split, the 312 trailing — all byte-preserving). So
those fields ARE user/services-influenced free text and now route through
`MircBody` too. The remaining whois fields stay plain because they are
genuinely structured: `user@host` + `server` (hostnames), `idle`/`signon`
(formatted numbers), `channels` (channel names), `target` (`NickText`).
Lesson: do not exclude a whois field as "structured" without real-wire
evidence — services let users colorize identity fields. Proven at the
component boundary (`WhoisCard.test.tsx`: a bundle with bold/color/
underline codes in umodes/actually_host/actually_ip/server_info/realname
renders mIRC spans with zero raw bytes in `textContent` — RED on the
unfixed card). A real-wire e2e is the wrong tool: the testnet ircd emits
clean structured 326/378, so it cannot reproduce a services-set colored
field.

**Audited + excluded (not user free text):** names list / MembersPane
(per-nick `NickText`, deterministic palette), LusersCard (integer counts
via `fmt(n)`), lusers numerics (251–255/265/266 arrive as `$server`
`:notice` rows → already on the NOTICE `MircBody` path).
`AdminCredentialsTab` realname (a config-form `<input>`, operator's own
value, not an IRC render surface). WhowasCard `server` / `logoff_time`
(a hostname and a timestamp — genuinely structured, no free-text field
left unwrapped).

**Tests — RED→green, E2E on the QUIT surface.**
`cicchetto/e2e/tests/issue142-quit-mirc-render.spec.ts` drives a peer to
QUIT with reason `\x02\x0304bye-142\x0f tail` (bold+red, then reset+plain
tail), asserts the `.scrollback-mirc-bold` span carrying `bye-142` exists,
its computed color is `rgb(255, 0, 0)` (= `MIRC_PALETTE[4]` `#ff0000`),
and the post-`\x0f` tail is NOT bold (reset honored). Reproduced RED on
the unfixed cic (the bold-span locator resolved to 0 elements — the reason
sat raw in the text node); GREEN after the wrap. The truncation-sensitive
topic strip stays ellipsised — the mIRC classes only touch
font-weight/style/decoration/family/filter, none set `display:inline-block`
or `white-space:pre`, so the inline spans inherit the parent's
`nowrap`/`overflow:hidden`/`text-overflow:ellipsis`.

**Deploy:** cic-only — `deploy-m42.sh --cic` (vite rebuild + bundle-changed
broadcast, HOT, no BEAM restart, no session drop). Zero `.ex` changed.

---

## 2026-06-29 — the visitor landing experience: CRT loading splash + reworked home pane (#134 + #135)

Bundled because both are the same surface — what a visitor sees on open —
and ship together. Both are **cic-only** (zero `.ex` touched); the welcome
text is a static cic string (operator-editable per-network welcome is
split to #136, out of scope here).

**#134 — retro CRT loading splash (LOADING-ONLY).** Replaced the bare
`<Switch fallback>` placeholder (`"select a channel…"`) in `Shell.tsx`
(desktop + mobile) with `CrtSplash.tsx` — a self-contained CSS/SVG CRT
boot screen (overscan rounded-corner vignette, scanlines, phosphor-green
glow, flicker, fake POST/boot lines, blinking block cursor). Pattern
mirror of `InstallSplash.tsx` (component + `.crt-splash*` CSS in
`themes/default.css`), theme-aware via `--crt-phosphor`,
`prefers-reduced-motion`-aware (animations off, static aesthetic kept).

The load-bearing constraint: this is **loading-only**, not a persistent
empty state. The Shell main-pane `<Switch fallback>` only renders when
`selectedChannel()` is null, which in practice is the cold-load window
*before* the auto-select effect (`Shell.tsx` ~L438-511) lands on `$home`.
So the fallback IS the loading state. `CrtSplash` self-gates on the
**same predicate the auto-select effect waits on** — `!user() ||
channelsBySlug() === undefined` (createResource is `undefined` while
loading; a resolved `{}` is truthy = loaded, no channels yet) — so it
clears on the same reactive tick the handoff to `$home` fires. No parallel
"still loading" notion to drift, no infinite spinner, no blocked handoff.

*Why a component test, not an e2e:* a transient loading screen is
e2e-hostile — it's gone the instant the page finishes loading, so an e2e
that waits for load never catches it (flaky/hollow, the exact failure mode
of the #78 vacuous gate). The honest proof is `CrtSplash.test.tsx`: drive
the loading predicate directly → assert the splash + boot/LOADING text
render; flip to loaded (`channelsBySlug()` resolved `{}`) → assert the
splash renders nothing (the handoff). Existing `Shell.test.tsx` cold-load
tests (no `select a channel` fallback, lands on home) stay green — the
fallback only mounts when selection is null, and `CrtSplash` returns null
once loaded.

**#135 — visitor home pane = welcome + featured + directory link.**
`HomePaneVisitor` reworked into three stacked sections: (1) refreshed
static welcome/orientation copy, (2) the #85 `FeaturedLinks` (now takes an
optional `heading` prop, gated on the same has-links condition so an empty
list shows no dangling title), (3) the **new** "📇 Browse channels"
affordance the visitor pane lacked. The directory link reuses
`ConnectedRow.onBrowse` EXACTLY — a `kind:"list"` selection deep-link into
the #84 `DirectoryPane` (`$list`), keyed on the visitor's single network
slug (`visitorSlug()`), NOT a new navigation path. Sections 2+3 gate on
`visitorSlug()` so a null slug can't dispatch a network-less `$list`.

*Tests — RED→green.* Unit (`HomePane.test.tsx`): the directory-link case
was RED (no `home-visitor-browse` control) before the rework, green after,
asserting the click dispatches the `kind:"list"` selection and fires no
REST. E2E (`issue135-visitor-home-landing.spec.ts`): boots as a visitor
(auto-lands on home), operator-seeds a featured channel via the admin REST
path (network id resolved by slug from `GET /admin/networks`, removed in
`finally`), asserts the welcome phrase + the `home-featured-{slug}` list +
the seeded channel name, then **clicks Browse → asserts `.directory-search`
renders** (the DirectoryPane mount). Genuinely RED without the link (the
testid wouldn't exist) — not a hollow gate.

**Deploy:** cic-only — `deploy-m42.sh --cic` (vite rebuild + bundle-changed
broadcast, HOT, no BEAM restart, no session drop). Zero `.ex` changed.

## 2026-06-29 — `--full-restart`: bind a new jail vhost in ONE bounce

**Problem.** Binding a NEW jail vhost (or any jail-layer network change)
needed TWO session-drop windows: a normal cold deploy (`service grappa
start` inside the jail) AND then a host `bastille restart grappa` to bind
the new vhost at the jail layer. Two bounces, twice the downtime, twice
the chance of a half-applied state between them.

**Shape.** A `deploy.sh --defer-restart` flag (cold-path only) splits the
cold path at the rc.d-wrapper refresh: it runs the cold path through
`vite build → migrate → service grappa stop → jail_beam_wait wait-stopped
→ jail_install_rcd` exactly as before, then — instead of `service grappa
start` + healthcheck + marker — prints a staged-message and `exit 0`. The
BEAM is stopped and the new release + rc.d wrappers are on disk, but the
daemon is NOT running. The host wrapper `deploy-m42.sh --full-restart`
then does a SINGLE `bastille restart grappa`, which boots the staged
release through the NEW wrapper and binds the vhost in one go. One window.

**Why the order is load-bearing (unchanged).** The cold path's
stop→wait-stopped→rc.d-refresh→start order exists so the OLD daemon is
stopped through the wrapper that started it and the NEW wrapper boots the
next daemon (see the 2026-06-11 defect #9 note). `--defer-restart` cuts
the path AFTER the rc.d refresh, so that invariant holds: the host bounce
is just the deferred "start" through the already-installed new wrapper.

**Why the marker moves to the host.** `runtime/last-deployed-sha` is the
completed-deploy signal the next auto deploy's nothing-to-do guard reads.
On the defer path the deploy is intentionally INCOMPLETE — the daemon
isn't up — so deploy.sh must NOT write it; writing it would let the next
auto deploy think the work finished and skip it. The host wrapper writes
the marker only AFTER its post-bounce healthcheck passes, and reads the
jail's OWN HEAD (`git rev-parse HEAD` inside the jail) rather than passing
a sha from the host — a sibling push could have raced the host's view.

**Why defer is cold-only.** `--defer-restart` defers a *stop*; the hot
path has no stop (it POSTs `/admin/reload` and keeps the daemon pid). So
`--force-hot --defer-restart` and an auto-classified-HOT deploy with
`--defer-restart` both abort with a usage error (exit 64) — the first
caught at arg-parse before any side effect, the second right after
preflight resolves the mode.

**Scope / non-goals.** The host-side `jail.conf` / `grappa.env` vhost edit
stays a manual operator step at restart time — `--full-restart` does NOT
touch host vhost config. Never rehearsed against prod (it bounces the live
jail + drops every session); proven by bats only
(`test/infra/deploy_jail_test.bats` for the defer split,
`test/infra/deploy_m42_test.bats` for the host stage→bounce→verify→marker
sequence). First real run is the next genuine operator-driven cold deploy.

---

## 2026-06-29 — #156: the in-pane unread divider needs an ANCHORED fetch when unread exceeds the window

**Symptom.** Open a channel whose unread count is larger than the initial
scrollback page (~50): the `── XX unread messages ──` divider slams to the
TOP of the pane with a window-sized count (~50, not the true ~190) and no
read-context above it — or fails to inject at all depending on hydration
timing.

**Root cause.** `loadInitialScrollback` (cicchetto, `lib/scrollback.ts`)
fetched a TAIL-ONLY page — `listMessages(t, slug, name)`, the server's
newest ~50 rows, no `before`/`after`. The in-pane divider derives from the
FROZEN `markerCursorId` snapshot of the server read cursor (the freeze
contract, see 2026-06-08) and `sessionTopId` (max id at mount). When the
cursor is OLDER than the oldest row in the tail page (unread > window), the
divider's anchor — the last-read row and the first-unread row — is simply
not in the loaded set: every loaded row has `id > cursor`, so `unreadCount`
counts the whole window (~50) and the marker injects before index 0. The
freeze contract was never the problem; the loaded ROWS were.

**Fix (cic-only — the REST verbs already existed).** When a read cursor
exists, fetch the region AROUND it instead of the tail:
  * `listMessagesAfter(cursor, 200)` → the unread region (`id > cursor`,
    ASC), capped at the server `@max_http_limit` (200).
  * `listMessages(cursor + 1)` → the before-context page (`id <= cursor`;
    integer ids, so the strict `< cursor+1` cursor is exactly `<= cursor`)
    — the last-read row + ~50 rows of read-context above the divider.
Both merge via the existing `mergeIntoScrollback` (id-dedupe + ASC sort),
so the loaded set is contiguous around the anchor and `loadMore`'s
oldest-id paging still works. The no-cursor arm keeps the tail-only load
(and its RC2 cursor-to-tail baseline) unchanged — a fresh channel has no
divider to anchor and auto-scrolls to the newest row.

**Gate signal chosen: cursor presence, NOT a server unread count
(unconditional anchored fetch when a cursor exists).** A per-channel server
unread count IS available — but only in `selection.ts` (the sole caller of
`loadInitialScrollback`), via `serverSeedCounts` hydrated from the `/me`
envelope. Reaching it from `scrollback.ts` means either an import cycle
(`selection → scrollback` already exists) or threading it through the
signature. Both are heavier than the cost they'd save: ONE extra small GET
per cursor-present channel-open, behind the load-once gate, on a human
click. Worse, a count-vs-window gate is FRAGILE — it couples cic to the
server's ~50 page-size constant, and the seed count (`messages + events`)
measures a different set of rows than the marker's filtered count
(own-presence / operator-echo excluded). The unconditional anchored fetch
is window-size-agnostic and fixes the root cause for any page size; for a
fully-read channel `after(...)` returns 0 rows and the load is just the
before-context page.

**>200 cap (known edge).** If true unread > 200, `after(cursor, 200)` stops
at `cursor + 200`, so the very newest rows aren't in the initial load. The
DIVIDER stays correctly anchored; only the in-pane count caps at the loaded
window (`sessionTopId = cursor + 200`). The marker count was left reading
the loaded rows (not the server unread_count) — honest about what's loaded,
and pulling the server count into the frozen-marker derivation would have
meant the same cycle the gate decision rejected. **CORRECTION (#161, see
2026-07-01 entry below):** the original claim here — that the rows past
`cursor + 200` "stream in via the WS join-ok `refreshScrollback`" — was
WRONG. `refreshScrollback` fetches `after(resume_cursor, REFRESH_LIMIT=200)`
from the SAME resume cursor and hits the SAME 200 cap, so it never reached
the tail either; and there was no scroll-to-bottom forward-paging handler.
The newest rows were UNREACHABLE, not deferred. #161 adds the forward-paging
verb (`loadNewer`) that makes `[cursor+200 .. tail]` reachable on
scroll-to-bottom. The divider-anchoring reasoning above stands unchanged.

**Tests.** Unit RED→GREEN in `src/__tests__/scrollback.test.ts` (the clean
witness — `listMessagesAfter` is called 0× by the old tail-only code) +
`src/lib/__tests__/loadInitialScrollback.test.ts`. Real chromium e2e
`cicchetto/e2e/tests/unread-divider-beyond-window.spec.ts` reuses the
seeded 200-line `#bofh`, plants the read cursor ~120 rows below the tail
via REST, and asserts the early last-read row IS in the DOM with the
`unread-marker` immediately after it and the count equal to the true
unread. Proven RED against the unmodified tail-only load (the early row is
absent → `toBeVisible` fails) before the fix landed.

---

## Lifecycle verbs — detach / disconnect ⇄ reconnect / quit (#126, 2026-06-29)

Two distinct lifecycle actions were conflated, and **detach was broken**.
vjt standardized the surface into the full **(web client × upstream IRC)**
state matrix — each transition is a named verb:

|              | upstream UP                          | upstream DOWN                              |
|--------------|--------------------------------------|--------------------------------------------|
| **web UP**   | normal                               | `disconnect` (drop upstream, stay in cic) ⇄ `reconnect` |
| **web DOWN** | `detach` (leave cic, keep upstream)  | `quit` (close cic + tear down upstream)    |

**Subject classes split by NickServ identity** (the load-bearing
asymmetry): a registered **user** (`Networks.Credential.connection_state`
column), a registered **visitor** (a visitor with a NickServ identity —
`visitors.password_encrypted` non-nil ⟺ permanent), and an **ephemeral**
visitor (no identity, Reaper-swept). `detach` + `disconnect`/`reconnect`
are persistent-identity-only; `quit` is universal.

**The two bugs (one root).** Pre-#126 `DELETE /auth/logout` called a
teardown (`stop_all_user_sessions` / visitor `stop_session`) for EVERY
subject. That (1) tore the upstream down on every detach, and (2) never
transitioned `connection_state` nor broadcast, so the credential stayed
`:connected` while the live pid was gone — a textbook violation of the
"DB state and live state are separate sources of truth" invariant. The
fix is one scoping change: **detach is the ABSENCE of teardown.** Logout
now only revokes the web session + closes the socket; the lone exception
is the ANON visitor, which keeps the W11 co-terminus teardown (stop +
`purge_if_anon`) because it has no persistent identity to come back to.
With no teardown for a persistent identity, DB == live and the desync
vanishes. (An ephemeral visitor's user-facing "quit" simply IS this anon
logout — the wipe didn't move, it was renamed.)

**One disposition core, every door (reuse the verbs, not the nouns).**
There is NO second teardown. The verbs compose the EXISTING cores:
  * teardown = `Session.stop_session/3` (already subject-polymorphic; the
    same core `Networks.disconnect/2` uses for users);
  * respawn = `SpawnOrchestrator.spawn/4` (the same core
    `NetworksController` drives for a user `:connected` transition).
Per-subject routing:
  * **user** — detach = logout; disconnect/reconnect = the existing
    per-network `PATCH /networks/:slug {parked|connected}` (a user has
    many networks, so the whole-session verb is ambiguous for them —
    "≈ existing"); quit = `quitAll` (park all) + detach.
  * **registered visitor** — detach = logout (keeps the session); a NEW
    `POST /session/{disconnect,reconnect}` (registered-visitor-gated)
    drives stop/respawn; quit = disconnect + detach (row + scrollback
    KEPT — `purge_if_anon` no-ops a registered visitor).
  * **ephemeral visitor** — quit only = logout (anon branch stops +
    purges). detach/disconnect/reconnect are withheld (403 server-side +
    cic-gated).

**#152 seam.** #152 (ident live-apply) needs an internal reconnect =
"tear down the upstream, then respawn preserving row + scrollback." That
is exactly `Visitors.reconnect_session/3`'s shape — `SessionPlan.resolve`
→ `SpawnOrchestrator.spawn` — with a CHANGED plan substituted at the
resolve step. The seam is left open; #152 is a follow-on, not a third
copy. New `Admission` flow `:visitor_reconnect` (subject_kind `:visitor`).

**Visitor connection surface (the one new display, lightweight).**
Visitors have NO `connection_state` column and NO
`connection_state_changed` broadcast — live status is whereis-derived. To
make disconnect/reconnect visible, `GET /me` (visitor) gained a
`connected: boolean` computed from `Session.whereis/2` (a cheap
`Registry.lookup`, NOT a `GenServer.call`, so `/me` stays off blocking
Session calls), plus a derived `registered: boolean` (= `password_encrypted`
present) on the visitor wire as the cic gate. NO schema change, NO new
PubSub event: the verb handler refetches `/me` and the SettingsDrawer
toggles its disconnect ⇄ reconnect face off `connected`. Sibling-tab
consistency is best-effort (no live push) — acceptable for a deliberate
single-tab action.

**Terminology.** Canonical vocabulary everywhere (cic labels, endpoints,
events, atoms): `detach` / `disconnect` / `reconnect` / `quit`. The
user-facing "logout" term is RETIRED — what an ephemeral visitor called
"logout" IS quit; `DELETE /auth/logout` stays as shared plumbing (it IS
detach). `delete account` (#157) is the separate, explicit, irreversible
wipe of a persistent identity — `quit` NEVER wipes one.

**Tests.** Server: `auth_controller_test` rewritten to assert
detach-keeps-the-session (no `:DOWN`, pid + `connection_state` survive)
for user + registered visitor, anon stop+purge unchanged;
`session_controller_test` for the new endpoints + the whereis-derived
`/me` `connected` round-trip; `wire_test` / `me_controller_test` for the
flags. cic: `lib/lifecycle.test.ts` (per-subject verb routing) +
SettingsDrawer vitest (per-subject rendering). Real chromium e2e
(`issue126-detach-lifecycle.spec.ts`): the ephemeral-visitor gate (quit
alone, "log out" gone) + user detach keeps the upstream (autojoin channel
stays `joined` server-side). The registered-visitor disconnect/reconnect
round-trip is server- + vitest-covered rather than e2e: a *registered*
visitor in the e2e testnet would need the full NickServ REGISTER dance
(no pre-seeded identified nick), more flake surface than the gate is
worth — the user-analog disconnect/reconnect already has a full-stack
e2e in `cp15-b6-parked-disconnect-reconnect.spec.ts`.

## delete account — the irreversible nuke (#157, 2026-06-29)

#126 deliberately kept the total wipe OUT and flagged it as #157. `quit`
PRESERVES a persistent identity (a registered visitor's row + scrollback
survive; a user's account survives a park-all). **`delete account` is the
ONLY self-service door that destroys it** — distinct verb, distinct
affordance, distinct confirm; the server NEVER wipes on quit.

**Subject routing + gating (`Grappa.AccountDeletion.delete_account/1`).**
One subject-routed verb, forbidden cases pattern-matched FIRST so the wipe
clauses carry no negated guards:
  * **admin user → `{:error, :forbidden}`** (issue #157: not for admins).
    An operator removing an admin uses `DELETE /admin/users/:id`, which
    keeps the last-admin lockout guard. The self-delete door never reaches
    `Accounts.delete_user/1`'s `:last_admin` branch (admins 403 earlier).
  * **non-admin user →** stop ALL the user's live `Session.Server`s (one
    per bound network, via `Credentials.list_credentials_for_user/1`) THEN
    `Accounts.delete_user/1`.
  * **anon visitor → `{:error, :forbidden}`** — no persistent identity to
    delete; its only teardown is quit. Mirrors
    `SessionController.require_registered_visitor/1` (server-side
    defense-in-depth, NOT a reliance on the cic gate).
  * **registered visitor →** `Session.stop_session/3` THEN
    `Visitors.delete/1`.

**Teardown → wipe ordering** mirrors `Operator.delete_visitor/2`: stop the
live session BEFORE the `Repo.delete` so an in-flight scrollback persist
can't trip a `*_id` FK and the GenServer drains via `terminate/2`. The
DB-level `ON DELETE CASCADE` on every subject-keyed FK (verified at the
migrations: sessions, messages, query_windows, read_cursors,
network_credentials, user_settings, push_subscriptions, …) wipes the
dependents in the same transaction — no orphans, no nilify/restrict.

**Reuse the verbs, not the nouns.** The wipe PRIMITIVES already existed
(`Session.stop_session` + `Visitors.delete` / `Accounts.delete_user`).
`Operator.delete_visitor/2` (the admin door) wraps them with admin-event
emission + actor attribution; `AccountDeletion` (the self-service door)
wraps the SAME primitives with self-only gating — and emits NO admin event
(no admin actor). Two doors, one core. The new top-level boundary module
owns the cross-context orchestration (deps Accounts/Networks/Session/
Visitors) so no single existing context grows the others' deps.

**The door: `DELETE /me`** (subject-routed in `MeController.delete/2`,
thin: route → context → 204). Chosen over a new `/account` prefix because
`/me` already rides the nginx allowlist + the SW navigation denylist — no
proxy/SW change. After the cascade the auth-session row is already gone, so
the only remaining controller teardown is the socket close — the SAME
mid-flight WS enforcement as logout's H2, now shared via the extracted
`UserSocket.disconnect_subject/1` (auth_controller refactored to delegate;
one socket-teardown code path).

**The irreversibility gate is cic-side.** A two-tap `InlineConfirmButton`
(quit's gate) is too weak for an irreversible nuke. `DeleteAccountModal`
keeps the destructive button DISABLED until the operator types their exact
account name / nick (`displayNick(me)`, no trim/casefold) — "the user
cannot do this by accident." The server stays simple: the modal is the
gate, the endpoint is the deliberate action; `lib/lifecycle.deleteAccount`
PROPAGATES errors (unlike quit/logout's best-effort swallow) so a failed
wipe (403, server error) does NOT clear the local bearer on a
still-existing account. The drawer affordance is gated to a registered
non-admin user or a registered visitor — admins + anon visitors never see
it (the reactive `/me` `is_admin` / `registered` flags drive it, so a
mid-session demote flips it).

**Tests.** Server: `Grappa.AccountDeletionTest` (live-session teardown +
cascade + the gating + the **#126 boundary asserted explicitly**: a
registered visitor's row SURVIVES detach/`purge_if_anon` but is WIPED by
`delete_account`); `me_controller_test` for the `DELETE /me` HTTP contract
(204 / 403-admin / 403-anon / 401-no-bearer + the socket "disconnect"
broadcast + re-auth-fails). cic: `lifecycle.test.ts` (wipe→clear, distinct
from quit, no-clear-on-failure), `DeleteAccountModal.test.tsx` (the
type-the-name gate), SettingsDrawer vitest (per-subject affordance gating).
Real chromium e2e (`issue157-delete-account.spec.ts`): the USER wipe is the
RED-provable visible flow (throwaway user via `POST /admin/users` →
confirm-delete → fresh login + old bearer both rejected); the anon-visitor
no-button is a guard. A registered-visitor visible wipe needs the NickServ
REGISTER dance (out of scope, same wall #126 hit) — covered by
server-unit + vitest.

---

## 2026-07-01 — #146 recurrence: the SW→page navigate swallows on a rejecting `focus()`

**vjt: tapping a push notification again opens no window.** The
2026-06-29 fix corrected the cic-side ROUTING (open-then-select for a DM
query window) and is live + byte-correct in prod (verified: `su`
=routePushTarget in the deployed bundle resolves the network,
`openQueryWindowState`, THEN selects). Every drivable routing path is
green. The recurrence is one layer lower: the SW→page DELIVERY.

`service-worker.ts`'s `notificationclick` → `focusOrOpen` did, for the
warm path (a cic window already running, e.g. backgrounded):

```
await existing.focus();
existing.postMessage({ type: "navigate", url });
```

`WindowClient.focus()` returns a Promise that **rejects** —
`InvalidAccessError: Not allowed to focus a window` — when the
`notificationclick` lacks transient activation. iOS/WebKit reject it even
from a genuine tap. A rejected `focus()` threw out of the async
`focusOrOpen` **before** `postMessage` ran, so the `{type:"navigate"}`
deep-link never reached the page's `installPushTargetListener` and the
tap opened nothing. This is a no-silent-swallow violation: `focus()` is a
nicety, never a gate on the navigation.

Distinct from the original #146 (cic routing) — different layer, and hit
on a different trigger: the WARM path (cic backgrounded-but-running,
which fires `focus()`), NOT the cold path (`openWindow`, no `focus()`, so
the original DM-while-closed case was unaffected and stayed working after
the June fix).

**Fix.** Extract the delivery into a SW-safe, vitest-testable
`lib/swNavigate.ts` `deliverNavigate(client, url)` that posts the
navigate FIRST, then focuses best-effort inside a `try/catch`. Delivery
no longer depends on `focus()` resolving. `focusOrOpen` calls it; the
cold-path `openWindow` branch is unchanged.

**Why the June e2e missed it.** The shipped `notif-tap-focus.spec.ts`
drives COLD via `page.goto(deepLink)` and WARM via a **synthetic**
`navigator.serviceWorker.dispatchEvent(MessageEvent)` — both bypass the
real SW `focusOrOpen`, so the `await focus(); post` ordering was never
exercised. The June note called the real SW handler "undrivable
headless" because `showNotification`/`focus()`/`openWindow` reject
without activation — but that very `focus()` rejection IS the bug's
trigger, and the handler CAN be driven: dispatch a real
`notificationclick` into the live SW via
`context.serviceWorkers()[0].evaluate(...)` with a synthetic notification
(`{data:{url}, close()}`) + a `waitUntil` collector. The new
`notif-tap-sw-handler.spec.ts` does exactly this and went RED
(`focusOrOpen waitUntil → rejected: InvalidAccessError`, window never
selected) against the old ordering, GREEN after. Companion
`swNavigate.test.ts` pins the contract deterministically (post fires even
when `focus()` rejects). `notif-tap-sw-controlled.spec.ts` additionally
guards the SW-controlled precache serving of the deep-link (the real
`openWindow` path the June cold test — a fresh-context `goto`, SW not yet
claiming — never covered).

**Deploy:** cic bundle only (`deploy-m42.sh --cic`) — no server change.

---

## #160 — virtual-tab read-cursor POST bans legit users via fail2ban (2026-07-01)

**Prod incident (P0).** Selecting the **Home** / directory tab made
cicchetto `POST /networks/$home/channels/$home/read-cursor` (and
`$admin` / `$list`). Those pseudo-windows have no server-side channel
row, so the POST 404s (`$home`/`$admin` — unknown network slug) or 400s
(`$list` — invalid target name). nginx feeds those 4xx to the m42 host's
fail2ban `http-404` / `http-400` jails (`maxretry 20`); a user idling on
Home accumulates 404s, gets banned, and after repeats is escalated into
the `recidive` jail — a long-bantime **pf** block that cuts the IP off
the whole host, **web AND IRC**. Already hard-banned at least one legit
beta user.

**Root cause.** `ScrollbackPane` is a single, non-keyed instance whose
`networkSlug`/`channelName` props are reactive getters bound to
`selectedChannel()` (the three scrollback-backed kinds share one
`<Match when={kindHasScrollback(selKind())}>` so the pane persists across
`channel↔query↔server`). Selecting a non-backed tab flips that `<Match>`
false and **disposes** the pane; its `onCleanup` cursor-flush reads
`props.channelName` — which by then already points at the **virtual**
selection — and POSTs a read-cursor there. The `onCleanup` comment
asserting props "won't change before unmount" was false for this shared
mount shape. The read side (`/messages`) was already gated by
`kindHasScrollback` (grappa-irc#81); the write side (read-cursor) had no
twin guard.

**Fix.** Guard at `setReadCursor` — the single chokepoint every one of
the six settle/blur/leave/unmount call sites funnels through — mirroring
its existing `messageId > 0` boundary contract. New name-side predicate
`isVirtualWindowName/1` in `windowKinds.ts` (the write-edge twin of
`kindHasScrollback`): true for `$home` / `$admin` / `$list` /
`mentions("")`, i.e. the names with no server-side row. `$server` is
deliberately excluded — it is a real `NumericRouter`-backed target the
server accepts (200), so cic must still write its cursor. IRC nicks
(start with a letter) and channels (`#/&/+/!`) can never collide with the
`$`-sentinels, so the name match is unambiguous. Guarding at the POST
boundary (not per-call-site) makes the invariant robust against future
new writers — "never emit a channel-scoped request for a window with no
server-side row," now enforced on BOTH read and write edges.

**Not fixed (flagged, latent, pre-existing — NOT a regression).** The
same `onCleanup` reactive-props leak means leaving a real channel FOR a
virtual tab no longer flushes the *real* channel's cursor on that
transition (it read the wrong, now-virtual name before this fix too). In
practice the scroll-settle timer already advanced the cursor while the
channel was focused, so impact is a lost last-scroll within the 500 ms
settle window — benign. A proper fix would snapshot the displayed
`(slug, channel)` for `onCleanup` instead of reading live props; left as
follow-up, out of scope for this hotfix.

**Server-side defence-in-depth (already in place).** A fail2ban
`ignoreregex` for `/read-cursor` responses `40[04]` was added to both the
`http-400` and `http-404` jails on the m42 host as a safety net. The cic
suppression is the real fix; the ignoreregex stops a legit client's own
404 from ever counting as abuse. The server route is NOT changed to
accept virtual channels — virtual tabs correctly have no cursor.

**Test.** Unit (`setReadCursorVirtualGuard.test.ts`): real `setReadCursor`
+ `fetch` spy — no POST (and no optimistic local advance) for the four
virtual names, POST for `#chan` and `$server`. Real e2e
(`issue160-virtual-tab-no-cursor.spec.ts`): watches `page.on("response")`,
selects a real channel then Home, asserts no read-cursor POST targeted a
virtual name and none returned 4xx. RED against the disabled guard (it
captured the real `POST …/channels/%24home/read-cursor → 404`), GREEN
after — not hollow-green.

**Deploy:** cic bundle only (`deploy-m42.sh --cic`) — no server change,
no BEAM restart, no session drop.

---

## 2026-07-01 — #159: activation/visibility/reconnect freshness re-fetch (silent one-channel message loss)

**The bug (P0, prod).** On one channel, cic silently STOPPED rendering
new messages. The rows were on the server (peers + REST scrollback had
them); cic gave no error, no signal — the pane just looked quiet. Only
recovery the user found: force-close the PWA and reopen (a full reload).
Silent message loss is worse than a visible error: the operator trusts an
empty pane to mean "nothing new."

**Root cause (H1).** cic had exactly one catch-up verb, `refreshScrollback`
(`scrollback.ts` — resolves a resume cursor, `GET …/messages?after=<id>`
capped 200, id-deduped through `appendToScrollback`, does NOT touch the
frozen unread divider), and it was called from **only** the five
per-channel `joinChannel(…).receive("ok")` callbacks in `subscribe.ts`
— i.e. the initial join and phoenix.js auto-rejoin, and nothing else. The
activation path ran `loadInitialScrollback`, which is **load-once gated**
(`loadedChannels` Set), so re-selecting an already-loaded tab fetched
nothing. Visibility/focus handlers refreshed the badge COUNT
(`badge.ts`), mentions (`selection.ts`), and scroll position
(`ScrollbackPane.tsx scrollToActivation`) but never message CONTENT. The
socket-open resync (`subscribe.ts`) only `refetchNetworks/refetchChannels`,
and the channels-loop skips `joined.has(key)` — so it never drove a
re-fetch for an already-joined channel; it relied entirely on phoenix.js
re-firing each channel's join `"ok"`. **Net:** any delivery gap that did
NOT coincide with a Phoenix (re)join — socket stays `"open"`, that one
channel's fan-out severed / rejoin never reaches `"ok"` — had no recovery
path except a full reload (which wipes `loadedChannels` + fresh-joins
everything). That is exactly the user's force-close-and-reopen.

**The fix — one verb, three new call sites (reuse, not duplicate).** No
parallel fetch path, no second high-water tracker — route all three
through the existing `refreshScrollback` (idempotent: a no-op when nothing
is newer than the resume cursor; per-key in-flight-guarded):
1. **Activation** (`selection.ts` selection-change effect) — alongside the
   load-once `loadInitialScrollback`, call `refreshScrollback` for
   `kindHasScrollback` windows that were ALREADY LOADED before this
   activation (a re-select). Re-selecting a tab now catches up. (Shipped
   the same day as UNCONDITIONAL; narrowed to re-select-only hours later —
   an unconditional fresh-open fire starved a just-opened query window's
   join-ok safety-net refetch and dropped its live 401. See the
   "#159 regression: activation refetch vs a fresh query-window's live
   delivery" entry below.)
2. **Visibility** (`ScrollbackPane.tsx` `isDocumentVisible` false→true
   effect) — the same call on re-foreground. Deliberately NOT folded into
   `scrollToActivation`: that routine early-returns on an empty pane
   (`messages().length === 0`), which is precisely the gap case we must
   heal — the fetch has to run independent of pane geometry.
3. **Reconnect** (`subscribe.ts` socket-open resync) — drive
   `refreshScrollback` for EVERY key in the `joined` Map, so reconnect
   recovery is cic-driven and no longer depends on each per-channel rejoin
   completing its `"ok"`.

**Untouched by design.** `loadInitialScrollback`'s load-once gate and the
#156 anchored-fetch / frozen-divider contract stay as-is — the divider
logic is correct; the gap was the ABSENCE of a re-fetch, not the initial
fetch shape. The freshness fetch never re-baselines the read cursor.

**Test.** New chromium e2e (`freshness-on-activation.spec.ts`) covers the
socket-STAYS-open gap that the two existing socket-drop specs
(`message-replay-on-reconnect`, `refresh-on-join-ws-gap-recovery`) do NOT:
a per-channel delivery gap opened with a new test-only seam
(`__cic_suppressChannelDeliveryForTests`, sibling to
`__cic_dropSocketForTests`) that silences `phx.on("event")` for ONE topic
while the socket + every other channel stay live. Two tests assert the
missed row becomes VISIBLE after re-select (item 1) and after
hidden→visible (item 2) — the rendered row, never a fetch spy, never after
a reload. RED against the disabled call sites (row never appears), GREEN
after — not hollow-green. Both existing socket-drop specs stay green
(item 3 overlaps the join-ok refresh; the in-flight guard dedupes).

**Deploy:** cic bundle only (`deploy-m42.sh --cic`) — no server change,
no BEAM restart, no session drop.

## 2026-07-01 — #159 regression: activation refetch vs a fresh query-window's live delivery

**The regression (P0, CI).** The #159 ship (720e7b8) turned
`cp13-s5-msg-ghost-401.spec.ts` FLAKY (~1 run in 3): `/msg <ghost>` to a
nonexistent nick intermittently dropped the 401 ERR_NOSUCHNICK `:notice` —
the error row never rendered in the just-opened query window
(`.scrollback-notice-error` stuck at count 0). Green at #160 (e3a8d5b),
red at #159 (720e7b8); #159 is cic-only, so the fault is client-side. It
slipped because the #159 worker ran `integration.sh --grep <own-spec>`
and never saw cp13-s5 flip (see the full-suite mandate below).

**The mechanism (proven by instrumentation — NOT the naive clobber
story).** Both scrollback fetch verbs are append-only, id-deduped merges
(`appendToScrollback` / `mergeIntoScrollback`): neither can DROP or
replace a row, so the notice was not clobbered — it was NEVER FETCHED OR
DELIVERED. The 401 has two paths into a fresh ghost query window:
  1. the live per-`(slug, ghost)` WS push, and
  2. the query-window join-ok `refreshScrollback` (`subscribe.ts`) — the
     REST safety net (`GET …/messages?after=<cursor>`) that backfills the
     401 whenever the live push is missed while the subscription is still
     settling.
#159 added a THIRD refetch: an activation `refreshScrollback` fired from
the `selection.ts` selection-change effect the instant the window is
focused. On a FRESH `/msg <ghost>` open this activation refetch fires
FIRST — before the server has round-tripped to bahamut and persisted the
401 — so it (a) grabs `refreshScrollback`'s per-key in-flight lock and
(b) returns `[]`. When the join-ok safety-net `refreshScrollback` then
fires, it finds the in-flight lock HELD and returns early WITHOUT
fetching. In the race where the live WS push is ALSO missed (the broadcast
reaches the topic before cic's subscription is wired), BOTH paths are lost
and the 401 never renders. WS-frame + network traces of a red run
confirmed it exactly: ONE `?after=0` GET (the activation refetch,
returning `[]`), NO join-ok GET, and no live `event` push — while the
ghost join reply reported `unread_count: 2`, proving the 401 was already
persisted server-side and any later fetch WOULD have found it. Pre-#159
nothing held the lock, so the join-ok safety net always ran and caught the
missed-push 401 — which is why cp13-s5 was green before #159.

**The fix (preserve the #159 gap fix; guard ONLY item 1).** The #159 gap
is specifically "RE-selecting an ALREADY-LOADED background tab fetches
nothing." A FRESH open is already covered by `loadInitialScrollback` + the
live WS subscription + the join-ok refetch, and does NOT need — must not
fire — the activation refetch. So `selection.ts` item 1 now fires
`refreshScrollback` ONLY for a re-select of an already-loaded window:
`scrollback.ts` exposes a synchronous `wasLoaded(slug, name)` probe over
its own `loadedChannels` Set (the single source of truth — no parallel
tracker in `selection.ts`, per "derive state, don't duplicate"), captured
BEFORE `loadInitialScrollback` (which adds the key SYNCHRONOUSLY, so a
post-call read is always `true`, even on a first open — the naive
`loadedChannels.has` guard does not work). A fresh open no longer fires
the activation refetch, so the join-ok safety net's in-flight lock is free
and the 401 is delivered. Items 2 (visibility) and 3 (reconnect) are
UNCHANGED: both fire only for an already-established / already-joined
window (the re-foregrounded active pane; every key already in `joined`),
never a genuinely fresh open, so neither can starve a settling
subscription.

**Tests.** cp13-s5 goes flaky-red → reliably green (12× repeat-each,
0 failed); the #159 gap pin `freshness-on-activation.spec.ts` (re-select
+ hidden→visible) stays green, proving the gap fix is preserved. The
full chromium suite is the merge gate — run with NO `--grep`, because
this regression slipped through a scoped run.

**Deploy:** cic bundle only (`deploy-m42.sh --cic`) — no server change,
no BEAM restart, no session drop.

## 2026-07-01 — #163: off-by-one unread — last message never stays read when pinned to bottom

**Symptom (vjt prod-reported, P1).** Open channel A scrolled to the
bottom → the unread marker clears, A shows read. Select channel B. A's
sidebar badge returns to **1 unread**. Re-selecting A re-injects the
`── 1 unread message ──` divider. The last message of a channel never
stayed marked-read while the pane was pinned to the bottom.

**Root cause — the leave-arm never ran (a Solid `on`+`defer` trap), NOT
geometry.** The cursor write for the LEAVING window on a
channel↔query↔server switch (the pane stays MOUNTED across these — one
shared `kindHasScrollback` Match in `Shell.tsx`, so `onCleanup` does not
fire) is the pane's `on(key, …)` **leave-arm**. It lived INSIDE the pane's
*activation* effect `createEffect(on(key, …, {defer:true}))`, guarded by
`if (prevKey !== undefined && prevKey !== newKey)` — the author's intent
being "skip the initial mount run." But Solid's `on(deps, fn, {defer:true})`
skips the mount call and `return`s **before** assigning its internal
`prevInput` (verified in `solid-js/dist/solid.js`), so the FIRST real key
change after mount invokes the callback with `prevKey === undefined`. The
guard therefore skipped the first genuine window-leave after every mount
(and every remount — leaving to `$home`/`mentions`/`list` unmounts the
pane, so re-entering chat and switching is a fresh "first leave"). No
cursor was written for the leaving channel; its last message stayed unread
→ phantom "1 unread" + re-injected divider. Proven by runtime
instrumentation on the testnet: on `#bofh → $server` (pane `distance=7` ⇒
pinned to bottom, true DOM tail present) the leave-arm logged exactly once
with `prevKey` **undefined**, and **zero** read-cursor POSTs fired for the
leaving channel. The symptom presents "when pinned to the bottom" only
because that is the case where a skipped write is *visible* — the operator
saw everything, yet the channel shows unread.

The earlier WIP hypothesised a different site — a strict-`>` fractional
off-by-one in `lastFullyVisibleRowId` (the pure fn feeding the
fresh-measure paths: `onCleanup`, the 500ms scroll-settle, visibility-hide,
and the `onScroll` snapshot). Instrumentation refuted it as the
reproduction: the geometric walk already lands on the true tail in the
runner (`walk === domTail`). That fractional drop is a real but
browser/zoom-dependent hazard, not what #163 reproduced.

**Fix.**
1. **Split the leave-arm into its OWN `createEffect(on(key, …))` WITHOUT
   `defer`** — the actual fix. A non-deferred effect runs fn at the mount
   run (the `prevKey === undefined` guard skips it) AND Solid assigns
   `prevInput`, so the first real change carries a DEFINED `prevKey` and
   the arm runs. The activation effect keeps `defer:true` (its mount run
   would pre-emptively clear the auto-focus scroll — the reason `defer` was
   there; the bug was piggy-backing the leave-arm on it).
2. **Choose the id from the leaving pane's own snapshot —
   `id = snapshotted ?? storeTail`, NOT `atBottom()`.** `atBottom()` is
   unreliable at this point: the sibling activation effect runs in the SAME
   key-change batch and `setAtBottom(true)`s *before* the arm reads it —
   instrumentation caught `atBottom() === true` while the leaving pane sat
   407px off the bottom, which mis-selected the store-tail on a scrolled-up
   leave and regressed `cursor-forward-only.spec.ts`. The leaving pane's
   captured onScroll `visibleTailSnapshot` is the honest source (a post-hoc
   `lastFullyVisibleRowId(listRef)` can't be used — Solid's `<For>` has
   already swapped rows). At the bottom the snapshot equals the store
   true-tail (guaranteed by point 3's short-circuit — onScroll captured the
   true tail); scrolled up it is the last row actually seen; absent (pure
   auto-follow, never scrolled — still at bottom) it falls back to the
   store-tail. Forward-only drops a scrolled-up snapshot below the cursor,
   never rewinding.
3. **Kept the `lastFullyVisibleRowId` at-bottom short-circuit** (return the
   DOM true tail within `SCROLL_BOTTOM_THRESHOLD_PX` instead of the
   strict-`>` walk). Correct-by-construction against the fractional drop
   the walk can hit on other browsers/zoom levels — and load-bearing for
   point 2: it is what makes the `onScroll` snapshot equal the true tail
   when at the bottom, so `snapshotted ?? storeTail` lands on the tail
   without consulting the (unreliable) live `atBottom()` signal.

**Invariants preserved.** `setCursorIfAdvances` stays forward-only (the
snapshot/tail id only advances the cursor, never rewinds — a scrolled-up
leave whose snapshot is below the cursor is dropped). Read state stays
server-owned per (subject, network, channel) —
this only changes which id cic COMPUTES as "last read" on leave, no
storage-model / wire-shape / server change; cic originates no new state
machine. The #156 anchored-fetch / frozen-divider contract and the #159
activation-freshness re-fetch (same file surface) are untouched.

**Test.** New chromium e2e (`unread-off-by-one-on-leave.spec.ts`): focus
#bofh pinned to bottom, a peer PRIVMSGs a real tail row (asserted
VISIBLE), leave to the $server window, then assert the leaving channel's
sidebar badge has count 0 AND re-selecting injects NO `unread-marker` —
the rendered outcome, never a cursor/fetch spy, never after a reload. RED
because the deferred leave-arm never wrote the cursor (badge stays 1 /
marker re-injects); GREEN once the non-deferred split makes it run. jsdom
has zero layout so the vitest suite is unaffected. Full chromium
`integration.sh` (NO `--grep`) is the merge gate.

**Deploy:** cic bundle only (`deploy-m42.sh --cic`) — no server change,
no BEAM restart, no session drop.

---

## 2026-07-01 — #161: the newest messages were unreachable after the #156 anchored fetch — no scroll-to-bottom forward-paging

**Symptom.** Open a channel whose unread count exceeds 200 (the server
`@max_http_limit`). The `── XX unread ──` divider anchors correctly (#156
works), but scrolling to the BOTTOM never reveals the newest messages — the
latest traffic is simply inaccessible. The pane bottoms out at
`cursor + 200` and stops.

**Root cause.** #156's `loadInitialScrollback` cursor-present arm fetches
the region AROUND the read cursor: `listMessagesAfter(cursor, 200)` (the
unread region, ASC, capped at the server's `@max_http_limit = 200`) +
`listMessages(cursor + 1)` (before-context). When true unread > 200 the
after-page stops at `cursor + 200`. #156's decision log claimed the rows
past that "stream in via the WS join-ok `refreshScrollback`" — but that was
WRONG (corrected at the source in the #156 entry above):
`refreshScrollback` calls `listMessagesAfter(resume_cursor, 200)` from the
SAME resume cursor and hits the SAME 200 cap, so it never reaches the tail
either. And there was NO forward-paging handler: `loadMore` pages OLDER
rows on scroll-to-TOP (oldest-id paging); nothing paged NEWER rows on
scroll-to-BOTTOM. The gap `[cursor+200 .. true newest]` was unreachable —
you couldn't scroll into it and no background fetch backfilled it.

**Fix (cic-only — the REST verb already existed).** A forward-paging verb
`loadNewer` (cicchetto, `lib/scrollback.ts`), the mirror image of
`loadMore`: on scroll-to-bottom, if the pane isn't at the live tail, pull
`listMessagesAfter(highestLoadedId, 200)` and merge via the existing
`mergeIntoScrollback` (id-dedupe + ASC — the SAME merge as loadMore /
refresh). `ScrollbackPane.onScroll` fires it when the pane nears the bottom
of the loaded content (`distance ≤ LOAD_MORE_THRESHOLD_PX = 200`, the same
threshold as the scroll-to-top loadMore, mirrored). NO scroll-position
restore is needed — forward rows APPEND below the viewport (loadMore
prepends above it, which is why loadMore needs the height-delta correction
and this does not).

**The growing-tail latch (the 20% that is NOT symmetric to loadMore).**
`loadMore`'s `loadMoreExhausted` latch is permanent because the OLDER end
never grows. The NEWER end GROWS via live WS `appendToScrollback`, so a
permanent forward latch would strand rows that arrive after latching. But
the naive alternative — "invalidate the latch on every append that advances
the max" — is worse: at a busy live tail every WS row would clear the
latch, the auto-follow scroll-to-bottom would re-fire `loadNewer`, and
`after(newMax)` would return empty → one REST GET per message (a
fetch-per-message storm). The resolution turns on an invariant: ordinary
live appends are CONTIGUOUS — each appended row IS the server's newest — so
`after(max)` stays empty and `loadNewerExhausted` stays CORRECT even as
`max` advances (we're still at the live tail; no fetch needed, the row is
already rendered). The ONLY way a forward gap RE-opens after latching is a
`refreshScrollback` batch that hit its 200-row cap (a >200-message
reconnect): it appended a full page but the tail may be further ahead. So
the latch is invalidated at exactly ONE site — a capped `refreshScrollback`
page (`page.length === REFRESH_LIMIT`) — and NOWHERE else. After
invalidation the auto-follow scroll drains the remaining gap page-by-page
(200 at a time) until an empty page re-latches: a bounded cascade, not a
per-message storm.

**Why it can't fight #156 or #163.** `loadNewer` only changes which ROWS
are loaded; it never touches the read cursor or the frozen `markerCursorId`
/ `sessionTopId` snapshots. Forward-paged rows have `id > sessionTopId`, so
the divider's `(cursor, sessionTopId]` count filter excludes them — the
in-pane count still caps at the loaded window and the divider does not thaw
(the #156 freeze contract holds). The #163 leave-arm cursor write
(`snapshotted ?? storeTail`) and forward-only `setCursorIfAdvances` are
untouched. Per the #163 lesson, the gap is derived from loaded-id vs the
fetched page, NOT from the `atBottom` signal (unreliable across a key-change
batch).

**Tests.** Unit RED→GREEN in `src/__tests__/scrollback.test.ts`
(`loadNewer` describe): fetch shape `after(newestId, 200)`, concurrency
guard, growing-tail latch, in-flight release on resolve + on error, and the
asymmetric latch (a CAPPED `refreshScrollback` invalidates; a SHORT page
does not). Real chromium e2e
(`cicchetto/e2e/tests/issue161-forward-paging.spec.ts`): re-seeds #bofh with
260 rows via the admin `resetSubject(baselineSeed)` surface, plants an early
read cursor so unread > 200, opens the channel (anchored fetch loads only
`[cursor .. cursor+200]`), then scroll-to-bottom must page forward until the
TRUE newest privmsg (`id > cursor + 200`) renders. RED against the
unmodified anchored-fetch code (the newest row never attaches); GREEN once
forward-paging lands. Full chromium `integration.sh` (NO `--grep`) is the
merge gate.

**Deploy:** cic bundle only (`deploy-m42.sh --cic`) — no server change,
no BEAM restart, no session drop.

---

### 2026-07-01 — #153: every state-changing verb is visitor-eligible (the identity gate is gone)

**P0 ask (vjt): visitors and users alike must be able to send every
command.** #148 relaxed the visitor gate for `/oper` only; #153
generalizes that to EVERY verb — `/op /deop /voice /devoice /kick /ban
/unban /umode /mode /topic_set /topic_clear` and the `/quote` (raw)
escape hatch. Pre-#153 those routed through `dispatch_ops_verb/3`, whose
`with` chain ran `check_not_visitor/1` → a visitor-backed socket got
`{:error, :visitor_not_allowed}` and the verb never reached upstream.

**The issue's own mechanism was wrong — challenge-the-spec.** The #153
body said "drop `check_not_visitor`, KEEP `safe_get_user`." Verified
against the code, that mechanism is broken: `safe_get_user/1` =
`Accounts.get_user_by_name!/1` rescuing `NoResultsError`, and a visitor's
`user_name` is `"visitor:<uuid>"` — no `users` row → `:error` →
`user_not_found`. And every `dispatch_ops_verb` thunk hard-built
`{:user, user.id}`, which targets a `{:user, _}`-keyed session that a
visitor doesn't own. So de-gating `dispatch_ops_verb` while keeping
`safe_get_user` just moves the visitor's rejection one line down; the
verbs still never reach upstream.

**Correct fix = consolidate onto the ONE visitor-eligible helper (reuse
the verbs, not the nouns).** Every ops verb now routes through the
existing `dispatch_subject_verb/3` — the same helper #148 (`/oper`) and
#31 (`/invite`) already used. It resolves the socket identity via
`resolve_subject/1` (`"visitor:"<>id → {:visitor, id}`, else delegates to
`safe_get_user` → `{:user, id}`) and hands the thunk the SUBJECT. This
PRESERVES every validation the old path carried — `validate_args`
(identifier/CRLF/NUL shape), `with_body_check` BodyLimit on
kick/umode/mode/topic, and the REV-E/REV-F `upstream_unavailable`
catch-all — and KEEPS `safe_get_user` (resolve_subject calls it on the
user branch; "keep safe_get_user" in the spec meant keep that
VALIDATION, which the re-route does). All `Session.send_*` facades
already accept `subject()`, so no facade/Server change was needed.
`topic_set_dispatch/5` (its own `with` chain, not a `dispatch_ops_verb`
call) was de-gated the same way (`resolve_subject` + `send_topic(subject,
…)`). This is not a behavior change for USERS — they already resolved to
`{:user, id}` via the user branch → byte-identical send.

**Dead code removed (mandatory for green, not tidy-up).**
`dispatch_ops_verb/3`, `check_not_visitor/1`, and `visitor?/1` (its sole
caller was `check_not_visitor`) are deleted, along with the two
now-unreachable `{:error, :visitor_not_allowed}` `else` arms — Dialyzer
flags unreachable arms as `pattern_match never matches` and
`--warnings-as-errors` fails on the orphaned `visitor?/1`.
`dispatch_subject_verb/3` is now the SOLE dispatch path for every
`handle_in/3` verb.

**`/quote` now passes EVERYTHING — intended.** De-gating the raw escape
hatch means a visitor (like a user) can send adminserv/as/stats/rehash
and any other raw line. That is deliberate (vjt: visitors + users send
every command): the ircd O:line + services are the real authority; the
bouncer keeps only the CRLF/NUL frame-safety gate (`validate_args`),
which runs BEFORE identity resolution and still rejects malformed lines
for visitors and users alike.

**Tests — RED→GREEN, anti-hollow.** Server ExUnit
(`grappa_channel_test.exs`): the `"visitor socket: op returns
visitor_not_allowed"` and `"topic_set: visitor … visitor_not_allowed"`
tests were FLIPPED to assert the verb ships MODE/TOPIC upstream (never
assert removed behavior), and a new visitor `/raw` test asserts the raw
line ships verbatim; the `"topic_set: visitor + invalid_channel"` test
stays GREEN and pins that `validate_args` still runs before identity
resolution. E2E (`cicchetto/e2e/tests/issue153-visitor-state-verbs.spec.ts`):
a visitor boots cic, `/oper`s (so it can mode regardless of the leaf's
split-mode first-joiner-op behavior), `/join`s a fresh channel, and an
independent peer IRC client sharing the channel WITNESSES both a
`/quote PRIVMSG` line and a `/mode +m` MODE line arriving from upstream —
the visible upstream effect, not a client-side spy. RED pre-fix (both
`peer.waitForLine` promises time out; the verbs are short-circuited);
GREEN post-fix. Full chromium `integration.sh` (NO `--grep`) is the merge
gate — de-gating the shared channel-dispatch path touches every ops verb.

**Deploy:** server change (`grappa_channel.ex`) — COLD (BEAM restart,
drops live IRC sessions), night-batched per the no-daytime-cold-deploy
standing order; `deploy-m42.sh` auto-classifies hot/cold.

## 2026-07-02 — #155: native /stats + /rehash (cic-only sugar over the #153 raw path)

**Scope: CIC-ONLY, no server change.** `/stats [query] [server]` and
`/rehash` are added as native `cicchetto` parser commands
(`slashCommands.ts` handlers + Intent union members) whose `compose.ts`
dispatch builds the raw `STATS …`/`REHASH` frame and ships it via the
existing `pushRaw` helper — the same `handle_in("raw", …)` #153 de-gated
for visitors, with its `.receive(ok/error)` no-silent-drop contract
(the #154 lesson). This is native-parser sugar over an existing
transport, exactly like the #20 services shortcuts rewrite to
`{kind:"msg"}`. NO server `handle_in`, NO Session facade, NO
`IRC.Client` change, NO numeric-routing change.

**Why no server change is needed.** `Grappa.Session.NumericRouter`'s
scan-then-server fallback already routes any numeric with no
channel-shaped param to `{:server, nil}` = the `$server` synthetic
window as a `:notice` row. The STATS reply numerics (211–219, 240–250)
and the REHASH/permission numerics (382 RPL_REHASHING, 481
ERR_NOPRIVILEGES) are NOT in `@delegated_numerics` or `@active_numerics`,
so they already fall through to `$server` — the same mechanism that
renders #148's 381 RPL_YOUREOPER. Empirically confirmed on the connected
testnet: a visitor's `/quote STATS u` renders 242 in `$server`.

**Build-defer (rides #153).** The native slashes emit raw frames over
the `raw` path #153 de-gated for visitors, and #153 is merged-not-yet-
deployed (ships in a night cold batch). Per the cic↔server coupling
rule #155 is therefore also build-defer: BUILD + TEST + MERGE + PUSH,
then STOP — comment "code complete — PENDING NIGHT COLD-DEPLOY BATCH
(rides #153)" and ship the cic bundle in the same night pass after #153
goes live. No prod deploy, no close, from this session.

**The e2e is deliberately NON-oper — and that flushed out a real
bahamut bug.** The first `/rehash` e2e opered first (copying the
#148/#153 pattern) and reproducibly SIGSEGV'd the testnet leaf. Root
cause (see GH #164, fix PR azzurra/bahamut#26): bahamut's custom
`irc_printf` (src/ircsprintf.c) reads `%d/%i/%u` with
`va_arg(ap, unsigned long)` — a 64-bit read for a 32-bit `int` arg. On
LP64 the undefined high bits make a small value (e.g. `TOPICLEN=307`)
into a ~14-digit number, whose backward itoa write underflows the global
`char num[12]` and clobbers the adjacent global `KList1` (an empty
`aConfList`); its `conf_list` pointer becomes ASCII garbage. Latent
until an operator (or adminserv — `as.c:656` calls the same
`rehash(cptr,sptr,0)`) issues REHASH → `clear_conf_list(&KList1)`
(dich_conf.c:538) frees the garbage → SIGSEGV. `-O2`-only (KList1
layout adjacency). Three verdicts, tested against the connected leaf:
`/rehash` by oper CRASHES; `/rehash` via adminserv CRASHES; **`/stats`
by anyone does NOT crash** (all 22 STATS letters survive — severity not
elevated; a hub-less *standalone* leaf self-crashes on any connect,
which is a split-mode artifact, not a STATS bug). So #155's e2e never
opers: a visitor's native `/stats u` renders 242 RPL_STATSUPTIME and
native `/rehash` renders 481 ERR_NOPRIVILEGES (the realistic outcome for
a non-oper — proves the frame shipped + the reply rendered), both in
`$server`; RED pre-fix (unknown command → nothing sent → no numeric),
GREEN post-fix. This keeps the full suite green (no leaf crash).

**Testnet pinned to the fix.** `cicchetto/e2e/infra` (submodule
azzurra-testnet) pins `BAHAMUT_REF` to `refs/pull/26/head` so the e2e
builds a patched ircd; revert to `master` once #26 merges (GH #165).

**Deploy:** cic bundle only (`deploy-m42.sh --cic`), HOT — but
build-deferred to the night batch behind #153 (above).

---

## 2026-07-02 — #154: MODE-family reliability (no-silent-drops + own-nick MODE render)

Two bugs Mez hit on a visitor socket, one cluster.

**(1) Ops-verb errors swallowed (cic, `--cic`).** The
`pushChannel{Op,Deop,Voice,Devoice,Kick,Ban,Unban,Mode,Umode}` helpers
were fire-and-forget `: void` — they `.push(...)` with no `.receive`, and
`compose.ts` set `result = {ok:true}` SYNCHRONOUSLY, so a server
`{:error,_}` (or a WS-down) was silently swallowed: a dropped
state-changing frame painted a green ✓. The server already replies
`{:reply, :ok | {:error, %{error: code}}}` for every one of these verbs
via `dispatch_subject_verb/3` (+ `with_body_check` for kick/umode/mode),
so this was a pure cic gap. Fix: a shared `pushUserChannelVerb/2` gives
all nine the `pushOper`/`pushRaw` promise shape (resolve on "ok", reject a
typed `ChannelPushError` on "error"); the compose arms `await` them so a
rejection hits the shared catch → `friendlyChannelError` inline banner —
the same contract as `case "oper"`/`case "quote"`. Extended
`friendlyChannelError`'s known-code union with the ops-verb tokens
(`invalid_channel`/`invalid_nick`/`invalid_mask`/`invalid_line`,
`upstream_unavailable`, `body_too_large`). `banlist` stays fire-and-forget
(read-only query, 367/368 route via the numeric pipeline); `invite` was
left as-is this pass (candidate for the same treatment — noted follow-up).

**(2) Own-nick MODE produced no visible feedback (server, COLD).**
EventRouter's user-MODE-on-self branch (`nick_eq?(target, state.nick)`)
DELIBERATELY dropped the echo ("user-modes on the session's own nick are
not channel events — no scrollback row"). So `/umode +a`, the +iS/+ixS
CONNECT burst, +r at NickServ IDENTIFY, and the services-pushed +a ALL
rendered nothing — the Mez incident. Reversed here **with vjt's sign-off**
(B): the self-branch now persists EVERY own-nick mode transition as a
`:mode` row on the synthetic `"$server"` window — GENERAL, not
special-cased to a mode letter (Mez's explicit ask) — keeping the
orthogonal `:visitor_r_observed` +r effect. Direct mirror of the NICK
self-rename `self_server_effects` (#61), which already surfaces a
zero-channel self-rename on `$server`. cic's `ScrollbackPane` `case "mode"`
renders the `"$server"`-channel form as "sets user mode +x" (no "on
<channel>" suffix); no real channel is ever named `"$server"` (reserved
`SERVER_WINDOW_NAME`), so the routing target is an unambiguous
discriminator — the same boundary `operatorActionEcho` keys off. `:mode`
is a presence kind on both sides → no unread badge / OS notify, like the
self-rename row.

**What the guardrail proved (server-vs-cic split).** Before touching
anything, a static end-to-end trace established: 221 RPL_UMODEIS
(numeric_router `:scan` → `{:server, nil}` → `:notice` on `$server`) and
channel MODE (EventRouter channel branch → `:mode` row) ALREADY reach cic
and ALREADY render — no cic-render gap there. The ONLY render gap was the
own-nick echo, which the server dropped. That is what flipped #154 from
`--cic`-only to **COLD + `--cic`**. "cic can't EMIT own-nick MODE" (bug
(a) as first reported) was a MISDIAGNOSIS: the `/umode` and `/mode` emit
paths exist end-to-end (slashCommands → compose → socket → GrappaChannel →
`Session.send_umode`/`send_mode` → `MODE <nick> …` upstream). The
user-perceived "can't emit" was the absence of *feedback* — bug (2) plus
the bug-(1) swallow — not a missing path. No new emit code was needed.

**Deploy coupling.** #154 rides the #153/#155 night window. Ordering:
#153 (server de-gate, COLD) + #154-server (COLD) fold into ONE cold
restart (zero extra session drops — `feedback_minimize_cold_deploys`),
then #155 + #154-cic ship `--cic`. Build-deferred: build+test+merge+push,
then the orchestrator ships in the night pass.

---

### 2026-07-02 — #168: one always-bottom scroll authority (P0 regression fix)

**Symptom (P0 regression).** After sending a message the cicchetto
scrollback pane yanked UP to the unread divider instead of staying pinned
at the bottom. A side-effect of the unread-anchor cluster (#156 divider /
#161 forward-paging / #163 leave-cursor): those left cic's `ScrollbackPane`
with **two** authorities writing the pane's `scrollTop`, and they raced —
the scroll-to-unread-marker anchor won on activation (parking the viewport
mid-pane, `atBottom=false`), so a subsequent send did not follow to the
tail. The just-sent line rendered off-screen at the bottom while the view
stayed stuck on the divider.

**The two racing authorities (dedup-review).** Every `scrollTop`/
`scrollIntoView` writer in `ScrollbackPane.tsx`, and what became of each:
- **`scrollToActivation`** (window activation — channel switch, visibility
  false→true, resize). Had a *marker branch* (`markerRef.scrollIntoView({
  block:"center"})` + `setAtBottom(distance…)` → often false) and a
  *tail branch*. → **collapsed**: always the tail branch (`atBottom=true`).
  *(Rescoped 2026-07-03 — this collapse over-reached: it also killed the
  jump-to-marker on a deliberate channel-SWITCH. A `mode` param restores it
  for the switch trigger ONLY, via a one-shot `querySelector` of the rendered
  divider, no `markerRef`; see the 2026-07-03 entry below.)*
- **length-effect `on(rows().length)`** (append / cursor-hydration). Had a
  *first-render marker branch* (`!markerScrolled && marker →
  scrollIntoView center`) and an *atBottom tail-follow*. → **collapsed**:
  only the `atBottom` tail-follow remains.
- **#130 channel-switch reset** — reuses `scrollToActivation`, inherits the
  fix. `setMarkerScrolled(false)` reset deleted.
- **`scrollToBottom`** (floating-button click) — already tail-only, kept.
- **`onScroll` loadMore/loadNewer scroll-restore** — pagination-prepend
  bookkeeping, semantically distinct (operator IS scrolling up); untouched.

The `markerRef` + `markerScrolled` signals (and the marker-row `ref`
callback) existed ONLY to feed the two marker branches — deleted with them.
The REV-G H23 stale-ref machinery stays dead even after the 2026-07-03
rescoping: the restored switch-only marker jump reads the divider with a
one-shot `listRef.querySelector('[data-testid="unread-marker"]')` inside the
settled-geometry rAF, so there is no long-lived DOM pointer to go stale — the
lookup lives and dies inside a single activation.

**Final scope (vjt + Mez).** ALWAYS scroll-to-bottom; NO event-type
branching (the earlier "branch by own-send vs inbound" idea is superseded).
irssi-shape: new content ⇒ bottom, the operator PAGES UP MANUALLY to
re-read. Exactly one scroll behavior. `atBottom` (a derived scroll-position
state, not an event-type) still gates the tail-follow — scrolled-up
preserves position, only the operator's own scroll leaves the tail.

**Reconciliation with the divider-freeze contract (2026-06-08).** The
freeze contract has two facets that were entangled in the marker branches;
#168 SPLITS them: (1) *scroll-position* — the tail (rescoped 2026-07-03: the
divider is a scroll anchor ONLY on the deliberate channel-SWITCH trigger, not
post-send / cold-mount / resize); (2) *divider-display* — the `── XX unread ──` row
still renders at its frozen `markerCursorId` position (`rows()` memo +
`sessionTopId`/`markerCursorId` freeze all untouched). You land at the
bottom and page UP to find the frozen boundary. No read-state invariant
changed: the cursor stays server-owned per `(subject, network, channel)`;
mark-all-read falls out for free via the EXISTING send-optimistic cursor
advance (`sendMessage` → `setReadCursor` → send-relatch collapses the
divider) — no second cursor writer added.

**A read-context PREPEND corrupts `atBottom` (the non-obvious part).**
Gating the tail-follow on `atBottom()` alone was NOT enough at first; it took
THREE wrong theories and a round of console instrumentation to find the real
cause. When a channel opens with a mid-buffer read cursor, the newest rows
load first (WS join-ok `refreshScrollback`, and/or the #156 anchored
`after(cursor,200)` page), the length-effect snaps the pane to that tail, and
then the read-context (`before(cursor+1)`) page merges — PREPENDING ~50 older
rows ABOVE the viewport. `scrollHeight` jumps (e.g. 622→1670) while `scrollTop`
stays put (443), so the distance-to-tail balloons to ~1056px even though the
operator never touched anything. The prepend fires a `scroll` event;
`onScroll`'s `setAtBottom(distance <= threshold)` reads that huge distance and
flips `atBottom` FALSE. The next always-bottom length-effect then aborts its
snap (`if (!atBottom()) return`) and the pane strands mid-buffer. The
instrumented trace nailed it: `onScroll st=443 dist=1055 ab:true->false
input=null` immediately followed by `LEsnap ABORT ab=false`.

Three rejected attempts, each disproven by evidence: (1) a `following()`
predicate (`atBottom() || lastInputEventAtMs() === null`) — correct for real
users but broke `cp14-b2`, whose loadMore test scrolls to the top
PROGRAMMATICALLY (no input event), so the predicate wrongly treated it as
"following"; (2) reversing the `loadInitialScrollback` merge order —
irrelevant, the newest region is loaded by `refreshScrollback`, not that
merge; (3) `overflow-anchor: none` — the trace showed `scrollTop` already
stayed fixed, so anchoring was never the trigger; the flip came purely from
`onScroll` recomputing `atBottom` off the grown geometry.

Root-cause fix: **`onScroll` flips `atBottom` false only on a real scroll UP
(`scrollTop` DECREASES vs the last observed value); reaching the tail always
re-arms it.** A content-grow-above keeps `scrollTop` put (or increases it),
so it can no longer masquerade as "the operator left the bottom." This
distinguishes it from `cp14-b2`'s scroll-to-top (scrollTop drops to 0 → a
genuine leave) and from a real operator wheel/drag up — both DECREASE
scrollTop — so the loadMore-preserve and paged-up-to-read paths are
untouched. `lastScrollTop` is a single `let`, updated every `onScroll`; no
new signal, no coupling to input events.

**Send is unconditional (issue #168 acceptance).** A send re-enters follow
mode even if the operator had paged up: the `lastOwnSend` effect calls
`scrollToBottom()` (the same tail authority) so the just-sent line is always
visible. This is NOT event-type branching — the send resets the follow-STATE
and the one always-bottom authority does the scrolling.

**Consequence worth noting.** Because activation now lands at the tail and
`onScroll` fires `loadNewer` near the bottom, opening a channel with >200
unread auto-forward-pages toward the true live tail (bounded by the
existing `loadNewerInFlight`/`loadNewerExhausted` latches). That is the
intended "always live tail" behavior, not a new mechanism.

**Tests.** New e2e `issue168-scroll-authority.spec.ts` (RED→GREEN): seed a
mid-page cursor so a divider is present, SEND, then assert the pane is
pinned at the bottom, the sent line is in the viewport (did NOT jump to the
marker), and the divider clears. Two prior specs that pinned the *removed*
scroll-to-marker behavior were inverted to the new contract:
`cp14-b1-scroll-marker-vs-bottom` scenario 2 (divider present but scroll at
bottom) and `scroll-on-window-switch` test 2 (fresh focus lands at bottom,
divider frozen above). The vitest REV-G H23 stale-ref pin was replaced by a
`#168` display-only-divider pin (atBottom stays true → no scroll-to-bottom
button).

**Deploy coupling.** cic-only viewport fix, but build-deferred: it rides
the #153/#154/#155 night `--cic` batch (shipping cic from `main` daytime
would push #154/#155 cic to prod before their server halves go live).
build+test+merge+push, then the orchestrator ships in the night pass.

## 2026-07-02 — #169: /who returns a typed who_reply modal, not a scrollback dump

`/who` mirrored `/whois`-era ergonomics badly: on 315 RPL_ENDOFWHO the
EventRouter drained the per-target accumulator into **N+1 `:persist
:notice` rows** — one irssi-shape line per 352 RPL_WHOREPLY plus an
"End of /WHO list" terminator — routed into the target channel's window
(if joined) or the synthetic `$server` window otherwise. Transient query
output polluted permanent scrollback; cic had **no `who_reply` arm at
all**, so the server's structured `meta.who` payload was dead weight and
the rows rendered as plain notice text. `/names` already did it right
(#140): buffer the burst → emit ONE typed event → cic renders a
dismissable modal, nothing persisted. This makes `/who` mirror `/names`.

**What changed (server, COLD).** The 315 drain (`event_router.ex`) now
emits a single `{:who_reply, target_display, users}` effect — the N+1
`build_persist` loop and its `format_who_reply/2` helper are deleted. The
channel-vs-`$server` routing distinction disappears entirely: a who_reply
is always a user-topic modal, so even a `/who` on a **joined** channel no
longer dumps into that channel's buffer. `server.ex` gained an
`apply_effects([{:who_reply, …}])` arm that broadcasts
`SessionWire.who_reply/3` on `Topic.user(...)` — ephemeral, direct mirror
of the `:names_reply` arm. No sort tier is applied: the WHO row is a
superset of `member` (adds user/host/server/hops/realname/channel), so the
sigil-tier sort names uses doesn't fit; the flat table shows arrival
(server WHO) order.

**What stayed untouched (the load-bearing invariant).** The 352 route +
`who_fold/3` accumulator are reused AS-IS — the ONLY addition is carrying
the per-row `channel` into the folded map (for the modal column + a future
354 slot). Critically the 352 route STILL upserts `userhost_cache` (feeds
`/ban` mask derivation); that is orthogonal to scrollback and was never
the hack. Only the 315 drain was.

**Wire contract.** `who_reply_payload/0` + `who_user/0` types and
`who_reply/3` + `who_user/1` builders in `wire.ex`; `:who_reply` added to
the kind union. Each row is projected through `who_user/1` (explicit field
projection like `member/1`) so the JSON-safe wire shape is single-sourced
— raw structs over PubSub crash fastlane at the WS edge. `wireTypes.ts`
regenerated from `wire.ex` (drift-gated).

**cic (`--cic`).** New `whoModal.ts` store (identity-scoped
`whoModalBySlug`, one roster per network, last-write-wins — copy of
`namesModal.ts`); new `WhoModal.tsx` (same overlay / scroll-lock / dismiss
×-Esc-backdrop / nick-click-opens-query scaffolding as NamesModal, body
renders a flat per-user table instead of sigil-grouped chips); `userTopic`
`who_reply` arm → `narrowWhoUsers` (a single malformed row drops the whole
payload) → `setWhoReply`; mounted beside `<NamesModal/>` in both Shell
branches; `WhoUser`/`WhoReply` types in `api.ts`.

**WHOX (354) out of scope, shape left extensible.** grappa sends plain
`WHO`; there is no 354 handler. The row type deliberately has room for a
future handler to fill account etc. without a reshape — designed for the
general case, not retrofitted.

**Deploy coupling.** SERVER (event_router) → COLD; also `--cic`.
Build-deferred: rides the #153/#154/#155/#168 night batch. Server COLD
half (#153 + #154-server + #169-server) folds into ONE cold restart; cic
half ships `--cic` with #154-cic/#155/#168. build+test+merge+push, then
the orchestrator ships in the night pass.

---

### 2026-07-02 — #127: /info, /version, /motd render one typed server_reply modal

**Same buffered-drain-to-modal shape as #169/#140.** `/info` (371 RPL_INFO
burst → 374 RPL_ENDOFINFO), `/version` (351 RPL_VERSION, single-shot) and
`/motd` (375/372/376, or 422 ERR_NOMOTD) buffer their reply server-side and
drain ONE ephemeral event on the user topic — cic renders a dismissable,
scrollable, retro-styled modal (`ServerReplyModal`) and persists NOTHING.
This is the /who and /names pattern reused, not a new mechanism.

**ONE event, not three (implement-once).** The three commands differ only
in a title and content, so they share a single wire event
`{:server_reply, source, lines}` where `source :: :info | :version | :motd`
is the typed discriminant (`Wire.server_reply/3`; wireTypes emits
`"info" | "version" | "motd"`). One store (`serverReplyModal.ts`,
`*BySlug`, last-write-wins per network), one `userTopic` arm, one modal,
one CSS block. Per `feedback_no_localized_strings_server_side` the server
ships only `source` + raw lines; cic maps `source` → human title
("Server Info" / "Version" / "Message of the Day"). Three near-identical
stores/modals would have been a copy-paste-with-tweaks smell.

**The MOTD gating decision (the one real fork).** MOTD is dual-purpose: the
server auto-sends it on registration AND replies to an explicit `/motd`,
using the SAME numerics (375/372/376). Connect-time MOTD has always landed
as `:notice` rows on the synthetic `$server` window (BUG2), and that is the
right home for it — a modal popping on every reconnect would be obnoxious,
and the server-messages window should carry the connect banner. So the
modal is gated on an explicit request: `Session.Server` primes
`motd_pending` (a `%{lines: []}` accumulator) when the user issues `/motd`;
EventRouter's MOTD clause drains the burst into the modal ONLY when the flag
is set, and falls through to the legacy `$server` persist when it is nil
(connect-time). Same `whois_pending`/`in_flight_joins` priming idiom. The
general rule: **a pending flag set by the outbound command is what
distinguishes an on-demand query from a server-initiated burst** — INFO and
VERSION get the same `{info,version}_pending` treatment for uniformity (they
have no connect-time source, so unprimed simply means "unsolicited" and
falls back to `$server`, never silently dropped). 422 folds its own line
before draining so a no-MOTD `/motd` resolves the modal instead of
dangling.

**Delegation.** 371/374/351/422 join 375/372/376 in
`NumericRouter.@delegated_numerics` so EventRouter owns them end-to-end
(delegated numerics skip the auto-persist; the clause chooses modal-vs-
`$server` itself). A property test in `numeric_router_test` that scans
400–499 for channel-prefix routing had to exclude 422 (the only new
delegate in that range).

**IRC stays text-only.** The modal renders the reply lines as monospace
pre-wrapped text (classic MOTD/INFO look) — no media, no unfurl. The retro
"bells and whistles" (uppercase title, phosphor sigil, blinking footer
cursor) are pure CSS on existing theme vars; `prefers-reduced-motion`
disables the blink.

**Deploy coupling.** SERVER (event_router / server / client / channel /
wire / numeric_router) → COLD; also `--cic` (new store, modal, userTopic
arm, slash intents, transport). Build-deferred to the night cold batch.

### 2026-07-03 — #171: the one per-actor cap is per-(source-IP, network)

**The bug.** `Admission.check_capacity/1` composed a NetworkCircuit gate, a
per-network total cap, and a per-(client, network) cap — no per-source-IP
dimension. Visitor / unauthenticated logins carry `client_id: nil` (no
`X-Grappa-Client-Id` header), so `check_client_cap/2` short-circuited to
`:ok` **by construction** and one source IP could open arbitrary concurrent
visitor sessions. Seven concurrent sessions from a single IP were observed
live on the testnet — a connection-flood / resource-exhaustion vector.

**The decision (vjt): drop per-client entirely, collapse to per-IP.** The
first cut added a per-IP cap *alongside* the per-client cap, both reading the
one `max_per_client` knob. That coupled the two dimensions — loosening the IP
cap (needed for NAT + the shared-runner-IP e2e) also loosened the per-client
cap. Rather than add a second knob to decouple them, vjt cut the per-client
dimension altogether: **visitors have no stable client identity, so the
source IP is the only durable per-actor handle; authenticated users are
capped per-IP too.** So `check_capacity/1` is now circuit → network-total →
per-(source-IP, network), and the knob is renamed to match its meaning:
`networks.max_per_client` → `networks.max_per_ip`,
`default_max_per_client_per_network` → `default_max_per_ip_per_network`,
`effective_max_per_client/1` → `effective_max_per_ip/1`. The atom
`:client_cap_exceeded` is retired; `:ip_cap_exceeded` is the sole per-actor
cap error. `client_id` is removed from `capacity_input` (it stays on the
session row for the #117 attach path + audit, just not for admission);
`Telemetry.capacity_reject/4`'s 4th arg is now `source_ip`.

**`accounts_sessions.ip` is the count source — derive, don't duplicate.**
The `ip` column already exists and is populated at session creation
(`Accounts.create_session/4`; login writes `RemoteIP.format(conn)`). So the
per-IP count is a plain SQL query over persisted rows — NO new column, NO
ETS tracker, NO parallel state. `count_subjects_for_ip_on_network/4` keeps
the two disjoint subject-kind clauses (visitor JOINs visitors on
`network_slug`, user JOINs credentials on `network_id`), `count(_, :distinct)`,
the non-revoked filter, and the UX-5-BC self-exclusion of the requesting
subject — an IP running a visitor + a user is two independent budgets,
mirroring the per-network-total subject split. The `source_ip` handed to
`check_capacity/1` MUST come through the SAME `GrappaWeb.RemoteIP.format/1`
formatter login stores, or the string won't match the stored `ip` and the
count silently reads 0. Login flows carry a pre-formatted `input.ip`; the two
raw-conn surfaces (`NetworksController.orchestrate_spawn/4`,
`SessionController`'s `:visitor_reconnect`) format the conn; cold-start
Bootstrap + `subject_reset` carry `nil` (no HTTP conn → the cap skips).

**Real client IP in prod, not the nginx socket.** The per-IP cap keys on
`conn.remote_ip` *after* `GrappaWeb.Plugs.RemoteIpFromProxy`. Prod nginx is
same-jail loopback (`infra/freebsd/nginx.conf` upstream `127.0.0.1:4000`) and
sets `X-Forwarded-For`, so the plug's "loopback peer + XFF → trust XFF" arm
rewrites `remote_ip` to the real client IP (the cp52 S2 mechanism that makes
`accounts_sessions.ip` the real client IP + what #160 fail2ban bans on). The
cap counts real client IPs, NOT a single global nginx IP. (In the docker/e2e
stack nginx proxies via the non-loopback bridge `grappa:4000`, so that path
surfaces the nginx bridge IP — a test-substrate artifact, not prod.)

**`source_ip` is a required `capacity_input` field, nil-or-binary** — enforced
by `check_ip_cap/2`'s clause patterns (`%{source_ip: nil}` skips; `is_binary`
counts), so a construction site that omits it is a loud `FunctionClauseError`,
never a silent nil-skip. `:ip_cap_exceeded → too_many_sessions` (the same 503
envelope the retired `:client_cap_exceeded` used), so cic is unchanged (it
keys on the wire string, not the atom).

**NAT/CGNAT is a deliberate consequence, not an oversight.** With `max_per_ip`
defaulting to 1, distinct legitimate users behind one address (carrier NAT,
university, office) share a single per-network slot and all but one get
503'd. That is exactly why the cap is a tunable knob and not a hardcoded 1:
operators widen it by raising per-network `max_per_ip`. With per-client gone
there is no coupling caveat — it is one honest per-IP knob.

**Migration.** `ALTER TABLE networks RENAME COLUMN max_per_client TO
max_per_ip` (in-place, no table-recreate → no FK-ref refresh, no
`messages`-column-drift trap). SQLite 3.25+ rewrites the CHECK expression but
NOT the constraint name, so `max_per_client_non_negative` keeps firing against
the renamed column — same pattern as the U-1 `max_concurrent_sessions`
rename. COLD (migration + server).

**E2E (the shared-IP interaction).** The serial Playwright suite
(`workers: 1`) drives every browser login through one source IP (the e2e
nginx) and every direct API login through another (the runner) — many
DISTINCT seeded subjects per IP. At the production default (1) the 2nd
subject on a shared IP 503s, cascading unrelated specs. Fix (dev/test config,
NEVER the production default): `config/dev.exs` raises
`default_max_per_ip_per_network` to 10 (e2e boots `MIX_ENV=dev`;
`config.exs`'s base 1 stays for prod); `azzurra` additionally seeds
`max_per_ip: 100` for anon-visitor volume. The `#171` e2e drives the cap
deterministically (patch `azzurra` to 1, two-visitor probe, restore 100).
`u-3` still saturates end-to-end (two distinct users on the shared IP → 503
`too_many_sessions`, now via the IP cap); `u-4` was REMOVED (its subject-kind
cap-independence assertion ran through an ungated user *login*, so it was
vacuous — the property stays unit-covered by `admission_test`'s cross-clause
disjointness); `ux-5-bc` reframed to prove the gated `/connect` self-excludes
the returning subject (tight-cap self-exclusion is unit-covered by
`networks_controller_test`).

### 2026-07-03 — #168 regression + completion: marker on switch AND cold-mount/app-startup, post-send stays bottom, 307 race fixed

**Symptom (P0, vjt prod-confirmed).** After #168 shipped, clicking a channel
that has unread NO LONGER jumped to the unread divider — it landed at the
TAIL. #168's "collapse to one always-bottom authority" (2026-07-02 entry
above) over-reached: it removed the scroll-to-marker branch from
`scrollToActivation`, and cic's channel-SWITCH (the `on(key)` activation
effect, #130) reuses `scrollToActivation` — so a deliberate switch inherited
the always-tail behavior meant for the post-send / cold-mount paths.

**Three activation triggers, now deliberately divergent (scoped).** #168
correctly conflated them into one always-bottom routine to kill a send-time
race; the fix RE-SEPARATES them WITHOUT re-opening that race:

| trigger | lands at | why |
|---|---|---|
| deliberate channel-SWITCH into an unread window | the **MARKER** | the operator chose to open it — show them where they left off |
| COLD-MOUNT / app-startup into an unread window | the **MARKER** | **updated 2026-07-03b (vjt point-2)** — launching the PWA onto a window you left unread should land you where you left off, same as a switch. Reverses the #46 cold-mount-tail wontfix below. No unread → tail. |
| post-send / live-append while following | the **BOTTOM** | irssi-shape, the just-sent line must be visible (#168 acceptance) |
| visibility-return / resize | the **TAIL** | #46 resume family; a brief tab-blur / keyboard-open is not a window activation |

> **2026-07-03b note — this row's `cold-mount` was originally TAIL** (matching
> the #46 wontfix). vjt reversed that in the completion below; the table now
> reads the current behavior. The DESIGN entry keeps the history in prose so the
> decision is legible, not a caveat wall.

**The scoping mechanism.** `scrollToActivation` takes a `mode:
"marker-or-tail" | "tail-only"`. The channel-switch `on(key)` effect passes
`"marker-or-tail"`; visibility-return and the resize handler pass
`"tail-only"`. In `"marker-or-tail"` mode the routine reads the RENDERED
frozen divider — a one-shot `listRef.querySelector('[data-testid=
"unread-marker"]')` inside its existing settled-geometry rAF×2 — and
`scrollIntoView({block:"start"})`s it, deriving `atBottom` from the resulting
distance. It reuses the divider node the `rows()` memo already injected (from
the frozen `markerCursorId`); it does NOT recompute the cursor geometry a
second way, and it introduces no `markerRef` (the REV-G H23 stale-ref class
stays structurally dead — the lookup lives and dies in one activation). The
divider's ABSENCE (a fully-read channel, or a not-yet-warm cold switch)
naturally falls to the tail.

**Why this does NOT re-open the #168 send-race.** The race #168 killed was a
SECOND authority (`scrollToActivation`'s marker branch AND the length-effect's
marker branch) fighting the tail-follow after a send. Here (as of the 03a scoping; superseded in part by the 03b completion below):
(1) the length-effect stays TAIL-ONLY — the marker jump is NOT restored there,
only in the switch-scoped `scrollToActivation`; (2) post-send goes through
`lastOwnSend`→`scrollToBottom`, untouched; (3) the cold-mount path is the
`defer`-skipped `on(key)` mount run, so a first-focus-after-login was handled by
the length-effect at the tail; (4) when a switch DOES park on the divider it
sets `atBottom=false` first, so the length-effect's `if (!atBottom()) return`
guard yields and never races the jump back to the tail. One trigger, one scroll
target, no two authorities on the same trigger.

**COMPLETION (2026-07-03b) — vjt's GENERALIZED rule + the 307-race root cause.**

> **vjt's rule (authoritative — supersedes any earlier "fills the viewport"
> wording).** The scroll-landing criterion is a single question: *did a COMMAND
> produce scrollback in THIS window?*
>   - **Yes → SCROLL-TO-BOTTOM.** A send of ANY length is command output → bottom
>     (the short-send caveat is explicitly WITHDRAWN; there is no length
>     condition — this cleanly preserves the #168 send-jump).
>   - **No (pure activation: app-startup / switch / cold-mount, no command
>     output) → UNREAD MARKER** (if unread exists; else bottom).
>   - **Neither (loadMore / loadNewer pagination) → PRESERVE** the operator's
>     scroll position. Never marker, never bottom.
> NOT how much output fills the viewport, NOT how long it is — just "did a
> command emit here." This reverses the #46 cold-mount-tail wontfix (point 3
> above) by vjt's explicit call today.

In the impl this maps cleanly: `lastOwnSend` (an own send to THIS window — the
"command produced current-window scrollback" case) → clears the latch +
`scrollToBottom`; a pure activation → the marker latch; loadMore →
a synchronous latch-clear at the top boundary (below). app-startup / cold-mount
onto a window you left unread now lands on the divider, same as a switch. Extending the marker branch to cold-mount surfaced the
REAL bug behind an intermittent switch failure (`scroll-on-window-switch:307`,
deterministic-red in isolation, `marker +1048`): **the marker jump was a
one-shot that did not survive the NEXT rows recreation.** `<For each={rows()}>`
is ref-keyed and the `rows()` memo rebuilds fresh wrapper objects every
recompute, so EVERY rows change re-creates the list DOM and resets scrollTop to
0 — this is exactly why the length-effect + `scrollToActivation` exist: to
re-establish the scroll position pre-paint (rAF×2) after each recreation. After
a switch parked on the marker (`atBottom=false`), the post-switch catch-up
`refreshScrollback` (selection.ts fires it on an already-loaded re-select) — or
a late read-cursor hydration inserting the divider — recreated the DOM again;
the ONLY re-establish path (the length-effect) was `atBottom`-gated and so
suppressed, stranding the pane at scrollTop 0.

The fix makes the marker jump re-establish exactly like the tail-follow does:
a `markerActivationPending` latch (set by the SWITCH key-effect AND cold-mount
`onMount`, cleared on real operator input or an own send) drives the
length-effect to RE-ASSERT `scrollToActivation("marker-or-tail")` on every rows
recreation while active (`withHide=false` — the rAF×2 corrects pre-paint, so the
intermediate scrollTop=0 is never shown). This does NOT re-open the #168
send-race: the marker re-assert is latch-gated, and `lastOwnSend` CLEARS the
latch before `scrollToBottom`, so a send falls straight through to the
always-bottom authority; a scrolled-up operator clears the latch via the
input gate, after which the plain `atBottom` tail-follow owns live appends.
Visibility-return / resize stay `tail-only` one-shot (their `atBottom=true`
means the tail-follow already re-establishes them — no latch).

**Pagination is excluded from BOTH paths (the cp14-b2 oscillation canary).**
loadMore (scroll-to-top → prepend older rows) and loadNewer (scroll-to-bottom →
append newer) are neither a command nor an activation — they must PRESERVE the
operator's position (loadMore owns a height-delta scrollTop restore). The fix
is in the RE-ASSERT GATE, not in onScroll: the length-effect re-asserts the
marker jump only when `markerActivationPending()` AND a rendered unread divider
EXISTS. With no divider it FALLS THROUGH to the `atBottom` tail-follow, which
resolves both no-marker cases with one rule — an initial cold-mount
(`atBottom=true`) tails; a loadMore prepend after the operator scrolled up
(`atBottom=false`) does nothing, so the height-delta restore preserves position.
A no-marker re-assert would instead TAIL and yank the prepend to the bottom
(cp14-b2 RED at distance 7px). Two REJECTED approaches, both documented so the
oscillation isn't re-explored: (1) a transient `paginating` flag skipping the
length-effect — Solid fires the effect for the prepend merge AFTER the scroll
handler + its promise `.finally`, so the flag is already reset when the effect
runs (RED, tail); (2) synchronously clearing the latch in the loadMore block —
the ref-keyed `<For>` reset to scrollTop 0 on a SWITCH fires `onScroll` at the
top boundary during the activation's own transient, clearing the latch before
the marker jump settles and re-stranding 307 at +1048 (RED). The marker-EXISTS
gate sidesteps both: a read-channel prepend has no divider (fall through,
preserve), and a real marker activation keeps re-asserting until the operator
takes over. `cp14-b2` scenario 2 is the canary. (The oscillation the prior #168
v2 broke — no blind trading: the marker, send→bottom, and loadMore-preserve
specs are gated together.)

**Freeze contract unchanged.** The divider still derives from the frozen
`markerCursorId` snapshot (2026-06-08) and re-latches on focus acquisition; the
switch jump is a DISPLAY-side scroll to that frozen row, not a cursor write
(the programmatic `scrollIntoView` fires no operator-input event, so the
scroll-settle gate does not advance the cursor — the divider survives the
jump). Read-state stays server-owned.

**Tests (03a + 03b).** `scroll-on-window-switch.spec.ts` scenario 3 is the
SWITCH→marker RED→GREEN (seed mid-page cursor on `#bofh`, focus `$server` first
so #bofh warms via the eager join-ok `refreshScrollback`, then click #bofh — a
real key-change SWITCH; asserts marker near the top + a follow-on SEND→bottom).
03b makes it deterministic (was flaky-red in isolation, `+1048`) and FLIPS the
cold-mount specs to the new behavior: `scroll-on-window-switch` scenario 2 and
`cp14-b1` scenario 2 now assert cold-mount JUMPS to the marker (+ a send→bottom
leg for the gate); a new `scroll-on-window-switch` sibling repeats it after a
full `page.reload()` (genuine app-startup); `issue168-scroll-authority`'s
"paged-up → send" test flips its cold-mount premise (now lands on the marker)
but keeps the post-send→bottom assertion. `issue168-scroll-authority` test 1
(unread present → send→bottom) is post-send-only, untouched. The load-bearing
non-e2e gate stays the swipe/scroll unit tests for #123; this #168 zone is
DOM-scroll behavior, e2e-only.

**Deploy.** 03a shipped HOT via `deploy-m42.sh --cic` the same day (vjt
override, riding #171's undeployed cic admin-rename). 03b (this completion) is
BUILD-DEFER-NIGHT: it batches with #123 into the night COLD+`--cic` window
(deploy was HELD while main carried the device-confirmed regressions — nothing
ships until main is verified green and the orchestrator re-schedules).

### 2026-07-03 — #123: boundary-claim the compose swipe so slow drags scroll the textarea

**The hijack.** `ComposeBox`'s stock-keyboard swipe affordances (swipe UP =
older history, DOWN = newer, RIGHT = tab-complete) were gated on DISPLACEMENT
only. `onTouchMove` claimed the gesture the instant `dragAxis` cleared an 8px
slop and immediately `preventDefault`ed — killing native scroll for ANY drag
past 8px, fast or slow — and `onTouchEnd` dispatched purely on
`swipeDirection`'s 40px floor. So a slow, deliberate vertical drag meant to
SCROLL a long draft (the textarea is `rows=1`, `resize:none` → overflow scrolls
internally) got hijacked into history recall, and reviewing the top of a long
draft on touch was impossible (#123, vjt-filed P1).

**Both halves were the bug.** The CSS half compounded it: `.compose-box
textarea` was `touch-action: none` (UX-3 UNDEC R3, 2026-06-24 — added to stop a
drag from driving iOS's chrome gesture back when the textarea was treated as
"chrome, not a scroll container"). `none` blocks ALL pan, so even with the JS
fixed the slow drag could not scroll natively. The fix needs BOTH: JS must stop
`preventDefault`ing slow drags AND the CSS must permit vertical pan.

**First attempt — velocity-claim — and why it was REWORKED the same day.**
The initial fix made VELOCITY the mid-drag claim discriminator: `onTouchMove`
claimed + `preventDefault`ed only if `isFastSwipe(start, point, now−startTime)`
held at the first 8px-slop crossing, else ABANDONED (`swipeStart` nulled) to
native scroll. On-device (vjt dogfood) it regressed BOTH ways — a double
failure. (1) A real flick starts from rest and ACCELERATES; at the 8px mark it
is still on the ramp and reads BELOW 0.3px/ms, so a genuine swipe-up was
abandoned — irrevocably — and never recalled. (2) iOS COALESCES touchmoves; a
deliberate scroll-drag's first delivered move can jump ~20px in one frame and
read ABOVE 0.3px/ms, so it got claimed + `preventDefault`ed and the scroll was
suppressed. Same root: instantaneous velocity sampled at the ramp, at the wrong
instant, locked in forever — it tracks iOS event delivery, not human intent.
(The old e2e stayed green because `slowMs:0` synthetic events fire same-tick →
`elapsedMs<=0` → `isFastSwipe` true unconditionally; the ramp is never
exercised. Hollow vs the device — the `feedback_playwright_webkit_not_ios_scroll`
trap.)

**The rework — BOUNDARY claim + touchend-only velocity.** The claim decision
moves off velocity onto the textarea's native-scroll BOUNDARY, sampled at
touchstart. `claimAxis(start, current, boundary)` in `lib/swipe.ts` claims only
a drag native scroll CANNOT consume: any horizontal drag (pan-x is blocked by
`touch-action`, so it would only select text → tab-complete), or a vertical
drag PAST an edge — up while `atTop`, down while `atBottom`. A short,
non-overflowing draft is at BOTH edges, so its vertical flicks always claim (the
stock-keyboard history affordance). A vertical drag WITH scroll room returns
null → the caller never `preventDefault`s → native `pan-y` scrolls the draft.
Model: scroll to the edge first, THEN a second flick recalls. Velocity is now
judged ONCE, at touchend, over the WHOLE gesture (`gestureAction` →
`isFastSwipe(start, end, now−startTime)`), where displacement + elapsed are both
large and reliable — a claimed drag that settled slowly is not a recall. The 8px
slop (`dragAxis`) and 40px floor (`swipeDirection`) still bound displacement.
`ComposeBox` reads the boundary via a stored textarea ref at touchstart and
threads `performance.now()` for the touchend gate (browser time is fine in cic
runtime — the `Date.now` ban is a workflow-script rule).

**Threshold.** `SWIPE_MIN_VELOCITY_PX_PER_MS = 0.3` (~300px/s), applied at
touchend: above an empirical deliberate read-drag (<~150px/s), below a natural
flick (>~500px/s). Velocity FEEL is a device call — a defensible default, not a
measured optimum; vjt calibrates on-device post-ship. It is no longer the CLAIM
discriminator (the boundary is), so a mis-judged velocity can at worst drop a
recall — it can never abandon a scroll or hijack one.

**CSS.** `.compose-box textarea` → `touch-action: pan-y` +
`overscroll-behavior: contain` (the latter stops a past-the-limit scroll
chaining to the shell / chrome, same guard as `.scrollback` and the UX-5 BO
pan-y surfaces). `pan-y` re-enables vertical native scroll while still blocking
pan-x / zoom / the double-drag chrome reveal the old `none` was guarding
against. KNOWN device-test item: a SHORT non-overflowing draft at `pan-y` may
still fall through to iOS chrome-reveal on a slow vertical drag (the
`.scrollback` `none`↔`pan-y` overflow-toggle case) — accepted; re-open with a
JS overflow-toggle only if it bites on-device.

**Why the e2e can't be the real gate (and what it guards instead).** Actual
pixel-scroll and velocity feel are NOT webkit-reproducible (Playwright webkit ≠
iOS scroll physics) and synthetic `TouchEvent`s don't drive native scroll at
all, so the load-bearing gates are the `lib/swipe.ts` UNIT tests (jsdom, pure
fns): `claimAxis` (boundary claim: at-edge vertical + any horizontal claim;
vertical-with-room → native; velocity-blind) and `gestureAction` (touchend
dispatch: fast up/down/right → recall/tab; slow release → null; 40px floor).
The e2es (`issue123-compose-swipe-velocity.spec.ts`) guard the WIRING + CSS:
(1) a chromium touchend pair (fast swipe-up recalls, slow 350ms drag doesn't —
only jointly green if the touchend gate distinguishes); (2) a chromium BOUNDARY
probe that reads `event.defaultPrevented` on a dispatched touchmove (a
JS-level signal independent of `touch-action`, so deterministic without native
scroll): a mid-scroll up-drag is NOT prevented (native scroll owns it, no
hijack, draft unchanged) while an at-top up-drag IS prevented + a fast flick
recalls; (3) a `@webkit` CSS-contract assertion (computed `touch-action: pan-y`
+ `overscroll-behavior: contain` on the real iPhone-15 target, ux-6-a pattern;
reverting to `none` reds it). DEVICE test = vjt post-ship.

**Deploy.** cic-only. BUILD-DEFER-NIGHT: rides the same night COLD+`--cic`
batch as #171 — a daytime `--cic` would rebuild cic from main HEAD, which still
carries #171's undeployed admin-rename expecting the not-yet-deployed
`max_per_ip` server API.

### 2026-07-03 — #79: let scrollback selection start with the keyboard open (keep-keyboard skips selectable surfaces)

> **SUPERSEDED 2026-07-04 (see next entry).** This v1 fix — an *unconditional*
> skip of the preventDefault on `.scrollback` — was device-tested FAILING by
> vjt: it did not deliver long-press selection (the freed focus-shift closed the
> keyboard mid-press, and the keyboard-close reflow tore the long-press down
> before iOS committed a selection), and its only observed effect was that a
> plain TAP now closed the keyboard. vjt chose to KEEP tap-to-close and gate the
> preventDefault on press DURATION instead. The v1 mechanism below is history;
> the shipped behaviour is the 2026-07-04 rework.

vjt iPhone dogfood: tap-hold text selection in the scrollback works ONLY with
the on-screen keyboard CLOSED. Keyboard OPEN (compose focused) → long-pressing a
scrollback message does nothing, no selection handles. Closing the keyboard
first is a manual PRE-step no user should need.

**Root cause — the unfinished half of Dispatch-1.** The 2026-06-11 "text
selection dead" arc (above) had two stacked causes: (a) desktop, keepKeyboard's
document-level capture mousedown `preventDefault` cancelling the
selection-drag start — fixed by gating the handler on `isIos()`; (b) iOS, the
blanket `html.is-ios { user-select: none }` — fixed by re-enabling
`user-select: text` on `.scrollback` / `.topic-modal-text`. But (a)'s gate
scoped the fix to *desktop*: on iOS the handler STILL preventDefaults every
non-input mousedown while compose is focused — including on the very
`.scrollback` surface (b) had just marked selectable. CSS granted
`user-select: text`; the JS then cancelled the drag before it could start. The
two fixes half-passed each other. The 2026-06-11 note even flagged this class
("iPad-with-trackpad stays imperfect: a hardware-pointer drag still gets
preventDefaulted while compose is focused") but filed it under a niche edge —
#79 is the same defect on the mainline touch path.

**Fix.** keepKeyboard's `handleMouseDown` gains one guard before the
`preventDefault`: skip it when the mousedown target sits on a selectable-text
surface. The allowlist is the SAME set the CSS re-enables — `.scrollback`,
`.topic-modal-text` — MINUS the re-excluded control `.scrollback-invite-join`
(a `[Join]` button inside scrollback; a tap there is a control, so
keep-keyboard MUST still fire). Structural DOM test (`el.closest(...)`), not
`getComputedStyle(...).userSelect`: the computed-style approach is elegant but
jsdom does not resolve inherited `user-select` from a stylesheet, so it isn't
unit-testable; the structural allowlist is. keep-keyboard is UNCHANGED for real
chrome (tabs, arrows, buttons) — a tap there still pins the keyboard.

**Two-site allowlist — deliberate duplication.** The selectable-surface set now
lives in BOTH `default.css` (the `user-select: text` re-enable) and
`keepKeyboard.ts` (`SELECTABLE_TEXT_SURFACES` / `_EXCLUDE`). CSS can't export a
TS constant, so this is an unavoidable two-site policy — same shape as the
nick-fold SQL/fragment invariant. Both sites carry a cross-referencing comment
("selectable-text policy point — keep in sync"): a future copyable surface must
be added to both, or a surface marked selectable by CSS stays un-drag-startable
while compose is focused (or vice-versa). Kept small + named.

**Accepted UX.** Starting a selection may shift focus / close the keyboard as a
SIDE EFFECT — that satisfies the spec (the prohibition was on closing the
keyboard as a manual PRE-step, not as a natural consequence of the gesture).
Keeping the keyboard open AND selecting would need a materially heavier
mechanism (on-screen-keyboard-visibility detection — the UX-6-D tar pit); not
built without a vjt call. vjt device-judges the feel post-ship.

**Why the e2e is webkit-contract-only.** Real iOS long-press selection
(magnifier, handles, momentum) is NOT reproducible on Playwright
webkit-iphone-15 (feedback_playwright_webkit_not_ios_scroll). The load-bearing
gate is the keepKeyboard UNIT test (jsdom, RED→GREEN: a mousedown inside
`div.scrollback` / `.topic-modal-text` is now NOT prevented; on
`.scrollback-invite-join` and generic chrome it still IS; the misleading old
"scrollback message text" case — a bare span NOT inside `.scrollback` that
asserted prevented=true — was relabelled honest generic chrome, since it never
was inside a selectable surface). `issue79-ios-select-keyboard-open.spec.ts`
(`@webkit`) is the WIRING guard: on the live is-ios surface with compose
focused it dispatches a cancelable mousedown on a real `.scrollback` line
(`defaultPrevented === false`) and on the send button (`=== true`) — a
mutually-validating pair, only jointly green if the guard actually
discriminates; reverting the fix reds the scrollback half. DEVICE test (handles
actually appearing) = vjt post-ship.

**Deploy.** cic-only. BUILD-DEFER-NIGHT: appends to the same night COLD+`--cic`
batch as #171 + #123 — a daytime `--cic` would rebuild cic from main HEAD,
which still carries #171's undeployed admin-rename expecting the not-yet-deployed
`max_per_ip` server API.

### 2026-07-03 — #172: long-press to confirm window close (kill spurious taps; keep the bottom bar)

**Symptom.** A bare tap on the BottomBar window-picker close `×` closed a
window instantly. On mobile that made a fat-finger tap enough to lose a window
the user never meant to close (spurious closures). Owner direction: KEEP the
bottom bar (some users prefer it), make closing DELIBERATE — require a longer
press/hold; a short tap must not close.

**Cause.** All three close verbs — `closeChannelWindow`, `closeQueryWindow`,
`disconnectNetwork` (`lib/windowClose.ts`) — were wired directly to the `×`
button's `onClick` on both surfaces (`BottomBar.tsx` mobile, `Sidebar.tsx`
desktop). A single click = an instant close, with no deliberation gate.

**Placement (the crux — challenge the spec).** The issue suggested the gate
"likely lives in/around `windowClose.ts` so both surfaces are covered." The
instinct (one shared point) is right; the literal placement is wrong.
`windowClose.*` is a synchronous STATE-PUSH layer with no pointer/event/timer
context — stuffing a `setTimeout` + pointer tracking into `closeChannelWindow`
would be a boundary violation (a gesture timer is a UI-interaction concern, not
a state-push concern) and untestable. So the shared point is at the
button-INTERACTION layer instead: a new pure gesture core + thin Solid handler
factory `lib/holdToClose.ts`, wrapped by one `<CloseButton>` component that
BOTH surfaces attach to; it calls the existing `windowClose.*` verb ON CONFIRM.
`windowClose.ts` stays a pure state-push verb, unchanged. This is "reuse the
verbs (windowClose.*), not the nouns" and genuinely covers both surfaces via
one helper without the boundary violation. The pure core
(`HoldToCloseGesture`) mirrors `keyboard/gesture.ts` `KeyGesture`: no DOM, no
timer (the factory owns the `setTimeout`), unit-testable with plain method
calls.

**Touch-gated, not all-pointers (the key UX decision).** The spurious-close
problem is a mobile fat-finger problem; a desktop MOUSE click on `×` is
pixel-precise and already deliberate. Forcing desktop users to hold 500ms
would be a regression. So the hold applies ONLY to touch/pen
(`e.pointerType !== "mouse"`); a mouse click — and a keyboard Enter/Space —
confirms instantly via the native `onClick`. This lets the SAME `<CloseButton>`
attach to both surfaces safely: Sidebar-on-desktop mouse stays instant,
Sidebar-on-tablet is held, consistent. The gate keys off `pointerType`, not
the device — so the e2e drives it identically on both the chromium-desktop
(`.sidebar-close`) and webkit-iPhone (`.bottom-bar-close`) surfaces with
synthetic touch pointer events.

**Synthetic-click swallow.** A touch tap/hold fires a trailing synthetic
`click` after `pointerup`. If left alone it would confirm behind the gesture's
back (defeating the whole fix). The factory sets a `swallowClick` flag on any
gated (touch/pen) `pointerdown` and eats the next `click`; a mouse/keyboard
click is never preceded by a gated pointerdown, so it flows through. The flag
resets on every `pointerdown` (a mouse press clears any stale value), so a
persistent button (the registered-user disconnect `×`, which survives a park)
can't get wedged.

**Which verbs are gated.** All of them, via `<CloseButton>`: channel close,
query close, AND the network-header `disconnectNetwork` — the most destructive
(visitor `quitAll` = park-all + logout), where an accidental nuke is worse than
a channel-close. The Sidebar pseudo-row dismiss (`handleClosePseudo` →
`setParted`) rides `<CloseButton>` too, for TOTAL consistency (one `×` code
path, no half-migrated second pattern) — though it's a local projection clear
on a desktop-only surface the mobile fat-finger never reaches, so the touch
gate is a no-op there. Distinct from `InlineConfirmButton` (the two-click
archive-delete affordance) — that stays; #172 is specifically the owner's
preferred HOLD approach, not a confirm affordance.

**Constants (FEEL knobs).** `HOLD_TO_CLOSE_MS = 500` — longer than the 300ms
keyboard-variations `LONG_PRESS_MS` because a destructive confirm wants more
deliberation; a device-calibration default vjt tunes on-device post-ship. Slop
reuses `keyboard/gesture` `MOVE_SLOP_PX` (~10px) — a finger that drifts past it
is scrolling, not confirming, so the hold cancels. `pointercancel`/
`pointerleave` (iOS steals the gesture for a scroll) also cancel. Pointer
events (not `touch*`) sidestep Solid's passive-touch delegation
(project_solid_touch_passive_delegation); `touch-action: none` on the close
buttons (mirroring `.kbd-key`) stops a hold being stolen by the bottom bar's
`pan-x` scroll.

**Short-tap affordance.** A short tap silently no-ops (the requirement is only
"short tap doesn't close"). To signal the hold IS working, a `.close-holding`
class tints the `×` warning-red + grows it slightly WHILE a touch hold is in
progress (never for mouse). Immediate, not a timed fill, so the 500ms constant
isn't duplicated in CSS; a timed progress fill is possible on-device polish.

**Why the e2e is a timing/wiring guard.** Playwright webkit-iPhone-15 does NOT
reproduce real iOS long-press FEEL (magnifier/haptics)
(feedback_playwright_webkit_not_ios_scroll), but it CAN drive synthetic pointer
timing. The load-bearing gate is the UNIT layer: the pure-core test
(`HoldToCloseGesture`, method-level) + the BottomBar component test (RED→GREEN:
a short touch tap no longer calls the close verb; a held press does).
`x172-longpress-close-confirm.spec.ts` (chromium + `@webkit`) is the WIRING
guard — a mutually-validating pair per surface: QUICK press → window still
present, SUSTAINED hold → window closed; reverting the fix reds the "quick
press ≠ close" half. Real long-press feel = vjt device test post-ship.

**Deploy.** cic-only. BUILD-DEFER-NIGHT: appends to the same night COLD+`--cic`
batch as #171 + #123 + #79 — a daytime `--cic` would rebuild cic from main
HEAD, which still carries #171's undeployed admin-rename expecting the
not-yet-deployed `max_per_ip` server API.

## 2026-07-03 — #123 (attempt 3): the compose swipe was a nested-scroll boundary handoff, not a velocity/claim heuristic

Two prior fixes shipped and both failed on vjt's device the same way. The
velocity-gate (659aa06) sampled speed on the acceleration ramp and abandoned
irrevocably. The boundary-claim rework (4e828a2) keyed the mid-drag claim off
the textarea's scroll edge instead of speed — the right idea, wrong mechanics.
On device it presented as: **the swipe gesture fires only when the textarea's
`scrollTop === 0`; above that, the textarea eats the drag** — and a
"double-swipe" where the first drag scrolls the textarea to its edge and only a
second drag fires the gesture.

**Root cause — two bugs, both in the claim path.**

1. **Frozen touchstart snapshot.** The boundary was sampled ONCE in
   `onTouchStart` (`startBoundary = scrollBoundary(textareaEl)`) and
   `claimAxis` read that snapshot for the whole touch. So if the finger landed
   while `scrollTop > 0`, the claim decision never re-read the boundary even
   after the textarea native-scrolled to its edge DURING the same touch. The
   gesture could only ever hand off from an already-at-edge start — hence
   "works only at scrollTop 0" and the "double-swipe" (the 2nd touch starts
   settled at the edge). The design comment even codified this as intent
   ("scroll to the edge first, THEN a second flick recalls"). That was the bug,
   not the contract.

2. **Inverted direction→edge mapping.** `claimAxis` claimed a finger-UP drag at
   `atTop` and a finger-DOWN drag at `atBottom`. Physically backwards: screen y
   grows downward, so a finger-UP drag scrolls the content up — `scrollTop`
   INCREASES — until the **bottom** edge; a finger-DOWN drag decreases
   `scrollTop` until the **top** edge. "up while atTop" is unreachable by a
   continuous drag on an overflowing draft (the moment you drag up you leave
   atTop), so it only ever claimed on a non-overflowing draft (atTop && atBottom
   both true) — which is exactly the short-draft case that appeared to work.

**Fix — the standard nested-scroll / bottom-sheet handoff.** The textarea is
the INNER scroll surface; the swipe is the OUTER gesture. The inner scroll owns
the vertical drag WHILE it has room in the drag direction; the instant it hits
its wall (finger-up → `atBottom`, finger-down → `atTop`) it cedes the rest of
THIS touch to the gesture — no second touch. Mechanically: read the boundary
LIVE on every `touchmove` (not a touchstart snapshot) and pass it to
`claimAxis`; correct the direction→edge mapping. `claimAxis` still returns null
(hands-off, native `pan-y` scrolls) while there's room, so a deliberate
scroll-drag is never hijacked.

**Why no re-baseline of the gesture anchor at handoff.** Tempting to reset
`swipeStart` to the boundary-crossing point so the flick is measured only past
the edge. Rejected: the velocity gate already measures over the WHOLE gesture at
touchend (touchstart→touchend endpoints), which is coalescing-robust — the
attempt-1 failure was mid-drag velocity sampling, and re-baselining reintroduces
that fragility (a coalesced touchmove at the boundary would swallow most of the
flick's displacement). Keeping the whole-gesture measurement means a brisk
continuous drag hands off and fires; a slow read-drag that merely grazes the
edge stays below the flick threshold and correctly does nothing.

**iOS unknown + on-device evidence.** Whether iOS honours a `touchmove`
`preventDefault` mid-touch once `pan-y` has begun compositor-scrolling is not
provable in webkit-playwright (feedback_playwright_webkit_not_ios_scroll). With
`overscroll-behavior: contain` there's no rubber-band to fight at the edge, so
the claim firing (recall) is the win even if the visual suppression is partial.
To get the real numbers, `ComposeBox` now emits per-touch telemetry
(`lib/diagLog.ts` ring buffer → `DiagFloat`, `cic_diag` flag-gated): touchstart
geometry, the claim decision (direction / live boundary / scrollTop), the
touchend action. Free no-op with the flag off.

**Gate reality.** The e2e (`issue123-compose-swipe-velocity.spec.ts`) asserts
the handoff LOGIC deterministically via `event.defaultPrevented` on synthetic
touchmoves — both directions, and a LIVE-read regression guard that changes
`scrollTop` BETWEEN touchstart and touchmove (a frozen snapshot fails it). The
prior test asserted the inverted "up-drag at scrollTop 0 claims" — that was
encoding the bug, so it was rewritten, not preserved. e2e is necessary, NOT
sufficient: the ship gate is vjt's device dogfood. #123 stays OPEN until then.

**Deploy.** cic-only. BUILD-DEFER-NIGHT: rides the same night COLD+`--cic`
batch as #171 + #79 + #172 — a daytime `--cic` would rebuild cic from main
HEAD, which still carries #171's undeployed admin-rename expecting the
not-yet-deployed `max_per_ip` server API. This attempt-3 supersedes the
attempt-2 (4e828a2) cic already queued in that batch; no separate hot ship.
Device dogfood happens once the batch lands.

### 2026-07-04 — #79 rework: tap-to-close vs long-press-select, split by press DURATION

The 2026-07-03 v1 (unconditional preventDefault-skip on `.scrollback`) failed on
device: a plain TAP on a scrollback message now closed the keyboard (vjt liked
this and asked to KEEP it), but a tap-HOLD still did nothing — no selection
handles. Root cause of the still-dead selection with the skip already in place:
freeing the mousedown default let the focus-shift proceed, which on iOS
dismisses the keyboard; the keyboard-close reflow moves the pressed text out
from under the finger before iOS's ~500ms long-press commits, so the selection
never lands. (Three-state proof: keyboard CLOSED → selection works — no reflow,
the keyboard is already down; keyboard OPEN + v0 unconditional preventDefault →
dead — the preventDefault itself cancels the drag; keyboard OPEN + v1 skip →
dead — the reflow tears it down on release.)

**The conflict is real and lives in TIME.** Two behaviours are wanted on the
SAME surface: a short tap must close the keyboard, a long-press must select. A
single mousedown-time preventDefault decision cannot tell them apart — that
distinction only exists over elapsed time. vjt was presented the trade-off and
chose **Option 2: a long-press threshold** (accepting the small feel change,
device-judged post-ship; the deeper iOS-selection unknown — whether
`touch-action: none` on a non-overflowing `.scrollback` also blocks the gesture
— was explicitly deferred to that dogfood, not pre-probed).

**Mechanism — no timer, no async.** iOS dispatches the compat `mousedown` on
finger-RELEASE, so at mousedown time the held duration is already known:
`performance.now()` at the document `touchstart` (a new passive capture listener
stamps it) subtracted from `performance.now()` in the mousedown handler. On a
selectable surface: `held < LONG_PRESS_MS` (500) is a TAP → leave the default →
focus shift → keyboard dismisses (tap-to-close KEPT); `held >= 500` is a
LONG-PRESS → `preventDefault` the focus-shift → keyboard stays up → no reflow →
the selection iOS began survives. 500ms matches iOS's own long-press convention
— below it iOS would not have started a selection anyway, so closing the
keyboard there is never wrong. Chrome (tabs, arrows, the send button) is
UNCHANGED: not a selectable surface → preventDefault fires regardless of
duration (UX-3 preserve). No `pointerdown`, no `touch-action` change (that
regression risk stays out of scope; if the deferred `touch-action` unknown bites
a non-overflowing channel on device, that is a separate follow-up).

**Two-site allowlist still holds.** WHICH surfaces are duration-gated
(`.scrollback` / `.topic-modal-text`, minus `.scrollback-invite-join`) is
unchanged from v1 and still duplicated in `default.css` (the `user-select: text`
re-enable, load-bearing — selection needs it) and `keepKeyboard.ts`
(`SELECTABLE_TEXT_SURFACES`). Only the ACTION within them changed (skip →
duration-gate); the sync invariant is intact, both comments updated.

**On-device evidence.** A `cic_diag`-gated `diagPush` on the scrollback-branch
decision (`held=Xms → HOLD keep+select | tap close-kbd`) surfaces in DiagFloat so
vjt can confirm on-device that his holds cross the threshold — the observability
for the post-ship dogfood that is now the SOLE real gate (webkit playwright is
blind to the actual selection handles; `feedback_playwright_webkit_not_ios_scroll`).

**e2e.** `issue79-ios-select-keyboard-open.spec.ts` (`@webkit`, needs `is-ios`)
now asserts the three-way discrimination via synthetic dispatch + a real
wall-clock hold (JS-level facts, not touch physics): short tap not prevented,
long-press prevented, chrome prevented — only jointly green if the gate
discriminates. Necessary, NOT sufficient. The keepKeyboard UNIT test carries the
RED→GREEN boundary cases (short/long/threshold/exclude). #79 stays OPEN until
vjt device-confirms.

**Deploy.** cic-only, HOT `--cic` (prod server+cic both at ae2d34a — the
BUILD-DEFER-NIGHT coupling from the #171 batch cleared once that batch landed, so
a daytime `--cic` no longer rebuilds an undeployed-server dependency).

## 2026-07-04 — #119: unified stacked error-banner region (WS + connectivity + bundle-refresh, no overlap)

**The bug.** cic rendered its top status banners as independent components,
each `position: fixed; top: 0; left/right: 0`. `SocketHealthBanner` (WS health,
z=1000) and `BundleRefreshBanner` (new-bundle prompt, z=999) both pinned to the
same top coordinate. A `position: fixed` element does NOT participate in normal
flow, so the old CSS comment's claim that "document order handles stacking" was
false — when both fired they OVERLAPPED (the higher z-index simply painted over
the other). #120 (service-worker registration failure) would have added a third
colliding banner.

**The fix — ONE owner + a DERIVED typed registry.** `ErrorBanners.tsx` is the
sole owner: a single `position: fixed; top: 0` **flex-column** container whose
children (`BannerSlot`) live in normal flow INSIDE it, so N banners stack
vertically without overlap. State is derived, never stored: `errorBanners.ts
activeBanners()` reads the existing source signals (`socketHealth`,
`connectivity`, `bundleHash`) and projects the active ones into typed entries —
no parallel store, no housekeeping (each source stays the single owner of its
state). `source` and `severity` are closed-set string-literal unions with
runtime guards + a `sanitizeBanners` boundary that drops anything outside the
set (CLAUDE.md "atoms or @type union, never untyped strings"). The 20% that
differs between sources is modelled as entry FIELDS, not a type flag: WS +
connectivity are derived-and-auto-clearing; bundle-refresh carries an
`actionHint` (reload) and persists until reload. **#120 slots in as ONE new
`BannerSource` member + one `activeBanners()` push — the enum + the derivation
are the whole seam; #120 is NOT implemented here.**

**Deleted a false cause (vjt refinement 1).** The old WS banner's
`origin_rejected` arm guessed "your origin is most likely misconfigured" on a
1006 abnormal close. That is FALSE: a 1006 with no server reason most often
means there is simply no connection, not a `check_origin` misconfig. Showing a
wrong cause is worse than showing none — so `classifyFailure`,
`SocketFailureKind`, and the now-unused `browserOrigin` are DELETED. The WS
entry now only ever surfaces the real close code + any reason string the browser
exposed (the honest "generic" arm).

**Honest connectivity source (vjt refinement 1).** `connectivity.ts` tracks
`navigator.onLine` + the `online`/`offline` window events. When the device is
offline THAT is the true message the 1006 could only guess at — a typed
`connectivity` source in the same stacked region, replacing the deleted origin
heuristic.

**Connectivity-driven reconnect (vjt refinement 2) — phoenix native vs our
delta.** phoenix.js's `Socket` ALREADY auto-reconnects natively: on an
unexpected close/error it schedules `connect()` via its `reconnectTimer` using
the default `reconnectAfterMs` backoff
(`[10,50,100,150,200,250,500,1000,2000]` then 5000ms steady), and every joined
Channel auto-rejoins on the new socket. We construct the Socket with NO
`reconnectAfterMs` override, so that default is live, and we reimplement NONE of
it. The DELTA phoenix does not give: it never listens to the browser's
`online`/`offline` events. So `socket.ts` adds two window listeners — `offline`
→ `disconnect()` (halt futile retries on a dead network + reset the backoff
timer); `online` → `disconnect()`+`connect()` to force an IMMEDIATE reconnect
rather than waiting out the pending native backoff (phoenix's own connect path
re-evaluates `params()` and auto-rejoins every channel). The kick is a pure
`kickReconnect`/`haltForOffline(ReconnectableSocket | null)` seam so it is
unit-testable with a fake socket, no live WS server. Both no-op when no socket
exists yet (logged out / lazy pre-join). `connectivity.ts` owns only the
UI-facing signal; `socket.ts` owns the reconnect — the two just observe the same
two events independently (no cross-import).

**Preserved.** The bundle-refresh flow (banner on new-bundle broadcast +
`performRefresh` SW-update/cache-purge/reload chain) is UNCHANGED — it became a
registry entry with an `actionHint`, not a regressed text line. Its two e2e
specs (`bundle-refresh-banner`, `bundle-refresh-real-swap`) stay green with only
a selector migration (`.bundle-refresh-banner` → `.error-banner[data-source=
"bundle-refresh"]`).

**Tests.** Unit: `errorBanners` (derivation + closed-set sanitize/guards),
`ErrorBanners` (N sources → N distinct stacked slots as children of one
container + auto-clear), `BannerSlot` (message/severity-role/actionHint by
injection), `connectivity` (online/offline signal), `socketReconnect`
(kick/halt on a fake socket). The bundle-refresh source can't be driven in jsdom
(`bootBundleHash` needs a real build's `<script src="/assets/index-…">` tag), so
those unit tests mock ONLY that DOM-derived boundary. e2e
(`error-banners.spec.ts`, anti-hollow-green): WS-down AND bundle-mismatch forced
SIMULTANEOUSLY, asserting BOTH slots visible AND their bounding boxes do not
intersect (the overlap regression); plus WS generic-close-code, connectivity
offline/online, and auto-dismiss.

**Deploy.** cic-only, HOT `--cic`. `gen_wire_types --check` stays green — no
wire touch. #119 stays OPEN until vjt device-confirms; #120 dispatched next.

## 2026-07-04 — #120: surface service-worker registration failure in the #119 stacked error region

**The bug.** `cicchetto/src/main.tsx` called `registerSW()` (vite-plugin-pwa /
Workbox) **bare** — no options object, zero callbacks. A service-worker
registration failure was therefore SWALLOWED SILENTLY: it reached only the
browser console (vite-pwa's own log), never the UI. SW-dependent features (push
notifications, offline shell, icon badge) then silently don't work with no
in-app cause a user or operator can see. That silent swallow at a boundary is
exactly the CLAUDE.md "no silent-swallow" anti-pattern. It surfaced verifying
iOS Safari SW registration on prod (#94), where the only detection paths were
Web Inspector console or "absence of SW features."

**The fix — extend the #119 seam, don't build a new one.** #119 promised #120
would slot in as ONE new `BannerSource` member + one `activeBanners()` push, and
it did, verbatim:

  * NEW source signal `cicchetto/src/lib/swRegistration.ts` — a module-singleton
    Solid signal mirroring `socketHealth.ts` / `connectivity.ts` EXACTLY
    (record fns + `shouldShowSwRegBanner()` predicate + `__resetForTests` seam +
    a `window.__cic_swRegistration` e2e/devtools hook). It is the SINGLE owner of
    the SW-registration state (derive-don't-duplicate); `errorBanners.ts` reads
    it, never copies it.
  * `main.tsx` now calls `registerSW({ onRegisterError, onRegisteredSW })`.
    `onRegisterError` feeds the signal → the banner. `onRegisteredSW` (the
    non-deprecated success callback — `onRegistered` the issue named is
    `@deprecated` and only fires when `onRegisteredSW` is absent) records the
    healthy outcome for devtools/#181 only, NO banner. Registration TIMING is
    unchanged — still the default deferred-until-`window.load` behaviour; only
    observability was added.
  * `errorBanners.ts` gained ONE `BANNER_SOURCES` member (`sw-registration`,
    hyphen form matching `bundle-refresh`) and ONE `activeBanners()` push gated
    on `shouldShowSwRegBanner()`, ordered `warn` after the two error sources and
    before the info bundle prompt (deterministic error→warn→info stacking). The
    closed-set guards + `sanitizeBanners` accept it for free; unknown sources
    (incl. the near-miss `sw_registration` / `service-worker`) still rejected.

**Severity `warn`, no actionHint.** The app keeps working; only PWA capability
is degraded — so `warn`, not `error`. It's a diagnostic, not a user action, so
no reload/retry button (vite-plugin-pwa exposes no clean re-register anyway; a
reload re-attempts). The error surface is STICKY: unlike connectivity's `online`
event or socketHealth's clean-open reset, nothing clears it for the page
lifetime — it only clears on an explicit reset (tests) or a later successful
registration (won't happen for the same page).

**The #181 diagnostic lever (the load-bearing non-obvious constraint).** The
signal captures the ERROR DETAIL — `{ name, message }` normalized from the
`onRegisterError` Error/DOMException — NOT a boolean. The push-notification
cluster (#181) will need to know WHY SW registration failed; it reads that
detail programmatically via the `swRegistration` accessor / the
`window.__cic_swRegistration` hook. The banner message is merely the human view
of the same captured detail. A boolean or a lossy one-liner would NOT deliver
the lever, so both the banner text and the signal carry name + message.

**Tests.** Unit: `swRegistration` (captures name+message from an Error, a plain
object, and a bare string; predicate flips; sticky-until-reset; success clears);
`errorBanners` (the derivation emits the `warn` entry with the captured detail,
the closed set accepts `sw-registration` and rejects near-misses, 4-source
stack + error→warn→info order). Unlike bundle-refresh, the signal is jsdom-
driveable via its record fn — no mock needed. e2e (`error-banners.spec.ts`,
extending #119's anti-hollow-green spec): drive `__cic_swRegistration.recordError`
→ assert the `[data-source="sw-registration"]` slot is visible AND contains the
error name+message AND the hook exposes the same detail; plus a second no-overlap
stacking proof (WS + sw-registration, bounding boxes don't intersect).

**Deploy.** cic-only, HOT `--cic`. `gen_wire_types --check` stays green — 100%
client state, no wire touch. #120 stays OPEN until vjt eyeball-confirms.

---

## 2026-07-04 — #181: push subscription survives an SW-swap re-subscribe; ghost rows superseded on re-subscribe (NOT prune-on-410)

**Symptom (live iOS debug, vjt + morph, 2 devices).** Push "silently
re-disables": the in-app toggle reads OFF and delivery stops; re-enabling
re-subscribes and restores it — until it drops again. Second symptom
(server): the device list shows a device as *subscribed* that in reality
receives no push (ghost).

**Evidence-first, on the LIVE prod node (read-only rpc + logs).** The
brief handed down a two-part diagnosis: (client) no auto re-subscribe,
(server) *dead subscriptions are never pruned*. Half of that was already
false in the code — so we verified against prod before building:

- 9 `push_subscriptions`; old Apple rows (inserted 06-22 / 06-23 / 07-03)
  ALL carried `last_used_at` = 07-04 21:40. `last_used_at` is bumped ONLY
  on a `{:ok,_}` send (`Push.touch_last_used/1`) → **the push service is
  still returning 2xx for the ghosts.**
- Logs across the retained window: `push.send subscription gone — deleted`
  = 1, `push.send http error` = 0, `push.send failed` = 0.

So the server 410-prune (`Push.Sender` → `{:error, :expired}` on vendor
404/410 → `Push.delete_dead/1`, shipped B2 2026-05-14, covered by
`sender_test.exs`) is **correct and firing** — but it *structurally cannot*
touch these ghosts: the client dropped its browser subscription (iOS
SW-swap / storage eviction) WITHOUT `unsubscribe()`, so Apple keeps the
endpoint valid, returns 2xx, and no 410 ever arrives. Prune-on-410 is a
backstop for endpoints the vendor invalidates, not for silently-dropped
ones. The GIVEN "server never prunes" was a hypothesis from the issue's
investigation direction; the code already did it. (This is why the
escape-hatch report went back before building — CLAUDE.md "challenge the
spec"; the spec inherited a wrong half.)

**Why the ghosts accumulate — the real bug.** Two client defects, no
server-mechanism defect:

1. `disablePush` bailed on a null `getSubscription()` — it
   `forgetSubscription()`d the stashed server-row id WITHOUT DELETEing the
   row. Every silent-drop → toggle-off → toggle-on cycle ORPHANED the old
   row and minted a new one.
2. Nothing re-subscribed after the drop, so the toggle (which correctly
   already reflects `getSubscription()`, not `Notification.permission` —
   `SettingsDrawer.probeLocalSubscription`) sat at OFF.

**Why NOT a server-side dedup keyed on subject/UA.** The reconciliation
"subscribed ⇒ deliverable" cannot be derived server-side: the send
response is 2xx, so the server has zero signal a still-valid endpoint is
undeliverable. And this user genuinely owns 6 distinct devices incl. TWO
iPhones with an IDENTICAL `user_agent` (iOS 18_7, Safari 26.5.2) — so
dedup-by-(subject) or (subject, user_agent) would delete a REAL device.
The only deterministic, safe signal is **client-authoritative**: the
client knows the exact endpoint it is replacing.

**The fix (client + server, one deploy window).**

- **SERVER — supersede-on-(re)subscribe.** `Push.create/2` accepts an
  optional `:supersedes` (previous endpoint) in attrs; the controller reads
  the optional `"supersedes"` body field. When present and ≠ the new
  endpoint, create runs in a transaction that subject-scoped-deletes that
  endpoint, then inserts. Subject-scoped ⇒ a subject can only supersede its
  own rows; `:supersedes == :endpoint` (endpoint didn't rotate) is a no-op
  so the same-endpoint re-subscribe still surfaces as the unique-constraint
  422 replay. 410-prune + `DELETE /push/subscriptions/:id` unchanged (both
  already correct/existing).
- **CLIENT — renew on the SW-update / resume seams.** `disablePush`'s
  null-branch now DELETEs the stashed row instead of orphaning it.
  `ensurePushSubscription` (RENEW-ONLY — never prompts; acts only when
  permission granted + a stashed endpoint proves prior opt-in + the live
  subscription is null) re-subscribes via the SAME VAPID path and POSTs the
  fresh subscription with `supersedes: <old endpoint>`; a 422 replay counts
  as present. `installPushResubscribe` (main.tsx) wires it on
  `navigator.serviceWorker` `controllerchange` (the bundle-refresh trigger),
  `document` `visibilitychange` (backgrounded eviction), and boot; a
  single-flight guard prevents overlapping renews.

**Boundary vs #182.** #182 is the presence-gate (suppress push when a WS is
present — `Grappa.WSPresence`). #181 touches ONLY (1) subscription survival
across SW updates and (2) ghost supersession. No presence-gating decision
here.

**No `pushsubscriptionchange` SW handler.** That event fires inside the SW,
which has no bearer token to POST a renewal, and iOS does not fire it
reliably anyway. The observed trigger is the page-side SW-swap
(`controllerchange`), where the token lives — so renewal is page-driven.

**Residual.** Ghosts whose client can't name them (localStorage cleared
before the fix shipped) are not deterministically reap-able server-side
(no signal); they get superseded on that device's next re-subscribe, or
rot via the vendor's own TTL. A one-time operator reap was deemed optional
(can't distinguish live-vs-ghost among identical-UA iPhones without
guessing).

**Wire.** `push` has no `wire.ex`; the subscribe request is a hand-written
type — `gen_wire_types --check` stays green (no drift). **Deploy (actual).**
The server half was pure BEAM code (no schema/config/deps/supervision change),
so the auto-classifier deployed it HOT — reloaded `Grappa.Push` +
`GrappaWeb.PushSubscriptionController` with the daemon pid unchanged and all
IRC sessions preserved (no cold restart needed) — batched with the `--cic`
bundle (`hash=C9iUUKr1`) in one window. #181 stays OPEN until vjt
eyeball-confirms on device.

---

## 2026-07-04 — WS subprotocol / transport allowlist inheritance (closing #97)

Issue #97 ("Phase 5: WS subprotocol allowlist inheritance") is closed as **already covered** — the constraint it asked to formalise is the last bullet of the *2026-04-26 — Phase 3 wrap: WS `check_origin`* section above. Restated here so it isn't lost in a closed issue:

**Guardrail.** When adding a new WS subprotocol or an alternate Channel transport, it inherits the existing `check_origin` allowlist by construction. A feature that genuinely needs a *different* host (e.g. a login-free public-status endpoint) lands as a **separate `Phoenix.Endpoint`**, never as a relaxation of `check_origin` in `runtime.exs`. Relaxing the shared allowlist to fit one feature widens the authz-on-handshake surface for every socket.

No action needed today: there is a single WS transport and no new subprotocol in flight. This is a pre-emptive guardrail, tripped only when a future transport is added.

## 2026-07-05 — #180: enlarge the CRT loading-splash text +30%, proven by a FROZEN-splash e2e

vjt device report: the retro CRT loading splash (`CrtSplash.tsx`, #134)
text read too small. Fix is a pure font-size bump — `.crt-splash-boot`
0.8→1.04rem and `.crt-splash-status` 1.4→1.82rem (both ×1.3, scoped to
the splash selectors; the rem/`--font-size` base is untouched so no
unrelated text grows). CRT aesthetic (letter-spacing, glow, line-height)
unchanged.

**The reusable bit — how you e2e a loading-ONLY component.** `CrtSplash`
is the Shell main-pane `<Switch fallback>`, alive only in the cold-load
window before `/me` resolves, then it hands off to `$home`. Its own vitest
calls it "e2e-hostile (gone the moment the page finishes loading)", and
jsdom can't resolve a rem `font-size` to px (no cascade/layout) — so
neither existing surface can assert the RENDERED size. The e2e
(`crt-splash-font.spec.ts`) freezes the splash deterministically: seed a
bearer (RequireAuth gates on token PRESENCE, not `/me` — `auth.ts`
`isAuthenticated`) so Shell mounts, then HANG `/me` (a never-resolving
`page.route`) so the `user` resource stays PENDING → `user()` undefined →
`loading()` true → the splash persists under a real Chromium that cascades
`default.css`. Then assert the rem-RATIO (computed text px ÷ root font px),
which is layout-independent (holds for any root px; == the rem multiplier).
Hang, NOT `abort()`: an aborted resource ERRORS and Solid re-throws it on
read (trips an ErrorBoundary, kills the splash); a 401 would fire `on401`
→ clear the token → bounce to `/login`. Pending is the genuine cold-load
state. This is the pattern for any future loading-only / transient-overlay
e2e.

## 2026-07-05 — #182: server-side foreground push-suppression (one visibility signal, two consumers, two timings)

**The bug.** Web Push was delivered even while the PWA was on-screen
(iOS). The pre-existing suppression was CLIENT-side in the SW
(`shouldSuppressPush` → `clients.matchAll().visibilityState`), and its
pure predicate is correct — but `clients.matchAll` is UNRELIABLE on iOS
PWAs (the SW often sees an empty/non-"visible" client list while
foregrounded), so the client gate cannot detect iOS foreground. The fix
moves suppression SERVER-side, driven by a signal the PAGE reports:
page-context `document.visibilitychange` IS reliable on iOS (unlike the
SW's `clients.matchAll`).

**The signal.** cic's `reportVisibility` (`socket.ts`) pushes
`{visible}` on the user-level channel — on every `visibilitychange`
(main.tsx listener) AND on every user-channel (re)join
(`joinUser` receive-ok, so a reconnect re-reports since the server
defaults a fresh transport pid to `:hidden`). `GrappaChannel`'s
`handle_in("visibility", …)` forwards it to
`WSPresence.set_visibility/3` keyed by `socket.transport_pid` — the SAME
pid `UserSocket.connect` registered, so DOWN cleanup is automatic.

**The store — WSPresence EXTENDED, not duplicated** (vjt 11:07: "non
reinventare la ruota"). The map went `%{user_name => MapSet.t(pid())}` →
`%{user_name => %{pid() => :visible | :hidden}}`. `ws_count`/
`list_user_names` still derive from the pid keys (byte-for-byte
unchanged). Default on register = `:hidden` (DELIVER-leaning: erring
toward hidden never suppresses a wanted push; the SW re-check backstops a
false delivery, whereas defaulting `:visible` would risk suppressing a
push to a connected-but-backgrounded iOS device = a lost notification).
No second GenServer: a parallel store would monitor the same socket pids
= duplicated lifecycle housekeeping that drifts.

**One raw bool, TWO consumers, TWO timings (the crux).**
- **Push suppression — RAW, immediate.** `Push.Triggers.evaluate_and_dispatch`
  gates the whole fan-out: `should_notify?/4 and not
  WSPresence.any_visible?(subject_label)`. `should_notify?/4` stays a PURE
  predicate (no IO); the visibility read is a SEPARATE step. No debounce —
  a debounced gate would miss a mention landing right after you set the
  phone down. Keyed by `subject_label` (== `user.name` / `"visitor:"<>id`,
  threaded through the Triggers ctx from `Session.Server.state`), so
  WSPresence stays Accounts-free. Applies to visitors too.
- **IRC auto-away — DEBOUNCED 30s, network-visible.** The auto-away FSM
  was generalized: its trigger moved from "all sockets disconnected" to
  "no VISIBLE device." WSPresence now fires `:ws_visible` /
  `:ws_all_hidden` on the `any_visible?` TRANSITION (renamed from
  `:ws_connected` / `:ws_all_disconnected`; sole PubSub consumer is
  `Session.Server`'s Topic.ws_presence subscriber, so the rename is
  self-contained). `Session.Server` reuses the existing 30s debounce +
  real upstream `AWAY :reason`.

**REAL behavior change (intended):** backgrounding the PWA >30s now marks
you `/away` to OTHER network users (301/whois), because iOS holds the
socket while backgrounded — a live socket is no longer proof of presence.
The 30s debounce prevents channel-flap on brief glances; foregrounding
unaways immediately. This SUPERSEDES the earlier S3.x auto-away note
("last socket gone → away"): the trigger is now visibility, not
connection. Auto-away stays USER-only (visitors don't subscribe); the
push gate still applies to visitor subjects via raw `any_visible?`.

**The SW client re-check is RETAINED** as a defensive backstop (the small
just-connected window before a fresh tab reports visibility; non-iOS
where `matchAll` is trustworthy) — the parked "hybrid until quota bites"
notes in `service-worker.ts` / `pushDedup.ts` are now stale and were
corrected at source. Never weaken `shouldSuppressPush`.

**e2e.** The old `push-server-fires-regardless-of-focus.spec.ts` encoded
the now-reversed contract and was reworked into
`push-foreground-suppression.spec.ts`: device visible → DM → catcher
receives NOTHING; device hidden → DM → catcher DOES receive it. A shared
`setPageVisibility(page, visible)` fixture overrides
`document.visibilityState` + dispatches `visibilitychange` (drives the
PRODUCTION reporter), then blocks on the `window.__visibilityAck` seam
until the server acks — so the trigger can't race the visibility update.
The three delivery-asserting specs (dm / channel-mention / prefs-whitelist)
now background the page first (their delivery is gated by
prefs/mention, not foreground). Away-transition coverage lives in
`server_test.exs` (WSPresence → PubSub → Session → real `AWAY` line),
firing `:auto_away_debounce_fire` directly to avoid a 30s wait.

## 2026-07-05 — #184: STATS reply numerics are server-directed → `$server`, never a query window

`/stats <letter>` output was rendering in a bogus QUERY window named
after the stats letter (a DM "o" for `/stats o`) instead of the network's
`$server` window, and even leaked into the per-network Archive.

**Root cause was SERVER-side** (`Grappa.Session.NumericRouter`), not cic —
cic is a faithful mirror of the server's routing target. The STATS reply
family (211–219 `RPL_STATS*` + `RPL_ENDOFSTATS`, 240–250) was in NEITHER
`@active_numerics` NOR `@delegated_numerics`, so it fell through to the
`scan_params/2` param-scan. Every `/stats` query terminates with
**219 RPL_ENDOFSTATS `[own_nick, <letter>, "End of /STATS report"]`**; the
bare stats letter is nick-shaped (`Identifier.valid_nick?("o")` is true,
no dot, ≠ own_nick), so the scan resolved `{:query, "o"}` and the server
persisted a `:notice` on `channel="o"` — which surfaced as a query tab AND
leaked into Archive via `Scrollback.list_archive`'s
`COALESCE(dm_with, channel)` GROUP BY. This is the **exact same disease**
as the UX-4 004/042 connect-storm ghost: a nick-shaped middle param that
is metadata, not a destination.

**Rule (invariant): STATS replies are server-directed — always
`{:server, nil}`.** The fix folds the whole `211–219 / 240–250` range —
the STATS reply set Azzurra's bahamut actually emits — into
`@active_numerics` via a `@stats_numerics` attribute. None of these
numerics ever names a user-correlatable destination: their nick-shaped
middle params are all data (the stats letter, the O/I/K/C-line class
letter, a link name, a host mask). We deny the observed range, not a
claim of universal STATS coverage — other ircds put STATS numerics in
220–239 too; add them here if a bound network emits them. Verified
disjoint from `@delegated_numerics` (no collision / no double-persist);
250 RPL_STATSCONN already routed to `$server` at connect-time both before
and after, so zero connect-storm change.

**#155's e2e MASKED this** (the #78 hollow-green lesson): it drives
`/stats u` and asserts only that 242 RPL_STATSUPTIME lands in `$server`.
242 is trailing-only (`[nick, "Server Up…"]`, no middle param) so it
routed to `$server` by ACCIDENT even pre-fix — while the sibling 219 (same
query) silently forked a "u" query window it never looked for. #155's
`compose.ts` "No server change — scan-then-server already routes STATS"
comment inherited the same false premise and was corrected at source.

**e2e** (`issue184-stats-window-routing.spec.ts`): drives `/stats u` as a
visitor and asserts (a) the 219 "End of /STATS report" renders in
`$server`, (b) NO sidebar window `data-window-name="u"`, (c) decisively,
server-side, `GET /channels/u/messages` returns `[]` (ordered after the
219 lands, so the reply is fully drained). All three legs are RED pre-fix.

**Deploy class: SERVER change → COLD** (BEAM restart, drops live IRC
sessions). The `compose.ts` comment fix is a runtime no-op (comment
stripped from the bundle) and needs no separate `--cic` deploy.

---

## 2026-07-05 — #187: last-open-window restore for visitors (kind-gate + decide-once race)

**Contract reaffirmed: last-open-window restore is CLIENT-owned, keyed on
the subject's `/me` id.** cic persists the focused window to
`localStorage["cic.lastFocusedChannel.<id>"]` on every focus change
(`selection.ts` `on(selectedChannel)` → `saveLastFocused`) and re-selects
it on cold load (`Shell.tsx`). The server owns read-cursors and
`last_joined_channels`, NOT "which window was focused" — that is a pure UI
concern and stays on the client. A visitor's `/me` `id` is a stable
`Ecto.UUID` resolved from the persisted `grappa-token`, so it keys the
same slot across a refresh/reopen exactly like a registered user's id.

**Bug 1 — the restore READ was gated to `kind === "user"`.** #34/#35
shipped restore for registered users; the cold-load arm wrapped the whole
attempt in `if (m.kind === "user")` on the (wrong) assumption that
"visitors get a fresh single-network session per visit, so persisting has
no payoff." The WRITE path was never gated — it fired for every subject —
so visitors reliably FILLED a slot the read refused to consult, and every
visitor refresh fell through to the `$home` default. Fix: drop the gate;
restore keys on `m.id` for any subject class (both `MeResponse` arms carry
`id: string`).

**Bug 2 — the restore was DECIDE-ONCE, so a late-arriving channel was
missed.** A registered user's saved channel is an autojoin — always in the
FIRST `channelsBySlug` snapshot after reconnect. A visitor's saved channel
is runtime-joined: the bouncer session survives the browser reload, but
`GET /channels` can snapshot mid-reconnect and return WITHOUT it, the
channel arriving a beat later via a refetch. The old arm decided once
(latched `coldLoadAutoSelected` after the first `channelsBySlug !==
undefined`), so it selected `$home` before the channel appeared and never
re-checked — the exact #187 symptom (the sidebar row was present but never
`.selected`). This is why registered-user restore looked fine while
visitors broke: the asymmetry is autojoin-in-first-snapshot vs
runtime-joined-arrives-late, NOT the subject kind per se.

Fix: make the cold-load restore arm **reactive, not decide-once**. It
lands `$home` PROVISIONALLY (never a blank screen), keeps re-attempting the
restore as the tracked resource updates (each branch reads exactly the
resource — `channelsBySlug` / `networkBySlug` / `queryWindowsByNetwork` —
that will gain the target, so Solid re-runs the effect when the window
arrives), overrides the provisional `$home` when the saved window appears,
and stops the instant the operator navigates (a real, non-`home` selection
latches `coldLoadDone`). If the saved window never returns (parted while
cic was closed), `$home` is the correct terminal fallback. Two flags:
`coldLoadDone` (terminal) and `provisionalHome` (we placed `$home` as a
placeholder, so a later restore may still override it — distinct from an
operator who selected home). The effect reaches a fixed point in one extra
no-op run and cannot thrash: it writes only `selectedChannel`, which feeds
none of the resources it tracks, and `setSelectedChannel` short-circuits
same-tuple writes.

**Tests.** Unit (`Shell.test.tsx`): a visitor restores its saved channel
(not `$home`); and — the decide-once regression net — a saved channel that
lands AFTER the first `channelsBySlug` resolve still overrides the
provisional `$home` (RED against a decide-once latch, proven by temporarily
re-latching). The mock's `channelsBySlug` became a real mutable Solid
signal so the late-arrival can be driven deterministically. E2E
(`issue187-visitor-window-restore.spec.ts`): a visitor `/join`s a channel,
focuses it, `page.reload()`s, and the channel row is `.selected` again (not
`$home`) — the deterministic race proof is the unit test (forcing a split
`/channels` snapshot in-browser is impractical), the e2e proves the
end-to-end visitor-restore outcome.

**Deploy class: cic-only** (bundle swap, no BEAM restart). No server or
wire-type change.

---

### 2026-07-05 — #188: "while you were /away" mentions panel restyle + open-button + clear-on-away

The mentions-while-away panel (C8, spec #19) worked but read as a raw flat
list of default-chrome `<button>` rows with a terse `N mentions while away
(HH:MM:SS – HH:MM:SS · reason)` header. #188 is a POLISH pass — the server
path (`maybe_broadcast_mentions_bundle` → `mentions_bundle` on the user
topic) and the row-click-jumps-to-message contract are untouched; only cic
presentation + one lifecycle rule changed.

**Panel restyle contract (`MentionsWindow.tsx` + `.mentions-*` CSS).** The
pane now mirrors the `/list` directory pane (`DirectoryPane`) so the two
read as siblings: a flex-column frame (`.mentions-window` ≈ `.directory-
pane`), a fixed header, and a SCROLLABLE list (`.mentions-list` ≈
`.directory-list`). Concretely:
- **Heading** leads with the `/away` phrasing and a count that makes the
  scope visible before scrolling: `while you were /away — N messages in M
  channels` (slightly-bigger bold `.mentions-heading`). The away interval +
  reason survive as a muted sub-line (`.mentions-header-meta.muted`), the
  reason still routed through `MircBody` (#142 control-byte render).
- **Grouped by channel.** Rows cluster under a muted per-channel label
  (`.mentions-group-channel.muted`); the old per-row channel column is
  gone. `groupByChannel/1` is a pure first-seen-order grouping — the server
  already returns messages `server_time ASC`, so the first channel to
  appear leads.
- **Rows are not button-y.** `.mentions-row` mirrors the SAME reset the
  `/list` rows use (`.directory-row-join`: transparent bg, no border,
  left-aligned, `font: inherit`) — the properties are copied, not
  class-shared, because the mentions row layout differs from the directory
  grid — so a form control stops rendering as UA button chrome. Padding
  separates rows; the whole padded area is the tap target. (The close-x, by
  contrast, IS a literal `.directory-close` class reuse — same shape.) Touch has no `:hover`, so `:active` (which DOES fire on tap)
  carries the "this is tappable" feedback — the row reads as tappable
  without relying on hover.

**Close-x = the `/list` affordance, and the mentions panel now records its
opener.** Item 5 reuses `.directory-close` + `closeToPreviousWindow` (#125).
But `closeToPreviousWindow` restores the pre-overlay window only if
`setSelectedChannel` recorded `backTarget` when the overlay opened — and
that recording was gated on `kind === "list"` alone. Extended it to
`kind === "list" || kind === "mentions"` (with an overlay→overlay guard):
both panes are transient network-context overlays, so they must remember
their opener identically ("same problem, same solution"). Without this the
mentions close-x fell through the MRU→server→home fallback instead of
restoring the exact window you were in. `MentionsWindow` stays presentational
— it takes an `onClose` callback (like it already takes `onMentionClicked`);
Shell wires it to `closeToPreviousWindow(slug)`.

**Open button — network-derivation decision.** A `@` button next to the
Settings cog (`ShellChrome`, `shell-chrome-mentions`) opens the panel via
the SAME verb the return-from-away auto-open uses
(`setSelectedChannel({networkSlug, channelName: "", kind: "mentions"})`).
Which network's bundle? Derive it from the current selection exactly like
the archive button (`archiveSlugForSelection()`), and render the button
ONLY when `mentionsBundleBySlug()[slug]` has a bundle — there's nothing to
consult otherwise. NOT mobile-gated (unlike archive, which is redundant
with the desktop sidebar drawer): the mentions panel has no sidebar
equivalent, so the button surfaces on both. `archiveSlugForSelection()`
returns null while the panel itself is open, which conveniently hides the
redundant re-open button.

**Clear-on-away lifecycle.** The bundle is SET on RETURN-from-away
(`mentions_bundle`) and now CLEARED on GOING away again: the
`away_confirmed` handler calls `clearMentionsBundle(network)` when
`state === "away"` (NOT on `"present"` — that IS the return path, and
clearing there would wipe the bundle the instant it arrives). Within a
session you tap through all the mentions; the next away resets the panel so
the following return consults a fresh one. `clearMentionsBundle/1` is a
per-network delete on the `mentionsBundleBySlug` store (sibling to
`setMentionsBundle`) — sibling networks' bundles are untouched.

E2E (`issue188-mentions-panel-polish.spec.ts`) drives the REAL path — no
synthetic bundle: operator joins two channels, goes `/away`, a peer PRIVMSGs
the operator's nick into both, operator returns → the server aggregates and
pushes `mentions_bundle` → the panel auto-opens. It then asserts the
restyle (heading + count, two muted per-channel groups, scroll container),
row-click navigation, the open-button re-open, the close-x, and — going
`/away` again — the open-button disappearing (bundle cleared).

**Deploy class: cic-only** (bundle swap, no BEAM restart). No server or
wire-type change.

## 2026-07-06 — #192: presence folds window focus, not just Page Visibility (a #182 regression)

**Symptom.** A user on phone + desktop simultaneously never got Web Push on
the phone while the desktop tab was open. Root cause: #182's
`reportVisibility()` (`socket.ts`) reported presence off
`document.visibilityState` alone. On desktop that stays `"visible"` whenever
the tab isn't minimized/switched-away — including when the user clicks
another application and the grappa window sits on-screen but unfocused. So
the 30s auto-away FSM never armed and, because #182's push-suppression is
**per-user across all devices** (`any_visible?`, by design — the server has
no push-endpoint→socket-pid map), one un-minimized desktop tab pinned
presence and suppressed the whole fan-out on every device.

**Fix — reuse the existing focus-aware signal, don't duplicate.** cicchetto
already had `lib/documentVisibility.ts` exporting `isDocumentVisible` — a
Solid signal computing exactly `visibilityState === "visible" &&
document.hasFocus()`, already listening to `visibilitychange` + window
`focus`/`blur`, already consumed by `subscribe.ts` + `selection.ts`. The
#182 server-presence reporter was the one consumer that bypassed it. So the
fix is two edits, no new logic:
- `socket.ts reportVisibility()` folds `&& document.hasFocus()` into the
  reported bool (same predicate as `documentVisibility.ts`; kept as a fresh
  imperative DOM read because the reporter is a fire-and-forget push, not a
  reactive consumer — decoupled from signal timing and trivially unit-testable).
- `main.tsx` replaces the raw `document.addEventListener("visibilitychange",
  reportVisibility)` with a `createRoot(() => createEffect(() => {
  isDocumentVisible(); reportVisibility(); }))`. Driving the report off the
  signal REUSES its one set of focus/blur/visibilitychange listeners — no
  parallel registration — and fires the report on every transition. The
  initial state is still reported explicitly on user-channel join (`joinUser`).

**Server FSM/debounce/gate unchanged.** WSPresence `any_visible?` →
`:ws_all_hidden`/`:ws_visible` → 30s debounce → upstream `AWAY` → push gate
are all reused untouched; #192 only makes the INPUT signal focus-aware. A
brief blur→refocus within 30s is absorbed by the existing debounce (refocus
fires `:ws_visible`, cancelling the pending timer — no push churn). Mobile
PWA is unaffected: backgrounding already flips `visibilityState` to
`"hidden"`, so `&& hasFocus()` doesn't change mobile behaviour.

**Test-isolation footnote.** Making `reportVisibility` read
`document.hasFocus()` exposed a latent order-dependency in
`socket.test.ts`: the existing #182 cases asserting `{visible:true}` never
controlled focus and relied on jsdom's default `hasFocus()===true`. Under
the full suite another file could leave the shared jsdom document blurred,
flipping the assertion. Fixed by pinning `hasFocus()` true in the
`reportVisibility` describe's `beforeEach` (surgical `mockRestore` in
`afterEach`) — the tests now state their focus precondition explicitly.

**E2E** (`push-focus-suppression.spec.ts`, sibling of
`push-foreground-suppression.spec.ts`): with `visibilityState` pinned
`"visible"` (so focus is the only variable), a new `setPageFocus` fixture
overrides `document.hasFocus()` + dispatches window `focus`/`blur` and blocks
on the `__visibilityAck` seam. Asserts the visible outcome via push-catcher:
visible+focused → DM → no delivery; visible+**blurred** → DM → delivered
(the #192 fix); refocused → DM → suppressed again.

**Deploy class: cic-only** (bundle swap, no BEAM restart). No server or
wire-type change.

**2026-07-08 — follow-up: the desktop-FOCUSED case is intentional, not a bug.**
vjt re-opened #192 reporting "with the PWA open on desktop I never go away →
breaks push." Diagnosed live against prod (`:sys.get_state` on `WSPresence` +
each `Session.Server.away_state` via the `su -l grappa` sourced-env release
`rpc`): at the time of the report he was correctly `:away_auto` with one
`:hidden` socket and `any_visible? == false` — i.e. the #192 fix was already
working; the earlier "never away" was the *old bundle* before he refreshed the
desktop PWA. The ONLY remaining case is when the desktop is genuinely
**focused**: `any_visible? == true` → no `/away`, and #182's push-suppression
(per-user across all sockets) correctly stays quiet on every device. **That is
#182 working as specified, not a defect** — the point of the per-user gate is
that a mention you can already see on a focused screen shouldn't also buzz your
phone. vjt reviewed and chose **keep-as-is**, explicitly declining both
per-device gating (each device gated by its own visibility — would kill the
cross-device suppression #182 built, and produce redundant buzzes) and a
focus-idle timeout (focused-but-no-interaction → hidden — more machinery for a
narrow "walked away from a focused window" case). So: **no per-device push,
no idle-away timer.** If this resurfaces, it is a WON'T-FIX by design, not a
bug to chase. Also note the auto-away FSM is edge-triggered (`:ws_all_hidden`
fires only on a *visible→hidden* transition in `WSPresence`); a socket that is
`:hidden` from birth and never goes visible produces no edge — not hit in
practice here (his desktop had been visible then blurred), but a latent sharp
edge worth remembering if a future change lets a session sit at `:present`
with only hidden sockets.

---

## 2026-07-10 — #89: upstream TLS `verify_none` → `verify_peer` (system CA store)

The Phase-1 expedient in `Grappa.IRC.Client`'s TLS connect —
`verify: :verify_none`, connect-and-encrypt with no chain validation — is
closed. Upstream TLS sockets now use `verify: :verify_peer` against the
operator's **system CA trust store**, with `depth: 3`, SNI, and RFC-6125
hostname verification.

**The lockout risk, and why it didn't bite.** A wrong flip is
catastrophic: if the upstream cert doesn't validate, `verify_peer` refuses
the handshake and grappa can never reconnect after a restart — total
upstream IRC outage. vjt's caveat was explicit: probe azzurra's cert
BEFORE any code change, and hard-stop rather than flip blind. So the
go/no-go was gated **solely** on a cert probe, run before touching code:

- Upstream (from prod `network_servers`): `irc.azzurra.chat:6697`,
  round-robin = 2×A + 2×AAAA.
- openssl chain-probe of **every** pool member against the system CA
  store: all four validate (`Verify return code: 0`), chain
  `Let's Encrypt YE1 → ISRG Root`, unexpired, and — critically for
  round-robin under a hostname check — **every** member carries
  `DNS:irc.azzurra.chat` in its SAN (leaf CNs are per-server:
  ruby / raccooncity / allnight6 / nightwish). The v6 members were
  probed from m42 (voyager, the dev Mac, has no v6 route).
- The decisive proof was **real OTP**, not openssl: ran
  `:public_key.cacerts_get/0` + `:ssl.connect(verify: :verify_peer, …)`
  against the LIVE prod node via the release `rpc` — `cacerts_get: OK
  (119 anchors)`, `HANDSHAKE OK (verify_peer)`. Intermittent `:closed` /
  `unsupported_record_type,58` on rapid back-to-back probes was azzurra
  **rate-limiting** the probe connects (a transport drop BEFORE TLS cert
  verification — identical under verify_none), confirmed by spacing
  probes 6s apart (2/2 clean). This is the same connection-storm the
  `Client` connect-fail throttle exists to prevent; probing stopped
  immediately to avoid throttling grappa's real IP.

**The four opts (`Client.tls_connect_opts/1`).**
`verify: :verify_peer` is the whole point; the rest make it correct:
`cacerts: :public_key.cacerts_get()` (OTP 25+ reads the platform bundle —
no cacertfile to ship or rotate; it RAISES if no store exists, which is
the honest loud failure rather than a silent downgrade),
`depth: 3` (azzurra's chain is depth 2; one slot of headroom for a
cross-signed root), and hostname verification via `server_name_indication`
(SNI, so the pool serves the SAN-matching cert) +
`customize_hostname_check` with `pkix_verify_hostname_match_fun(:https)`
(rejects a valid-CA cert issued for the wrong host — the MITM-with-any-leaf
class). Without the hostname check, verify_peer alone would accept any
publicly-trusted cert for any host.

**Operator trust-store strategy.** The anchor set is the host OS CA bundle
(FreeBSD `/etc/ssl/cert.pem` via `ca_root_nss`; Linux `ca-certificates`;
macOS keychain). grappa pins nothing. A private/self-signed upstream must
have its CA added to the system store — grappa is never weakened to a
per-network `verify_none`. Documented in the `Client` moduledoc "TLS
posture" section, `CLAUDE.md` Security, and `docs/OPERATIONS.md`.

**e2e is unaffected:** the bahamut testnet binds `--no-tls` on 6667, so
the flip only touches real TLS connects; the self-signed testnet certs are
never presented to grappa.

The `init/1` per-connection `Logger.warning` about verify_none became a
`Logger.info` recording the verify_peer posture. The AuthFSM's historical
comments about SASL-blob leaks "under verify_none" are left as-is — the
phase-pin guard (C1) is the real fix; verify_none only widened the blast
radius, and that context stays accurate as a record.

---

## 2026-07-10 — #205: iPad standalone-PWA layout broke because it renders the DESKTOP shell, not the mobile one

Reported on #it-opers: cicchetto installed as a Home-Screen PWA on iPadOS
rendered clipped in both orientations (landscape worse), the top chrome
painted UNDER the iOS status bar, and the settings cog was dead — neither
touch nor pointer reached it.

The issue's suspected cause was the classic naive one (missing
`viewport-fit=cover` / missing `env(safe-area-inset-*)` / `100vh`). But
`index.html` already had `viewport-fit=cover` +
`apple-mobile-web-app-status-bar-style: black-translucent`, and the
stylesheet already carried extensive safe-area + `100dvh` +
VisualViewport handling. So the naive fix was already in place — the bug
was subtler.

**Root cause: the breakpoint, not the insets.** `isMobile()` is
`matchMedia("(max-width: 768px)")` (`lib/theme.ts`). An iPad is WIDER than
768px in BOTH orientations (portrait ≥810 CSS-px on modern models,
landscape ≥1024), so `isMobile()` is `false` and `Shell.tsx` renders the
DESKTOP `.shell` branch — never `.shell-mobile`. And every safe-area /
dynamic-viewport rule in `default.css` was scoped to the mobile shell
(`@media (max-width: 768px)` / `.shell-mobile` / mobile `.shell-members`).
The desktop `.shell` shipped a bare `height: 100vh` with zero insets. With
the `black-translucent` status bar the page paints under the bar, so the
shell's top edge — carrying the always-visible `.shell-chrome` settings
cog — landed inside the status-bar reservation zone: clipped, and
non-interactive because iOS captures touches in that zone (the exact
failure mode the mobile shell's own UX-3 BIS comment already documents:
"insets on the container, not the bars, because iOS captures touches in
the status-bar reservation zone"). The desktop shell simply never got the
UX-3 BIS treatment — it predates iPad-as-PWA dogfooding.

**Fix (mirror the mobile shell onto the desktop shell):**
1. `.shell` gets `env(safe-area-inset-*)` padding on all FOUR edges
   (container-level: `box-sizing: border-box` consumes the inset from the
   height, pushing the whole shell — background included — inside the safe
   area, so the cog clears the bar AND stays in the hit region; left/right
   matter in landscape where the home-indicator + camera housing eat the
   side gutters) and `height: 100dvh` (visible viewport, vs `100vh`'s
   taller layout viewport that overflowed + clipped the bottom), with a
   `@supports not (height: 100dvh)` 100vh floor for Safari < 15.4.
2. The base `.shell-members` `env()` insets were RELOCATED into the mobile
   `.shell-members` override. On desktop the members aside is a grid child
   of the now-padded `.shell`, so keeping its own insets double-counted
   the top inset (members column shoved down 2× the status-bar height
   while sidebar + main sat flush). The mobile drawer is `position: fixed`
   (escapes the container padding box → its own containing block) so it
   genuinely needs its own insets; that's where they live now. Values are
   byte-identical, so mobile is unchanged.

**Double-inset audit.** Every other `env(safe-area-inset-top)` consumer in
`default.css` is either `position: fixed` itself (`.error-banners`,
`.settings-drawer`, `.diag-float`, the `*-modal-backdrop`s) or a child of
a `position: fixed` backdrop (`.delete-account-modal`, `.archive-modal`) —
each establishes a viewport-relative containing block, so none double-count
against `.shell`'s new padding. Desktop browsers resolve
`env(safe-area-inset-*)` to 0 and `100dvh == 100vh`, so the change is a
visual no-op there (the members column loses a mobile-only 1.5rem bottom
floor, which had no desktop launcher footer to justify it).

**Why no e2e.** Playwright chromium/webkit does NOT reproduce real iPadOS
Safari safe-area/dvh physics — no status bar, `env(safe-area-inset-*)`
resolves to 0 — so the cog is reachable in Playwright even on the BROKEN
code. A layout/clickability e2e would pass on both broken and fixed code:
hollow. The regression guard is instead a source-level vitest
(`ipadSafeArea.test.ts`): viewport-fit present, four insets on `.shell`,
no bare clipping `100vh`. Real on-device iPad confirmation stays a manual
dogfood — recorded, not automated. Companion of the on-device
dogfood-verification backlog (#111).

---

## 2026-07-10 — #207: error banners were sticky → per-source × dismiss with recovery re-arm

**P0 (vjt, "appena possibile").** The stacked error-banner region (#119)
had no dismiss affordance. Two of its four sources auto-clear when the
underlying condition recovers (`ws` on a clean open resets `errorCount`;
`connectivity` on the `online` event), but `sw-registration` and
`bundle-refresh` have **no** auto-clear event — once shown they stayed up
forever with no × and no timeout, piling up and obscuring the UI.

**Fix: a × on every banner, dismissed-state client-local, with re-arm.**
The design is constrained by two documented invariants, and the
interesting decision is how they interact:

- **Never fabricate server state.** The source signals (`socketHealth`,
  `connectivity`, `swRegistration`, `bundleHash`) remain the single owners
  of whether a source is *active*. Dismiss is NOT a new state on those
  signals — it's a pure render filter layered on top. `activeBanners()`
  (the raw derivation) is untouched; the new `visibleBanners()` =
  `activeBanners()` minus a client-local `dismissed: Set<BannerSource>`
  signal. The owner renders `visibleBanners()`.

- **A dismiss must not permanently silence a recurring fault**
  (`feedback_silent_retry_anti_pattern`). A × that stuck forever would be
  a silent-retry-loop-shaped bug: the operator dismisses a WS-failing
  banner, the connection later breaks *again*, and they never see it. So
  the dismiss is scoped to the **current episode**: `rearmDismissed(active)`
  — run by the owner inside a `createEffect` on every re-derivation — drops
  any dismissed source no longer in the active set. When a dismissed source
  recovers (leaves the active set) and later re-fires, its banner returns.

**Why NO auto-dismiss timer** (the other option the issue offered). `ws` +
`connectivity` already auto-clear on recovery; a timer hiding them *while
the fault persists* would mask a live problem — the exact anti-pattern
above. `sw-registration` is the #181 push-diagnostic surface (hiding it on
a clock the user didn't set loses the lever); `bundle-refresh` is
user-actionable (the Refresh CTA). None of the four wants a clock. The ×
(with re-arm) is the whole fix — no timer anywhere.

**Reactivity note.** `rearmDismissed` reads the `dismissed` set via
`untrack`, so the owner's `createEffect(() => rearmDismissed(activeBanners()))`
depends only on the *active* set, not on its own write. The re-arm graph
converges in ≤2 effect runs (a kept dismissal is kept because its source is
still active → no further write). The intermediate empty-active state
between a recover and a re-fire is observed because those arrive as
separate signal writes (Solid flushes the effect between them) — not
batched. `BannerSlot` stays pure: it takes an optional `onDismiss`
callback and renders a labelled × button, knowing nothing about which
source it is; the owner (`ErrorBanners`) holds the dismiss state.

**E2E.** `error-banners.spec.ts` gained a click-× test and a
recover-then-re-fire re-arm test, both driven through the existing
`__cic_socketHealth` injected-event hook — no real backend op, so the
shared testnet is never poisoned (the #204 cascade lesson).

## 2026-07-11 — #210: suppress server PING/PONG keepalive from the `$server` status window

**Symptom.** The cic status window accreted ~1 protocol-noise row per
minute — a keepalive artefact rendered as a `:server_event`. Standard IRC
clients hide server ping/pong; grappa wasn't.

**Root cause (traced, not assumed).** Two distinct PING/PONG flows:

1. **Inbound server PING** (`command: :ping`) is answered by the dedicated
   `Session.Server.handle_info({:irc, %Message{command: :ping, params:
   [token | _]}}, state)` clause (`server.ex`), which replies `PONG` and
   returns `{:noreply, …}` — it never delegates to the router. Already
   silent. Not the noise.
2. **Our OWN liveness probe.** `IRC.Client` sends `PING :grappa-liveness`
   after 60s of inbound silence (the #100 half-open-socket watchdog).
   Upstream answers with a **PONG**, which arrives as `{:irc,
   %Message{command: :pong}}`. There is **no dedicated `:pong` handler**,
   so it falls through `Session.Server`'s catch-all `handle_info({:irc,
   %Message{} = msg}, state) → delegate/2 → EventRouter.route`. `:pong`
   was not in `@no_persist_verbs`, so `route_unhandled_command/2`
   persisted a `:server_event` on `$server`. **That** is the ~1/min row.

**Fix.** One line: `@no_persist_verbs` gains `ping pong`
(`event_router.ex`). `pong` closes the real leak. `ping` is
belt-and-braces: a malformed param-less `PING\r\n` (`params: []`) misses
the Server clause's `[token | _]` guard and would fall through to the same
catch-all — deny-listing `:ping` keeps every PING variant off `$server`
too.

**Why `@no_persist_verbs` is the correct gate.** The `do_route/2` clause
order is numeric-catchall → inbound-INVITE (#78) → **`@no_persist_verbs`
guard** → persisting catch-all. Both `:pong` and a param-less `:ping`
reach the guard before the persisting fallthrough. This is the same
suppression point already used for the `authenticate`/`pass`/`oper`
credential-leak deny-list (B6.1 CRIT-1) — one allowlist, one reason:
verbs that carry no user-facing content and must never touch scrollback.

**Tests.** Unit (`event_router_test.exs`): `:pong` and param-less `:ping`
each assert `{:cont, ^state, []}` — zero effects, mirroring the
authenticate/pass/oper deny-list tests. Integration
(`server_test.exs`, PING/PONG describe): feed an inbound PONG through the
`Grappa.IRCServer` fake, then a server PING; when the outbound PONG reply
appears on the wire the mailbox-ordered inbound PONG is already processed,
so `Scrollback.fetch(…, "$server", …)` deterministically observes `[]` —
the user-visible absence is the real guard.

---

## 2026-07-11 — #152: ident + realname user-settable, live-applied via internal reconnect

**The ask.** Split the three IRC identity fields that grappa collapsed
onto one value (`nick == ident == userid`) so `ident` and `realname` are
independent + user-settable, as in every standard IRC client. Applying a
change to a LIVE session must not force a manual quit/relogin.

**Challenge-the-spec (three findings that shrank the work).**

- **`realname` was already half-built.** `Credential` already carried a
  nullable `realname` column with `validate_safe_line_token` + an
  `effective_realname/1` nick-fallback threaded into the USER trailing
  param. For registered USERS, realname was already split + settable —
  the only net-new realname pieces were the VISITOR side (hardcoded
  `"Grappa Visitor"`), a cic field, and live-apply.
- **`ident` is the one genuinely net-new field.** The USER username slot
  was a mechanical copy of the nick (`USER #{nick} 0 * :#{realname}`). New
  column on Credential + Visitor, new struct field on `AuthFSM`, new
  `effective_ident/1` fallback — symmetric with the EXISTING
  `realname`/`sasl_user` pair (reuse the pattern, not a new pattern).
- **Live-apply genuinely requires a reconnect (confirmed, no cheaper
  path).** ident/realname are carried ONLY by the `USER` command, sent
  exactly once at registration; a second `USER` on an established socket
  is rejected `462 ERR_ALREADYREGISTRED`. There is no live IRC verb to
  change them. But the reconnect *primitive already existed* (#126's
  disconnect ⇄ reconnect seam): `Session.stop_session/3` (graceful QUIT)
  + `SpawnOrchestrator.spawn/4`, and `Server.init/1`'s injected
  `refresh_plan` closure ALREADY re-reads the DB row on every respawn. So
  live-apply = **persist new value → stop → respawn → refresh_plan picks
  it up for free.** No new Session.Server state, no new teardown, no new
  live-client verb. Derive, don't duplicate.

**vjt's binding rulings.**

- **B — ident validation:** STRIP a leading `~` (sanitize off, don't
  reject the input), cap length **10**, shape `^[A-Za-z0-9._-]{1,10}$`
  (no `@`, no whitespace). **Stripping the tilde IS the anti-spoof
  guard**: grappa runs no identd, so the upstream ircd tilde-prefixes
  unverified idents (`~foo`) to mark them identd-UNVERIFIED; a
  user-supplied leading `~` must not be presented as identd-checked.
  Strip only ONE tilde so `~~evil` → `~evil` then FAILS validation
  (stripping-all would silently accept the spoof as `evil`). realname
  needs only the existing CR/LF/NUL `safe_line_token` guard — free-form,
  spaces legal, NO anti-spoof (realname isn't an identd surface). Single
  source: `Grappa.IRC.Identifier.{sanitize_ident,valid_ident?}/1`,
  siblings to `valid_nick?`/`valid_channel?`.
- **C — both subjects, same storage:** ident on the existing `Credential`
  row (users) + `ident`+`realname` on the existing `Visitor` row
  (visitors). NO new identity schema/table. Non-unique, no fold, no
  conflict target — free-form attrs, NOT keys (the design note is
  explicit: ident must NOT be unique; multiple users may share one).
- **D — no new event:** rely on the reconnect's natural re-emission of the
  existing identity/window-state events + the #204 connecting view. No
  `identity_changed` event introduced.
- **E — visitor defaults unchanged:** realname unset → `"Grappa Visitor"`;
  ident unset → nick. Anon branding preserved.

**Fork A + the Boundary constraint (Option A, orch 2026-07-11).** Ruling
A called for two thin per-subject reconnect wrappers (visitor +
user-side `Networks.reconnect_credential`). Building the user wrapper
surfaced a hard Boundary collision: `SpawnOrchestrator` deps `Admission`,
and `Admission` **formally deps `Networks`** — so a `Networks →
SpawnOrchestrator` edge closes a 3-node cycle
(`Networks → SpawnOrchestrator → Admission → Networks`). The VISITOR
wrapper is boundary-clean only because `Admission` reaches Visitors via
`dirty_xrefs: [Visitors.Visitor]` (schema-only, not a formal dep). This is
also *why the existing user `/connect` path already keeps spawn
orchestration OUT of the Networks context* — `Networks.connect/1` is
DB-transition-only and `NetworksController.orchestrate_spawn/4` (the WEB
layer) calls the orchestrator. Combined with the Fork-C deferral of the
registered-user cic self-service surface, the user reconnect wrapper had
NO caller this issue. Resolution: build ONLY the visitor wrapper
(`Visitors.update_identity/2`); the user ident rides the EXISTING admin
credentials PATCH. That PATCH does NOT live-apply an ident change: like
its sibling `realname` (and unlike `password`/`auth_method`), `ident` is
NOT in `classify_session_action`'s auth-touching set, so an ident-only
admin edit is `:left_alone` and the new ident applies on the NEXT
reconnect (operator `/connect`, or the deferred user-cic self-service
path). This is deliberate + consistent — realname behaves identically
today — not a bug: the deferred user-cic follow-on's reconnect wrapper
(web layer, mirroring `orchestrate_spawn`, never the Networks context) is
what will make the user ident live-apply. Same intent as Ruling A
(per-subject wrappers over shared teardown+respawn cores, no polymorphic
verb), minus one boundary-impossible/caller-less module.

**Shape of the build.**

- **Data:** `Credential.ident` + `effective_ident/1`; `Visitor.ident` +
  `Visitor.realname` + `identity_changeset/2`; migration adds three
  nullable columns → **COLD deploy** (hot path skips `ecto.migrate`).
- **Handshake:** `AuthFSM` gains `:ident` on struct/opts/`@line_bound_fields`
  (CRLF-injection self-defense fires on it too); USER line →
  `USER #{ident} 0 * :#{realname}`. Threaded through BOTH SessionPlans,
  `Session.start_opts`, `Server.{init_opts,client_opts}`, `Client.opts` —
  total consistency, both subjects.
- **Live-apply:** `Visitors.update_identity/2` = validate+persist →
  (if a live session exists) `stop_session/3` → `SpawnOrchestrator.spawn/4`;
  the respawn's `refresh_plan` re-reads the new values. Scrollback +
  `last_joined_channels` survive (DB-backed); 001 re-JOINs from autojoin.
  Persist-only when no session is live. Returns `{:ok, visitor}` — the
  reconnect is best-effort (identity IS saved; a cap-blocked bounce is
  logged, not surfaced).
- **Doors:** `PATCH /me/identity` (visitor-only, 403 for users; rides the
  existing `/me` nginx allowlist entry — no proxy change); admin
  credentials PATCH/POST whitelist gains `ident`. Login-Advanced
  (`POST /auth/login`) carries `ident`/`realname` onto the freshly
  provisioned anon row BEFORE first spawn (a bad ident → `:malformed_ident`
  400, the row purged like a spawn failure).
- **cic:** Login-Advanced adds realname+ident fields; SettingsDrawer gains
  a visitor identity editor (seeds from `/me`, two-tap apply → PATCH →
  reconnect, reusing the connecting affordance). Registered-user cic
  self-service is the deferred follow-on.

**Test evidence.** Unit (ident sanitize/validate, both changesets,
effective fallbacks, AuthFSM USER-line with ident≠nick + ident
line-safety, plan threading); server-level (`update_identity` bounces a
live session → new pid + fresh plan carries the new ident; persist-only
when no session); REST (PATCH /me/identity 200/422/403/401, admin creds
ident edit + tilde-strip); REAL e2e (`issue152-ident-realname.spec.ts`) —
a peer IRC client witnesses `nick!~grp@host` on the visitor's PRIVMSG
after login-Advanced, then `nick!~grp2@host` after a settings live-apply
reconnect (the `~` proves bahamut tilde-prefixed the unverified ident; the
new prefix + a unique post-reconnect marker prove the reconnect
re-registered upstream AND rejoined the channel).

## 2026-07-11 — #200: decouple self-JOIN auto-focus from the per-channel WS sub lifecycle

**The leak.** Per-channel Phoenix `Channel` subscriptions in `subscribe.ts`'s
`joined` Map were only `.leave()`d on token rotation. On own-PART,
`setParted(key)` dropped the windowState entry but left the `Channel` + its
`phx.on("event", …)` handler + the framework fastlane subscription alive on the
socket forever. Over an always-on session that joins/parts many channels, the
subs accrete — bounded by *distinct channels joined-then-parted over the
session's lifetime* (it does not self-heal), tiny per unit. **Benign** resource
hygiene: a parted channel's topic goes silent server-side (the session drops the
channel from `state.members`, so it only broadcasts on `Topic.channel` for
channels it's in) — the dangling sub is inert, no event doubling, no correctness
impact. Affects users + visitors.

**The trap (why the naive fix was reverted).** S19 (`7a1cecdf`) added the
obvious teardown (`joined.get(key)?.leave(); joined.delete(key)` on own-PART) and
was REVERTED (`81c0e90a`) because it regressed part→re-JOIN auto-focus. The old
"BUG4" self-JOIN auto-focus fired on the per-channel `kind:"join"` presence
*message* (`subscribe.ts` channel handler → `setSelectedChannel`). Tearing the
sub down forced a fresh `phx.join()` on re-JOIN whose subscribe RACED the
upstream JOIN echo; when the echo won, Phoenix does not replay to a late
subscriber (framework fastlane only), BUG4 never fired, and the rejoined pane
wasn't focused.

**Challenge-the-spec (the finding that reshaped the fix).** The window STATE was
ALREADY replayed on every channel-topic (re)subscribe — `push_channel_snapshot/4`
re-seeds topic + modes + members + window_state, and `join_reply/1` re-seeds the
read cursor. The ONLY thing missing on re-subscribe was the interactive-`/join`
auto-focus TRIGGER. And you can't just replay the JOIN message on subscribe: the
snapshot path fires on EVERY join including cold-reconnect auto-rejoins, so
unconditional replay would yank focus on every reconnect. The server cannot tell
interactive-rejoin from auto-rejoin — that distinction is cic-side. So the fix
belongs in cic.

Second finding, decisive: **every this-device join site ALREADY focuses
explicitly and race-free at the issuing boundary** — `compose.ts` (`/join`,
CP17 moved focus here precisely because the per-channel path raced),
`HomePane.tsx` (featured link), `ScrollbackPane.handleJoinChannel` (invite CTA);
`DirectoryPane` deliberately does NOT (#125). So BUG4's per-channel
`setSelectedChannel` was REDUNDANT for this-device joins and only reliably fired
for CROSS-DEVICE / external (raw-REST) re-JOINs on a still-live sub.

**vjt's binding rulings (GO Option 3).**
- **(a)** focus-intent is cic-LOCAL — join/focus state stays local to the single
  cic (acceptable under the "cic NEVER originates *window-state*" invariant:
  focus is a SELECTION concern, always cic-owned, not window-state).
- **(b)** PER-DEVICE focus, NO cross-device window-state sync — focus follows the
  issuing device, not all connected devices.

**The fix (cic-only).** (1) Remove BUG4's per-channel `setSelectedChannel` — the
per-channel WS handler no longer originates selection. (2) Re-apply S19's
teardown-on-own-PART. This is safe now precisely because auto-focus is decoupled:
on re-JOIN, the race-free user-topic `window_pending → joined` chain (CP17/F1,
delivered on the boot-joined user topic — cannot race a subscribe) drives state
recovery + re-subscribe (the pending pre-subscribe loop), the join-reply
`refreshScrollback` backfills the JOIN row, and focus comes from the this-device
issuing boundary. No arm/consume-intent machinery was needed — interactive focus
already existed synchronously in compose/HomePane/CTA.

**Behavior change (per ruling b).** An external/cross-device re-JOIN no longer
auto-focuses the channel on a device that didn't issue it (previously the
per-channel broadcast fanned focus to every device). This is more correct
(per-client focus, irssi-like). The one e2e that leaned on the old cross-device
behavior — `r6-own-action-no-events-badge` (re-JOINs via raw REST, then relied on
BUG4 to focus #bofh) — was updated to select explicitly; its actual subject is
the own-presence unread-marker/badge suppression, not the focus mechanism.

**Deploy class: cic-only → HOT** (`subscribe.ts` + tests; no `.ex` touched, no
migration).

## 2026-07-11 — #211 phase 1 (L2 epic): Credential becomes subject-polymorphic (XOR FK) + `networks.visitor_enabled`

First phase of the #211 L2 epic (unify visitor identity onto the user
Credential model → visitors ≈ users, multi-network visitors). **L2
confirmed by vjt; L3 (full `subjects`+`subject_id` merge) DEFERRED.**
Phase 1 is **schema EXPAND only** — no behavior cutover, no drops. It
rode a combined COLD deploy window with #152 + #200, so the hard
constraints were: strictly expand-only, rollback-safe, backfill
idempotent + zero-data-loss on real prod visitors.

### What landed

- **`network_credentials` promoted to the subject-XOR shape.** Gains a
  nullable `visitor_id` (FK visitors, ON DELETE CASCADE) as the XOR
  partner of `user_id` — the established `Grappa.Subject` pattern the 8
  downstream tables already use (NOT a role/type flag; Rule-6 is not
  triggered by XOR-FK). Enforced at 3 layers mirroring
  `Grappa.ReadCursor.Cursor`: schema `validate_subject_xor/1` (errors on
  synthetic `:subject` key), DB CHECK `network_credentials_subject_xor`,
  and two partial unique indexes
  (`(user_id,network_id) WHERE user_id IS NOT NULL` +
  `(visitor_id,network_id) WHERE visitor_id IS NOT NULL`).
- **`networks.visitor_enabled BOOLEAN NOT NULL DEFAULT false`** — the
  runtime per-network visitor allowlist flag that will replace the
  compile-time `:visitor_network` pin. Phase 1 lands ONLY the column +
  schema field + `false` default ("play safe", vjt); the login/attach
  READ + admin toggle endpoint are **phase 3**. Behavior-neutral now.

### Why the composite PK had to go (the one structural change)

Pre-#211 `network_credentials` was `PRIMARY KEY (user_id, network_id)`
with `user_id NOT NULL`. A composite-PK column cannot be NULL, but a
visitor credential carries `user_id IS NULL`; sqlite also rejects
`ALTER TABLE ADD CONSTRAINT` and in-place PK drops. So the XOR promotion
is a **table-recreate** (the `20260515005117_xor_fk_user_settings`
template) that drops the composite PK for a **surrogate `id INTEGER PK
AUTOINCREMENT`** — matching every other already-XOR table (read_cursors,
query_windows, user_settings; none keep a composite). The surrogate is
invisible to callers: every callsite keys by `(subject_id, network_id)`
via `Repo.get_by`/`where`, never by PK struct identity. Per-subject
uniqueness moved from the PK to the two partial indexes. Notably the
named index `network_credentials_user_id_network_id_index` — which the
changeset's `unique_constraint/3` already referenced but which NO
migration ever actually created (the composite PK had provided the
uniqueness) — is finally created here, alongside its visitor twin.

### The identity columns already existed

Every per-network identity column the epic scoped for visitors
(`nick`/`ident`/`realname`/`sasl_user`/`password_encrypted`/
`auth_method`/`last_joined_channels`) was ALREADY on Credential (users
have them). So phase 1's net-new columns are exactly **two**:
`visitor_id` + `visitor_enabled`. The shared identity-tuple EXTRACTION
that kills the #152 duplication is **phase 2**, not phase 1.

### Backfill (prod-critical, idempotent, zero-loss)

A separate data migration (`20260711125000`) creates ONE Credential per
existing visitor: `nick/ident/realname/last_joined_channels` copied;
`network_id` resolved from `visitors.network_slug`; `auth_method` =
`nickserv_identify` iff a committed password exists else `none` (mirrors
`Visitors.SessionPlan.auth_method/1`); `sasl_user` = the visitor nick.
Key decisions:

- **`password_encrypted` is a raw ciphertext byte-copy in SQL** — both
  columns are the same Cloak `EncryptedBinary` BLOB under the same
  `Grappa.Vault`, so copying the stored bytes preserves
  encryption-at-rest with NO decrypt/re-encrypt. A test asserts the
  copied bytes are byte-identical AND that the vault decrypts them back
  to the original plaintext.
- **`inserted_at`/`updated_at` are COPIED from the visitor row**, not
  stamped `now` in raw SQL — the visitor timestamps are already in the
  exact ecto_sqlite3 `:utc_datetime_usec` storage shape, so they
  round-trip through the loader guaranteed; a hand-built `strftime` risks
  a format drift that only surfaces as a load crash. Semantically the
  binding age IS the visitor age.
- **Idempotent** via `WHERE NOT EXISTS (matching visitor credential)` —
  the dry-run vjt ran against a COPY of the prod sqlite DB and the real
  run are identical + repeatable.
- **`expires_at`/`ip` STAY on the visitor identity row** — they are
  identity/TTL lifecycle, not per-`(subject, network)` attributes.
- **Orphan-slug visitors are skipped** (JOIN drops them; no Credential,
  no error, visitor row untouched) — `Bootstrap.validate_visitor_networks!`
  remains the loud boot-time signal for that case.

### Expand→contract boundary (explicit)

`Visitor` is UNTOUCHED this phase (expand rule): it keeps
`network_slug` + its `(fold(nick), network_slug)` folded-unique index
(#121) + all identity columns, because ~30 readers still assume
`Visitor.network_slug` non-null. Dropping those is **phase 7
(contract)**. The rfc1459 folded-nick UNIQUENESS therefore stays on
`visitors` this phase and only migrates onto the Credential at phase 7
(where it must reuse `Identifier.nick_fold` char-identical SQL). Phase 1
adds no nick-bearing index, so the fold invariant is preserved by not
being touched.

Rollback: `down/0` reverts to the composite-PK user-only shape,
discarding the backfilled visitor credentials (`WHERE user_id IS NOT
NULL`) — visitor rows themselves are untouched, so no visitor data is
lost. Full up→down→up round-trip verified.

**Deploy class: COLD** (table-recreate + new columns + data backfill;
the hot path skips `ecto.migrate`). Design comment: issue #211
comment 4945661060.

## 2026-07-11 — #211 phase 2 (L2 epic): extract the shared IRC-identity tuple (`Grappa.IRC.Identity`)

Second phase of the #211 L2 epic. Phase 2 is a **pure behavior-neutral
refactor** — the de-duplication the epic exists to enable. No storage
change, no migration, no wire/cic change, no visitor column dropped
(that is phase 7's contract). Rides the same deferred end-of-crank COLD
window as the rest of the functional stack; NOT deployed on its own.

### The duplication it kills

The IRC-registration identity tuple's validators + `effective_*`
fallbacks were pasted **verbatim into two schemas** — the #152 pain the
L2 epic exists to remove, where a review-fix bug had to be patched three
times independently:

- `Networks.Credential`: `sanitize_ident/1`, `validate_nick/2`,
  `validate_ident/2`, `validate_safe_line_token/2`, plus public
  `effective_ident/1`/`effective_realname/1`/`effective_sasl_user/1`.
- `Visitors.Visitor`: verbatim copies of the same four validators.
- `Visitors.SessionPlan`: private `effective_ident/1` +
  `effective_realname/1` (the latter with the visitor-specific
  `"Grappa Visitor"` realname default).

All four validators were already thin adapters over primitives centralised
in `Grappa.IRC.Identifier` (`sanitize_ident/1`, `valid_nick?/1`,
`valid_ident?/1`, `safe_line_token?/1`) — the duplication was the
CHANGESET-LEVEL wiring (`validate_change` callbacks + the changeset step),
not the primitives.

### Shape — shared VERBS, not an embedded schema (challenge-the-spec)

The epic body said "extract into ONE embedded schema / changeset
pipeline." Investigation rejected both framings:

- **Embedded schema is wrong here.** Both schemas store the tuple as
  **flat columns** (`nick`/`ident`/`realname`/`sasl_user`/… are
  top-level fields). An `embedded_schema` forces the tuple into a nested
  map column = a storage change = out of scope (phase-7 territory, and
  unwanted even then). The codebase uses **zero** `embedded_schema`
  today; introducing the first for a refactor that changes no storage is
  heavyweight-for-nothing.
- **A single bundled pipeline is insufficient.** `Credential` applies
  `safe_line_token` to non-identity fields too (`sasl_user`, `password`,
  `auth_command_template`, `connection_state_reason`), so that verb must
  be a standalone export regardless. Given that, a bundle-plus-verb
  surface would be two ways to do the same thing — the "half-migrated →
  copy whichever is closer" trap. One consistent pattern = expose the
  verbs.
- **"Reuse the verbs, not the nouns" (rule 6) — literally.** The shared
  unit is the validators (verbs); each schema keeps its own
  `cast`/`validate_required`/`unique_constraint` wiring (the nouns,
  which genuinely differ — a visitor row has no
  `sasl_user`/`password`/`auth_method` column).

### The module

`Grappa.IRC.Identity` (`lib/grappa/irc/identity.ex`), exported from the
`Grappa.IRC` boundary alongside `Identifier` (the primitives it
delegates to). **Boundary rationale:** `Grappa.IRC` is the acyclic sink
(deps only `Grappa.OutboundV6Pool`) and **both `Networks` and
`Visitors` already dep it** — so both route through the shared module
with zero graph change and no cycle. `import Ecto.Changeset` is
ungated (external app) and `Identifier` already couples the IRC boundary
to Ecto via its `nick_fold/1` fragment macro. Surface:

- `sanitize_ident/1` — the leading-`~`-strip changeset step.
- `validate_nick/2`, `validate_ident/2`, `safe_line_token/2` —
  `validate_change/3` callbacks (same error strings verbatim).
- `effective_ident/2`, `effective_sasl_user/2`, `effective_realname/2` —
  value-level fallbacks taking plain strings (NOT structs), so the
  module never depends on either schema struct.

### The `effective_realname` divergence is a PARAMETER, not two impls

A user's realname falls back to its `nick`; a visitor's falls back to
the `"Grappa Visitor"` branding default (vjt ruling E). That is one rule
with a per-subject fallback ARGUMENT (`effective_realname(realname,
fallback)`): `Credential` passes `nick`, the visitor plan passes
`"Grappa Visitor"`. `Credential.effective_ident/1`/`effective_realname/1`
/`effective_sasl_user/1` stay as thin struct-accessor wrappers
delegating to the shared verbs — the public API + domain-accessor
contract (no leaky abstraction) is preserved, so `Networks.SessionPlan`
call sites are unchanged.

### Behavior-neutral proof

The existing `credential_test`/`credential_xor_test`/`visitor_test`/
`session_plan_test` are the characterization lock — staying green proves
neutrality; the new `Grappa.IRC.IdentityTest` pins the shared verbs
directly (schemaless changeset, both realname fallback branches). A
review agent enumerated the full `(binary | nil)²` input space for every
`effective_*` verb against its deleted original and confirmed
byte-identical results (including the unreachable both-nil
`FunctionClauseError`). e2e `issue152-ident-realname` (visitor
login-Advanced ident → USER line → settings live-apply reconnect) +
`admin-credentials` realname edit both green — the tuple still
round-trips to upstream identically for both subjects.

**Deploy class: COLD** (deferred to the end-of-crank window with the
rest of the functional stack; NO standalone deploy). Design comment:
issue #211 comment 4946480803.

## 2026-07-11 — #211 phase 3 (L2 epic): multi-network entry + runtime `visitor_enabled` allowlist + the visitor read-cutover to Credential

Third phase of the #211 L2 epic — the first **behavior-changing** one
(phases 1-2 were expand + pure refactor). Phase 3 makes the visitor
connect chain resolve identity from the per-`(subject, network)`
**Credential** (not the raw `%Visitor{}` columns), replaces the
compile-time `:visitor_network` pin with the runtime
`networks.visitor_enabled` allowlist, and adds the admin toggle for it.
Rides the same deferred end-of-crank COLD window; NOT deployed on its
own. All 7 design forks ruled by vjt (recommended option on each).

### Piece A — runtime `visitor_enabled` allowlist replaces the compile pin

The compile-time `Application.compile_env!(:grappa, :visitor_network)`
coupling is GONE from BOTH sites (`Visitors.Login` + `AuthController`);
the `:grappa, :visitor_network` config key is removed from
`config/{config,test}.exs`. Which networks accept visitors is now the
DB flag `networks.visitor_enabled` (landed dormant in phase 1), read at
login time — naturally hot, admin-togglable without a restart, and
CLAUDE.md-compliant vs app-env. New readers:
`Networks.list_visitor_enabled/0` +
`Networks.get_visitor_enabled_network_by_slug/1`.

**Login network selection (fork 1).** `Login.login/2` input gains an
OPTIONAL `:network` slug. Present → must be `visitor_enabled` (else
`:network_not_visitor_enabled` → 403) → the existing
`(nick, network_slug)` lookup/provision runs against it. Absent (today's
cic) → default to the **sole** `visitor_enabled` network:
exactly-one-enabled = backward-compatible; zero = `:network_unconfigured`
(503); more-than-one = `:network_ambiguous` (400, can't happen until an
admin enables a 2nd network — cic sends a slug once the phase-6 picker
ships). This SUBSUMES #42 (closed).

**Continuity seed (fork 2).** `visitor_enabled` defaults `false`, so a
naive cutover leaves zero enabled networks → every visitor login breaks.
Migration `20260711130000` is **derive-from-reality** (NOT a hardcoded
slug): `UPDATE networks SET visitor_enabled = true WHERE id IN (SELECT
DISTINCT network_id FROM network_credentials WHERE visitor_id IS NOT
NULL)` — a network that currently serves visitors IS a visitor network.
Idempotent, expand-only, works for any deployment.

### Piece B — admin `visitor_enabled` toggle (no new route, no nginx change)

The toggle rides the EXISTING `PATCH /admin/networks/:slug`
(`Admin.NetworksController.update/2`, already behind `:admin_authn`,
already nginx-allowlisted — `/admin/networks` is in the
`locations-api.conf` regex alternation). `Networks.update_network_caps/2`
was renamed `update_network_settings/2` (one verb now owns the whole
editable-network-settings surface — caps + the allowlist flag; a
"caps"-named verb that also flips `visitor_enabled` would mislead). The
controller's body allowlist widened to accept `visitor_enabled`;
`Networks.AdminWire.network_to_admin_json/1` now surfaces it. cic UI is
deferred to phase 6 (fork 7) — phase 3 ships endpoint + wire only.

### Piece C — the READ-CUTOVER (the heart)

`Visitors.SessionPlan.resolve/1` stops reading `%Visitor{}` identity
columns and reads the visitor's `(visitor_id, network_id)`
**Credential**. Cutting that ONE resolver cuts the whole chain — all
three callers (Login spawn, Bootstrap respawn, reconnect) + the injected
`refresh_plan` closure route through it (total consistency, no split
reader).

**Two resolvers, shared fields-only builder (fork 3).** Extracted
`Networks.SessionPlan.base_plan/6` — the ~14 identity/connect fields that
are byte-identical for a user and a visitor credential (subject / label
/ nick / ident / realname / sasl_user / auth_method / password / autojoin
/ host / port / tls / source_address). Each resolver merges its OWN
subject-specific callbacks on top (user: 4; visitor: 6 + the anon→IDENTIFY
login dance) — those genuinely differ and live in different context
modules. This is exactly phase 2's ruling ("reuse the VERBS, not the
nouns"): shared verb = the field-flatten; per-subject wiring = the
callbacks. The `realname` fallback is a `base_plan` PARAMETER (user → its
own nick; visitor → `"Grappa Visitor"`, ruling E), one rule two call
sites (fork 4). One-resolver unification is a natural phase-5/7 endgame,
NOT forced here.

**Fields converge (why the cutover is clean).** The phase-1 backfill made
`credential.auth_method` == the visitor's derived `:none |
:nickserv_identify`; `sasl_user` == nick; `autojoin_channels='[]'` so
`merge_autojoin([], last_joined)` == the pre-cutover `last_joined`-only
list. Only the realname fallback diverged (handled by the param). So the
existing `session_plan_test` characterization lock stays green through
the cutover — behavior-neutral for existing visitors because the
write-through keeps the Credential == the visitor row.

**Write-path maintenance + reconcile (forks 5, 6).** ONE idempotent
choke-point verb, `Credentials.upsert_visitor_credential/3` (primitives,
no `%Visitor{}` — Networks needs no Visitors dep, the FK stays a
dirty_xref), is reused by BOTH: (a) the per-mutation write-through —
`Grappa.Visitors` calls it after EVERY visitor identity mutation
(`find_or_provision_anon`, `commit_password`, `rotate_password`,
`update_nick`, `update_identity`, `update_last_joined_channels`,
`remove_autojoin_channel`) via the private `sync_credential/1`; and (b)
the bulk reconcile at `Bootstrap.run/0` (before `spawn_visitors`) via
`Visitors.reconcile_credential/1`. Same operation ("make the Credential
match the visitor"), bulk-applied vs single. This MOOTS the phase-1
dormant-drift concern (new/changed visitors get correct creds at write
time) and self-heals drift at boot. `resolve/1` also self-heals a
missing credential on first use (`Visitors.resolve_credential/2` creates
it from the visitor row). The subject-scoped reader
`Credentials.get_visitor_credential/2` (`WHERE visitor_id ==`, never
`user_id ==`) keeps a visitor out of the user resolver's
`Accounts.get_user!(nil)` crash BY CONSTRUCTION — the phase-1
subject-blind-reader class (`feedback_xor_fk_promotion_audit`).

### What STAYS (phase-7 hold — HARD rule)

No visitor column dropped: `visitors.network_slug`/`nick`/`ident`/
`realname`/`password_encrypted`/`last_joined_channels` all stay and are
DUAL-WRITTEN (visitor row + Credential) through the transition. The
`(fold(nick), network_slug)` folded-unique index stays the identity
guard. Visitor wire display (`Visitors.Wire`/`AdminWire`) untouched —
dropping singular `network_slug` from the wire is phase 6.
`Bootstrap.validate_visitor_networks!` still reads `visitor.network_slug`
as the boot orphan-guard. The temporary identity duplication is the
standard expand→contract shape the whole L2 epic is built on; phase 7
removes it.

**Deploy class: COLD** (data migration + read/write cutover; hot path
skips `ecto.migrate`). Deferred to the end-of-crank window. Design
comment: issue #211 comment 4947161594.
