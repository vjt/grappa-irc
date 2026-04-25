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

- **Client framework:** Svelte vs SolidJS vs plain lit-html. Decision deferred to Phase 3 (client walking skeleton). Criteria: PWA shell ergonomics, service-worker story, bundle size budget (≤200 KB gzip target before optional Vosk/piper drop-ins). Note: any choice integrates with `phoenix.js` (3KB, framework-agnostic) for the Channels client.
- **KV vs sqlite for scrollback:** sqlite via `ecto_sqlite3` is the chosen default. The pagination-heavy access pattern + per-user row counts + the need for indexed lookup by (channel, server-time) all favour SQL. Revisit only if the sqlite file turns out to be the bottleneck.
- ~~**Session token format:** `Phoenix.Token` short-lived access + long-lived refresh, or single long-lived + revocation list. Phase 2 concern.~~ **Resolved 2026-04-25:** opaque UUID session ID + sliding 7d idle expiry + revocation table. See dedicated DESIGN_NOTES entry above.
- **How to expose multi-network per user in the UI** without descending into tree-view hell. Phase 3 concern.
- **Coverage floor:** start CI at 80%; ratchet up each major release. No exclusion lists — if a file is hard to test, the design needs fixing, not the gate.

---

## What's *not* in this document (on purpose)

- Anything that was decided inside a private channel and hasn't been published elsewhere. The repo is public; private crew chatter stays private.
- Implementation scheduling ("I'll do X next week") — that belongs on the issue tracker, not in-repo.
- Anything that belongs in `CONTRIBUTING.md` or a future issue template — to be added when the project moves past spec-only.
