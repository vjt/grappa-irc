# grappa — project evolution

Header stats updated every session. Source of truth for "where are we
in the project's lifecycle?"

---

**Last generated:** 2026-04-25
**Period covered:** 2026-04-18 (kickoff in #it-opers) → 2026-04-25 (Phase 0 complete)

## Phase status

| Phase | Status | Lands |
|-------|--------|-------|
| 0. Spec | **complete** | README + DESIGN_NOTES + walking-skeleton plan + tooling scaffold |
| 1. Server walking skeleton | next | Single-user bouncer, REST + Channels, sqlite scrollback, PRIVMSG round-trip |
| 2. Auth + multi-user | scheduled | SASL bridge, NickServ proxy, Phoenix.Token sessions |
| 3. Client (cicchetto) walking skeleton | scheduled | PWA shell, login, channel list, scrollback, send |
| 4. irssi-shape UI | scheduled | Themes, keybindings, mobile ergonomics, voice I/O |
| 5. Hardening | scheduled | Reconnect/backoff, scrollback eviction, allowlist, TLS verify |
| 6. IRCv3 listener facade | scheduled | Goguma/Quassel compatibility, CHATHISTORY mapping |

## Stats

| Metric | Value |
|--------|-------|
| Total commits on main | (run `git rev-list --count main`) |
| Sessions | 1 |
| Lines of Elixir | 0 (Phase 1 not started) |
| Lines of Markdown spec | ~3000 |
| Test count | 0 |
| Coverage | n/a |
| Pace | sessions per week (track once trend exists) |

## Decisions to date

(See `docs/DESIGN_NOTES.md` for the full chronological log.)

- 2026-04-18 — pitch: persistent per-user IRC session + REST API + irssi-shape PWA.
- 2026-04-19 — rejected: terminal-in-browser (Glowing Bear) + IRC-over-WebSocket (soju+gamja).
- 2026-04-20 — server architecture: process-per-user + sqlite scrollback + REST + multiplexed event streaming.
- 2026-04-20 — rejected: forking soju (IRCv3-first DNA fights REST-first design).
- 2026-04-20 — opportunistic IRCv3 upstream; required floor is `CAP LS` + SASL.
- 2026-04-20 — two facades, one store: REST primary, IRCv3 listener phase 2+ (now phase 6).
- 2026-04-20 — no server-side `MARKREAD` / read cursors. Client-side only.
- 2026-04-20 — client owns UI state; server owns session state.
- 2026-04-20 — grappa is NOT an ircd; it's a bouncer-and-then-some.
- 2026-04-25 — server stack: Elixir/OTP + Phoenix (decision recorded with rationale + tradeoffs).
- 2026-04-25 — Phoenix Channels for streaming surface (replaced SSE).
- 2026-04-25 — reconnect-on-deploy is acceptable; hot-reload is NOT load-bearing.
- 2026-04-25 — rigid tooling baseline: Dialyzer + Credo strict + Sobelow + mix_audit + doctor + Boundary, every CI gate mandatory.

## Roadmap horizon

Phase 1 walking skeleton is 10 TDD tasks per
`docs/plans/2026-04-25-walking-skeleton.md`. Ship target: **one full
functioning bouncer connected to Azzurra, persisting scrollback,
delivering events over Phoenix Channels** by end of Phase 1.

Phase 2 (auth + multi-user) follows directly. Phase 3 (cicchetto PWA)
gates the actual product UX.
