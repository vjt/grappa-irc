# Phase 4 — Product Shape Brainstorm

**Date:** 2026-04-27
**Status:** Brainstorm — design approved, awaiting per-cluster implementation plans
**Cluster sequence:** E1 → P4-1 → P4-V (Phase 4 closes here) → M2 → M3 → M3-A (post-Phase-4)
**Author:** Marcello Barnaba (vjt) + Claude (brainstorm session)

---

## Context

The original Phase 4 framing in `docs/todo.md` was narrow ("irssi-shape UI
redesign"). The expanded framing is wider: **Phase 4 designs the web-IRC
PRODUCT** — three auth modes baked in alongside the irssi-shape UI,
treated as one inseparable design surface, because the UI's login flow
has to expose three entry paths and the auth-mode choice constrains the
data model the UI consumes.

The three auth modes:

1. **Mode 1 — local-DB multi-network bouncer (current Phase 2, unchanged).**
   Operator binds users + networks via mix tasks. Multi-network per user,
   long-lived bearer tokens, Cloak-encrypted upstream credentials. The
   bouncer use case: vjt + Italian Hackers' Embassy + Azzurra crew.

2. **Mode 2 — NickServ-as-IDP single-network.**
   Visitor logs in with nick + NickServ password. Grappa probe-connects,
   on success lazily creates a User row keyed on (nick, network). The
   community-runs-grappa-for-its-network use case (Azzurra/Libera/OFTC).

3. **Mode 3 — anonymous, ephemeral.**
   Visitor types a nick, no password. Grappa creates an ephemeral User
   row + cookie-bound bearer. 48h TTL. The web-IRC equivalent of a
   webchat gateway for someone wanting to lurk in a public channel from
   their phone without registering.

The brainstorm walked these as one design surface and decomposed Phase 4
into clusters that ship the visual model + auth mode 1 first, and
preserve modes 2+3 as additive post-Phase-4 clusters.

## Decisions

### D1. First-ship scope: Mode 1 only

Phase 4 first ship implements **mode 1 only** (operator-bound, current
Phase 2). Modes 2+3 are deferred to post-Phase-4 clusters (M2, M3).

**Rationale:**
- Walking-skeleton discipline — get irssi-shape on vjt's iPhone first,
  validate the visual model, then expand auth surface.
- Modes 2+3 are **purely additive** on top of mode 1: new endpoints,
  optional `users.expires_at` column, additive cookie path on `Plugs.Authn`,
  Reaper GenServer as new supervision-tree child, additive operator
  config for single-network gating. NO wire-shape break, NO schema
  break, NO architectural retrofit required in P4-1.
- "Don't design for hypothetical future requirements" (CLAUDE.md). P4-1
  ships pure mode 1 with zero hooks for modes 2/3.

### D2. Anon (mode 3) data model: real User row + cookie

**Mode 3 anon = real `users` row + random bearer-as-cookie + 48h TTL.**
The cookie token IS the secret (HttpOnly, SameSite=Lax, Secure once TLS
lands). `users.password_hash` is filled with an Argon2-hashed random
secret the user never sees — only the bearer-as-cookie identifies them.
Reuses every existing Scrollback verb. NO nullable `messages.user_id`.
NO separate `anon_messages` table. NO new context boundary.

**Rationale:** "Reuse the verbs, not the nouns" (CLAUDE.md). The verbs
(User CRUD, Scrollback persist, Session.Server lifecycle, PubSub topic
shape) all reuse unchanged. The 20% that doesn't fit:
- `users.expires_at` field (additive migration in M3 cluster)
- Reaper GenServer (additive supervision-tree child)
- Cookie path on `Plugs.Authn` (additive plug change)

This is the cleanest forward-compat shape and was pinned in the
brainstorm so the Scrollback context evolves on a known trajectory.

**Cookie loss = scrollback loss.** Document loud in:
- The login UI for mode 3 (warns "your session lasts 48h on this
  browser; clearing cookies = losing your scrollback")
- The cicchetto README + the operator-facing README
- DESIGN_NOTES (the immutability-of-cookie-loss principle)

No magic recovery. No "email me my session" path (that requires identity
= mode 1 or 2).

### D3. UI layout: B (three-pane responsive) + mIRC-default theme

Phase 4 first ship UI is the **three-pane responsive layout**:
- Left sidebar: networks + channels (tappable, with mention badges and
  unread indicators)
- Middle: topic bar + scrollback + compose
- Right sidebar: nick list (with mode prefixes @/+, mIRC nick palette)
- Mobile: sidebars collapse to swipe drawers

**Theme system:** mIRC-light + irssi-dark presets via CSS custom
properties + `data-theme` attribute. `prefers-color-scheme` auto-detect
on first load; user override stored in localStorage.

**irssi keyboard shortcuts preserved for power users:**
- `Alt+1..9` — channel switch by index
- `Ctrl+N` / `Ctrl+P` — next/prev unread
- `/` — focus compose
- `Esc` — close drawer (mobile)
- `Tab` / `Shift+Tab` — nick autocomplete cycle (in compose)

**Rationale:** The audience is a mix of irssi-power-users (Azzurra crew)
+ mIRC-veterans + non-techies. Tappable channels = discoverable for
non-techies. mIRC palette = familiar to anyone who's been on IRC since
1996. Keyboard shortcuts = preserved for power users on desktop.

C (irssi-faithful with numbered window tabs Alt+N) was rejected: more
authentically-irssi but keyboard-first; tabs are tappable but small +
less discoverable for non-techies. A (single-pane purist) was rejected:
smallest cut but cuts the soul of the design (no nick list).

### D4. A6 architectural close: full retire (all 10 message kinds)

E1 cluster closes A6 entirely. Producer-side gap closed for all 10
message kinds: `:privmsg | :notice | :action | :join | :part | :quit |
:nick_change | :mode | :topic | :kick`. Wire+renderer already advertise
all 10 (CP10 C3 widened both); E1 brings the producer in line.

**Rationale:** Architecture review was clear: "either accept deferral
and explicitly TAG unused kinds as schema-reserved, OR implement
persistence for all of them." Half-measures encode the same drift the
review flagged. Marginal cost from minimal (presence only) to full is
~150 LOC; cluster size jumps from "half session" to "~3/4 session" but
stays within D-cluster scope. Once E1 closes, the wire+renderer+producer
triangle is finally aligned and Phase 5 starts on clean foundation.

**E1 lands BEFORE P4-1.** Phase 4 first-ship UI operates on a clean
post-A6 surface. Decomposing into E1 + P4-1 (rather than one
mega-cluster) mirrors the D-cluster pattern proven across D1+D2+D3.

### D5. Voice I/O: P4-V (own cluster, after P4-1)

Voice I/O lands as its own cluster after P4-1 ships. Browser-native
`SpeechSynthesis` + `SpeechRecognition` first; Vosk/piper offline
drop-in deferred to Phase 4.6 or Phase 5.

**Rationale:** Voice I/O isn't load-bearing for "ships to vjt's iPhone
for daily-driver." Bundling into P4-1 inflates cluster size and dilutes
review focus. Voice I/O needs DESIGN (toggle placement, ARIA wiring,
mute/unmute, mobile-keyboard interaction) that deserves its own
cluster's attention.

### D6. Modes 2/3 future-proofing hooks: NONE

P4-1 ships pure mode 1 with zero hooks for modes 2/3.

**Rationale:** Modes 2+3 are purely additive (see D1). No premature
abstraction needed. Login UI gets second/third tab in M2/M3 as a
one-component rewrite. `Plugs.Authn` gets additive cookie path in M3.
`users.expires_at` is an additive migration in M3. No P4-1 architecture
needs to anticipate them.

## Cluster trajectory

```
┌─────┐   ┌──────┐   ┌──────┐
│ E1  │ → │ P4-1 │ → │ P4-V │  ← Phase 4 closes here
└─────┘   └──────┘   └──────┘
                        │
                        ▼
                   ┌──────┐   ┌──────┐   ┌────────┐
                   │  M2  │ → │  M3  │ → │  M3-A  │  ← post-Phase-4
                   └──────┘   └──────┘   └────────┘
                                  (additive — no P4 retrofit)
```

### E1 — A6 architectural close

**Scope:** server-side only, mechanical, well-rehearsed pattern (4th
application of verb-keyed sub-context principle from D1/D2/D3).

**Module changes:**

1. **NEW: `lib/grappa/session/event_router.ex`** — pure module
   (no GenServer, no I/O), mirrors `Grappa.IRC.AuthFSM` shape from D2:
   ```elixir
   @spec route(IRC.Message.t(), Session.state()) ::
     :ignore
     | {:persist, kind :: Scrollback.kind(), attrs :: map()}
     | {:reply, [iodata()]}
   ```

2. **REFACTOR: `lib/grappa/scrollback.ex`** — `persist_privmsg/5` →
   `persist_event/1` taking `:kind` explicitly (no defaulting per
   CLAUDE.md "no default arguments via `\\`"). `persist_privmsg/5`
   deleted (zero callsites once Session.Server migrates).

3. **REFACTOR: `lib/grappa/session/server.ex`** — `handle_info({:irc, msg}, state)`
   delegates to `EventRouter.route/2`. Per-kind clauses collapse to one
   delegation. Session.Server gains `members: %{channel => MapSet.t()}`
   field updated by EventRouter's `:join | :part | :quit | :nick_change |
   :mode | :kick` handlers (small extension, ~50 LOC).

4. **NEW: handlers in EventRouter for all 10 kinds:**
   - `:privmsg` (existing, ported)
   - `:notice` — same shape as PRIVMSG, different `:kind` tag
   - `:action` (CTCP /me) — IRC.Parser already distinguishes
   - `:join | :part | :quit` — sender = nick joining/leaving; meta carries reason
   - `:nick_change` — meta carries `:new_nick`
   - `:mode` — meta carries `:modes` + `:args`
   - `:topic` — body = new topic; meta carries setter
   - `:kick` — meta carries `:target` + `:reason`

5. **NEW: `Session.list_members/2`** + REST endpoint
   `GET /networks/:net/channels/:chan/members` for cicchetto's nick
   list. Crash-safe: members rebuilt from upstream `353 RPL_NAMREPLY`
   + `366 RPL_ENDOFNAMES` on reconnect.

**Tests:** EventRouter unit tests per kind (pure module, fast); existing
Session tests verify delegation; property tests on EventRouter
classification; A6 contract test (compile-time exhaustiveness over
`Scrollback.kind()`).

**Gates:** `mix ci.check` green. Zero warnings.

**LOC estimate:** ~500 server, ~200 test. **~3/4 session.**

### P4-1 — Phase 4 first ship UI

**Scope:** cicchetto-side rewrite from single-pane to three-pane
responsive + small server-side additions.

**Server-side:**
- A5 fix: `ChannelsController.index` returns session-tracked joined
  channels, not operator's autojoin list. Wire-shape extension:
  `{name, joined: bool, source: :autojoin | :joined}`. ~50 LOC server.
- (`/members` endpoint and `Session.list_members/2` already shipped
  in E1.)

**Cicchetto-side new modules (`cicchetto/src/lib/`):**
- `theme.ts` — theme state, `prefers-color-scheme` detection,
  localStorage override, `data-theme` attribute toggle
- `keybindings.ts` — global shortcuts (`Alt+1..9`, `Ctrl+N/P`, `/`, `Esc`)
- `members.ts` — nick list state per channel, fetched on channel-select,
  updated from PubSub presence events
- `compose.ts` — input state + tab-completion + slash-command parser

**Cicchetto-side new components:**
- `Sidebar.tsx` — left sidebar (network+channel tree, tappable, badges)
- `MembersPane.tsx` — right sidebar (nick list, mode prefixes, mIRC palette)
- `TopicBar.tsx` — channel name + topic + nick count + channel modes
- `ComposeBox.tsx` — input with `[#italia]` channel-prefix, tab-complete
  UI, slash-command tokenization
- `SettingsDrawer.tsx` — theme toggle (☼/☾), placeholder for P4-V voice
  toggle
- `App.tsx` (rewrite) — three-pane responsive shell, breakpoint logic
  (≤768px = mobile drawer mode), drawer state

**Cicchetto-side existing components (light edits):**
- `ScrollbackPane.tsx` — adjust presence-event rendering inline
- `Login.tsx` — unchanged (modes 2+3 add tabs in M2/M3)

**Behavioral details:**
- Auto-scroll: scroll-locked-to-bottom when at bottom; pause when
  scrolled up; resume on send-message OR explicit scroll-to-bottom
  button
- Mention highlight: own nick (case-insensitive word-boundary match) →
  entire line bg-tinted + bold sender; mention in non-active channel →
  red badge on sidebar entry
- Unread distinction: bold (unread, no mention) vs bold + red badge
  (mention)
- Mobile drawers: swipe-from-left edge opens channel sidebar;
  swipe-from-right edge opens nick list; tap outside drawer to close;
  drawer animation = transform translateX (60fps on iPhone)
- Tab-completion: in compose, after `@` or word-at-cursor, Tab cycles
  through matching nicks (Members + sender history); Shift+Tab cycles
  backward
- Slash commands: `/me action` → POST /messages with `kind: action`;
  `/join #foo` → POST /channels; `/part` → DELETE /channels/:chan;
  `/raw …` → POST /networks/:net/raw

**LOC estimate:** ~1000-1200 cicchetto + ~150 server. **~full session,
possibly two sessions** if visual-iteration loop is long.

### P4-V — Voice I/O (Phase 4 closes here)

**Scope:** per-channel TTS + STT toggle in cicchetto, browser-native APIs.

- Per-channel TTS toggle (☊ icon in TopicBar) using `SpeechSynthesis`
- Compose-box STT button (🎙 icon) using `SpeechRecognition`
- ARIA wiring for screen readers
- Mute interaction with iOS keyboard auto-show
- Phase 5 stretch: Vosk/piper offline drop-in (+200KB gzip ex-model)

**LOC estimate:** ~150-300 cicchetto. **~half session.**

### M2 — NickServ-as-IDP (post-Phase-4)

**Scope:** new auth mode, additive on top of mode 1.

- New endpoint `POST /auth/nickserv-login {network_slug, nick, password}`
- Lazy User row creation: `Accounts.find_or_create_for_nickserv/2`
- Probe-connect via `Grappa.IRC.AuthFSM` (D2 already extracted; first
  reuse application — validates the FSM-extraction shape pays off)
- Single-network constraint enforced at config + at User-row creation
- Login UI gets second tab (or auto-detect — pin in M2)
- NickServ password stored encrypted via existing Cloak.Vault path

**Open questions resolved in M2:**
- Probe-connect shape: ephemeral Session.Server (one-shot connect, run
  AuthFSM, on `001` declare success + tear down) vs borrow live Session
- SASL vs NICK+USER+IDENTIFY priority for the probe
- Single-network gating config shape

**LOC estimate:** ~600 server + ~200 cicchetto. **~full session.**

### M3 — Anon ephemeral (post-M2)

**Scope:** new auth mode, additive on top of mode 1.

- Anon = real `users` row + auto-generated random secret + ephemeral cookie
- Additive migration: `users.expires_at: utc_datetime, null: true`
- New endpoint `POST /auth/anon-login {nick}` → returns bearer + sets
  HttpOnly cookie
- `Plugs.Authn` reads cookie OR Authorization header (additive ~30 LOC)
- Reaper GenServer (`:permanent` child, sweeps expired Users every 60s)
- Login UI gets third tab/path

**Open questions resolved in M3:**
- Nick collision shape (`guest_` prefix vs random suffix vs separate
  `display_name` column)
- Upstream connection shape (one-Session-per-anon vs gateway-mux)
- TTL semantics (hard wall vs sliding)
- Reaper supervision tree placement + restart strategy

**LOC estimate:** ~800 server + ~200 cicchetto. **~full session.**

### M3-A — Anon abuse posture (post-M3)

**Scope:** rate-limit + operator allowlist + captcha hook.

- Per-IP rate-limit on `POST /auth/anon-login` (e.g., 5 sessions/hour/IP,
  sliding window)
- Operator allowlist: per-network flag `accept_anon: bool`
- Captcha escape-hatch (Cloudflare Turnstile / hCaptcha) — design hook
  only, not implemented in M3-A; lands when abuse materialises

**LOC estimate:** ~300 server. **~half session.**

## Open design questions

| # | Question | Resolved in |
|---|----------|-------------|
| 1 | Mode 2 probe-connect: ephemeral Session.Server vs borrow live Session | M2 |
| 2 | Mode 2 SASL vs NICK+USER+IDENTIFY priority | M2 |
| 3 | Mode 3 anon nick collision shape | M3 |
| 4 | Mode 3 upstream connection shape (one-Session-per-anon vs gateway-mux) | M3 |
| 5 | Mode 3 TTL semantics (hard wall vs sliding) | M3 |
| 6 | Mode 3 Reaper supervision tree placement + restart strategy | M3 |
| 7 | Anon abuse rate-limit shape + operator allowlist | M3-A |
| 8 | Single-network gating config shape | M2 |
| 9 | Tab-completion source: Members-only vs Members + sender-history | P4-1 implementation |
| 10 | Mobile drawer swipe vs iOS back-swipe conflict | P4-1 implementation |

## Risks / unknowns

- **E1 size creep:** `:nick_change` cross-channel update (sender on
  every channel where nick was present) is more complex than per-channel
  events. Pin during E1 implementation; if it bloats E1 past full
  session, split as E1.5.
- **P4-1 size creep:** cicchetto rewrite from single-pane to three-pane
  responsive is ~1000-1200 LOC. Visual iteration loop may take 2 sessions
  (worktree + paused/resumed checkpoint cycle, mirroring D-cluster
  pattern).
- **Mobile drawer ergonomics on iPhone:** swipe-edge gestures conflict
  with iOS back-swipe. Mitigation: explicit drawer-edge buffer (e.g.,
  16px) OR alt-trigger (hamburger button). Pin during P4-1 implementation.
- **A5 wire-shape change:** `ChannelsController.index` adding `joined:
  bool` + `source` is technically a wire-shape extension, not a break.
  cicchetto consumer ignores unknown fields. Forward-compat OK.

## Reading list / cross-refs

- `CLAUDE.md` — engineering rules. Particularly: "Reuse the verbs, not
  the nouns" (D2 anon shape), "Crash boundary alignment" (M3 Reaper),
  "Application.{put,get}_env/2: boot-time only" (single-network gating
  config in M2/M3).
- `docs/DESIGN_NOTES.md` — chronological decision log; D1, D2, D3
  closing entries set the verb-keyed sub-context pattern E1 reuses.
- `docs/checkpoints/2026-04-27-cp10.md` S14 — D3/A4 close + post-A4
  module surface.
- `docs/reviews/architecture/2026-04-27-architecture-review.md` — A6
  (wire-shape vs producer divergence, closed by E1), A5 (autojoin vs
  session-tracked, closed by P4-1).
- `docs/todo.md` — Phase 4 entry + adjacent Phase 5 hardening items.
- `lib/grappa/irc/auth_fsm.ex` — D2-extracted pure FSM, reused by M2 probe.
- `lib/grappa/scrollback/{message,wire,meta}.ex` — wire surface E1
  brings the producer into alignment with.
- `lib/grappa/session/server.ex` — host of the `EventRouter` extraction
  + the new `members` field.
- `cicchetto/src/lib/{networks,scrollback,selection,subscribe,channelKey}.ts`
  — D3-split modules P4-1 builds on top of.
- `cicchetto/src/Login.tsx` — unchanged in P4-1; reshaped in M2/M3.

## Phase 4 boundary

**In Phase 4:** E1 + P4-1 + P4-V (architecturally clean A6 close +
irssi-shape UI on iPhone + voice I/O accessibility surface).

**Out of Phase 4:** M2 (NickServ mode), M3 (anon mode), M3-A (anon
abuse posture). Each becomes its own post-Phase-4 cluster, additive to
the already-shipped Phase 4 surface.

**Hooks needed in Phase 4 for M2/M3:** NONE. Modes 2+3 land additively.

## Next step

Per the brainstorming skill's terminal state, the next action is to
invoke `superpowers:writing-plans` to produce per-cluster implementation
plans (TDD steps, exit criteria, file-level changes). Order of plans:
E1 first (it lands first and unblocks P4-1), then P4-1, then P4-V.
M2/M3/M3-A plans land when their respective clusters open (post-Phase-4).
