# grappa-irc

> An always-on IRC bouncer with a REST-first API and a browser PWA that looks like irssi.

![grappa-irc cover](assets/cover.jpg)

## What

Two components, one monorepo:

- **grappa** — the server. Persistent bouncer, one async task per user, terminates IRC at the server boundary, exposes a clean REST API (plus SSE or WebSocket for event push). SASL bridging to upstream NickServ. Self-hostable on any VPS.
- **cicchetto** — the client. A PWA that speaks pure REST. Never parses IRC. Installable on mobile home screens. Visually irssi; mobile ergonomics added on top, not instead.

The pitch in one sentence: *modern IRC — always-on, consumable from a phone — without making it not-IRC.*

The shorter pitch, for anyone who's been on IRC >10 years: *grappa is the equivalent of irssi inside tmux, made accessible from a browser.*

### Two facades, one store

grappa exposes the same underlying state through **two facades** that share a single scrollback store:

1. **REST + SSE** — the primary surface. Canonical API, consumed by cicchetto. IRC is fully terminated at the server; the web client is IRC-protocol-ignorant end-to-end. This is the design center.
2. **IRCv3 listener** *(phase 2+)* — a secondary, optional surface that speaks `CAP LS` + SASL + `CHATHISTORY` to existing IRCv3-capable mobile IRC clients (Goguma, Quassel mobile, etc). It is a *view* over the same store the REST surface reads from — never a second source of truth.

The two facades expose the same data. Neither introduces state the other does not. In particular: **no server-side `MARKREAD` / read watermark on either facade.** Read position is client-side, always.

## Status

Pre-alpha. Not a line of code yet. **This README is the spec.** README-driven development.

## Why this exists

There are good IRC bouncers already. [soju](https://soju.im/) + [gamja](https://sr.ht/~emersion/gamja/) is the closest shape: a persistent Go bouncer + JS web client, both maintained by emersion, both excellent.

grappa-irc diverges on one deliberate axis: **the web client does not parse IRC**. soju and gamja communicate in IRC-framing-over-WebSocket — the client re-implements IRC protocol state in the browser. That's a principled choice and it buys standards-purity via IRCv3 extensions.

grappa makes the other choice: IRC terminates at the server, the **web** client sees only REST resources (channels, messages, members, networks) and an event stream. The browser stays ignorant of IRC. Everything the web client needs — scrollback pagination, channel modes, nick changes, join/part — arrives as typed JSON.

This also means grappa works against vanilla IRC servers. **Upstream** IRCv3 extensions are opportunistic bonuses where the upstream ircd supports them, not hard requirements. No upstream `CHATHISTORY` needed: the bouncer owns scrollback.

Separately, grappa can *expose* IRCv3 downstream to mobile IRC clients — that listener is the "two facades" design above. It re-uses the same scrollback store, so for the user it looks identical whether they open cicchetto or point Goguma at grappa.

## Architecture

```mermaid
flowchart LR
    subgraph Clients["Clients"]
        cicchetto["cicchetto PWA<br/>(irssi-shape UI)"]
        mobileirc["Mobile IRCv3 client<br/>(Goguma / Quassel / …)<br/><em>phase 2+</em>"]
    end

    subgraph VPS["Self-hosted VPS"]
        rest["REST + SSE facade"]
        irclisten["IRCv3 listener facade<br/><em>phase 2+</em>"]
        store[("shared scrollback store<br/>(sqlite / any KV)")]
        rest --- store
        irclisten --- store
        subgraph tasks["async tasks (one per user)"]
            t1["user A session"]
            t2["user B session"]
            t3["user C session"]
        end
        rest --- tasks
        irclisten --- tasks
    end

    subgraph Upstream["Upstream IRC"]
        azzurra["irc.azzurra.chat"]
        libera["irc.libera.chat"]
        other["…any ircd<br/>(allowlisted)"]
    end

    cicchetto <-->|"HTTPS REST + SSE"| rest
    mobileirc <-.->|"IRC + SASL + CHATHISTORY"| irclisten
    t1 <-->|"IRC + SASL"| azzurra
    t2 <-->|"IRC + SASL"| libera
    t3 <-->|"IRC + SASL"| other
```

- Each connected user has one persistent server-side task that owns their upstream IRC connection(s).
- The task streams IRC events into a per-user ring-buffer of scrollback (bounded, paginated).
- The REST surface is a thin read/write layer over that state. Writes (send message, join, part) translate to upstream IRC commands; reads return typed JSON.
- New events push to connected clients over SSE (or WebSocket if negotiated). Disconnected clients catch up on next connect via the paginated scrollback endpoints.

## Design principles

1. **No IRC parsing in the web client. Ever.** REST is the contract for cicchetto. The browser never sees a raw `PRIVMSG`. Mobile IRC clients talking to the optional IRCv3 listener are a separate case — they parse IRC by definition, that's what they are.
2. **Upstream IRCv3 is opportunistic, not required.** grappa works against any ircd that speaks `CAP LS` + SASL. Fancy upstream extensions are bonuses. *Downstream* (toward IRCv3 mobile clients) grappa will speak `CAP` + SASL + `CHATHISTORY` fully, because that's the point of the second facade.
3. **Scrollback is bouncer-owned.** One store, paginated API for REST, `CHATHISTORY` mapping for the IRCv3 listener. No dependency on upstream server-side `CHATHISTORY`.
4. **Auth is NickServ.** Login via SASL handshake against upstream. Registration proxied through a dedicated endpoint.
5. **Self-hostable.** Any VPS. sysadmin-configurable allowlist for upstream IRC servers.
6. **Irssi-shape on desktop, irssi-shape on mobile too.** Large screens nearly identical to irssi (themes + keybindings). Mobile keeps the same visual grammar but adds touch-ergonomic helpers (channel switcher, tap targets, soft keyboard handling). No chat-app metaphor — it's still IRC.
7. **No images, no voice, no file sharing.** It's IRC. Those problems belong to someone else.
8. **No mobile push infrastructure.** If the browser's PWA push API is available, we use it. Otherwise, no notifications. We don't run notification servers.

## REST surface (first draft)

All endpoints are authenticated except `POST /auth/login` and `POST /auth/register`.

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/auth/login` | SASL-bridged login against a configured upstream network |
| `POST` | `/auth/register` | Proxy NickServ `REGISTER` on upstream |
| `POST` | `/auth/logout` | Invalidate session |
| `GET`  | `/me` | Current session info |
| `GET`  | `/networks` | Configured networks for current user |
| `POST` | `/networks` | Add a network binding |
| `DELETE` | `/networks/:net` | Remove a network binding |
| `GET`  | `/networks/:net/channels` | Joined channels on that network |
| `POST` | `/networks/:net/channels` | Join a channel |
| `DELETE` | `/networks/:net/channels/:chan` | Part |
| `GET`  | `/networks/:net/channels/:chan/messages?before=<ts>&limit=N` | Paginated scrollback |
| `POST` | `/networks/:net/channels/:chan/messages` | Send |
| `GET`  | `/networks/:net/channels/:chan/members` | Nicks + modes |
| `POST` | `/networks/:net/raw` | Escape hatch: send a raw IRC line |
| `GET`  | `/events` | SSE stream of new events (one endpoint, multiplexed) |

Events on `/events` are typed JSON — `message`, `join`, `part`, `quit`, `nick`, `mode`, `topic`, `notice`, etc. The client updates its local state from these; it does not need to reason about IRC framing.

## Scope

**In scope:**
- Text chat on IRC. Channels, queries, notices, CTCP ACTION.
- Multi-network per user.
- Persistent scrollback with pagination.
- NickServ authentication bridging.
- PWA that works on phones without an app-store detour.
- Self-hosting for individuals and small groups.

**Out of scope:**
- File sharing (DCC, HTTP uploads, anything).
- Voice, video, audio messages.
- Inline image/video/link unfurling beyond a URL as text.
- Running as a hosted multi-tenant SaaS. Self-hosted only.
- Push notification servers. PWA push only if the browser provides it.
- Being kinder to the ircd than the ircd is to itself.

## Prior art (read for behavior, not imported)

- [**soju**](https://soju.im/) — SASL bridging, scrollback ring-buffers, reconnect/backoff policy, multi-network management. The reference for "what a correct bouncer does".
- [**gamja**](https://sr.ht/~emersion/gamja/) — web-client login UX, channel-switch flow, PWA manifest. Visually not our target (chat-app shape), but the flows are instructive.
- [**The Lounge**](https://thelounge.chat/) — another working PWA reference. Bundles server + client, which is not our split, but the manifest + service-worker setup is canonical.
- [**IRCCloud**](https://www.irccloud.com/) — the commercial mobile-IRC UX north star. A "done" version of the experience we're aiming for.
- [**ZNC**](https://znc.in/) — the classic. Not an architectural reference, but every bouncer exists in dialogue with ZNC.

None of the above is being forked or imported. grappa is greenfield. The value here is reading their code for edge cases (retry logic, SASL negotiation nuances, scrollback eviction policy) and designing around the lessons.

## Why "grappa" and "cicchetto"

"Grappa" is Italian distillate — the direct homologue of Korean *soju*. "Cicchetto" is the small glass of wine, often accompanied by a bite, served at a *bàcaro* (a Venetian-style neighbourhood wine bar); parallel to *gamja*, the potato that accompanies soju in Korea. The naming is a deliberate riff on soju/gamja.

It is also a tribute: **Italian Grappa!** has been the call-sign of the [Italian Hackers' Embassy](https://events.ccc.de/camp/2019/wiki/Village:Italian_Hackers'_Embassy) at European hacker camps since 2001. The [Associazione Inclusive Hacker Framework](https://italiangrappa.it/) is the legal entity that carries the name today. This repository is not affiliated with that association; it borrows the cultural reference in the spirit it was intended — Italian hackers showing up somewhere with a bottle.

## Roadmap

### Phase 0 — spec (you are here)
- [x] README
- [ ] OpenAPI schema for the REST surface
- [ ] Pick a server language (Rust vs Go — decision pending)
- [ ] Pick a client framework (Svelte vs SolidJS vs plain lit-html)

### Phase 1 — server walking skeleton
- [ ] Single-user bouncer, single upstream network, hardcoded credentials
- [ ] Basic REST: `/networks`, `/channels`, `/messages` (paginated), `/events` (SSE)
- [ ] sqlite-backed scrollback
- [ ] Send + receive `PRIVMSG` round-trip

### Phase 2 — auth + multi-user
- [ ] SASL bridge for login
- [ ] NickServ `REGISTER` proxy
- [ ] Session tokens (short-lived + refresh)
- [ ] Per-user isolation

### Phase 3 — client walking skeleton
- [ ] PWA shell, manifest, service worker
- [ ] Login flow → token → connect `/events`
- [ ] Channel list + scrollback fetch on select
- [ ] Send message

### Phase 4 — irssi-shape UI
- [ ] Keyboard-first layout, theme system
- [ ] Nick list, mode indicators, topic bar
- [ ] Mobile ergonomics layer (touch helpers, not a different shape)

### Phase 5 — hardening
- [ ] Reconnect + backoff
- [ ] Scrollback eviction policy
- [ ] Allowlist configuration for upstream networks
- [ ] Docs for self-hosters

### Phase 6 — IRCv3 listener facade
- [ ] Downstream `CAP LS` + SASL, identity bridged to the same session the REST surface uses
- [ ] Map paginated scrollback to `CHATHISTORY` (`BEFORE`, `AFTER`, `BETWEEN`, `LATEST`)
- [ ] `server-time`, `message-tags`, `batch`, `labeled-response`
- [ ] Drop-in compatibility target: [Goguma](https://sr.ht/~emersion/goguma/), [Quassel](https://quassel-irc.org/), [mIRC 7.64+](https://www.mirc.com/) with IRCv3 support
- [ ] Deliberately **not** exposed: `MARKREAD` / server-tracked read positions

## Contributing

Pre-alpha. Issues welcome for design feedback on this spec; code PRs are deferred until Phase 1 lands.

## Why this exists (the longer story)

This project has a motive, not just an architecture. Three posts are the backstory:

- **2002 — [Forking Bahamut for Azzurra IRC: IPv6 and SSL in 2002](https://sindro.me/posts/2026-04-13-bahamut-fork-azzurra-irc-ipv6-ssl/)** — how a 21-year-old ended up forking an IRC server to add IPv6 and SSL because the Italian IRC network he'd fallen in love with needed it. The DNA of why IRC, specifically, and why Azzurra, specifically.
- **2002–2005 — [Sux Services: Multithreaded, SQL-Backed IRC Services from Scratch, 2002](https://sindro.me/posts/2026-04-14-suxserv-multithreaded-sql-irc-services/)** — the sequel: writing IRC services from scratch in C, with real threading and a real SQL backend, because the off-the-shelf ones weren't good enough. Same instinct that drives grappa: if the existing thing is almost right but not quite, write the thing.
- **2026 — [Claude walks into #it-opers](https://sindro.me/posts/2026-04-17-claude-walks-into-it-opers/)** — how, twenty-four years later, the same crew is still on the same network, still in the same channel, and a Claude Code session was bridged into IRC as `vjt-claude`. The evening that surfaced the "we should just do this" for grappa.

The throughline:

- **Nostalgia**, honestly admitted. Azzurra is still alive. The nick and channel databases have been preserved across multiple network "earthquakes"; the servers and services kept running; the infrastructure cared for by people who still want it to be there. Individuals come and go — but *the spirit carries on*. **That** is the persistence worth investing in — the network itself, not any single nick — and it is a feature, not a nostalgia trap.
- **A general preference for self-hosted chat platforms** over whatever-SaaS-is-ascendant-this-year. Matrix, XMPP, IRC, the whole family. IRC's particular virtue is that the protocol is 30 years old, doesn't care about you, and will keep working when the vendor in question pivots or dies.
- **A preference for text-only communication** over the modern overloaded stuff. No unfurls, no reactions stacked on reactions, no threaded-inside-threaded, no "is-typing" indicators, no presence surveillance. Just text. What the brain wants to be reading at 23:00 after a day on Teams.

grappa isn't a product pitch. It's a tool built for a specific set of people who still want to use IRC on a phone in 2026, and who would rather self-host it than rent it.

## License

MIT — see [`LICENSE`](LICENSE).

## Author

[vjt](https://github.com/vjt) (Marcello Barnaba), who built [bahamut-inet6](https://github.com/vjt/azzurra-bahamut-inet6) and [suxserv](https://github.com/vjt/azzurra-suxserv) for the [Azzurra IRC network](https://www.azzurra.chat/). grappa-irc is the 2026 attempt at making Azzurra — and any IRC network — liveable on a phone.
