# P4-1 cluster — Phase 4 first ship UI: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Phase 4 first-ship UI — a three-pane responsive cicchetto shell (channel sidebar / scrollback + topic + compose / members sidebar) with mIRC-light + irssi-dark themes, irssi keyboard shortcuts, members sidebar consuming `/members`, compose with tab-complete + slash commands. Close architecture review A5 server-side: `ChannelsController.index/2` returns the union of credential autojoin and session-tracked joined channels with wire shape `{name, joined: bool, source: :autojoin | :joined}`.

**Architecture:** Server-side: extend `Grappa.Session.EventRouter` with self-PART / self-KICK semantics so `state.members` keys remain a faithful "currently-joined channels" set. Add `Grappa.Session.list_channels/2` facade (mirror of `list_members/3`) returning the bare channel-name list. `GrappaWeb.ChannelsController.index/2` composes credential autojoin + session-tracked list into the new wire shape; `:autojoin` wins on overlap. Client-side: cicchetto rewrites `Shell.tsx` from two-pane to three-pane responsive with collapsible drawers at ≤768px; introduces four new verb-keyed `lib/` modules (`theme`, `keybindings`, `members`, `compose`) following the D3 verb-keyed split pattern; `ScrollbackPane.tsx` is decomposed into pure-render scrollback list + new sticky-bottom `ComposeBox.tsx`. Members sidebar derives presence deltas from existing `MessagesChannel` PubSub events (no new server-side broadcast). Theme system is one CSS file with `:root[data-theme="mirc-light" | "irssi-dark"]` blocks; `theme.ts` writes `document.documentElement.dataset.theme` and exports a reactive `isMobile()` signal for layout-mode logic.

**Tech Stack:** Server: Elixir 1.19 + OTP 28 + Phoenix 1.8 + ExUnit (sandbox per test). Cicchetto: SolidJS 1.9 + TypeScript 6 + Vite 8 + Bun 1.3 + Biome 2.4 + Vitest 4 + `@solidjs/testing-library`. Phoenix Channels for the realtime push (no new SSE / polling). All gates: server `scripts/check.sh` (mix format / credo --strict / sobelow / dialyzer / deps.audit / hex.audit / doctor / test --warnings-as-errors --cover); cicchetto `bun --cwd cicchetto run check` (biome + tsc) + `bun --cwd cicchetto run test` (vitest run).

---

## Pinned decisions

The Phase 4 brainstorm spec (`docs/plans/2026-04-27-phase-4-product-shape.md` § "P4-1 — Phase 4 first ship UI") plus the ten open questions surfaced at CP10 S18 (resolved 2026-04-27 by vjt over four orchestrator-mediated rounds):

- **Q1 → (a) Self-leave drops channel key.** When `EventRouter` processes a PART where `sender == state.nick`, OR a KICK where `target == state.nick`, the channel key is `Map.delete`'d from `state.members` (symmetric with the existing self-JOIN wipe). Invariant: `Map.keys(state.members)` is the live "currently-joined channels" set. Other-user PART/KICK keep the existing semantics (delete inner nick only).
- **Q2 → (a) `Session.list_channels/2` returns bare names.** Shape `{:ok, [String.t()]} | {:error, :no_session}`. Mirror of `Session.list_members/3`. Controller composes wire envelope; Session boundary stays REST-wire-agnostic.
- **Q3 → (a) `:autojoin` wins on overlap.** Wire shape `{name, joined: bool, source: :autojoin | :joined}`. Channels in BOTH credential autojoin AND session state ⇒ `source: :autojoin, joined: true`. Channels only in autojoin ⇒ `source: :autojoin, joined: false`. Channels only in session ⇒ `source: :joined, joined: true`. Channels in neither ⇒ not in list.
- **Q4 → (a) Presence derived from existing message stream.** `members.ts` filters the same `MessagesChannel` WS events `subscribe.ts` already consumes; on `:join | :part | :quit | :nick_change | :mode | :kick` kinds applies the delta to local nick map. No new server-side broadcast, no new wire shape, no new topic. The persist row IS the wire-level evidence.
- **Q5 → (a) One cluster, one merge.** ~250 LOC server + ~1700 LOC cicchetto = ~2000 LOC total. May span two sessions (paused-resumed checkpoint per D-cluster pattern); single cluster branch + single merge to main when complete.
- **Q6 → (a) Members-only tab-completion for P4-1.** `compose.ts`'s tab-completion verb reads from `members.ts` snapshot for the current channel. Sender-history fallback deferred to M-cluster polish.
- **Q7 → (b) Hamburger buttons; no swipe gestures in P4-1.** Two ☰ buttons in `TopicBar` (left = sidebar drawer, right = members drawer). Conflict-free with iOS back-swipe. Edge-swipe gestures deferred to M-cluster.
- **Q8 → (b) Single CSS file with `:root[data-theme="..."]` blocks.** `themes/default.css` is restructured: shared rules use `var(--*)`; two `:root[data-theme="mirc-light"]` and `:root[data-theme="irssi-dark"]` blocks redefine the variables. `theme.ts` writes `document.documentElement.dataset.theme`. Both themes paint at first frame (no FOUC on toggle).
- **Q9 → 768px mobile breakpoint.** Single source: `--breakpoint-mobile: 768px` on `:root` for CSS media queries; `theme.ts` exports a reactive `isMobile()` signal backed by `window.matchMedia("(max-width: 768px)")` for TS callers (e.g. drawer-state logic, keybinding gating).
- **Q10 → (a) ScrollbackPane decomposition.** Existing `ScrollbackPane.tsx` (271 LOC, list + auto-scroll + compose form bundled) splits into pure-render `ScrollbackPane` (list + auto-scroll only) + new `ComposeBox.tsx` (sticky-bottom textarea + history + tab-complete + slash). `compose.ts` is the verb store ComposeBox consumes.

Other resolved (non-blocking, pinned in plan steps below):

- **Keyboard library:** vanilla `window.addEventListener("keydown")` + dispatch in `keybindings.ts`. No third-party dep — too few bindings (`Alt+1..9`, `Ctrl+N/P`, `Ctrl+K`, `/`, `Esc`, `Tab`/`Shift+Tab`) to justify bundle weight.
- **Slash commands shipped in P4-1:** `/me <action>`, `/join <channel>`, `/part [channel]`, `/topic <body>` (POSTs new topic via `Session.send_topic` — NEW server endpoint), `/nick <new>` (POSTs nick change — NEW server endpoint), `/msg <target> <body>` (PRIVMSG to target). DROPPED: `/raw <line>` (needs `POST /networks/:net/raw` server endpoint that doesn't exist; M-cluster).
- **`/topic` and `/nick` server endpoints:** ship with the slash command set. `Session.send_topic/3` + `Session.send_nick/2` facades + `POST /networks/:net/channels/:chan/topic` + `POST /networks/:net/nick` REST routes. Tiny additions that mirror the existing `Session.send_join/3` + `Session.send_part/3` shape.
- **Mention highlight matcher:** case-insensitive word-boundary regex match against `state.user_name` from `cicchetto/src/lib/networks.ts`'s `user()` resource. Match in `body` only (not `sender`/`channel`). Highlighted line gets `.scrollback-mention` class; sidebar entry gets `mention-badge` count separate from regular unread count.
- **mIRC palette:** classic 16-color mIRC presets used as accents (navy `#00007f`, red `#ff0000`, etc.); full color table in Task 9. mIRC-light bg `#ffffff` / fg `#000000`; irssi-dark stays at current `#0a0a0a` / `#e0e0e0` (existing `themes/default.css` colors).
- **Mode-prefix nick colors:** `@` ops red (`#7f0000`), `+` voiced green (`#007f00`), plain default `var(--fg)`. Same hue family across both themes (saturation tuned per theme bg).
- **Members map `:mode` event handling in cicchetto:** mode-string parsing client-side (e.g. `+o alice` → grant `@`, `-v bob` → revoke `+`). Reuse the same `(ov)@+` mode-prefix table the server hard-codes in EventRouter (Phase 5 PREFIX ISUPPORT-driven negotiation will replace both at once). Pure-function module `lib/modeApply.ts` keeps the parser unit-testable.
- **Drawer-state lifecycle:** `Shell.tsx` owns `[sidebarOpen, setSidebarOpen]` + `[membersOpen, setMembersOpen]` Solid signals. Desktop (≥769px): both panes always visible, drawer state ignored. Mobile (≤768px): drawers `position: fixed` with `transform: translateX(...)`; `Esc` closes whichever is open; selecting a channel auto-closes the sidebar drawer; tap-outside closes (overlay backdrop captures click).
- **`Session.list_channels/2` empty-on-no-session shape:** the function is called from `ChannelsController.index/2` AFTER `Plugs.ResolveNetwork`. The user has a credential (otherwise 404 already); but the session may not be running yet (Bootstrap not finished, or session crashed). In that case: returns `{:error, :no_session}`. Controller treats it as "no session-tracked channels"—`Map.keys` over empty—and returns the credential's autojoin list with `joined: false, source: :autojoin`. The `{:error, :no_session}` only collapses to a 404 when `list_members/3` is called (a missing session for a member-list lookup IS the error case there); for `list_channels/2` it's a soft state (missing session ≠ missing user; user has credential ⇒ list autojoin only).

---

## File structure

### Server-side

```
lib/grappa/session/event_router.ex                  (REFACTOR)
  - PART handler: when sender == state.nick, Map.delete(state.members, channel)
  - KICK handler: when target == state.nick, Map.delete(state.members, channel)
  - other-user PART/KICK: existing semantics unchanged

lib/grappa/session/server.ex                        (UPDATE)
  - new handle_call({:list_channels}, _, state) returning Map.keys(state.members) sorted
  - new handle_call({:send_topic, channel, body}, _, state) — NEW; outbound TOPIC
  - new handle_call({:send_nick, new_nick}, _, state) — NEW; outbound NICK

lib/grappa/session.ex                               (UPDATE)
  - new list_channels/2 facade: GenServer.call wrapper
  - new send_topic/4 facade: validates, GenServer.call
  - new send_nick/3 facade: validates, GenServer.call
  - Boundary exports unchanged

lib/grappa/irc/client.ex                            (UPDATE)
  - new send_topic/3 helper (sends "TOPIC :<body>")
  - new send_nick/2 helper (sends "NICK <new>")
  - Identifier validation reused

lib/grappa_web/router.ex                            (UPDATE)
  - new POST /networks/:network_id/channels/:channel_id/topic route
  - new POST /networks/:network_id/nick route
  - existing GET /networks/:network_id/channels route unchanged (controller body changes)

lib/grappa_web/controllers/channels_controller.ex   (REFACTOR)
  - index/2 composes credential autojoin + Session.list_channels/2
  - new wire shape: [%{name, joined, source}]
  - new topic/2 action: POST /channels/:chan/topic body {"body": "..."}

lib/grappa_web/controllers/channels_json.ex         (UPDATE)
  - render maps with {name, joined, source} not bare channel name strings

lib/grappa/networks/wire.ex                         (UPDATE)
  - channel_json type: %{name: String.t(), joined: boolean(), source: :autojoin | :joined}
  - channel_to_json/3 — takes (name, joined, source); old /1 deleted

lib/grappa_web/controllers/nick_controller.ex       (NEW)
  - create/2 — POST /networks/:net/nick body {"nick": "..."}; calls Session.send_nick/3

test/grappa/session/event_router_test.exs           (UPDATE)
  - new tests: self-PART drops channel key; self-KICK drops channel key;
    other-user PART/KICK keeps channel key

test/grappa/session/server_test.exs                 (UPDATE)
  - new tests: list_channels snapshot; send_topic upstream + persist;
    send_nick upstream + reconcile

test/grappa_web/controllers/channels_controller_test.exs (REFACTOR)
  - rewrite: assert wire shape {name, joined, source}; cover all three categories
  - new test: topic/2 action

test/grappa_web/controllers/nick_controller_test.exs (NEW)
  - create/2 happy path + 404 no-session + invalid nick
```

### Cicchetto-side

```
cicchetto/src/lib/api.ts                            (UPDATE)
  - ChannelEntry type: {name: string, joined: boolean, source: "autojoin" | "joined"}
  - new postTopic(token, slug, channel, body) helper
  - new postNick(token, slug, nick) helper

cicchetto/src/lib/theme.ts                          (NEW)
  - theme state: "mirc-light" | "irssi-dark" | "auto"
  - getTheme()/setTheme(): localStorage + DOM dataset
  - isMobile(): reactive Solid signal backed by matchMedia

cicchetto/src/lib/keybindings.ts                    (NEW)
  - install(): one window keydown listener
  - registers Alt+1..9, Ctrl+N/P, Ctrl+K, /, Esc, Tab, Shift+Tab
  - dispatches to actions consumed by Shell / ComposeBox

cicchetto/src/lib/members.ts                        (NEW)
  - membersByChannel: Record<ChannelKey, MemberEntry[]>
  - loadMembers(slug, channel): fetches snapshot from GET /members
  - applyPresenceEvent(key, msg): consumes scrollback-stream events, updates map
  - on(token) cleanup arm — same shape as scrollback.ts / selection.ts

cicchetto/src/lib/modeApply.ts                      (NEW)
  - pure module: applyModeString(members, channel, modeStr, args) → updated members
  - reused server-test-symmetric — mode chars (ov)@+ table

cicchetto/src/lib/compose.ts                        (NEW)
  - composeByChannel: Record<ChannelKey, {draft, history, historyCursor}>
  - setDraft(key, value); recallPrev(key); recallNext(key)
  - submit(key) — parses slash commands; dispatches; pushes history
  - tabComplete(key, input, cursor) — pure-function helper

cicchetto/src/lib/slashCommands.ts                  (NEW)
  - parseSlash(body) → {kind: "privmsg" | "me" | "join" | "part" | "topic" | "nick" | "msg", args}
  - pure module — unit-tested without DOM

cicchetto/src/Shell.tsx                             (REWRITE)
  - three-pane responsive shell
  - drawer state: sidebarOpen, membersOpen
  - imports new Sidebar / TopicBar / ScrollbackPane / ComposeBox / MembersPane components
  - matches isMobile() signal for layout switch

cicchetto/src/ScrollbackPane.tsx                    (REFACTOR)
  - drop the inline compose form; pure list + auto-scroll
  - add mention highlight (consume user.name from networks.ts)

cicchetto/src/ComposeBox.tsx                        (NEW)
  - textarea + send button
  - reads/writes compose.ts store
  - keybindings: Enter / Shift+Enter / Up/Down (history) / Tab (complete)

cicchetto/src/Sidebar.tsx                           (NEW)
  - extracted from Shell.tsx
  - renders network → channel tree; consumes ChannelEntry's new joined/source fields
  - mention badges + unread count differentiated

cicchetto/src/TopicBar.tsx                          (NEW)
  - renders selected channel's topic + nick count
  - hosts the two ☰ hamburger buttons (mobile only — hidden on desktop)
  - hosts Settings button (theme toggle)

cicchetto/src/MembersPane.tsx                       (NEW)
  - right pane: member list with mIRC mode-prefix coloring
  - mode tier sort (already done by /members endpoint; preserves order)

cicchetto/src/SettingsDrawer.tsx                    (NEW)
  - theme toggle: auto / mIRC / irssi (radio)
  - logout button (moved from header)

cicchetto/src/themes/default.css                    (REFACTOR)
  - shared rules use var(--*) only
  - :root[data-theme="mirc-light"] block — full mIRC palette
  - :root[data-theme="irssi-dark"] block — current irssi palette
  - new selectors for sidebar/topic-bar/members-pane/compose-box/drawers
  - --breakpoint-mobile: 768px var (used in matchMedia from JS too)
  - mobile media queries (max-width: 768px) for drawer layout

cicchetto/src/main.tsx                              (UPDATE)
  - import "./lib/keybindings" (side-effect install)
  - apply initial theme from theme.ts before render

cicchetto/src/__tests__/theme.test.ts               (NEW)
cicchetto/src/__tests__/keybindings.test.ts         (NEW)
cicchetto/src/__tests__/members.test.ts             (NEW)
cicchetto/src/__tests__/modeApply.test.ts           (NEW)
cicchetto/src/__tests__/compose.test.ts             (NEW)
cicchetto/src/__tests__/slashCommands.test.ts       (NEW)
cicchetto/src/__tests__/Shell.test.tsx              (NEW)
cicchetto/src/__tests__/Sidebar.test.tsx            (NEW)
cicchetto/src/__tests__/TopicBar.test.tsx           (NEW)
cicchetto/src/__tests__/MembersPane.test.tsx        (NEW)
cicchetto/src/__tests__/ComposeBox.test.tsx         (NEW)
cicchetto/src/__tests__/SettingsDrawer.test.tsx     (NEW)
cicchetto/src/__tests__/ScrollbackPane.test.tsx     (UPDATE — drop compose; add mention)
cicchetto/src/__tests__/api.test.ts                 (UPDATE — new ChannelEntry shape)
```

### Docs

```
docs/DESIGN_NOTES.md                                (UPDATE)
  - new entry: P4-1 / A5 closure — three-pane shell + verb-keyed cicchetto
    extension; 5th application of the verb-keyed sub-context principle
    (post-D3 the cicchetto store was 4 verbs; P4-1 adds 4 more); A5 closed
    by ChannelsController source-merge

docs/checkpoints/2026-04-27-cp10.md                 (UPDATE)
  - S18 entry: P4-1 cluster opening, plan landed, Q1-Q10 resolved
  - S19 entry (after impl): P4-1 LANDED + deployed (post-impl session)
```

---

## Phase 0 — Setup

### Task 0: Worktree + baseline check

**Files:**
- No file changes. Branch + working dir setup only.

- [ ] **Step 1: Verify on main, working tree clean**

```bash
cd /srv/grappa
git status
git branch --show-current
```

Expected: `On branch main`, `working tree clean` (or only the doc commits CP10 S18 already on main).

- [ ] **Step 2: Pull latest main**

```bash
git fetch origin
git checkout main
git pull --ff-only origin main
git rev-parse main origin/main
```

Expected: identical SHAs on both. CLAUDE.md "Branch from local main, NEVER origin/main" rule still applies — verify parity, then branch from local.

- [ ] **Step 3: Create implementation worktree**

```bash
git worktree add ~/code/IRC/grappa-task-p4-1-impl -b cluster/p4-1-first-ship main
cd ~/code/IRC/grappa-task-p4-1-impl
git branch --show-current
```

Expected: `cluster/p4-1-first-ship`. (Note: the planning worktree at `~/code/IRC/grappa-task-p4-1` on `plan/p4-1` is separate; the implementation runs in its own worktree. The plan branch will be merged to main BEFORE the implementation worktree is created.)

- [ ] **Step 4: Run baseline `scripts/check.sh` — must be green**

```bash
scripts/check.sh
```

Expected: every gate green (format, credo --strict, sobelow, dialyzer, deps.audit, hex.audit, doctor, test). If anything fails, STOP and fix in the FIRST commit of the cluster (CLAUDE.md "Fix pre-existing errors first" — zero baseline before P4-1 changes start).

- [ ] **Step 5: Run cicchetto baseline gates**

```bash
bun --cwd cicchetto install
bun --cwd cicchetto run check
bun --cwd cicchetto run test
```

Expected: biome clean, tsc clean, vitest 55 tests pass (the post-D3 baseline from CP10 S14).

---

## Phase 1 — Server: EventRouter self-leave semantics (Q1)

### Task 1: Self-PART drops channel key from `state.members`

The Q1 fix: `EventRouter`'s PART handler currently only deletes the sender nick from the inner per-channel map. After self-PART (operator parts a channel), the channel key persists with stale members. Q1 pinned (a): when `sender == state.nick`, `Map.delete(state.members, channel)`. Symmetric with the existing self-JOIN wipe.

**Files:**
- Modify: `lib/grappa/session/event_router.ex`
- Modify: `test/grappa/session/event_router_test.exs`

- [ ] **Step 1: Failing test — self-PART removes the channel key**

Append to `test/grappa/session/event_router_test.exs` in the existing `describe "PART"` block (or create one if absent — locate a sibling `describe "JOIN"` block and add adjacent):

```elixir
describe "PART — self-leave semantics (Q1)" do
  test "self-PART removes the channel key from state.members entirely" do
    # State: I'm in #grappa with two members (me + alice).
    state =
      base_state(%{
        nick: "vjt",
        members: %{"#grappa" => %{"vjt" => [], "alice" => []}}
      })

    msg = msg(:part, ["#grappa", "byebye"], {:nick, "vjt", "u", "h"})

    {:cont, new_state, effects} = EventRouter.route(msg, state)

    # Channel key gone from members map entirely (not just my nick).
    refute Map.has_key?(new_state.members, "#grappa")

    # Persist effect still emitted so audit trail is preserved.
    assert [{:persist, :part, attrs}] = effects
    assert attrs.channel == "#grappa"
    assert attrs.sender == "vjt"
    assert attrs.body == "byebye"
  end

  test "other-user PART keeps the channel key, only deletes inner nick" do
    # State: I'm in #grappa with alice. alice parts.
    state =
      base_state(%{
        nick: "vjt",
        members: %{"#grappa" => %{"vjt" => [], "alice" => []}}
      })

    msg = msg(:part, ["#grappa", "bbl"], {:nick, "alice", "u", "h"})

    {:cont, new_state, effects} = EventRouter.route(msg, state)

    # Channel key still present; alice gone; vjt still there.
    assert Map.has_key?(new_state.members, "#grappa")
    assert Map.has_key?(new_state.members["#grappa"], "vjt")
    refute Map.has_key?(new_state.members["#grappa"], "alice")

    assert [{:persist, :part, _}] = effects
  end
end
```

- [ ] **Step 2: Run test — must fail**

```bash
scripts/test.sh test/grappa/session/event_router_test.exs --only describe:'PART — self-leave semantics (Q1)'
```

Expected: 1 fail on "self-PART removes the channel key" — current impl keeps the key with `vjt` deleted; assertion `refute Map.has_key?(..., "#grappa")` fails. Other test passes (covers existing other-user behavior — confirms we don't regress it in Step 3).

- [ ] **Step 3: Implement — patch the PART handler**

Edit `lib/grappa/session/event_router.ex`. Locate the PART clause (around line 161). Replace the `members =` block:

```elixir
def route(%Message{command: :part, params: [channel | rest]} = msg, state)
    when is_binary(channel) do
  sender = Message.sender_nick(msg)

  reason =
    case rest do
      [r | _] when is_binary(r) -> r
      _ -> nil
    end

  # Q1: self-PART drops the channel key entirely so `Map.keys(state.members)`
  # remains a faithful "currently-joined channels" set. Symmetric with
  # self-JOIN (which wipes-and-reseeds). Other-user PART preserves the
  # existing inner-nick-only semantics.
  members =
    cond do
      sender == state.nick ->
        Map.delete(state.members, channel)

      Map.has_key?(state.members, channel) ->
        Map.update!(state.members, channel, &Map.delete(&1, sender))

      true ->
        # Defensive: persist the audit row even for an unknown channel
        # (member-state untouched). Lets a renderer recover the PART event
        # if upstream re-orders relative to a JOIN we haven't seen yet.
        state.members
    end

  {state, eff} = build_persist(%{state | members: members}, :part, channel, sender, reason, %{})
  {:cont, state, [eff]}
end
```

- [ ] **Step 4: Run test — must pass**

```bash
scripts/test.sh test/grappa/session/event_router_test.exs --only describe:'PART — self-leave semantics (Q1)'
```

Expected: both tests pass. Then run the full PART suite to confirm no regression:

```bash
scripts/test.sh test/grappa/session/event_router_test.exs --only describe:PART
```

Expected: all PART tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/grappa/session/event_router.ex test/grappa/session/event_router_test.exs
git commit -m "$(cat <<'EOF'
feat(event-router): self-PART drops channel key from state.members

Q1 from CP10 S18 P4-1 plan: when the operator parts a channel,
EventRouter must remove the channel key from `state.members` entirely
(not just delete the operator's nick from the inner map). Symmetric
with the existing self-JOIN wipe-and-reseed behavior. Without this,
`Map.keys(state.members)` was not a faithful currently-joined set —
the post-A5 ChannelsController.index/2 would have reported parted
channels as still joined.

Other-user PART/KICK semantics unchanged.

Closes Q1 of P4-1 cluster open questions.
EOF
)"
```

---

### Task 2: Self-KICK drops channel key from `state.members`

Mirror of Task 1 for the KICK handler. KICK has a `target` rather than `sender` — the target is the kicked user. When `target == state.nick`, the operator was kicked off a channel; same outcome: drop the channel key.

**Files:**
- Modify: `lib/grappa/session/event_router.ex`
- Modify: `test/grappa/session/event_router_test.exs`

- [ ] **Step 1: Failing test — self-KICK removes the channel key**

Append to `test/grappa/session/event_router_test.exs` in (or near) the existing `describe "KICK"` block:

```elixir
describe "KICK — self-target semantics (Q1)" do
  test "self-KICK removes the channel key from state.members entirely" do
    # State: I'm in #grappa with the channel-op alice. alice kicks me.
    state =
      base_state(%{
        nick: "vjt",
        members: %{"#grappa" => %{"vjt" => [], "alice" => ["@"]}}
      })

    msg = msg(:kick, ["#grappa", "vjt", "behave"], {:nick, "alice", "u", "h"})

    {:cont, new_state, effects} = EventRouter.route(msg, state)

    # Channel key gone — I'm no longer in any channel state.
    refute Map.has_key?(new_state.members, "#grappa")

    # Persist effect still emitted with target+reason on meta+body.
    assert [{:persist, :kick, attrs}] = effects
    assert attrs.channel == "#grappa"
    assert attrs.sender == "alice"
    assert attrs.body == "behave"
    assert attrs.meta == %{target: "vjt"}
  end

  test "other-user KICK keeps the channel key, only deletes the target nick" do
    # State: I'm in #grappa as op; bob is plain. alice kicks bob.
    state =
      base_state(%{
        nick: "vjt",
        members: %{"#grappa" => %{"vjt" => ["@"], "alice" => ["@"], "bob" => []}}
      })

    msg = msg(:kick, ["#grappa", "bob", "go away"], {:nick, "alice", "u", "h"})

    {:cont, new_state, _effects} = EventRouter.route(msg, state)

    # Channel key still present; bob gone; vjt + alice still there.
    assert Map.has_key?(new_state.members, "#grappa")
    refute Map.has_key?(new_state.members["#grappa"], "bob")
    assert Map.has_key?(new_state.members["#grappa"], "vjt")
    assert Map.has_key?(new_state.members["#grappa"], "alice")
  end
end
```

- [ ] **Step 2: Run test — must fail**

```bash
scripts/test.sh test/grappa/session/event_router_test.exs --only describe:'KICK — self-target semantics (Q1)'
```

Expected: 1 fail on the self-KICK case (channel key persists with vjt deleted from inner map); other-user case passes.

- [ ] **Step 3: Implement — patch the KICK handler**

Edit `lib/grappa/session/event_router.ex`. Locate the KICK clause (around line 260). Replace the `members =` block:

```elixir
def route(%Message{command: :kick, params: [channel, target | rest]} = msg, state)
    when is_binary(channel) and is_binary(target) do
  sender = Message.sender_nick(msg)

  reason =
    case rest do
      [r | _] when is_binary(r) -> r
      _ -> nil
    end

  # Q1: self-KICK (target == state.nick) drops the channel key entirely.
  # Symmetric with self-PART. Other-user KICK preserves the inner-nick
  # delete.
  members =
    cond do
      target == state.nick ->
        Map.delete(state.members, channel)

      Map.has_key?(state.members, channel) ->
        Map.update!(state.members, channel, &Map.delete(&1, target))

      true ->
        state.members
    end

  {state, eff} =
    build_persist(
      %{state | members: members},
      :kick,
      channel,
      sender,
      reason,
      %{target: target}
    )

  {:cont, state, [eff]}
end
```

- [ ] **Step 4: Run test — must pass**

```bash
scripts/test.sh test/grappa/session/event_router_test.exs --only describe:KICK
```

Expected: all KICK tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/grappa/session/event_router.ex test/grappa/session/event_router_test.exs
git commit -m "$(cat <<'EOF'
feat(event-router): self-KICK drops channel key from state.members

Q1 mirror for KICK: when the operator is the target of a KICK, drop
the channel key from `state.members` entirely (not just the operator's
inner-map nick). Symmetric with self-PART (Task 1) and self-JOIN
(pre-existing). Other-user KICK semantics unchanged.

Closes Q1 of P4-1 cluster open questions (KICK half).
EOF
)"
```

---

### Task 3: Run full EventRouter test suite + check.sh

Verify Tasks 1+2 didn't regress any other EventRouter behavior.

- [ ] **Step 1: Full EventRouter test suite**

```bash
scripts/test.sh test/grappa/session/event_router_test.exs
scripts/test.sh test/grappa/session/event_router_property_test.exs
```

Expected: every test passes (34 unit + 2 property = E1 baseline, plus the 4 new tests added in Tasks 1+2 = 38 unit + 2 property).

- [ ] **Step 2: Full server test suite**

```bash
scripts/test.sh
```

Expected: zero failures, zero warnings.

- [ ] **Step 3: Full check.sh on the worktree**

```bash
scripts/check.sh
```

Expected: every gate green.

- [ ] **Step 4: No commit needed** — Tasks 1 + 2 already commits the work.

---

## Phase 2 — Server: Session.list_channels/2 + ChannelsController A5 close

### Task 4: `Session.Server` `handle_call({:list_channels}, _, state)`

Add the GenServer callback that snapshots `Map.keys(state.members)` sorted alphabetically. Symmetric with the existing `handle_call({:list_members, channel}, _, state)` shape.

**Files:**
- Modify: `lib/grappa/session/server.ex`
- Modify: `test/grappa/session/server_test.exs`

- [ ] **Step 1: Failing test — list_channels snapshot via direct GenServer.call**

Append to `test/grappa/session/server_test.exs` in a new `describe "list_channels via GenServer.call"` block:

```elixir
describe "list_channels via GenServer.call" do
  test "returns Map.keys(state.members) sorted alphabetically", %{server: server} do
    {pid, state} = session_with_members(server, %{
      "#azzurra" => %{"vjt" => []},
      "#italia" => %{"vjt" => [], "alice" => []},
      "#bnc" => %{"vjt" => []}
    })

    {:ok, channels} = GenServer.call(pid, {:list_channels})

    # Sorted alphabetically — stable order for the wire shape.
    assert channels == ["#azzurra", "#bnc", "#italia"]

    :ok = GenServer.stop(pid, :normal, 1_000)
    _ = state
  end

  test "returns empty list when state.members is empty", %{server: server} do
    pid = session_with_members(server, %{}) |> elem(0)

    assert {:ok, []} = GenServer.call(pid, {:list_channels})

    :ok = GenServer.stop(pid, :normal, 1_000)
  end
end
```

(The `session_with_members/2` helper exists in `server_test.exs` per E1's Task 19 — it spawns a session with a synthetic IRCServer + injects the given `state.members` map via `:sys.replace_state`. If absent, follow the pattern in the existing `describe "list_members"` block.)

- [ ] **Step 2: Run test — must fail**

```bash
scripts/test.sh test/grappa/session/server_test.exs --only describe:'list_channels via GenServer.call'
```

Expected: `(FunctionClauseError) no function clause matching in Grappa.Session.Server.handle_call/3` — the `{:list_channels}` callback doesn't exist yet.

- [ ] **Step 3: Implement — add the callback**

Edit `lib/grappa/session/server.ex`. Locate the existing `handle_call({:list_members, channel}, _, state)` clause (around line 252). Add a new clause immediately after:

```elixir
@doc """
Returns a snapshot of currently-joined channels (`Map.keys(state.members)`)
sorted alphabetically. Public via `Grappa.Session.list_channels/2`.

The "currently-joined" invariant is preserved by EventRouter's self-JOIN
wipe + self-PART/KICK delete (Q1 of P4-1 cluster). A channel appears in
`state.members` IFF the operator's session has a live join on it.
"""
def handle_call({:list_channels}, _, state) do
  channels = state.members |> Map.keys() |> Enum.sort()
  {:reply, {:ok, channels}, state}
end
```

- [ ] **Step 4: Run test — must pass**

```bash
scripts/test.sh test/grappa/session/server_test.exs --only describe:'list_channels via GenServer.call'
```

Expected: both tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/grappa/session/server.ex test/grappa/session/server_test.exs
git commit -m "$(cat <<'EOF'
feat(session): add handle_call({:list_channels}) snapshot

Returns Map.keys(state.members) sorted alphabetically — the live set
of currently-joined channels. Mirror of the existing list_members
callback shape. Public facade in Task 5.

Part of P4-1 / A5 close.
EOF
)"
```

---

### Task 5: `Session.list_channels/2` public facade

The public `Grappa.Session.list_channels/2` wraps the `:list_channels` GenServer.call. Same shape as `list_members/3` minus the channel arg.

**Files:**
- Modify: `lib/grappa/session.ex`
- Modify: `test/grappa/session_test.exs`

- [ ] **Step 1: Failing test — facade returns sorted channel list**

Append to `test/grappa/session_test.exs`:

```elixir
describe "list_channels/2" do
  test "returns sorted channel-name list from session state", %{vjt: vjt, network: network} do
    pid = start_session_for(vjt, network)

    # Inject members directly via :sys.replace_state for the test —
    # the EventRouter's JOIN paths populate the same map on real
    # 353 RPL_NAMREPLY traffic.
    :sys.replace_state(pid, fn state ->
      %{state | members: %{
        "#italia" => %{"vjt" => []},
        "#azzurra" => %{"vjt" => []}
      }}
    end)

    assert {:ok, ["#azzurra", "#italia"]} =
             Session.list_channels(vjt.id, network.id)

    :ok = GenServer.stop(pid, :normal, 1_000)
  end

  test "returns {:error, :no_session} when no session is registered", %{vjt: vjt, network: network} do
    assert {:error, :no_session} = Session.list_channels(vjt.id, network.id)
  end
end
```

- [ ] **Step 2: Run test — must fail**

```bash
scripts/test.sh test/grappa/session_test.exs --only describe:list_channels/2
```

Expected: `(UndefinedFunctionError) function Grappa.Session.list_channels/2 is undefined or private`.

- [ ] **Step 3: Implement — add the facade**

Edit `lib/grappa/session.ex`. Locate `list_members/3` (around line 300) and add `list_channels/2` immediately above (preserve alphabetical order in the file):

```elixir
@doc """
Returns a snapshot of currently-joined channels for the session at
`(user_id, network_id)`, sorted alphabetically.

Source-of-truth: `Map.keys(Session.Server.state.members)`. The
self-JOIN wipe + self-PART/KICK delete in `Grappa.Session.EventRouter`
keeps the keys aligned with live membership (Q1 of P4-1 cluster).

Returns `{:error, :no_session}` if no session is registered for
`(user_id, network_id)`. Used by `GET /networks/:net/channels`
(P4-1's A5 close: ChannelsController composes this with the
credential autojoin list to produce the `{name, joined, source}`
wire shape).
"""
@spec list_channels(Ecto.UUID.t(), integer()) ::
        {:ok, [String.t()]} | {:error, :no_session}
def list_channels(user_id, network_id)
    when is_binary(user_id) and is_integer(network_id) do
  call_session(user_id, network_id, {:list_channels})
end
```

- [ ] **Step 4: Run test — must pass**

```bash
scripts/test.sh test/grappa/session_test.exs --only describe:list_channels/2
```

Expected: both tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/grappa/session.ex test/grappa/session_test.exs
git commit -m "$(cat <<'EOF'
feat(session): add Session.list_channels/2 facade

Public wrapper over GenServer.call({:list_channels}). Returns the
sorted list of currently-joined channels for a session, or
{:error, :no_session} when none is registered. Used by the upcoming
A5 close in ChannelsController.index/2 to merge with credential
autojoin.

Part of P4-1 / A5 close.
EOF
)"
```

---

### Task 6: Refactor `Networks.Wire.channel_to_json` to the new wire shape

Current: `channel_to_json(name) :: %{name: String.t()}`. New: `channel_to_json(name, joined, source) :: %{name: String.t(), joined: boolean(), source: :autojoin | :joined}`. The single-arg form is deleted (CLAUDE.md "no half-migrated, no exclusion lists, no Phase 2 later" — every callsite migrates in this commit).

Note: only one callsite exists — `lib/grappa_web/controllers/channels_json.ex` in `index/1`. Task 7 migrates it.

**Files:**
- Modify: `lib/grappa/networks/wire.ex`
- Modify: `test/grappa/networks/wire_test.exs` (if exists; otherwise create one — `wire.ex` has no dedicated unit test today, ChannelsController + Credential round-trip tests are the coverage)

- [ ] **Step 1: Failing test — new arity + wire shape**

Append to (or create) `test/grappa/networks/wire_test.exs`:

```elixir
defmodule Grappa.Networks.WireTest do
  use ExUnit.Case, async: true

  alias Grappa.Networks.Wire

  describe "channel_to_json/3 (P4-1 A5 wire)" do
    test "renders {name, joined, source} for an autojoin-joined channel" do
      assert %{name: "#italia", joined: true, source: :autojoin} =
               Wire.channel_to_json("#italia", true, :autojoin)
    end

    test "renders {name, joined, source} for an autojoin-but-parted channel" do
      assert %{name: "#italia", joined: false, source: :autojoin} =
               Wire.channel_to_json("#italia", false, :autojoin)
    end

    test "renders {name, joined, source} for a session-joined channel (not in autojoin)" do
      assert %{name: "#bnc", joined: true, source: :joined} =
               Wire.channel_to_json("#bnc", true, :joined)
    end
  end
end
```

- [ ] **Step 2: Run test — must fail**

```bash
scripts/test.sh test/grappa/networks/wire_test.exs
```

Expected: `(UndefinedFunctionError) function Grappa.Networks.Wire.channel_to_json/3 is undefined`.

- [ ] **Step 3: Implement — replace `channel_to_json/1` with `/3`**

Edit `lib/grappa/networks/wire.ex`. Replace the existing `@type channel_json` + `channel_to_json/1` with:

```elixir
@typedoc """
Per-channel wire shape returned by `GET /networks/:net/channels`. Object
envelope (not a bare string) per architecture review A5 close: every
channel entry advertises both `:joined` (currently-in-session) and
`:source` (`:autojoin` if declared in the credential's autojoin list,
`:joined` if dynamically joined via REST/IRC after boot). When a
channel is in BOTH sources, `:autojoin` wins (operator intent durable).

Q3 of P4-1 cluster pinned the merge order; P4-1 is the cluster that
landed it.
"""
@type channel_json :: %{
        name: String.t(),
        joined: boolean(),
        source: :autojoin | :joined
      }

@doc """
Renders a single channel entry to its public JSON shape, given the
channel `name`, the live `joined` state, and the `source` of the
list entry. Caller is responsible for the source-merge logic
(`GrappaWeb.ChannelsController.index/2`).
"""
@spec channel_to_json(String.t(), boolean(), :autojoin | :joined) :: channel_json()
def channel_to_json(name, joined, source)
    when is_binary(name) and is_boolean(joined) and source in [:autojoin, :joined] do
  %{name: name, joined: joined, source: source}
end
```

- [ ] **Step 4: Run test — must pass**

```bash
scripts/test.sh test/grappa/networks/wire_test.exs
```

Expected: 3 tests pass.

- [ ] **Step 5: Server compile will fail until Task 7** — this is intentional (CLAUDE.md "Total consistency or nothing"). The single callsite in `channels_json.ex` will be migrated in Task 7's atomic commit. Don't commit yet — the next task lands together with this one.

```bash
# DO NOT commit standalone — Task 7 lands in the same commit.
git add lib/grappa/networks/wire.ex test/grappa/networks/wire_test.exs
# Stage but don't commit; Task 7 adds the callsite migration.
```

---

### Task 7: Refactor `ChannelsController.index/2` to compose autojoin + session list

The A5 close. The controller now composes the credential autojoin list AND `Session.list_channels/2` into the new `[%{name, joined, source}]` wire shape. Q3 pinned: `:autojoin` wins on overlap.

**Files:**
- Modify: `lib/grappa_web/controllers/channels_controller.ex`
- Modify: `lib/grappa_web/controllers/channels_json.ex`
- Modify: `test/grappa_web/controllers/channels_controller_test.exs`

- [ ] **Step 1: Failing tests — wire shape per category**

Replace the existing `describe "GET /networks/:network_id/channels"` block in `test/grappa_web/controllers/channels_controller_test.exs` with the post-A5 contract:

```elixir
describe "GET /networks/:network_id/channels (A5 close)" do
  setup %{conn: conn} do
    vjt = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")
    session = session_fixture(vjt)
    {:ok, conn: put_bearer(conn, session.id), vjt: vjt}
  end

  test "channel in BOTH autojoin AND session: source: :autojoin, joined: true",
       %{conn: conn, vjt: vjt} do
    {server, port} = start_named_server()
    slug = "az-#{System.unique_integer([:positive])}"
    network = bind_network(vjt, port, slug, autojoin: ["#italia"])
    pid = start_session_for(vjt, network)

    {:ok, _} = Grappa.IRCServer.wait_for_line(server, &String.starts_with?(&1, "USER"))
    {:ok, _} = Grappa.IRCServer.wait_for_line(server, &String.starts_with?(&1, "JOIN"))

    Grappa.IRCServer.feed(server, ":vjt!u@h JOIN :#italia\r\n")
    Grappa.IRCServer.feed(server, ":irc 353 vjt = #italia :vjt\r\n")
    Grappa.IRCServer.feed(server, ":irc 366 vjt #italia :End\r\n")

    flush_pong(server)

    conn = get(conn, "/networks/#{slug}/channels")
    body = json_response(conn, 200)

    assert body == [
             %{"name" => "#italia", "joined" => true, "source" => "autojoin"}
           ]

    :ok = GenServer.stop(pid, :normal, 1_000)
  end

  test "channel ONLY in autojoin (no session yet): source: :autojoin, joined: false",
       %{conn: conn, vjt: vjt} do
    slug = "az-#{System.unique_integer([:positive])}"
    network = bind_network_no_session(vjt, slug, autojoin: ["#italia", "#azzurra"])
    # No start_session_for/2 — Bootstrap not running, no session registered.

    conn = get(conn, "/networks/#{slug}/channels")
    body = json_response(conn, 200)

    # Both autojoin entries surface with joined: false, source: autojoin.
    assert body == [
             %{"name" => "#azzurra", "joined" => false, "source" => "autojoin"},
             %{"name" => "#italia", "joined" => false, "source" => "autojoin"}
           ]
  end

  test "channel ONLY in session (joined post-boot, not in autojoin): source: :joined, joined: true",
       %{conn: conn, vjt: vjt} do
    {server, port} = start_named_server()
    slug = "az-#{System.unique_integer([:positive])}"
    network = bind_network(vjt, port, slug, autojoin: [])
    pid = start_session_for(vjt, network)

    # Operator joins #bnc dynamically — not in autojoin list.
    :sys.replace_state(pid, fn state ->
      %{state | members: %{"#bnc" => %{"vjt" => []}}}
    end)

    conn = get(conn, "/networks/#{slug}/channels")
    body = json_response(conn, 200)

    assert body == [
             %{"name" => "#bnc", "joined" => true, "source" => "joined"}
           ]

    :ok = GenServer.stop(pid, :normal, 1_000)
  end

  test "merges autojoin + session: union sorted alphabetically",
       %{conn: conn, vjt: vjt} do
    {server, port} = start_named_server()
    slug = "az-#{System.unique_integer([:positive])}"
    network =
      bind_network(vjt, port, slug, autojoin: ["#italia", "#azzurra"])

    pid = start_session_for(vjt, network)

    # Session has #azzurra (autojoin-joined) + #bnc (dynamic).
    # Missing from session: #italia (autojoin but not yet joined / parted).
    :sys.replace_state(pid, fn state ->
      %{state | members: %{
        "#azzurra" => %{"vjt" => []},
        "#bnc" => %{"vjt" => []}
      }}
    end)

    conn = get(conn, "/networks/#{slug}/channels")
    body = json_response(conn, 200)

    # Three entries: alphabetical sort across the union.
    assert body == [
             %{"name" => "#azzurra", "joined" => true, "source" => "autojoin"},
             %{"name" => "#bnc", "joined" => true, "source" => "joined"},
             %{"name" => "#italia", "joined" => false, "source" => "autojoin"}
           ]

    :ok = GenServer.stop(pid, :normal, 1_000)
  end

  test "404 cross-user network access (per-user iso unchanged)", %{vjt: vjt} do
    slug = "az-#{System.unique_integer([:positive])}"
    _ = bind_network_no_session(vjt, slug, autojoin: ["#italia"])

    stranger = user_fixture(name: "stranger-#{System.unique_integer([:positive])}")
    stranger_session = session_fixture(stranger)
    stranger_conn = put_bearer(Phoenix.ConnTest.build_conn(), stranger_session.id)

    conn = get(stranger_conn, "/networks/#{slug}/channels")

    assert json_response(conn, 404) == %{"error" => "not_found"}
  end
end
```

(`bind_network_no_session/3` and `flush_pong/1` are small test helpers — see existing patterns in `members_controller_test.exs` + `channels_controller_test.exs`. If they don't exist, define them in the test file as `defp` with the obvious shape.)

- [ ] **Step 2: Run tests — must fail**

```bash
scripts/test.sh test/grappa_web/controllers/channels_controller_test.exs
```

Expected: failures across all 4 new tests — current controller returns `[%{"name" => "#italia"}]` shape (no `joined`/`source`).

- [ ] **Step 3: Implement — controller + JSON view**

Edit `lib/grappa_web/controllers/channels_controller.ex`. Replace the `index/2` action:

```elixir
@doc """
`GET /networks/:network_id/channels` — lists the user's channels for
the network, with live joined-state.

Composes the credential's `:autojoin_channels` list with the live
`Grappa.Session.list_channels/2` snapshot:

  * Channels in BOTH sources: `joined: true, source: :autojoin`
    (Q3 of P4-1 cluster: `:autojoin` wins on overlap — operator
    intent durable).
  * Channels in autojoin only: `joined: false, source: :autojoin`
    (declared but not currently joined, or session not yet running).
  * Channels in session only: `joined: true, source: :joined`
    (dynamically joined via REST/IRC after boot).

Result is sorted alphabetically by `name` for stable rendering.

A5 close: pre-A5 the action returned only the autojoin list, so
session-tracked dynamic JOINs were invisible to cicchetto's sidebar.
"""
@spec index(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, :not_found}
def index(conn, _) do
  user = conn.assigns.current_user
  network = conn.assigns.network

  with {:ok, credential} <- Credentials.get_credential(user, network) do
    session_channels =
      case Session.list_channels(user.id, network.id) do
        {:ok, list} -> list
        {:error, :no_session} -> []
      end

    entries = merge_channel_sources(credential.autojoin_channels, session_channels)
    render(conn, :index, channels: entries)
  end
end

# Q3 pinned: when a channel is in both autojoin and session, source
# is :autojoin. The merge:
#   - autojoin ∩ session = {name, joined: true, source: :autojoin}
#   - autojoin only      = {name, joined: false, source: :autojoin}
#   - session only       = {name, joined: true, source: :joined}
# Sorted alphabetically by name for wire-shape stability.
@spec merge_channel_sources([String.t()], [String.t()]) ::
        [%{name: String.t(), joined: boolean(), source: :autojoin | :joined}]
defp merge_channel_sources(autojoin, session) do
  autojoin_set = MapSet.new(autojoin)
  session_set = MapSet.new(session)

  autojoin_entries =
    Enum.map(autojoin_set, fn name ->
      %{name: name, joined: MapSet.member?(session_set, name), source: :autojoin}
    end)

  session_only_entries =
    session_set
    |> MapSet.difference(autojoin_set)
    |> Enum.map(fn name -> %{name: name, joined: true, source: :joined} end)

  Enum.sort_by(autojoin_entries ++ session_only_entries, & &1.name)
end
```

Add the `Session` alias to the controller's `alias` block if not already present:

```elixir
alias Grappa.Networks.Credentials
alias Grappa.Session
```

Then edit `lib/grappa_web/controllers/channels_json.ex`:

```elixir
defmodule GrappaWeb.ChannelsJSON do
  @moduledoc """
  Phoenix view layer for `GrappaWeb.ChannelsController`'s `:index`
  action. Renders the post-A5 channel list — entries already shaped by
  `ChannelsController.merge_channel_sources/2` to `%{name, joined,
  source}`, this view is pure pass-through (delegating each entry to
  `Grappa.Networks.Wire.channel_to_json/3`).
  """
  alias Grappa.Networks.Wire

  @doc "Renders the `:index` action — flat JSON array of channel maps."
  @spec index(%{
          channels: [
            %{name: String.t(), joined: boolean(), source: :autojoin | :joined}
          ]
        }) :: [Wire.channel_json()]
  def index(%{channels: channels}) do
    Enum.map(channels, fn %{name: name, joined: joined, source: source} ->
      Wire.channel_to_json(name, joined, source)
    end)
  end
end
```

- [ ] **Step 4: Run tests — must pass**

```bash
scripts/test.sh test/grappa_web/controllers/channels_controller_test.exs
scripts/test.sh test/grappa/networks/wire_test.exs
```

Expected: all pass. The Wire test from Task 6 is now covered by a real consumer.

- [ ] **Step 5: Commit (atomic with Task 6)**

```bash
git add lib/grappa/networks/wire.ex \
        lib/grappa_web/controllers/channels_controller.ex \
        lib/grappa_web/controllers/channels_json.ex \
        test/grappa/networks/wire_test.exs \
        test/grappa_web/controllers/channels_controller_test.exs
git commit -m "$(cat <<'EOF'
feat(channels): A5 close — index/2 returns {name, joined, source}

ChannelsController.index/2 now composes the credential's autojoin list
with Session.list_channels/2 (the session-tracked currently-joined
channel set). Wire shape extended from %{name} to %{name, joined,
source}; :autojoin wins on overlap (Q3 of P4-1 cluster).

Networks.Wire.channel_to_json/1 → /3 — required arity bump caught by
the dialyzer; one callsite (channels_json.ex) migrated in this same
commit per CLAUDE.md "no half-migrated."

Closes architecture review A5 (autojoin-vs-session-tracked divergence).

Cluster: P4-1.
EOF
)"
```

---

### Task 8: Final Phase 2 gate

Run the full server gates to confirm A5 close didn't regress anything else.

- [ ] **Step 1: Full server test suite**

```bash
scripts/test.sh
```

Expected: zero failures, zero warnings.

- [ ] **Step 2: `scripts/check.sh`**

```bash
scripts/check.sh
```

Expected: every gate green. Dialyzer in particular should be clean — the wire-shape arity change is a hot type-check surface.

---

## Phase 3 — Server: Topic + Nick outbound endpoints

### Task 9: `IRC.Client.send_topic/3` + `send_nick/2`

The IRC.Client gains two new outbound helpers. Mirror of `send_join/2` and `send_part/2` shape — same Identifier validation, same `:gen_tcp.send` path.

**Files:**
- Modify: `lib/grappa/irc/client.ex`
- Modify: `test/grappa/irc/client_test.exs`

- [ ] **Step 1: Failing tests**

Append to `test/grappa/irc/client_test.exs` in a new `describe "send_topic/3 + send_nick/2"` block:

```elixir
describe "send_topic/3 (outbound)" do
  test "sends `TOPIC #channel :body\\r\\n` to the upstream socket", %{client: client, server: server} do
    assert :ok = Client.send_topic(client, "#italia", "ciao mondo")
    {:ok, line} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "TOPIC "))
    assert line == "TOPIC #italia :ciao mondo\r\n"
  end

  test "rejects CRLF in body", %{client: client} do
    assert {:error, :invalid_line} = Client.send_topic(client, "#italia", "evil\r\nINJECTION")
  end

  test "rejects malformed channel", %{client: client} do
    assert {:error, :invalid_line} = Client.send_topic(client, "no-hash", "body")
  end
end

describe "send_nick/2 (outbound)" do
  test "sends `NICK new\\r\\n`", %{client: client, server: server} do
    assert :ok = Client.send_nick(client, "vjt-away")
    {:ok, line} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "NICK "))
    assert line == "NICK vjt-away\r\n"
  end

  test "rejects CRLF / spaces in nick", %{client: client} do
    assert {:error, :invalid_line} = Client.send_nick(client, "vjt away")
    assert {:error, :invalid_line} = Client.send_nick(client, "vjt\r\nQUIT")
  end
end
```

- [ ] **Step 2: Run tests — must fail**

```bash
scripts/test.sh test/grappa/irc/client_test.exs --only describe:'send_topic/3 (outbound)'
```

Expected: `(UndefinedFunctionError) function Grappa.IRC.Client.send_topic/3 is undefined`.

- [ ] **Step 3: Implement — add helpers**

Edit `lib/grappa/irc/client.ex`. Locate `send_part/2` (around the existing outbound helpers section) and add `send_topic/3` + `send_nick/2`:

```elixir
@doc """
Sends `TOPIC <channel> :<body>\\r\\n` upstream. The body is the new topic;
the colon prefix marks it as a trailing param so spaces are preserved.

Returns `:error, :invalid_line}` if either channel or body fails the
`Grappa.IRC.Identifier.safe_line_token?/1` check (CRLF / NUL injection
blocked at the Client boundary).
"""
@spec send_topic(pid(), String.t(), String.t()) :: :ok | {:error, :invalid_line}
def send_topic(client, channel, body)
    when is_pid(client) and is_binary(channel) and is_binary(body) do
  if Identifier.safe_line_token?(channel) and Identifier.safe_line_token?(body) and
       Identifier.valid_channel?(channel) do
    GenServer.call(client, {:send_line, "TOPIC #{channel} :#{body}\r\n"})
  else
    {:error, :invalid_line}
  end
end

@doc """
Sends `NICK <new_nick>\\r\\n` upstream. The Server is expected to receive
this and replay the nick back via `:nick` (via the `state.nick == sender`
path in EventRouter, which then reconciles `state.nick` to the new
value). On error, the upstream may reject with 432/433 numerics — the
Client doesn't intercept those (they flow through as standard messages).
"""
@spec send_nick(pid(), String.t()) :: :ok | {:error, :invalid_line}
def send_nick(client, nick)
    when is_pid(client) and is_binary(nick) do
  if Identifier.safe_line_token?(nick) and Identifier.valid_nick?(nick) do
    GenServer.call(client, {:send_line, "NICK #{nick}\r\n"})
  else
    {:error, :invalid_line}
  end
end
```

(`Identifier.valid_nick?/1` may already exist; if not, add it as a sibling of `valid_channel?/1` with the RFC 2812 nick-chars check: `[A-Za-z\[\]\\\\\`_^{|}][A-Za-z0-9\[\]\\\\\`_^{|}-]{0,29}`. Pure pattern; no state.)

- [ ] **Step 4: Run tests — must pass**

```bash
scripts/test.sh test/grappa/irc/client_test.exs --only describe:'send_topic/3 (outbound)'
scripts/test.sh test/grappa/irc/client_test.exs --only describe:'send_nick/2 (outbound)'
```

- [ ] **Step 5: Commit**

```bash
git add lib/grappa/irc/client.ex lib/grappa/irc/identifier.ex test/grappa/irc/client_test.exs
git commit -m "$(cat <<'EOF'
feat(irc-client): add send_topic/3 + send_nick/2 outbound helpers

Mirror of send_join/2 / send_part/2 shape: validate channel + body
via Identifier; emit raw TOPIC / NICK lines with CRLF terminator.

Used by Session.send_topic/4 + Session.send_nick/3 (Task 10) to
back the /topic + /nick slash commands in cicchetto's compose box
(Phase 7).

Cluster: P4-1.
EOF
)"
```

---

### Task 10: `Session.send_topic/4` + `Session.send_nick/3` facades

Add `Session.Server` `handle_call` clauses + public facade in `Session`. Mirror of `send_join/3`/`send_part/3` for the cast path; both new ones are calls (synchronous — operator wants confirmation that the line went out).

**Files:**
- Modify: `lib/grappa/session/server.ex`
- Modify: `lib/grappa/session.ex`
- Modify: `test/grappa/session/server_test.exs`
- Modify: `test/grappa/session_test.exs`

- [ ] **Step 1: Failing tests — facade dispatches to client + scrollback persists topic**

Append to `test/grappa/session/server_test.exs`:

```elixir
describe "send_topic/3" do
  test "dispatches TOPIC upstream and persists a :topic scrollback row",
       %{server: server, vjt: vjt, network: network} do
    pid = start_session_for(vjt, network)
    flush_handshake(server)

    assert {:ok, message} = Session.send_topic(vjt.id, network.id, "#italia", "new topic")

    {:ok, line} = Grappa.IRCServer.wait_for_line(server, &String.starts_with?(&1, "TOPIC "))
    assert line == "TOPIC #italia :new topic\r\n"

    assert message.kind == :topic
    assert message.channel == "#italia"
    assert message.body == "new topic"
    assert message.sender == "vjt"

    :ok = GenServer.stop(pid, :normal, 1_000)
  end

  test "rejects CRLF in body before touching upstream",
       %{vjt: vjt, network: network} do
    pid = start_session_for(vjt, network)
    assert {:error, :invalid_line} =
             Session.send_topic(vjt.id, network.id, "#italia", "bad\r\nINJECT")
    :ok = GenServer.stop(pid, :normal, 1_000)
  end
end

describe "send_nick/2" do
  test "dispatches NICK upstream",
       %{server: server, vjt: vjt, network: network} do
    pid = start_session_for(vjt, network)
    flush_handshake(server)

    assert :ok = Session.send_nick(vjt.id, network.id, "vjt-away")

    {:ok, line} = Grappa.IRCServer.wait_for_line(server, &String.starts_with?(&1, "NICK "))
    assert line == "NICK vjt-away\r\n"

    :ok = GenServer.stop(pid, :normal, 1_000)
  end
end
```

- [ ] **Step 2: Run tests — must fail**

```bash
scripts/test.sh test/grappa/session/server_test.exs --only describe:send_topic/3
```

Expected: `function Grappa.Session.send_topic/4 is undefined`.

- [ ] **Step 3: Implement — Session.Server callbacks**

Edit `lib/grappa/session/server.ex`. Add two new `handle_call` clauses near the existing `{:send_privmsg, ...}` clause (around line 199):

```elixir
@doc """
Sends an outbound `TOPIC <channel> :<body>` upstream AND persists a
`:topic` scrollback row (so the operator's own topic-set is reflected
in their scrollback view alongside everyone else's). Symmetric with
`{:send_privmsg, ...}` shape — atomic from the caller's view.
"""
def handle_call({:send_topic, channel, body}, _, state)
    when is_binary(channel) and is_binary(body) do
  attrs = %{
    user_id: state.user_id,
    network_id: state.network_id,
    channel: channel,
    server_time: System.system_time(:millisecond),
    kind: :topic,
    sender: state.nick,
    body: body,
    meta: %{}
  }

  case Scrollback.persist_event(attrs) do
    {:ok, message} ->
      :ok =
        Phoenix.PubSub.broadcast(
          Grappa.PubSub,
          Topic.channel(state.user_name, state.network_slug, channel),
          Wire.message_event(message)
        )

      case Client.send_topic(state.client, channel, body) do
        :ok -> {:reply, {:ok, message}, state}
        {:error, _} = err -> {:reply, err, state}
      end

    {:error, _} = err ->
      {:reply, err, state}
  end
end

@doc """
Sends an outbound `NICK <new>` upstream. No scrollback row persisted
synchronously — the upstream will replay the NICK back to us, and
EventRouter's NICK handler emits the per-channel persist + state.nick
reconcile (state.nick == old_nick path).
"""
def handle_call({:send_nick, new_nick}, _, state) when is_binary(new_nick) do
  case Client.send_nick(state.client, new_nick) do
    :ok -> {:reply, :ok, state}
    {:error, _} = err -> {:reply, err, state}
  end
end
```

- [ ] **Step 4: Implement — Session facade**

Edit `lib/grappa/session.ex`. Add `send_topic/4` and `send_nick/3` near the existing `send_part/3`:

```elixir
@doc """
Sets the topic on `channel` for the session's `(user_id, network_id)`.
Synchronously persists a `:topic` scrollback row, broadcasts on the
per-channel PubSub topic, and writes `TOPIC <chan> :<body>` upstream —
single-source path, mirror of `send_privmsg/4`.

Returns `{:ok, message}` with the persisted row, `{:error, :no_session}`
if no session is registered, `{:error, :invalid_line}` for CRLF/NUL
injection, or `{:error, Ecto.Changeset.t()}` on validation failure.
"""
@spec send_topic(Ecto.UUID.t(), integer(), String.t(), String.t()) ::
        {:ok, Grappa.Scrollback.Message.t()}
        | {:error, :no_session | :invalid_line}
        | {:error, Ecto.Changeset.t()}
def send_topic(user_id, network_id, channel, body)
    when is_binary(user_id) and is_integer(network_id) and is_binary(channel) and
           is_binary(body) do
  if Identifier.safe_line_token?(channel) and Identifier.safe_line_token?(body) do
    call_session(user_id, network_id, {:send_topic, channel, body})
  else
    {:error, :invalid_line}
  end
end

@doc """
Sends `NICK <new>` upstream for the session's `(user_id, network_id)`.
No scrollback row written here — the upstream will replay the NICK back
and `EventRouter` reconciles `state.nick` + emits per-channel `:nick_change`
persist effects.

Returns `:ok`, `{:error, :no_session}`, or `{:error, :invalid_line}`.
"""
@spec send_nick(Ecto.UUID.t(), integer(), String.t()) ::
        :ok | {:error, :no_session | :invalid_line}
def send_nick(user_id, network_id, new_nick)
    when is_binary(user_id) and is_integer(network_id) and is_binary(new_nick) do
  if Identifier.safe_line_token?(new_nick) do
    call_session(user_id, network_id, {:send_nick, new_nick})
  else
    {:error, :invalid_line}
  end
end
```

- [ ] **Step 5: Run tests — must pass**

```bash
scripts/test.sh test/grappa/session/server_test.exs --only describe:send_topic/3
scripts/test.sh test/grappa/session/server_test.exs --only describe:send_nick/2
```

- [ ] **Step 6: Commit**

```bash
git add lib/grappa/session.ex lib/grappa/session/server.ex \
        test/grappa/session/server_test.exs test/grappa/session_test.exs
git commit -m "$(cat <<'EOF'
feat(session): add send_topic/4 + send_nick/3 facades

Symmetric with send_privmsg/4 (persist + broadcast + upstream send)
for TOPIC; bare upstream send for NICK (reply path covered by
EventRouter's existing :nick_change handler).

Used by cicchetto's /topic and /nick slash commands in P4-1's compose
box (Phase 7). Routes added in Task 11.

Cluster: P4-1.
EOF
)"
```

---

### Task 11: REST routes for /topic + /nick (controllers + tests)

The cicchetto compose box reaches the new facades over POST endpoints. Mirror of `ChannelsController.create/2` and `delete/2` shape.

**Files:**
- Modify: `lib/grappa_web/router.ex`
- Modify: `lib/grappa_web/controllers/channels_controller.ex` (new `topic/2` action)
- Create: `lib/grappa_web/controllers/nick_controller.ex` + `nick_json.ex`
- Modify: `test/grappa_web/controllers/channels_controller_test.exs` (new describe `topic/2`)
- Create: `test/grappa_web/controllers/nick_controller_test.exs`

- [ ] **Step 1: Failing tests — controller actions**

Append to `test/grappa_web/controllers/channels_controller_test.exs`:

```elixir
describe "POST /networks/:network_id/channels/:channel_id/topic" do
  setup %{conn: conn} do
    vjt = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")
    session = session_fixture(vjt)
    {:ok, conn: put_bearer(conn, session.id), vjt: vjt}
  end

  test "202 + ok body when session accepts the topic", %{conn: conn, vjt: vjt} do
    {server, port} = start_named_server()
    slug = "az-#{System.unique_integer([:positive])}"
    network = bind_network(vjt, port, slug, autojoin: ["#italia"])
    pid = start_session_for(vjt, network)
    flush_handshake(server)

    conn = post(conn, "/networks/#{slug}/channels/%23italia/topic", %{"body" => "new topic"})

    assert json_response(conn, 202) == %{"ok" => true}

    {:ok, line} = Grappa.IRCServer.wait_for_line(server, &String.starts_with?(&1, "TOPIC "))
    assert line == "TOPIC #italia :new topic\r\n"

    :ok = GenServer.stop(pid, :normal, 1_000)
  end

  test "400 on missing body", %{conn: conn, vjt: vjt} do
    slug = "az-#{System.unique_integer([:positive])}"
    _ = bind_network_no_session(vjt, slug, autojoin: [])

    conn = post(conn, "/networks/#{slug}/channels/%23italia/topic", %{})
    assert json_response(conn, 400)
  end

  test "404 no session", %{conn: conn, vjt: vjt} do
    slug = "az-#{System.unique_integer([:positive])}"
    _ = bind_network_no_session(vjt, slug, autojoin: [])

    conn = post(conn, "/networks/#{slug}/channels/%23italia/topic", %{"body" => "topic"})
    assert json_response(conn, 404) == %{"error" => "not_found"}
  end
end
```

Create `test/grappa_web/controllers/nick_controller_test.exs`:

```elixir
defmodule GrappaWeb.NickControllerTest do
  use GrappaWeb.ConnCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.IRCServer

  setup %{conn: conn} do
    vjt = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")
    session = session_fixture(vjt)
    {:ok, conn: put_bearer(conn, session.id), vjt: vjt}
  end

  describe "POST /networks/:network_id/nick" do
    test "202 + ok body when nick line goes upstream", %{conn: conn, vjt: vjt} do
      {server, port} = start_named_server()
      slug = "az-#{System.unique_integer([:positive])}"
      network = bind_network(vjt, port, slug, autojoin: [])
      pid = start_session_for(vjt, network)
      flush_handshake(server)

      conn = post(conn, "/networks/#{slug}/nick", %{"nick" => "vjt-away"})
      assert json_response(conn, 202) == %{"ok" => true}

      {:ok, line} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "NICK "))
      assert line == "NICK vjt-away\r\n"

      :ok = GenServer.stop(pid, :normal, 1_000)
    end

    test "400 on missing/empty nick", %{conn: conn, vjt: vjt} do
      slug = "az-#{System.unique_integer([:positive])}"
      _ = bind_network_no_session(vjt, slug, autojoin: [])

      conn1 = post(conn, "/networks/#{slug}/nick", %{})
      assert json_response(conn1, 400)

      conn2 = post(conn, "/networks/#{slug}/nick", %{"nick" => ""})
      assert json_response(conn2, 400)
    end

    test "404 no session", %{conn: conn, vjt: vjt} do
      slug = "az-#{System.unique_integer([:positive])}"
      _ = bind_network_no_session(vjt, slug, autojoin: [])

      conn = post(conn, "/networks/#{slug}/nick", %{"nick" => "newnick"})
      assert json_response(conn, 404) == %{"error" => "not_found"}
    end
  end
end
```

- [ ] **Step 2: Run tests — must fail**

```bash
scripts/test.sh test/grappa_web/controllers/channels_controller_test.exs --only describe:'POST /networks/:network_id/channels/:channel_id/topic'
scripts/test.sh test/grappa_web/controllers/nick_controller_test.exs
```

Expected: 404s on the new routes (router has no entries yet).

- [ ] **Step 3: Implement — router routes**

Edit `lib/grappa_web/router.ex`. In the `scope "/networks/:network_id"` block, add:

```elixir
post "/channels/:channel_id/topic", ChannelsController, :topic
post "/nick", NickController, :create
```

- [ ] **Step 4: Implement — `ChannelsController.topic/2`**

Append to `lib/grappa_web/controllers/channels_controller.ex` (after `delete/2`):

```elixir
@doc """
`POST /networks/:network_id/channels/:channel_id/topic` — body
`{"body": "new topic"}`. Casts `TOPIC <channel> :<body>` upstream
through the session AND persists a `:topic` scrollback row. Returns
202 + `{"ok": true}` on success. CRLF / NUL injection in body collapses
to `:invalid_line` (400). Missing/non-string body → 400.
"""
@spec topic(Plug.Conn.t(), map()) ::
        Plug.Conn.t() | {:error, :bad_request | :no_session | :invalid_line}
def topic(conn, %{"channel_id" => channel, "body" => body})
    when is_binary(body) and body != "" do
  user_id = conn.assigns.current_user_id
  network = conn.assigns.network

  with :ok <- validate_channel_name(channel),
       {:ok, _message} <- Session.send_topic(user_id, network.id, channel, body) do
    conn
    |> put_status(:accepted)
    |> json(%{ok: true})
  end
end

def topic(_, _), do: {:error, :bad_request}
```

Note: `Session.send_topic/4` returns `{:ok, message}` — but we don't render it (the WS push delivers the same row to the client). Returning the bare `{ok: true}` keeps the controller's wire shape symmetric with `create/2` and `delete/2`. The `with` matches `{:ok, _message}` and continues to the `put_status` arm.

- [ ] **Step 5: Implement — NickController + JSON view**

Create `lib/grappa_web/controllers/nick_controller.ex`:

```elixir
defmodule GrappaWeb.NickController do
  @moduledoc """
  `POST /networks/:network_id/nick` — change the operator's nick on
  the upstream IRC connection.

  Iso boundary: `Plugs.ResolveNetwork` collapses unknown-slug /
  not-your-network to 404 BEFORE this action runs. The
  `:no_session` tag from `Session.send_nick/3` collapses to the same
  404 wire body via `FallbackController` (S14 oracle close).

  Cluster: P4-1 — backs the `/nick <new>` slash command in cicchetto's
  ComposeBox.
  """
  use GrappaWeb, :controller

  alias Grappa.Session

  @doc """
  `POST /networks/:network_id/nick` — body `{"nick": "newname"}`. Sends
  `NICK <new>` upstream through the session. Returns 202 + `{"ok": true}`.
  Empty / non-string nick → 400. `:no_session` / `:invalid_line` collapse
  through `FallbackController` to 404 / 400 respectively.
  """
  @spec create(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :bad_request | :no_session | :invalid_line}
  def create(conn, %{"nick" => nick}) when is_binary(nick) and nick != "" do
    user_id = conn.assigns.current_user_id
    network = conn.assigns.network

    with :ok <- Session.send_nick(user_id, network.id, nick) do
      conn
      |> put_status(:accepted)
      |> json(%{ok: true})
    end
  end

  def create(_, _), do: {:error, :bad_request}
end
```

(NickController doesn't need a JSON view — the action returns plain `{ok: true}` via `Phoenix.Controller.json/2`.)

- [ ] **Step 6: Run tests — must pass**

```bash
scripts/test.sh test/grappa_web/controllers/channels_controller_test.exs
scripts/test.sh test/grappa_web/controllers/nick_controller_test.exs
```

- [ ] **Step 7: Commit**

```bash
git add lib/grappa_web/router.ex \
        lib/grappa_web/controllers/channels_controller.ex \
        lib/grappa_web/controllers/nick_controller.ex \
        test/grappa_web/controllers/channels_controller_test.exs \
        test/grappa_web/controllers/nick_controller_test.exs
git commit -m "$(cat <<'EOF'
feat(rest): add POST /channels/:chan/topic + POST /nick

Two new outbound endpoints, thin wrappers over Session.send_topic/4
and Session.send_nick/3. Backs the /topic and /nick slash commands
in cicchetto's compose box (P4-1 Phase 7).

Wire shape for both: 202 + {"ok": true} on success; 404 on no-session;
400 on missing/empty body or invalid_line.

Cluster: P4-1.
EOF
)"
```

---

### Task 12: Final Phase 3 gate

- [ ] **Step 1: Full server test suite + check.sh**

```bash
scripts/test.sh
scripts/check.sh
```

Expected: all green. Phase 3 closes the server-side surface — Phases 4-9 are pure cicchetto (with one Phase 9 mention-highlight integration that touches `cicchetto/src/lib/networks.ts` for the `user.name` resource).

---

## Phase 4 — Cicchetto: api.ts wire-shape + theme module

### Task 13: Update `api.ts` `ChannelEntry` type + add `postTopic` + `postNick`

The cicchetto-side wire-shape consumer for the post-A5 ChannelsController.index. Three changes: `ChannelEntry` extends with `joined: boolean` + `source: "autojoin" | "joined"`; new helpers for the new POST endpoints.

**Files:**
- Modify: `cicchetto/src/lib/api.ts`
- Modify: `cicchetto/src/__tests__/api.test.ts`

- [ ] **Step 1: Failing tests — new shape + new helpers**

Append to `cicchetto/src/__tests__/api.test.ts`:

```typescript
describe("listChannels (post-A5 wire shape)", () => {
  it("decodes {name, joined, source} entries", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify([
          { name: "#italia", joined: true, source: "autojoin" },
          { name: "#bnc", joined: true, source: "joined" },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const api = await import("../lib/api");
    const result = await api.listChannels("tok", "azzurra");

    expect(result).toEqual([
      { name: "#italia", joined: true, source: "autojoin" },
      { name: "#bnc", joined: true, source: "joined" },
    ]);

    fetchMock.mockRestore();
  });
});

describe("postTopic / postNick", () => {
  it("postTopic POSTs JSON to /networks/:slug/channels/:chan/topic", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 202 }),
      );

    const api = await import("../lib/api");
    await api.postTopic("tok", "azzurra", "#italia", "ciao");

    expect(fetchMock).toHaveBeenCalledWith(
      "/networks/azzurra/channels/%23italia/topic",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ body: "ciao" }),
      }),
    );

    fetchMock.mockRestore();
  });

  it("postNick POSTs JSON to /networks/:slug/nick", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 202 }),
      );

    const api = await import("../lib/api");
    await api.postNick("tok", "azzurra", "vjt-away");

    expect(fetchMock).toHaveBeenCalledWith(
      "/networks/azzurra/nick",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ nick: "vjt-away" }),
      }),
    );

    fetchMock.mockRestore();
  });
});
```

- [ ] **Step 2: Run tests — must fail**

```bash
bun --cwd cicchetto run test
```

Expected: `postTopic / postNick` cases fail (`api.postTopic is not a function`); `listChannels (post-A5)` may already pass or fail depending on the inferred type.

- [ ] **Step 3: Implement — extend `api.ts`**

Edit `cicchetto/src/lib/api.ts`. Replace the existing `ChannelEntry` type and add the helpers:

```typescript
// Mirror of `Grappa.Networks.Wire.channel_json/0` post-A5. Object envelope
// extended in P4-1 with the live `joined` state and the `source` of the
// list entry: `"autojoin"` (declared in the credential's autojoin_channels),
// `"joined"` (currently in session state.members but NOT in autojoin —
// dynamically joined post-boot via REST/IRC).
//
// Q3 of P4-1 cluster pinned the merge: when a channel is in BOTH sources,
// `:autojoin` wins (operator intent durable; session JOIN transient).
export type ChannelEntry = {
  name: string;
  joined: boolean;
  source: "autojoin" | "joined";
};
```

Append to the same file (after `sendMessage`):

```typescript
// Mirror of `GrappaWeb.ChannelsController.topic/2`. Sets the topic on
// `channel` for the operator's session on `networkSlug`. Server emits a
// `:topic` scrollback row that the WS push delivers; we don't read the
// 202 body (it's `{ok: true}`).
export async function postTopic(
  token: string,
  networkSlug: string,
  channelName: string,
  body: string,
): Promise<void> {
  const res = await fetch(
    `/networks/${encodeURIComponent(networkSlug)}/channels/${encodeURIComponent(channelName)}/topic`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ body }),
    },
  );
  if (!res.ok) throw await readError(res);
}

// Mirror of `GrappaWeb.NickController.create/2`. Sends `NICK <new>`
// upstream through the session. The upstream replays the NICK back via
// `EventRouter`'s NICK handler which fans out per-channel `:nick_change`
// scrollback rows + reconciles `state.nick` server-side.
export async function postNick(
  token: string,
  networkSlug: string,
  nick: string,
): Promise<void> {
  const res = await fetch(`/networks/${encodeURIComponent(networkSlug)}/nick`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ nick }),
  });
  if (!res.ok) throw await readError(res);
}
```

- [ ] **Step 4: Run tests — must pass**

```bash
bun --cwd cicchetto run test
```

Expected: all api.test.ts cases pass.

- [ ] **Step 5: Run cicchetto type + lint check**

```bash
bun --cwd cicchetto run check
```

Expected: clean. Type errors at THIS point are the load-bearing signal that downstream consumers (Shell.tsx reading `channel.joined`) will need to migrate in Phase 8 — that's expected; tsc will be green NOW because no consumer reads the new fields yet.

- [ ] **Step 6: Commit**

```bash
git add cicchetto/src/lib/api.ts cicchetto/src/__tests__/api.test.ts
git commit -m "$(cat <<'EOF'
feat(api): post-A5 ChannelEntry shape + postTopic/postNick helpers

ChannelEntry extends to {name, joined, source: "autojoin" | "joined"}
mirroring the post-A5 server wire. Two new helpers postTopic + postNick
for the new POST endpoints; consumers in Phase 7's compose.ts.

Cluster: P4-1.
EOF
)"
```

---

### Task 14: New `theme.ts` module — state, dataset toggle, isMobile signal

The verb-keyed theme module. Three responsibilities:
1. Theme state: `"mirc-light" | "irssi-dark" | "auto"` — localStorage-backed.
2. DOM dataset write: applies the resolved theme to `document.documentElement.dataset.theme`.
3. `isMobile()` reactive signal: backed by `matchMedia("(max-width: 768px)")`.

Module-singleton pattern mirroring `auth.ts` / `socket.ts` / `scrollback.ts`. `createRoot` wrapper anchors the matchMedia subscription.

**Files:**
- Create: `cicchetto/src/lib/theme.ts`
- Create: `cicchetto/src/__tests__/theme.test.ts`

- [ ] **Step 1: Failing tests — theme verbs**

Create `cicchetto/src/__tests__/theme.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";

describe("theme module", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });

  describe("getTheme()", () => {
    it("returns localStorage-stored theme when set", async () => {
      localStorage.setItem("grappa-theme", "mirc-light");
      const theme = await import("../lib/theme");
      expect(theme.getTheme()).toBe("mirc-light");
    });

    it("returns 'auto' when localStorage is empty", async () => {
      const theme = await import("../lib/theme");
      expect(theme.getTheme()).toBe("auto");
    });
  });

  describe("setTheme()", () => {
    it("writes localStorage + document.documentElement.dataset.theme", async () => {
      const theme = await import("../lib/theme");
      theme.setTheme("mirc-light");
      expect(localStorage.getItem("grappa-theme")).toBe("mirc-light");
      expect(document.documentElement.dataset.theme).toBe("mirc-light");
    });

    it("'auto' clears localStorage and resolves via prefers-color-scheme", async () => {
      // Prime with a stored theme.
      localStorage.setItem("grappa-theme", "mirc-light");
      const theme = await import("../lib/theme");
      theme.setTheme("auto");
      expect(localStorage.getItem("grappa-theme")).toBeNull();

      // dataset.theme should reflect the OS preference (jsdom defaults
      // to light → mirc-light).
      expect(document.documentElement.dataset.theme).toMatch(/^(mirc-light|irssi-dark)$/);
    });
  });

  describe("applyTheme() — boot-time entry", () => {
    it("applies stored theme on first call", async () => {
      localStorage.setItem("grappa-theme", "irssi-dark");
      const theme = await import("../lib/theme");
      theme.applyTheme();
      expect(document.documentElement.dataset.theme).toBe("irssi-dark");
    });

    it("falls back to prefers-color-scheme when no localStorage", async () => {
      // jsdom defaults: prefers-color-scheme: light → mirc-light.
      const theme = await import("../lib/theme");
      theme.applyTheme();
      expect(document.documentElement.dataset.theme).toBe("mirc-light");
    });
  });

  describe("isMobile() — reactive signal", () => {
    it("is false when viewport > 768px (jsdom default)", async () => {
      // jsdom's matchMedia mock returns matches: false unless explicitly
      // configured — we'll mock it.
      const matchMediaMock = vi.fn().mockReturnValue({
        matches: false,
        media: "(max-width: 768px)",
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      });
      window.matchMedia = matchMediaMock as unknown as typeof window.matchMedia;

      const theme = await import("../lib/theme");
      expect(theme.isMobile()).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run tests — must fail**

```bash
bun --cwd cicchetto run test cicchetto/src/__tests__/theme.test.ts
```

Expected: `Cannot find module '../lib/theme'`.

- [ ] **Step 3: Implement — `theme.ts`**

Create `cicchetto/src/lib/theme.ts`:

```typescript
import { createEffect, createRoot, createSignal } from "solid-js";

// Theme state + DOM dataset toggle + reactive viewport-mode signal.
// Module-singleton pattern mirroring auth.ts / socket.ts / scrollback.ts:
// every consumer reads the same fine-grained signals, no provider
// boilerplate.
//
// Three resolved themes:
//   * "mirc-light" — white bg, mIRC palette accents
//   * "irssi-dark" — dark bg, irssi palette accents (existing default)
//
// User preference persists in localStorage as one of:
//   * "mirc-light" / "irssi-dark" — explicit override
//   * (absent / "auto") — follow prefers-color-scheme
//
// `applyTheme()` is the boot-time entry called from main.tsx BEFORE
// `render()` so the first paint already has the right theme — no FOUC
// (and no flash on toggle either, because both themes ship in one CSS
// file via :root[data-theme="..."] blocks).

export type ThemePref = "mirc-light" | "irssi-dark" | "auto";
export type ResolvedTheme = "mirc-light" | "irssi-dark";

const STORAGE_KEY = "grappa-theme";
const MOBILE_QUERY = "(max-width: 768px)";

// Resolves the OS preference via matchMedia — used when ThemePref is
// "auto" to pick a concrete theme. Defensive against environments
// without matchMedia (older browsers, SSR — neither applies to cicchetto
// today, but the boundary is cheap).
function resolveAuto(): ResolvedTheme {
  if (typeof window === "undefined" || !window.matchMedia) return "irssi-dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "irssi-dark"
    : "mirc-light";
}

function readStoredPref(): ThemePref {
  const v = localStorage.getItem(STORAGE_KEY);
  if (v === "mirc-light" || v === "irssi-dark") return v;
  return "auto";
}

function resolveTheme(pref: ThemePref): ResolvedTheme {
  return pref === "auto" ? resolveAuto() : pref;
}

function writeDataset(theme: ResolvedTheme): void {
  document.documentElement.dataset.theme = theme;
}

export function getTheme(): ThemePref {
  return readStoredPref();
}

export function setTheme(pref: ThemePref): void {
  if (pref === "auto") {
    localStorage.removeItem(STORAGE_KEY);
  } else {
    localStorage.setItem(STORAGE_KEY, pref);
  }
  writeDataset(resolveTheme(pref));
}

// Boot-time entry. Applies the stored or auto-resolved theme to
// document.documentElement.dataset.theme so the first paint matches.
// Also wires up a media-query listener so OS-level theme changes
// propagate live when the user has "auto" selected.
export function applyTheme(): void {
  const pref = readStoredPref();
  writeDataset(resolveTheme(pref));

  if (typeof window === "undefined" || !window.matchMedia) return;
  const dark = window.matchMedia("(prefers-color-scheme: dark)");
  dark.addEventListener("change", () => {
    // Only re-resolve when user is in "auto" mode; explicit override
    // ignores OS changes.
    if (readStoredPref() === "auto") {
      writeDataset(resolveTheme("auto"));
    }
  });
}

// Reactive viewport-mode signal — backed by matchMedia(MOBILE_QUERY).
// Consumers (Shell.tsx for layout switch, keybindings.ts for gating)
// call isMobile() inside reactive contexts and re-render on viewport
// resize. createRoot anchors the listener since module-level effects
// need an owner.
const exports = createRoot(() => {
  const initial =
    typeof window !== "undefined" && window.matchMedia
      ? window.matchMedia(MOBILE_QUERY).matches
      : false;
  const [mobile, setMobile] = createSignal(initial);

  if (typeof window !== "undefined" && window.matchMedia) {
    const mm = window.matchMedia(MOBILE_QUERY);
    const listener = (e: MediaQueryListEvent) => setMobile(e.matches);
    mm.addEventListener("change", listener);
    // No cleanup arm here: the module-singleton lives for app lifetime;
    // matchMedia listeners on window are cheap and there's no token-
    // rotation analogue (viewport state is identity-agnostic).
    void createEffect(() => {
      // Force the signal into the createRoot's tracking scope.
      void mobile();
    });
  }

  return { isMobile: mobile };
});

export const isMobile = exports.isMobile;
```

- [ ] **Step 4: Run tests — must pass**

```bash
bun --cwd cicchetto run test cicchetto/src/__tests__/theme.test.ts
```

Expected: all pass.

- [ ] **Step 5: Update `main.tsx` to call `applyTheme()` before render**

Edit `cicchetto/src/main.tsx`. Add the import + call BEFORE `render()`:

```typescript
import { applyTheme } from "./lib/theme";
// ... other imports ...

applyTheme(); // BEFORE render — pre-paints document.documentElement.dataset.theme

render(
  () => (
    // ... unchanged ...
  ),
  root,
);
```

- [ ] **Step 6: Commit**

```bash
git add cicchetto/src/lib/theme.ts cicchetto/src/__tests__/theme.test.ts cicchetto/src/main.tsx
git commit -m "$(cat <<'EOF'
feat(cicchetto): add theme.ts verb-keyed module

5th application of D3 verb-keyed sub-context split: theme is a verb
(theming + viewport-mode), not a noun (settings). Owns:
- ThemePref state ("auto" | "mirc-light" | "irssi-dark"); localStorage
  persistence; document.documentElement.dataset.theme writes.
- applyTheme() boot-time entry called in main.tsx pre-render so first
  paint has the right theme (no FOUC).
- prefers-color-scheme auto-resolve + live OS-theme-change propagation
  when user is in "auto" mode.
- isMobile() reactive signal backed by matchMedia("(max-width: 768px)")
  for layout-switch + keybinding gating.

CSS data follows in Task 15.

Cluster: P4-1.
EOF
)"
```

---

### Task 15: `themes/default.css` — restructure for mIRC-light + irssi-dark

Refactor the existing single-theme stylesheet to ship both themes via `:root[data-theme="..."]` blocks. Shared rules use `var(--*)` (already true today). All the new selectors needed by Phase 8 components (Sidebar / TopicBar / MembersPane / ComposeBox / drawers) land here too — single CSS file, single source.

**Files:**
- Modify: `cicchetto/src/themes/default.css`

- [ ] **Step 1: Replace the file content**

Overwrite `cicchetto/src/themes/default.css`:

```css
/*
 * P4-1 theme system — single CSS file with mIRC-light + irssi-dark
 * presets via :root[data-theme="..."] blocks.
 *
 * Shared rules use var(--*); both themes ship in one asset so toggle
 * is FOUC-free (no second stylesheet fetch). theme.ts writes
 * `document.documentElement.dataset.theme = "mirc-light" | "irssi-dark"`
 * to swap.
 *
 * Variables:
 *   --bg, --fg              : main canvas / foreground
 *   --bg-alt                : sidebar / pane separator background
 *   --accent                : interactive accent (links, focus rings,
 *                             selected-channel highlight)
 *   --muted                 : secondary text (timestamps, placeholders,
 *                             "no messages yet")
 *   --border                : 1px hairlines between panes / sections
 *   --mention               : own-nick mention highlight bg-tint
 *   --mode-op               : @ ops nick color
 *   --mode-voiced           : + voiced nick color
 *   --mode-plain            : plain (no mode) nick color (= --fg)
 *   --font-mono             : font stack
 *   --font-size, --line-height
 *   --breakpoint-mobile     : 768px (mirrored in JS via theme.ts isMobile)
 *
 * --breakpoint-mobile is exposed as a CSS var (rather than inlined in
 * @media queries) so a future tooling pass can read it for testing
 * symmetry. The @media queries below USE the literal 768px because CSS
 * media queries don't accept var() inside the parentheses (browser
 * limitation, not a stylesheet limitation).
 */

:root {
  --font-mono: ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  --font-size: 14px;
  --line-height: 1.4;
  --breakpoint-mobile: 768px;
}

:root[data-theme="irssi-dark"] {
  --bg: #0a0a0a;
  --bg-alt: #111111;
  --fg: #e0e0e0;
  --accent: #5fafd7;
  --muted: #707070;
  --border: #1f1f1f;
  --mention: #2a1f00;
  --mode-op: #d77070;
  --mode-voiced: #70d770;
  --mode-plain: var(--fg);
}

:root[data-theme="mirc-light"] {
  --bg: #ffffff;
  --bg-alt: #f5f5f5;
  --fg: #000000;
  --accent: #00007f;
  --muted: #7f7f7f;
  --border: #c0c0c0;
  --mention: #fff8c0;
  --mode-op: #7f0000;
  --mode-voiced: #007f00;
  --mode-plain: var(--fg);
}

* {
  box-sizing: border-box;
}

html,
body {
  margin: 0;
  padding: 0;
  background: var(--bg);
  color: var(--fg);
  font-family: var(--font-mono);
  font-size: var(--font-size);
  line-height: var(--line-height);
}

#root {
  min-height: 100vh;
}

.muted {
  color: var(--muted);
}

/* Login (unchanged from pre-P4-1) */

.login {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  padding: 1rem;
}

.login-form {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  width: 100%;
  max-width: 22rem;
  padding: 1.5rem;
  border: 1px solid var(--border);
  background: var(--bg);
}

.login-form h1 {
  font-size: 1.2rem;
  font-weight: normal;
  color: var(--accent);
  margin: 0 0 0.5rem;
}

.login-form label {
  color: var(--muted);
  font-size: 0.85rem;
}

.login-form input {
  background: var(--bg);
  color: var(--fg);
  border: 1px solid var(--border);
  padding: 0.5rem;
  font-family: var(--font-mono);
  font-size: var(--font-size);
}

.login-form input:focus {
  outline: 1px solid var(--accent);
}

.login-form button {
  background: var(--accent);
  color: var(--bg);
  border: none;
  padding: 0.5rem 1rem;
  font-family: var(--font-mono);
  font-size: var(--font-size);
  cursor: pointer;
  margin-top: 0.5rem;
}

.login-form button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.login-error {
  color: var(--accent);
  margin: 0.5rem 0 0;
  font-size: 0.9rem;
}

/* Three-pane shell (P4-1) */

.shell {
  display: grid;
  grid-template-columns: 16rem 1fr 14rem;
  grid-template-rows: 1fr;
  height: 100vh;
  min-height: 0;
}

.shell-sidebar {
  border-right: 1px solid var(--border);
  background: var(--bg-alt);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}

.shell-main {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.shell-members {
  border-left: 1px solid var(--border);
  background: var(--bg-alt);
  overflow-y: auto;
}

/* Sidebar */

.sidebar-network {
  padding: 0.25rem 0;
}

.sidebar-network h3 {
  font-size: 0.85rem;
  font-weight: normal;
  color: var(--accent);
  margin: 0;
  padding: 0.25rem 1rem;
  text-transform: lowercase;
}

.sidebar-network ul {
  list-style: none;
  margin: 0;
  padding: 0;
}

.sidebar-network li button {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
  background: transparent;
  color: var(--fg);
  border: none;
  padding: 0.25rem 1rem 0.25rem 1.5rem;
  font-family: var(--font-mono);
  font-size: var(--font-size);
  text-align: left;
  cursor: pointer;
}

.sidebar-network li button:hover {
  background: var(--border);
}

.sidebar-network li.selected button {
  background: var(--border);
  color: var(--accent);
}

.sidebar-channel-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sidebar-channel-name.parted {
  color: var(--muted);
  font-style: italic;
}

.sidebar-unread {
  background: var(--accent);
  color: var(--bg);
  border-radius: 999px;
  padding: 0 0.4rem;
  font-size: 0.75rem;
  margin-left: 0.5rem;
}

.sidebar-mention {
  background: var(--mode-op);
  color: var(--bg);
  border-radius: 999px;
  padding: 0 0.4rem;
  font-size: 0.75rem;
  margin-left: 0.25rem;
  font-weight: bold;
}

.sidebar-footer {
  margin-top: auto;
  padding: 0.5rem 1rem;
  border-top: 1px solid var(--border);
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

/* TopicBar */

.topic-bar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 1rem;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
}

.topic-bar-hamburger {
  background: transparent;
  color: var(--muted);
  border: 1px solid var(--border);
  padding: 0.25rem 0.5rem;
  font-family: var(--font-mono);
  font-size: var(--font-size);
  cursor: pointer;
  display: none; /* desktop: hidden; mobile media query un-hides */
}

.topic-bar-channel {
  font-weight: bold;
  color: var(--accent);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.topic-bar-topic {
  flex: 1;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.topic-bar-count {
  color: var(--muted);
  font-size: 0.85rem;
}

.topic-bar-settings {
  background: transparent;
  color: var(--muted);
  border: 1px solid var(--border);
  padding: 0.25rem 0.5rem;
  font-family: var(--font-mono);
  font-size: var(--font-size);
  cursor: pointer;
}

/* Scrollback (existing rules — minor additions for mention highlight) */

.scrollback-pane {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.scrollback {
  flex: 1;
  overflow-y: auto;
  padding: 0.5rem 1rem;
  font-family: var(--font-mono);
  font-size: var(--font-size);
  line-height: var(--line-height);
}

.scrollback-empty {
  margin: 0;
}

.scrollback-line {
  white-space: pre-wrap;
  word-break: break-word;
  padding: 0.05rem 0;
}

.scrollback-line.scrollback-mention {
  background: var(--mention);
  font-weight: bold;
}

.scrollback-time {
  color: var(--muted);
}

.scrollback-sender {
  color: var(--accent);
}

.scrollback-body {
  color: var(--fg);
}

.scrollback-action {
  color: var(--accent);
  font-style: italic;
}

.scrollback-notice {
  color: var(--muted);
}

.scrollback-presence {
  color: var(--muted);
  font-style: italic;
}

/* ComposeBox */

.compose-box {
  display: flex;
  border-top: 1px solid var(--border);
  padding: 0.5rem;
  gap: 0.5rem;
  background: var(--bg);
}

.compose-box textarea {
  flex: 1;
  background: var(--bg);
  color: var(--fg);
  border: 1px solid var(--border);
  padding: 0.5rem;
  font-family: var(--font-mono);
  font-size: var(--font-size);
  line-height: var(--line-height);
  resize: none;
}

.compose-box textarea:focus {
  outline: 1px solid var(--accent);
}

.compose-box button {
  background: var(--accent);
  color: var(--bg);
  border: none;
  padding: 0 1rem;
  font-family: var(--font-mono);
  font-size: var(--font-size);
  cursor: pointer;
}

.compose-box button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.compose-box-error {
  color: var(--mode-op);
  margin: 0;
  padding: 0.25rem 1rem;
  font-size: 0.85rem;
  border-top: 1px solid var(--border);
}

/* MembersPane */

.members-pane {
  padding: 0.5rem 0;
}

.members-pane h3 {
  font-size: 0.85rem;
  font-weight: normal;
  color: var(--muted);
  margin: 0;
  padding: 0.25rem 1rem;
  text-transform: uppercase;
}

.members-pane ul {
  list-style: none;
  margin: 0;
  padding: 0;
}

.members-pane li {
  padding: 0.1rem 1rem;
  font-family: var(--font-mono);
  font-size: var(--font-size);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.members-pane li.member-op {
  color: var(--mode-op);
}

.members-pane li.member-op::before {
  content: "@";
}

.members-pane li.member-voiced {
  color: var(--mode-voiced);
}

.members-pane li.member-voiced::before {
  content: "+";
}

.members-pane li.member-plain {
  color: var(--mode-plain);
}

.members-pane li.member-plain::before {
  content: " ";
}

/* SettingsDrawer (positioned overlay) */

.settings-drawer {
  position: fixed;
  top: 0;
  right: 0;
  width: 18rem;
  height: 100vh;
  background: var(--bg-alt);
  border-left: 1px solid var(--border);
  padding: 1rem;
  z-index: 100;
  transform: translateX(100%);
  transition: transform 200ms ease-out;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.settings-drawer.open {
  transform: translateX(0);
}

.settings-drawer-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  z-index: 99;
  opacity: 0;
  pointer-events: none;
  transition: opacity 200ms ease-out;
}

.settings-drawer-backdrop.open {
  opacity: 1;
  pointer-events: auto;
}

.settings-drawer h2 {
  font-size: 1rem;
  font-weight: normal;
  color: var(--accent);
  margin: 0;
}

.settings-drawer fieldset {
  border: 1px solid var(--border);
  padding: 0.5rem;
  margin: 0;
}

.settings-drawer legend {
  color: var(--muted);
  font-size: 0.85rem;
  padding: 0 0.25rem;
}

.settings-drawer label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.25rem 0;
  cursor: pointer;
}

.settings-drawer button.logout {
  margin-top: auto;
  background: transparent;
  color: var(--mode-op);
  border: 1px solid var(--border);
  padding: 0.5rem 1rem;
  font-family: var(--font-mono);
  cursor: pointer;
}

/* Mobile drawer mode (≤768px) */

@media (max-width: 768px) {
  .shell {
    grid-template-columns: 1fr;
    grid-template-rows: auto 1fr;
  }

  .topic-bar-hamburger {
    display: inline-block;
  }

  .shell-sidebar,
  .shell-members {
    position: fixed;
    top: 0;
    height: 100vh;
    width: 80vw;
    max-width: 18rem;
    z-index: 90;
    transform: translateX(-100%);
    transition: transform 200ms ease-out;
  }

  .shell-sidebar {
    left: 0;
  }

  .shell-members {
    right: 0;
    transform: translateX(100%);
  }

  .shell-sidebar.open,
  .shell-members.open {
    transform: translateX(0);
  }

  .shell-drawer-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    z-index: 89;
    opacity: 0;
    pointer-events: none;
    transition: opacity 200ms ease-out;
  }

  .shell-drawer-backdrop.open {
    opacity: 1;
    pointer-events: auto;
  }
}
```

- [ ] **Step 2: Visual smoke test (live dev server)**

```bash
bun --cwd cicchetto run dev
```

Open `http://localhost:5173` in a browser. Without any TS changes yet (Phase 8 components not implemented), the existing pre-P4-1 selectors (`.shell-app`, `.shell-body`, `.sidebar`, `.network`, etc.) are GONE — replaced by the new `.shell`/`.shell-sidebar`/`.shell-main`/etc. The page will look broken. Do NOT panic — Phase 8 lands the components that consume the new selectors. Only run this step to confirm the CSS file parses; expect tsc / biome to be clean (CSS is not type-checked).

```bash
bun --cwd cicchetto run check
```

Expected: clean. Type/lint don't touch CSS.

- [ ] **Step 3: Visual confirm — toggle data-theme via DevTools console**

Still in browser dev console:

```javascript
document.documentElement.dataset.theme = "mirc-light";  // expect: white bg, blue accent
document.documentElement.dataset.theme = "irssi-dark";  // expect: dark bg, cyan accent
```

(Login form is the only fully-styled page right now; other shells will look broken until Phase 8.)

- [ ] **Step 4: Commit**

```bash
git add cicchetto/src/themes/default.css
git commit -m "$(cat <<'EOF'
feat(cicchetto): mIRC-light + irssi-dark themes via data-theme blocks

Single CSS file ships both themes via :root[data-theme="..."] blocks
(Q8 of P4-1 cluster). Toggle is FOUC-free — both palettes paint at
first frame; theme.ts writes document.documentElement.dataset.theme.

New selectors for Phase 8 components: .shell (three-pane grid),
.shell-sidebar / .shell-main / .shell-members panes, .topic-bar /
.compose-box / .members-pane / .settings-drawer / .shell-drawer-backdrop
plus mobile (max-width: 768px) drawer overlay rules.

Pre-P4-1 single-pane selectors (.shell-app, .shell-body) removed —
Phase 8 components migrate to the new shell.

Cluster: P4-1.
EOF
)"
```

---

## Phase 5 — Cicchetto: pure-function modules (modeApply, slashCommands, keybindings)

### Task 16: `lib/modeApply.ts` — pure mode-string parser

A pure module: `applyModeString(members, channel, modeStr, args)` returns updated members map. Mirrors the server-side `EventRouter.apply_mode_string/4`. Used by `members.ts` to apply mode events arriving on the message stream.

The mode string syntax: `+o alice`, `-v bob`, `+ov alice bob`. The `(ov)@+` mode-prefix table is hard-coded (matches server-side; PREFIX ISUPPORT-driven negotiation deferred to Phase 5).

**Files:**
- Create: `cicchetto/src/lib/modeApply.ts`
- Create: `cicchetto/src/__tests__/modeApply.test.ts`

- [ ] **Step 1: Failing tests**

Create `cicchetto/src/__tests__/modeApply.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { applyModeString } from "../lib/modeApply";
import type { ChannelMembers } from "../lib/members";

const m = (entries: Record<string, string[]>): ChannelMembers =>
  Object.entries(entries).map(([nick, modes]) => ({ nick, modes }));

describe("applyModeString", () => {
  it("+o grants @ to a target nick", () => {
    const before = m({ alice: [] });
    const after = applyModeString(before, "+o", ["alice"]);
    expect(after).toEqual([{ nick: "alice", modes: ["@"] }]);
  });

  it("+v grants + to a target nick", () => {
    const before = m({ bob: [] });
    const after = applyModeString(before, "+v", ["bob"]);
    expect(after).toEqual([{ nick: "bob", modes: ["+"] }]);
  });

  it("-o revokes @ from a target nick", () => {
    const before = m({ alice: ["@"] });
    const after = applyModeString(before, "-o", ["alice"]);
    expect(after).toEqual([{ nick: "alice", modes: [] }]);
  });

  it("+ov pairs args by position: alice gets @, bob gets +", () => {
    const before = m({ alice: [], bob: [] });
    const after = applyModeString(before, "+ov", ["alice", "bob"]);
    expect(after).toEqual([
      { nick: "alice", modes: ["@"] },
      { nick: "bob", modes: ["+"] },
    ]);
  });

  it("preserves unrelated members + their existing modes", () => {
    const before = m({ alice: [], bob: ["+"], carol: ["@"] });
    const after = applyModeString(before, "+o", ["alice"]);
    expect(after).toEqual([
      { nick: "alice", modes: ["@"] },
      { nick: "bob", modes: ["+"] },
      { nick: "carol", modes: ["@"] },
    ]);
  });

  it("ignores non-(ov) mode chars (e.g. +n channel-modes have no per-user effect)", () => {
    const before = m({ alice: ["@"] });
    const after = applyModeString(before, "+n", []);
    expect(after).toEqual(before);
  });

  it("unknown target nick is a no-op (defensive)", () => {
    const before = m({ alice: [] });
    const after = applyModeString(before, "+o", ["nonexistent"]);
    expect(after).toEqual([{ nick: "alice", modes: [] }]);
  });

  it("toggles the same mode without duplication", () => {
    const before = m({ alice: ["@"] });
    const after = applyModeString(before, "+o", ["alice"]); // already op
    expect(after).toEqual([{ nick: "alice", modes: ["@"] }]);
  });
});
```

- [ ] **Step 2: Run tests — must fail**

```bash
bun --cwd cicchetto run test cicchetto/src/__tests__/modeApply.test.ts
```

Expected: `Cannot find module '../lib/modeApply'`.

- [ ] **Step 3: Implement — `modeApply.ts` (pure module)**

Create `cicchetto/src/lib/modeApply.ts`:

```typescript
import type { ChannelMembers } from "./members";

// Pure mode-string parser. Mirrors `Grappa.Session.EventRouter`'s
// `apply_mode_string/4`: applies a single MODE event's mode string +
// args to a channel's member list, returning a new list.
//
// Mode-prefix table: (ov)@+ — `o` grants/revokes `@` (op), `v` grants/
// revokes `+` (voiced). Hard-coded matches the server side. PREFIX
// ISUPPORT-driven negotiation deferred to Phase 5+ (server + client
// move together).
//
// Mode chars that aren't (ov) are channel-modes (e.g. `n`, `t`, `m`,
// `k`, `l`) — they have no per-user effect, so the parser ignores
// them. Unknown targets (in the args list) are also no-ops (defensive
// against an out-of-order MODE arriving before its target's JOIN).

const MODE_PREFIX_TABLE: Record<string, string> = {
  o: "@",
  v: "+",
};

export function applyModeString(
  members: ChannelMembers,
  modeStr: string,
  args: readonly string[],
): ChannelMembers {
  if (modeStr.length === 0) return members;

  // Walk the mode string with a sign cursor + an args index. `+o` grants,
  // `-o` revokes; `+ov alice bob` is two ops paired with the next two args.
  let sign: "+" | "-" = "+";
  let argIdx = 0;
  let working = members;

  for (const ch of modeStr) {
    if (ch === "+" || ch === "-") {
      sign = ch;
      continue;
    }

    const prefix = MODE_PREFIX_TABLE[ch];
    if (prefix === undefined) {
      // Channel-mode (n/t/m/k/l/...) — these consume an arg in some cases
      // (k=key, l=limit, b=ban) but never affect per-user member modes.
      // We don't track channel-modes here. The server-side EventRouter
      // pairs args correctly; the client-side mirror only consumes (ov)
      // args, so a mismatched arg consumption doesn't matter for this
      // function's contract.
      continue;
    }

    const target = args[argIdx];
    argIdx += 1;
    if (target === undefined) continue;

    working = working.map((entry) => {
      if (entry.nick !== target) return entry;
      const has = entry.modes.includes(prefix);
      if (sign === "+" && has) return entry;
      if (sign === "-" && !has) return entry;
      const modes =
        sign === "+"
          ? [...entry.modes, prefix]
          : entry.modes.filter((m) => m !== prefix);
      return { ...entry, modes };
    });
  }

  return working;
}
```

(The `ChannelMembers` type is defined in `members.ts` — Task 18. For this task we forward-declare in this file's import; biome may complain about unresolved import until Task 18 lands. Workaround: define `ChannelMembers` here as `Array<{nick: string; modes: string[]}>` and re-export from `members.ts` in Task 18. Same shape; either order works as long as the type is consistent at end-of-Phase-5.)

To avoid the forward-import issue, the simpler path:
1. Create a tiny shared file `cicchetto/src/lib/memberTypes.ts` containing JUST the type.
2. Both `modeApply.ts` and `members.ts` import from it.

Edit Step 3 accordingly. Create `cicchetto/src/lib/memberTypes.ts`:

```typescript
// Shared low-level types for the per-channel member list. Pulled out
// to break the modeApply ↔ members import cycle. Mirrors the wire
// shape from `GrappaWeb.MembersJSON`'s `members` envelope.

export type MemberEntry = {
  nick: string;
  modes: string[];
};

export type ChannelMembers = MemberEntry[];
```

Then in `modeApply.ts` change the import to:

```typescript
import type { ChannelMembers } from "./memberTypes";
```

- [ ] **Step 4: Run tests — must pass**

```bash
bun --cwd cicchetto run test cicchetto/src/__tests__/modeApply.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add cicchetto/src/lib/modeApply.ts cicchetto/src/lib/memberTypes.ts cicchetto/src/__tests__/modeApply.test.ts
git commit -m "$(cat <<'EOF'
feat(cicchetto): add modeApply.ts pure mode-string parser

Mirrors server-side EventRouter.apply_mode_string/4. Used by members.ts
(Task 18) to apply MODE events arriving on the per-channel scrollback
stream. Mode-prefix table (ov)@+ hard-coded; PREFIX ISUPPORT-driven
negotiation deferred to Phase 5+ (server+client move together).

Shared type ChannelMembers extracted to memberTypes.ts to break the
modeApply ↔ members import cycle.

Cluster: P4-1.
EOF
)"
```

---

### Task 17: `lib/slashCommands.ts` — pure parser

Pure module that parses a compose-box body into either a privmsg or one of the supported slash commands. Discriminated-union return type so consumers in `compose.ts` can `switch` exhaustively.

**Files:**
- Create: `cicchetto/src/lib/slashCommands.ts`
- Create: `cicchetto/src/__tests__/slashCommands.test.ts`

- [ ] **Step 1: Failing tests**

Create `cicchetto/src/__tests__/slashCommands.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { parseSlash } from "../lib/slashCommands";

describe("parseSlash", () => {
  it("non-slash body parses as privmsg", () => {
    expect(parseSlash("hello world")).toEqual({ kind: "privmsg", body: "hello world" });
  });

  it("/me <action>", () => {
    expect(parseSlash("/me waves")).toEqual({ kind: "me", body: "waves" });
  });

  it("/join <channel>", () => {
    expect(parseSlash("/join #grappa")).toEqual({ kind: "join", channel: "#grappa" });
  });

  it("/part with explicit channel", () => {
    expect(parseSlash("/part #grappa")).toEqual({
      kind: "part",
      channel: "#grappa",
      reason: null,
    });
  });

  it("/part with no args parses as part-current (channel: null)", () => {
    expect(parseSlash("/part")).toEqual({
      kind: "part",
      channel: null,
      reason: null,
    });
  });

  it("/part with reason", () => {
    expect(parseSlash("/part #grappa byebye")).toEqual({
      kind: "part",
      channel: "#grappa",
      reason: "byebye",
    });
  });

  it("/topic <body>", () => {
    expect(parseSlash("/topic ciao mondo")).toEqual({
      kind: "topic",
      body: "ciao mondo",
    });
  });

  it("/nick <new>", () => {
    expect(parseSlash("/nick vjt-away")).toEqual({ kind: "nick", nick: "vjt-away" });
  });

  it("/msg <target> <body>", () => {
    expect(parseSlash("/msg alice ciao!")).toEqual({
      kind: "msg",
      target: "alice",
      body: "ciao!",
    });
  });

  it("/msg with body containing spaces preserved", () => {
    expect(parseSlash("/msg #italia ciao a tutti")).toEqual({
      kind: "msg",
      target: "#italia",
      body: "ciao a tutti",
    });
  });

  it("unknown slash command is parsed as :unknown with the original verb", () => {
    expect(parseSlash("/whois alice")).toEqual({ kind: "unknown", verb: "whois", rest: "alice" });
  });

  it("empty body is :empty", () => {
    expect(parseSlash("")).toEqual({ kind: "empty" });
    expect(parseSlash("  ")).toEqual({ kind: "empty" });
  });

  it("body starting with // is a literal privmsg starting with /", () => {
    expect(parseSlash("//me literal")).toEqual({ kind: "privmsg", body: "/me literal" });
  });
});
```

- [ ] **Step 2: Run tests — must fail**

```bash
bun --cwd cicchetto run test cicchetto/src/__tests__/slashCommands.test.ts
```

Expected: `Cannot find module '../lib/slashCommands'`.

- [ ] **Step 3: Implement — `slashCommands.ts`**

Create `cicchetto/src/lib/slashCommands.ts`:

```typescript
// Pure slash-command parser for cicchetto's compose box.
//
// Discriminated union: callers `switch` on `result.kind` and TypeScript
// narrows to the right field set. Adding a new command kind = one extra
// arm in this module + one extra arm in `compose.ts`'s submit verb (the
// `default: assertNever` makes the addition compile-loud).
//
// Slash escape: a body starting with `//` is a literal privmsg whose
// first character is `/` (mIRC convention — lets you say "/me" without
// the action). Two-slash prefix is consumed; the rest passes through.
//
// Empty / whitespace-only body is a no-op marker (`{kind: "empty"}`)
// so consumers can short-circuit submission without a separate guard.
//
// Unknown commands surface as `{kind: "unknown", verb, rest}` rather
// than throwing — lets the UI render an inline error like "unknown
// command: /whois" without losing what the user typed.

export type SlashCommand =
  | { kind: "empty" }
  | { kind: "privmsg"; body: string }
  | { kind: "me"; body: string }
  | { kind: "join"; channel: string }
  | { kind: "part"; channel: string | null; reason: string | null }
  | { kind: "topic"; body: string }
  | { kind: "nick"; nick: string }
  | { kind: "msg"; target: string; body: string }
  | { kind: "unknown"; verb: string; rest: string };

export function parseSlash(input: string): SlashCommand {
  const trimmed = input.trim();
  if (trimmed === "") return { kind: "empty" };

  // Literal-/ escape: //foo → privmsg with body /foo.
  if (trimmed.startsWith("//")) {
    return { kind: "privmsg", body: trimmed.slice(1) };
  }

  if (!trimmed.startsWith("/")) {
    return { kind: "privmsg", body: trimmed };
  }

  // Strip leading /, split on first whitespace into verb + rest.
  const stripped = trimmed.slice(1);
  const spaceIdx = stripped.search(/\s/);
  const verb = spaceIdx === -1 ? stripped : stripped.slice(0, spaceIdx);
  const rest = spaceIdx === -1 ? "" : stripped.slice(spaceIdx + 1).trim();

  switch (verb) {
    case "me":
      return { kind: "me", body: rest };
    case "join": {
      // Take first whitespace-delimited token as channel; ignore the rest.
      const [channel] = rest.split(/\s+/);
      if (!channel) return { kind: "unknown", verb, rest };
      return { kind: "join", channel };
    }
    case "part": {
      if (rest === "") return { kind: "part", channel: null, reason: null };
      const sp = rest.search(/\s/);
      if (sp === -1) return { kind: "part", channel: rest, reason: null };
      return {
        kind: "part",
        channel: rest.slice(0, sp),
        reason: rest.slice(sp + 1).trim(),
      };
    }
    case "topic":
      return { kind: "topic", body: rest };
    case "nick": {
      const [nick] = rest.split(/\s+/);
      if (!nick) return { kind: "unknown", verb, rest };
      return { kind: "nick", nick };
    }
    case "msg": {
      const sp = rest.search(/\s/);
      if (sp === -1) return { kind: "unknown", verb, rest };
      return {
        kind: "msg",
        target: rest.slice(0, sp),
        body: rest.slice(sp + 1).trim(),
      };
    }
    default:
      return { kind: "unknown", verb, rest };
  }
}
```

- [ ] **Step 4: Run tests — must pass**

```bash
bun --cwd cicchetto run test cicchetto/src/__tests__/slashCommands.test.ts
```

Expected: 12 tests pass.

- [ ] **Step 5: Commit**

```bash
git add cicchetto/src/lib/slashCommands.ts cicchetto/src/__tests__/slashCommands.test.ts
git commit -m "$(cat <<'EOF'
feat(cicchetto): add slashCommands.ts pure parser

Discriminated-union parser for compose-box slash commands. Supports:
/me /join /part /topic /nick /msg + unknown / empty / privmsg fallthrough
+ // literal-/ escape.

Pure module — DOM-free, fully unit-tested. Consumed by compose.ts
(Task 19) which wires each kind to its REST endpoint.

Cluster: P4-1.
EOF
)"
```

---

### Task 18: `lib/keybindings.ts` — global keydown dispatch

Vanilla `window.addEventListener("keydown")` + a tiny dispatch table. No third-party dep. Keybindings target an action interface that consumers register; this keeps keybindings free of imports from the components that consume the actions (avoids tight coupling).

**Files:**
- Create: `cicchetto/src/lib/keybindings.ts`
- Create: `cicchetto/src/__tests__/keybindings.test.ts`

- [ ] **Step 1: Failing tests**

Create `cicchetto/src/__tests__/keybindings.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  install,
  registerHandlers,
  uninstall,
  type KeybindingHandlers,
} from "../lib/keybindings";

const dispatch = (init: KeyboardEventInit) => {
  window.dispatchEvent(new KeyboardEvent("keydown", init));
};

let handlers: KeybindingHandlers;

beforeEach(() => {
  handlers = {
    selectChannelByIndex: vi.fn(),
    nextUnread: vi.fn(),
    prevUnread: vi.fn(),
    focusCompose: vi.fn(),
    closeDrawer: vi.fn(),
    cycleNickComplete: vi.fn(),
  };
  registerHandlers(handlers);
  install();
});

afterEach(() => {
  uninstall();
});

describe("keybindings", () => {
  it("Alt+1..9 dispatches selectChannelByIndex(0..8)", () => {
    dispatch({ key: "1", altKey: true });
    expect(handlers.selectChannelByIndex).toHaveBeenCalledWith(0);

    dispatch({ key: "5", altKey: true });
    expect(handlers.selectChannelByIndex).toHaveBeenCalledWith(4);

    dispatch({ key: "9", altKey: true });
    expect(handlers.selectChannelByIndex).toHaveBeenCalledWith(8);
  });

  it("Ctrl+N dispatches nextUnread", () => {
    dispatch({ key: "n", ctrlKey: true });
    expect(handlers.nextUnread).toHaveBeenCalledTimes(1);
  });

  it("Ctrl+P dispatches prevUnread", () => {
    dispatch({ key: "p", ctrlKey: true });
    expect(handlers.prevUnread).toHaveBeenCalledTimes(1);
  });

  it("/ dispatches focusCompose when compose is not already focused", () => {
    dispatch({ key: "/" });
    expect(handlers.focusCompose).toHaveBeenCalledTimes(1);
  });

  it("/ does NOT dispatch focusCompose when target is already a textarea", () => {
    const ta = document.createElement("textarea");
    document.body.appendChild(ta);
    ta.focus();

    const ev = new KeyboardEvent("keydown", { key: "/", bubbles: true });
    ta.dispatchEvent(ev);

    expect(handlers.focusCompose).not.toHaveBeenCalled();
    document.body.removeChild(ta);
  });

  it("Esc dispatches closeDrawer", () => {
    dispatch({ key: "Escape" });
    expect(handlers.closeDrawer).toHaveBeenCalledTimes(1);
  });

  it("Tab in textarea dispatches cycleNickComplete(forward=true)", () => {
    const ta = document.createElement("textarea");
    document.body.appendChild(ta);
    ta.focus();

    const ev = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
    });
    ta.dispatchEvent(ev);

    expect(handlers.cycleNickComplete).toHaveBeenCalledWith(true);
    document.body.removeChild(ta);
  });

  it("Shift+Tab in textarea dispatches cycleNickComplete(forward=false)", () => {
    const ta = document.createElement("textarea");
    document.body.appendChild(ta);
    ta.focus();

    const ev = new KeyboardEvent("keydown", {
      key: "Tab",
      shiftKey: true,
      bubbles: true,
    });
    ta.dispatchEvent(ev);

    expect(handlers.cycleNickComplete).toHaveBeenCalledWith(false);
    document.body.removeChild(ta);
  });
});
```

- [ ] **Step 2: Run tests — must fail**

```bash
bun --cwd cicchetto run test cicchetto/src/__tests__/keybindings.test.ts
```

- [ ] **Step 3: Implement — `keybindings.ts`**

Create `cicchetto/src/lib/keybindings.ts`:

```typescript
// Global keybindings: one window keydown listener dispatching to a
// handler interface. Vanilla — no third-party library; the binding
// surface (Alt+1..9, Ctrl+N/P, /, Esc, Tab, Shift+Tab) is too small
// to justify a dep + bundle weight.
//
// Two-stage init:
//   1. registerHandlers(...) — consumers (Shell.tsx) wire their action
//      callbacks
//   2. install() — attaches the window listener; called from main.tsx
//      after registerHandlers
//
// uninstall() removes the listener; used by tests + (in principle)
// for future hot-reload scenarios. Module-singleton pattern: one
// listener globally, never duplicated.

export type KeybindingHandlers = {
  selectChannelByIndex: (idx: number) => void; // Alt+1..9 → idx 0..8
  nextUnread: () => void; // Ctrl+N
  prevUnread: () => void; // Ctrl+P
  focusCompose: () => void; // /
  closeDrawer: () => void; // Esc
  cycleNickComplete: (forward: boolean) => void; // Tab (true) / Shift+Tab (false)
};

let handlers: KeybindingHandlers | null = null;
let installedListener: ((e: KeyboardEvent) => void) | null = null;

export function registerHandlers(h: KeybindingHandlers): void {
  handlers = h;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || target.isContentEditable;
}

function onKeydown(e: KeyboardEvent): void {
  if (handlers === null) return;

  // Tab cycle: only fire when the target is a typing surface (compose
  // box). Lets the rest of the page receive native Tab focus traversal.
  if (e.key === "Tab" && isTypingTarget(e.target)) {
    e.preventDefault();
    handlers.cycleNickComplete(!e.shiftKey);
    return;
  }

  // Esc closes any open drawer (Shell.tsx tracks the state); never
  // preventDefault — let any modal/dialog also see it if present.
  if (e.key === "Escape") {
    handlers.closeDrawer();
    return;
  }

  // / focuses the compose box, but ONLY when the user isn't already
  // typing in an input — otherwise typing literal "/" gets eaten.
  if (e.key === "/" && !isTypingTarget(e.target)) {
    e.preventDefault();
    handlers.focusCompose();
    return;
  }

  if (e.altKey && /^[1-9]$/.test(e.key)) {
    e.preventDefault();
    handlers.selectChannelByIndex(Number(e.key) - 1);
    return;
  }

  if (e.ctrlKey && e.key.toLowerCase() === "n") {
    e.preventDefault();
    handlers.nextUnread();
    return;
  }

  if (e.ctrlKey && e.key.toLowerCase() === "p") {
    e.preventDefault();
    handlers.prevUnread();
    return;
  }
}

export function install(): void {
  if (installedListener !== null) return; // idempotent
  installedListener = onKeydown;
  window.addEventListener("keydown", installedListener);
}

export function uninstall(): void {
  if (installedListener === null) return;
  window.removeEventListener("keydown", installedListener);
  installedListener = null;
}
```

- [ ] **Step 4: Run tests — must pass**

```bash
bun --cwd cicchetto run test cicchetto/src/__tests__/keybindings.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add cicchetto/src/lib/keybindings.ts cicchetto/src/__tests__/keybindings.test.ts
git commit -m "$(cat <<'EOF'
feat(cicchetto): add keybindings.ts global keydown dispatch

Single window keydown listener with handler-interface dispatch. Vanilla
JS — no library dep. Bindings: Alt+1..9 (channel switch by index),
Ctrl+N/P (next/prev unread), / (focus compose), Esc (close drawer),
Tab/Shift+Tab (cycle nick complete in compose).

Two-stage: registerHandlers() then install(). Shell.tsx wires the
handler callbacks; main.tsx calls install() once. Tab/Shift+Tab gated
on a typing target so plain-page Tab focus traversal still works.

Cluster: P4-1.
EOF
)"
```

---

## Phase 6 — Cicchetto: members.ts verb-keyed store

### Task 19: `lib/members.ts` — fetch snapshot + apply presence delta

The members store. Mirror of `scrollback.ts` shape: module-singleton signal store, on(token) cleanup arm, public verbs `loadMembers`, `applyPresenceEvent`. Also exports a small helper for querying the per-channel list.

Q4 pinned: members.ts derives presence from the EXISTING message stream (no new server-side broadcast). The `subscribe.ts` WS event handler will be extended in Task 20 to call `members.applyPresenceEvent(key, msg)` for presence kinds.

**Files:**
- Modify: `cicchetto/src/lib/api.ts` (add `listMembers` helper)
- Create: `cicchetto/src/lib/members.ts`
- Create: `cicchetto/src/__tests__/members.test.ts`

- [ ] **Step 1: Add `listMembers` to api.ts**

Edit `cicchetto/src/lib/api.ts`. Append after `sendMessage`:

```typescript
// Mirror of `GrappaWeb.MembersJSON.index/1` — wire shape:
//   { "members": [{"nick": String, "modes": [String]}] }
// Already mIRC-sorted by `Session.list_members/3` (ops → voiced → plain,
// alphabetical within tier). cicchetto preserves that order.
export async function listMembers(
  token: string,
  networkSlug: string,
  channelName: string,
): Promise<{ nick: string; modes: string[] }[]> {
  const res = await fetch(
    `/networks/${encodeURIComponent(networkSlug)}/channels/${encodeURIComponent(channelName)}/members`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw await readError(res);
  const body = (await res.json()) as { members: { nick: string; modes: string[] }[] };
  return body.members;
}
```

- [ ] **Step 2: Failing tests — members.ts verbs**

Create `cicchetto/src/__tests__/members.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";
import { channelKey } from "../lib/channelKey";

vi.mock("../lib/api", () => ({
  listMembers: vi.fn(),
  setOn401Handler: vi.fn(),
}));

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  vi.clearAllMocks();
});

describe("members.loadMembers (snapshot)", () => {
  it("fetches /members + populates membersByChannel", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.listMembers).mockResolvedValue([
      { nick: "vjt", modes: ["@"] },
      { nick: "alice", modes: ["+"] },
      { nick: "bob", modes: [] },
    ]);

    const members = await import("../lib/members");
    await members.loadMembers("freenode", "#grappa");

    const key = channelKey("freenode", "#grappa");
    expect(members.membersByChannel()[key]).toEqual([
      { nick: "vjt", modes: ["@"] },
      { nick: "alice", modes: ["+"] },
      { nick: "bob", modes: [] },
    ]);
  });

  it("guards double-loads on the same channel within an identity", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.listMembers).mockResolvedValue([{ nick: "vjt", modes: [] }]);

    const members = await import("../lib/members");
    await members.loadMembers("freenode", "#grappa");
    await members.loadMembers("freenode", "#grappa");

    expect(api.listMembers).toHaveBeenCalledTimes(1);
  });
});

describe("members.applyPresenceEvent", () => {
  it(":join inserts the sender (modes: []) at the end", async () => {
    localStorage.setItem("grappa-token", "tok");
    const members = await import("../lib/members");
    const key = channelKey("freenode", "#grappa");

    members.seedFromTest(key, [{ nick: "vjt", modes: ["@"] }]);

    members.applyPresenceEvent(key, {
      id: 1,
      network: "freenode",
      channel: "#grappa",
      server_time: 0,
      kind: "join",
      sender: "alice",
      body: null,
      meta: {},
    });

    expect(members.membersByChannel()[key]).toEqual([
      { nick: "vjt", modes: ["@"] },
      { nick: "alice", modes: [] },
    ]);
  });

  it(":part removes the sender", async () => {
    localStorage.setItem("grappa-token", "tok");
    const members = await import("../lib/members");
    const key = channelKey("freenode", "#grappa");

    members.seedFromTest(key, [
      { nick: "vjt", modes: ["@"] },
      { nick: "alice", modes: [] },
    ]);

    members.applyPresenceEvent(key, {
      id: 2,
      network: "freenode",
      channel: "#grappa",
      server_time: 0,
      kind: "part",
      sender: "alice",
      body: null,
      meta: {},
    });

    expect(members.membersByChannel()[key]).toEqual([{ nick: "vjt", modes: ["@"] }]);
  });

  it(":quit removes the sender", async () => {
    localStorage.setItem("grappa-token", "tok");
    const members = await import("../lib/members");
    const key = channelKey("freenode", "#grappa");

    members.seedFromTest(key, [
      { nick: "vjt", modes: ["@"] },
      { nick: "alice", modes: [] },
    ]);

    members.applyPresenceEvent(key, {
      id: 3,
      network: "freenode",
      channel: "#grappa",
      server_time: 0,
      kind: "quit",
      sender: "alice",
      body: "bye",
      meta: {},
    });

    expect(members.membersByChannel()[key]).toEqual([{ nick: "vjt", modes: ["@"] }]);
  });

  it(":nick_change renames the sender, preserving modes", async () => {
    localStorage.setItem("grappa-token", "tok");
    const members = await import("../lib/members");
    const key = channelKey("freenode", "#grappa");

    members.seedFromTest(key, [{ nick: "alice", modes: ["@"] }]);

    members.applyPresenceEvent(key, {
      id: 4,
      network: "freenode",
      channel: "#grappa",
      server_time: 0,
      kind: "nick_change",
      sender: "alice",
      body: null,
      meta: { new_nick: "alice_" },
    });

    expect(members.membersByChannel()[key]).toEqual([{ nick: "alice_", modes: ["@"] }]);
  });

  it(":kick removes the target", async () => {
    localStorage.setItem("grappa-token", "tok");
    const members = await import("../lib/members");
    const key = channelKey("freenode", "#grappa");

    members.seedFromTest(key, [
      { nick: "vjt", modes: ["@"] },
      { nick: "alice", modes: [] },
    ]);

    members.applyPresenceEvent(key, {
      id: 5,
      network: "freenode",
      channel: "#grappa",
      server_time: 0,
      kind: "kick",
      sender: "vjt",
      body: "behave",
      meta: { target: "alice" },
    });

    expect(members.membersByChannel()[key]).toEqual([{ nick: "vjt", modes: ["@"] }]);
  });

  it(":mode applies the mode string via modeApply", async () => {
    localStorage.setItem("grappa-token", "tok");
    const members = await import("../lib/members");
    const key = channelKey("freenode", "#grappa");

    members.seedFromTest(key, [
      { nick: "alice", modes: [] },
      { nick: "bob", modes: [] },
    ]);

    members.applyPresenceEvent(key, {
      id: 6,
      network: "freenode",
      channel: "#grappa",
      server_time: 0,
      kind: "mode",
      sender: "vjt",
      body: null,
      meta: { modes: "+ov", args: ["alice", "bob"] },
    });

    expect(members.membersByChannel()[key]).toEqual([
      { nick: "alice", modes: ["@"] },
      { nick: "bob", modes: ["+"] },
    ]);
  });

  it("non-presence kinds (privmsg/notice/action/topic) are ignored", async () => {
    localStorage.setItem("grappa-token", "tok");
    const members = await import("../lib/members");
    const key = channelKey("freenode", "#grappa");

    members.seedFromTest(key, [{ nick: "vjt", modes: ["@"] }]);

    members.applyPresenceEvent(key, {
      id: 7,
      network: "freenode",
      channel: "#grappa",
      server_time: 0,
      kind: "privmsg",
      sender: "alice",
      body: "hi",
      meta: {},
    });

    expect(members.membersByChannel()[key]).toEqual([{ nick: "vjt", modes: ["@"] }]);
  });
});
```

- [ ] **Step 3: Run tests — must fail**

```bash
bun --cwd cicchetto run test cicchetto/src/__tests__/members.test.ts
```

Expected: `Cannot find module '../lib/members'`.

- [ ] **Step 4: Implement — `members.ts`**

Create `cicchetto/src/lib/members.ts`:

```typescript
import { createEffect, createRoot, createSignal, on } from "solid-js";
import { type ScrollbackMessage, listMembers } from "./api";
import { token } from "./auth";
import { type ChannelKey, channelKey } from "./channelKey";
import { type ChannelMembers } from "./memberTypes";
import { applyModeString } from "./modeApply";

// Per-channel members store. Source-of-truth for the right-pane
// MembersPane (Task 22). Module-singleton signal store mirroring
// `scrollback.ts` / `selection.ts`.
//
// Lifecycle:
//   1. Initial bootstrap: `loadMembers(slug, name)` fetches GET /members
//      snapshot, populates the per-channel signal map. Once-per-channel
//      gate via `loadedChannels` Set (mirror of scrollback's pattern).
//   2. Live updates: `applyPresenceEvent(key, msg)` — called from
//      subscribe.ts (Task 20) for every message arriving on the channel
//      WS push. Filters by `msg.kind`: presence kinds mutate the map,
//      content kinds are no-ops. Q4 pinned: derived from existing
//      message stream — no new server-side broadcast.
//
// Identity-scoped state: `loadedChannels` + `membersByChannel` are
// scoped to the CURRENT bearer. Logout / rotation flushes both. The
// on(token) cleanup arm mirrors the C7/A1 pattern in scrollback.ts.
//
// Renderer-stable order: `loadMembers` preserves the server's mIRC
// sort (ops → voiced → plain, alphabetical within tier). Live presence
// events APPEND new joiners to the tail without re-sorting — so a
// freshly-JOINed user doesn't jump-cut the renderer; the next page
// reload (or channel-select re-fetch) re-sorts.

export type { ChannelMembers, MemberEntry } from "./memberTypes";

const exports = createRoot(() => {
  const loadedChannels = new Set<ChannelKey>();
  const [membersByChannel, setMembersByChannel] = createSignal<
    Record<ChannelKey, ChannelMembers>
  >({});

  // Identity-transition cleanup. Same shape as scrollback.ts.
  createEffect(
    on(token, (t, prev) => {
      if (prev != null && t !== prev) {
        loadedChannels.clear();
        setMembersByChannel({});
      }
    }),
  );

  const loadMembers = async (slug: string, name: string): Promise<void> => {
    const t = token();
    if (!t) return;
    const key = channelKey(slug, name);
    if (loadedChannels.has(key)) return;
    loadedChannels.add(key);
    try {
      const list = await listMembers(t, slug, name);
      setMembersByChannel((prev) => ({ ...prev, [key]: list }));
    } catch {
      // First-load failure leaves an empty entry; the pane renders
      // "no members yet" until the user re-selects (which calls this
      // again and lets the gate re-try).
      loadedChannels.delete(key);
    }
  };

  const applyPresenceEvent = (key: ChannelKey, msg: ScrollbackMessage): void => {
    setMembersByChannel((prev) => {
      const current = prev[key] ?? [];

      switch (msg.kind) {
        case "join": {
          // Skip if already present (out-of-order JOIN after 353 NAMES).
          if (current.some((m) => m.nick === msg.sender)) return prev;
          return { ...prev, [key]: [...current, { nick: msg.sender, modes: [] }] };
        }
        case "part":
        case "quit": {
          const next = current.filter((m) => m.nick !== msg.sender);
          if (next.length === current.length) return prev;
          return { ...prev, [key]: next };
        }
        case "kick": {
          const target = typeof msg.meta.target === "string" ? msg.meta.target : null;
          if (!target) return prev;
          const next = current.filter((m) => m.nick !== target);
          if (next.length === current.length) return prev;
          return { ...prev, [key]: next };
        }
        case "nick_change": {
          const newNick = typeof msg.meta.new_nick === "string" ? msg.meta.new_nick : null;
          if (!newNick) return prev;
          const next = current.map((m) =>
            m.nick === msg.sender ? { ...m, nick: newNick } : m,
          );
          return { ...prev, [key]: next };
        }
        case "mode": {
          const modes = typeof msg.meta.modes === "string" ? msg.meta.modes : null;
          const args = Array.isArray(msg.meta.args)
            ? (msg.meta.args.filter((a) => typeof a === "string") as string[])
            : [];
          if (!modes) return prev;
          const next = applyModeString(current, modes, args);
          return { ...prev, [key]: next };
        }
        case "privmsg":
        case "notice":
        case "action":
        case "topic":
          return prev;
        default: {
          const _exhaustive: never = msg.kind;
          void _exhaustive;
          return prev;
        }
      }
    });
  };

  // Test seam: lets unit tests inject a known-state member list without
  // exercising the full WS-bootstrap path. Mirrors the
  // `appendToScrollback` helper that scrollback.ts exposes for the same
  // reason. Production callers go through `loadMembers` + WS events.
  const seedFromTest = (key: ChannelKey, list: ChannelMembers): void => {
    setMembersByChannel((prev) => ({ ...prev, [key]: list }));
  };

  return {
    membersByChannel,
    loadMembers,
    applyPresenceEvent,
    seedFromTest,
  };
});

export const membersByChannel = exports.membersByChannel;
export const loadMembers = exports.loadMembers;
export const applyPresenceEvent = exports.applyPresenceEvent;
export const seedFromTest = exports.seedFromTest;
```

- [ ] **Step 5: Run tests — must pass**

```bash
bun --cwd cicchetto run test cicchetto/src/__tests__/members.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add cicchetto/src/lib/api.ts cicchetto/src/lib/members.ts cicchetto/src/__tests__/members.test.ts
git commit -m "$(cat <<'EOF'
feat(cicchetto): add members.ts verb-keyed store

Module-singleton store mirroring scrollback.ts: loadMembers(slug, name)
fetches the /members snapshot once per channel; applyPresenceEvent(key,
msg) consumes presence-kind events arriving on the WS scrollback
stream and mutates the per-channel member list in place. Q4 pinned —
no new server-side broadcast; same wire as scrollback already carries.

Presence kinds handled: join (append), part/quit (remove sender),
kick (remove meta.target), nick_change (rename, preserve modes),
mode (delegate to modeApply.ts). Content kinds (privmsg/notice/action/
topic) are no-ops.

Identity-scoped on(token) cleanup arm + once-per-channel load gate.

api.ts gains listMembers helper.

Cluster: P4-1.
EOF
)"
```

---

### Task 20: Wire `subscribe.ts` to dispatch presence events to `members.ts`

The subscribe.ts WS handler currently appends every event to scrollback + bumps unread. We extend it to ALSO dispatch presence events to `members.applyPresenceEvent`. The handler doesn't filter — `applyPresenceEvent` itself filters by `msg.kind` (already covered by the unit tests).

**Files:**
- Modify: `cicchetto/src/lib/subscribe.ts`
- Modify: `cicchetto/src/__tests__/subscribe.test.ts`

- [ ] **Step 1: Failing test — subscribe dispatches to members on presence events**

Append to `cicchetto/src/__tests__/subscribe.test.ts` (the existing file) a new describe block. The exact location depends on the test's existing fixture setup; locate the `describe("subscribe.ts WS event routing", ...)` block (or whatever it's called) and append:

```typescript
describe("members dispatch (P4-1)", () => {
  it("calls members.applyPresenceEvent for join/part/quit/nick_change/mode/kick events", async () => {
    // Full setup mirrors the existing subscribe test fixtures —
    // mock auth/networks/scrollback/selection/socket; inject a fake
    // user + a known channel; capture members module method.
    //
    // The assertion: after the subscribe handler routes a :join event,
    // members.applyPresenceEvent has been called with (key, msg).

    vi.doMock("../lib/members", () => ({
      applyPresenceEvent: vi.fn(),
      loadMembers: vi.fn(),
      membersByChannel: vi.fn(() => ({})),
    }));

    // ...rest of fixture setup mirrors existing subscribe tests.
    // After the fake WS push of a :join event:
    // expect(members.applyPresenceEvent).toHaveBeenCalledWith(key, joinMsg);

    expect.fail("flesh out: see existing subscribe.test.ts fixture setup pattern");
  });
});
```

(The full test body needs to match the existing subscribe.test.ts pattern; the implementer should copy the fixture skeleton from a sibling test in that file. The assertion to add: `expect(members.applyPresenceEvent).toHaveBeenCalledWith(key, payload.message)` after a presence event is pushed.)

- [ ] **Step 2: Run test — must fail**

```bash
bun --cwd cicchetto run test cicchetto/src/__tests__/subscribe.test.ts
```

Expected: fails on the new dispatch assertion.

- [ ] **Step 3: Implement — extend `subscribe.ts`**

Edit `cicchetto/src/lib/subscribe.ts`. Add the `members` import + the dispatch line in the existing WS event handler:

```typescript
import { applyPresenceEvent } from "./members";
// ... other imports ...

createRoot(() => {
  const joined = new Set<ChannelKey>();

  // ... existing on(token) cleanup ...

  createEffect(() => {
    const u = user();
    const cbs = channelsBySlug();
    if (!u || !cbs) return;
    for (const [slug, list] of Object.entries(cbs)) {
      for (const ch of list) {
        const key = channelKey(slug, ch.name);
        if (joined.has(key)) continue;
        const phx = joinChannel(u.name, slug, ch.name);
        phx.on("event", (payload: ChannelEvent) => {
          if (payload.kind !== "message") return;
          // Scrollback ingestion — unchanged.
          appendToScrollback(key, payload.message);
          // Members presence delta — applyPresenceEvent filters by kind
          // internally (presence kinds mutate; content kinds no-op).
          applyPresenceEvent(key, payload.message);
          // Unread bump — unchanged.
          const sel = untrack(selectedChannel);
          if (sel && sel.networkSlug === slug && sel.channelName === ch.name) return;
          bumpUnread(key);
        });
        joined.add(key);
      }
    }
  });
});
```

- [ ] **Step 4: Run tests — must pass**

```bash
bun --cwd cicchetto run test cicchetto/src/__tests__/subscribe.test.ts
```

Expected: all subscribe tests pass, including the new dispatch test.

- [ ] **Step 5: Commit**

```bash
git add cicchetto/src/lib/subscribe.ts cicchetto/src/__tests__/subscribe.test.ts
git commit -m "$(cat <<'EOF'
feat(cicchetto): subscribe.ts dispatches presence to members.ts

The WS handler now also calls members.applyPresenceEvent(key, msg)
for each event arriving on the per-channel scrollback stream —
applyPresenceEvent itself filters by kind (presence vs content), so
the dispatch is unconditional at the call site. Q4 of P4-1 cluster
pinned this single-stream derivation (no new server-side broadcast).

Cluster: P4-1.
EOF
)"
```

---

## Phase 7 — Cicchetto: compose.ts verb store

### Task 21: `lib/compose.ts` — per-channel draft, history, tab-complete, slash dispatch

The compose verb store. Owns:
- `composeByChannel: Record<ChannelKey, {draft, history, historyCursor}>`.
- `setDraft(key, value)` — typing into the textarea.
- `recallPrev(key)` / `recallNext(key)` — up/down history navigation.
- `submit(key)` — parses slash via `slashCommands.parseSlash`, dispatches to the right REST/Session call, appends to history, clears draft, returns `{ok: true} | {error: ...}`.
- `tabComplete(key, input, cursor)` — pure-function helper. Returns `{newInput, newCursor}` or `null` when no completion possible.

**Files:**
- Create: `cicchetto/src/lib/compose.ts`
- Create: `cicchetto/src/__tests__/compose.test.ts`

- [ ] **Step 1: Failing tests**

Create `cicchetto/src/__tests__/compose.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";
import { channelKey } from "../lib/channelKey";

vi.mock("../lib/api", () => ({
  postTopic: vi.fn(),
  postNick: vi.fn(),
  setOn401Handler: vi.fn(),
}));

vi.mock("../lib/scrollback", () => ({
  sendMessage: vi.fn(),
}));

vi.mock("../lib/members", () => ({
  membersByChannel: vi.fn(() => ({})),
  applyPresenceEvent: vi.fn(),
  loadMembers: vi.fn(),
}));

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  vi.clearAllMocks();
});

describe("compose draft state", () => {
  it("setDraft writes per-channel; getDraft reads", async () => {
    localStorage.setItem("grappa-token", "tok");
    const compose = await import("../lib/compose");
    const k1 = channelKey("freenode", "#a");
    const k2 = channelKey("freenode", "#b");
    compose.setDraft(k1, "hello");
    compose.setDraft(k2, "world");
    expect(compose.getDraft(k1)).toBe("hello");
    expect(compose.getDraft(k2)).toBe("world");
  });

  it("getDraft returns empty string for an untouched channel", async () => {
    const compose = await import("../lib/compose");
    expect(compose.getDraft(channelKey("freenode", "#never"))).toBe("");
  });
});

describe("compose history (up/down recall)", () => {
  it("submit pushes the body onto history; recallPrev returns it", async () => {
    localStorage.setItem("grappa-token", "tok");
    const sb = await import("../lib/scrollback");
    vi.mocked(sb.sendMessage).mockResolvedValue();

    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");

    compose.setDraft(k, "first message");
    await compose.submit(k, "freenode", "#a");
    compose.setDraft(k, "");

    compose.recallPrev(k);
    expect(compose.getDraft(k)).toBe("first message");
  });

  it("recallPrev/Next walks the history both directions", async () => {
    localStorage.setItem("grappa-token", "tok");
    const sb = await import("../lib/scrollback");
    vi.mocked(sb.sendMessage).mockResolvedValue();

    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");

    for (const body of ["one", "two", "three"]) {
      compose.setDraft(k, body);
      await compose.submit(k, "freenode", "#a");
    }
    compose.setDraft(k, "");

    compose.recallPrev(k);
    expect(compose.getDraft(k)).toBe("three");
    compose.recallPrev(k);
    expect(compose.getDraft(k)).toBe("two");
    compose.recallPrev(k);
    expect(compose.getDraft(k)).toBe("one");
    compose.recallPrev(k); // already at oldest — clamp
    expect(compose.getDraft(k)).toBe("one");

    compose.recallNext(k);
    expect(compose.getDraft(k)).toBe("two");
    compose.recallNext(k);
    expect(compose.getDraft(k)).toBe("three");
    compose.recallNext(k); // past newest — return to empty draft
    expect(compose.getDraft(k)).toBe("");
  });
});

describe("compose submit — slash command dispatch", () => {
  it(":privmsg sends via scrollback.sendMessage", async () => {
    localStorage.setItem("grappa-token", "tok");
    const sb = await import("../lib/scrollback");
    vi.mocked(sb.sendMessage).mockResolvedValue();

    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "hello");
    const result = await compose.submit(k, "freenode", "#a");

    expect(sb.sendMessage).toHaveBeenCalledWith("freenode", "#a", "hello");
    expect(result).toEqual({ ok: true });
  });

  it("/me action sends as ACTION via scrollback.sendMessage with CTCP framing", async () => {
    localStorage.setItem("grappa-token", "tok");
    const sb = await import("../lib/scrollback");
    vi.mocked(sb.sendMessage).mockResolvedValue();

    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/me waves");
    const result = await compose.submit(k, "freenode", "#a");

    // CTCP ACTION wraps body as \x01ACTION <text>\x01
    expect(sb.sendMessage).toHaveBeenCalledWith("freenode", "#a", "\x01ACTION waves\x01");
    expect(result).toEqual({ ok: true });
  });

  it("/topic body posts to /topic endpoint", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.postTopic).mockResolvedValue();

    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/topic ciao mondo");
    const result = await compose.submit(k, "freenode", "#a");

    expect(api.postTopic).toHaveBeenCalledWith("tok", "freenode", "#a", "ciao mondo");
    expect(result).toEqual({ ok: true });
  });

  it("/nick newnick posts to /nick endpoint", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.postNick).mockResolvedValue();

    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/nick vjt-away");
    const result = await compose.submit(k, "freenode", "#a");

    expect(api.postNick).toHaveBeenCalledWith("tok", "freenode", "vjt-away");
    expect(result).toEqual({ ok: true });
  });

  it("/msg target body sends PRIVMSG to target via scrollback.sendMessage", async () => {
    localStorage.setItem("grappa-token", "tok");
    const sb = await import("../lib/scrollback");
    vi.mocked(sb.sendMessage).mockResolvedValue();

    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/msg alice ciao");
    const result = await compose.submit(k, "freenode", "#a");

    expect(sb.sendMessage).toHaveBeenCalledWith("freenode", "alice", "ciao");
    expect(result).toEqual({ ok: true });
  });

  it("unknown slash returns {error: 'unknown command'}", async () => {
    localStorage.setItem("grappa-token", "tok");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/whois alice");
    const result = await compose.submit(k, "freenode", "#a");
    expect(result).toEqual({ error: "unknown command: /whois" });
  });

  it("empty draft returns {error: 'empty'} without dispatching", async () => {
    const sb = await import("../lib/scrollback");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "   ");
    const result = await compose.submit(k, "freenode", "#a");
    expect(result).toEqual({ error: "empty" });
    expect(sb.sendMessage).not.toHaveBeenCalled();
  });
});

describe("compose tabComplete (members-only, P4-1 Q6)", () => {
  it("returns null when no members", async () => {
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    expect(compose.tabComplete(k, "hello al", 8, true)).toBeNull();
  });

  it("completes the leading nick prefix at the cursor", async () => {
    const members = await import("../lib/members");
    vi.mocked(members.membersByChannel).mockReturnValue({
      [channelKey("freenode", "#a")]: [
        { nick: "alice", modes: [] },
        { nick: "alex", modes: [] },
        { nick: "bob", modes: [] },
      ],
    });

    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    const r = compose.tabComplete(k, "hi al", 5, true);
    expect(r).not.toBeNull();
    // First match alphabetically: alex
    expect(r?.newInput).toBe("hi alex");
    expect(r?.newCursor).toBe(7);
  });

  it("cycles through matches on repeated tab", async () => {
    const members = await import("../lib/members");
    vi.mocked(members.membersByChannel).mockReturnValue({
      [channelKey("freenode", "#a")]: [
        { nick: "alice", modes: [] },
        { nick: "alex", modes: [] },
      ],
    });

    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    const r1 = compose.tabComplete(k, "al", 2, true);
    expect(r1?.newInput).toBe("alex");
    const r2 = compose.tabComplete(k, r1?.newInput ?? "", r1?.newCursor ?? 0, true);
    expect(r2?.newInput).toBe("alice");
    const r3 = compose.tabComplete(k, r2?.newInput ?? "", r2?.newCursor ?? 0, true);
    // Wraps back to alex
    expect(r3?.newInput).toBe("alex");
  });
});
```

- [ ] **Step 2: Run tests — must fail**

```bash
bun --cwd cicchetto run test cicchetto/src/__tests__/compose.test.ts
```

- [ ] **Step 3: Implement — `compose.ts`**

Create `cicchetto/src/lib/compose.ts`:

```typescript
import { createEffect, createRoot, createSignal, on } from "solid-js";
import { postNick, postTopic } from "./api";
import { token } from "./auth";
import { type ChannelKey } from "./channelKey";
import { membersByChannel } from "./members";
import { sendMessage as sendPrivmsg } from "./scrollback";
import { parseSlash } from "./slashCommands";

// Per-channel compose state. Owns:
//   * `composeByChannel` — { draft, history, historyCursor } per key.
//     `historyCursor === null` = at-bottom (typing fresh draft);
//     non-null cursor walks the history array.
//   * `getDraft(key)` / `setDraft(key, value)` — read/write current draft.
//   * `recallPrev(key)` / `recallNext(key)` — up/down history walk.
//   * `submit(key, slug, channel)` — parses slash + dispatches; pushes
//     non-empty bodies to history; clears draft on success.
//   * `tabComplete(key, input, cursor, forward)` — pure helper.
//
// Identity-scoped on(token) cleanup mirrors scrollback / selection /
// members — logout flushes ALL drafts + histories.
//
// History semantics: most-recent-last; cursor walks BACKWARDS from the
// tail (recallPrev decrements cursor index). At index 0 (oldest)
// recallPrev clamps; at history.length (one past newest) recallNext
// returns the user to a fresh empty draft.

type ComposeState = {
  draft: string;
  history: string[];
  historyCursor: number | null; // null = bottom (live draft)
};

type SubmitResult = { ok: true } | { error: string };

const empty = (): ComposeState => ({ draft: "", history: [], historyCursor: null });

const exports = createRoot(() => {
  const [composeByChannel, setComposeByChannel] = createSignal<
    Record<ChannelKey, ComposeState>
  >({});

  // Tab-complete cycle state (NOT per-channel — there's one focused
  // textarea at a time). Tracks the prefix + index across consecutive
  // tab presses; reset by setDraft on a non-tab edit.
  let tabCycle: { key: ChannelKey; prefix: string; idx: number } | null = null;

  createEffect(
    on(token, (t, prev) => {
      if (prev != null && t !== prev) {
        setComposeByChannel({});
        tabCycle = null;
      }
    }),
  );

  const getState = (key: ChannelKey): ComposeState =>
    composeByChannel()[key] ?? empty();

  const writeState = (key: ChannelKey, fn: (s: ComposeState) => ComposeState): void => {
    setComposeByChannel((prev) => ({
      ...prev,
      [key]: fn(prev[key] ?? empty()),
    }));
  };

  const getDraft = (key: ChannelKey): string => getState(key).draft;

  const setDraft = (key: ChannelKey, value: string): void => {
    // Any explicit edit (typing, paste, clear) breaks the tab-cycle
    // and resets the history cursor to null (we're back to live draft).
    tabCycle = null;
    writeState(key, (s) => ({ ...s, draft: value, historyCursor: null }));
  };

  const recallPrev = (key: ChannelKey): void => {
    writeState(key, (s) => {
      if (s.history.length === 0) return s;
      const cur = s.historyCursor ?? s.history.length;
      const next = Math.max(0, cur - 1);
      const draft = s.history[next] ?? s.draft;
      return { ...s, draft, historyCursor: next };
    });
  };

  const recallNext = (key: ChannelKey): void => {
    writeState(key, (s) => {
      if (s.historyCursor === null) return s;
      const next = s.historyCursor + 1;
      if (next >= s.history.length) {
        return { ...s, draft: "", historyCursor: null };
      }
      return { ...s, draft: s.history[next] ?? "", historyCursor: next };
    });
  };

  const pushHistory = (key: ChannelKey, body: string): void => {
    writeState(key, (s) => ({
      ...s,
      history: [...s.history, body],
      historyCursor: null,
    }));
  };

  const submit = async (
    key: ChannelKey,
    networkSlug: string,
    channelName: string,
  ): Promise<SubmitResult> => {
    const t = token();
    if (!t) return { error: "no session" };
    const state = getState(key);
    const cmd = parseSlash(state.draft);

    let result: SubmitResult;
    switch (cmd.kind) {
      case "empty":
        return { error: "empty" };
      case "privmsg":
        await sendPrivmsg(networkSlug, channelName, cmd.body);
        result = { ok: true };
        break;
      case "me":
        // CTCP ACTION framing: \x01ACTION <text>\x01
        await sendPrivmsg(networkSlug, channelName, `\x01ACTION ${cmd.body}\x01`);
        result = { ok: true };
        break;
      case "join":
        // Reuse existing /channels POST via api.ts? scrollback.ts doesn't
        // expose join; fall through — implementer wires the existing
        // listChannels client (api.postChannelJoin) which already exists
        // at lib/api.ts (see the channels POST helper). For brevity here
        // we delegate to the scrollback "send raw line" path; if absent,
        // a small `api.postJoin(token, slug, channel)` lands in this
        // task as a sibling of postTopic.
        // Add api.postJoin / api.postPart helpers in this commit if not
        // already present.
        await import("./api").then((api) => api.postJoin(t, networkSlug, cmd.channel));
        result = { ok: true };
        break;
      case "part": {
        const target = cmd.channel ?? channelName;
        await import("./api").then((api) => api.postPart(t, networkSlug, target));
        result = { ok: true };
        break;
      }
      case "topic":
        await postTopic(t, networkSlug, channelName, cmd.body);
        result = { ok: true };
        break;
      case "nick":
        await postNick(t, networkSlug, cmd.nick);
        result = { ok: true };
        break;
      case "msg":
        await sendPrivmsg(networkSlug, cmd.target, cmd.body);
        result = { ok: true };
        break;
      case "unknown":
        return { error: `unknown command: /${cmd.verb}` };
      default: {
        const _exhaustive: never = cmd;
        void _exhaustive;
        return { error: "unhandled" };
      }
    }

    // Success: push the original draft (NOT the parsed cmd) onto history,
    // clear the draft, reset cursor.
    if (state.draft.trim() !== "") pushHistory(key, state.draft);
    writeState(key, (s) => ({ ...s, draft: "", historyCursor: null }));
    tabCycle = null;
    return result;
  };

  // Tab-complete: members-only (Q6 of P4-1 cluster). Pure-ish — reads
  // members snapshot, returns new {input, cursor} or null.
  //
  // Algorithm:
  //   1. Find the word at `cursor` (walk back to whitespace OR start).
  //   2. If word.length === 0, return null.
  //   3. Filter members.nick by case-insensitive prefix match.
  //   4. Sort matches alphabetically (stable order across cycles).
  //   5. If first call (no cycle, OR prefix changed), pick first match.
  //   6. If cycling (same prefix, repeated tab), advance idx (forward
  //      true) or backward; wrap mod matches.length.
  //   7. Replace the word with the chosen nick, update cursor.
  const tabComplete = (
    key: ChannelKey,
    input: string,
    cursor: number,
    forward: boolean,
  ): { newInput: string; newCursor: number } | null => {
    const all = membersByChannel()[key] ?? [];
    if (all.length === 0) return null;

    // Find word boundaries.
    let start = cursor;
    while (start > 0 && !/\s/.test(input[start - 1] ?? "")) start -= 1;
    const prefix = input.slice(start, cursor);
    if (prefix.length === 0) return null;

    const lower = prefix.toLowerCase();
    const matches = all
      .filter((m) => m.nick.toLowerCase().startsWith(lower))
      .map((m) => m.nick)
      .sort((a, b) => a.localeCompare(b));
    if (matches.length === 0) return null;

    // Cycle bookkeeping.
    let idx: number;
    if (
      tabCycle !== null &&
      tabCycle.key === key &&
      tabCycle.prefix === lower
    ) {
      idx =
        (tabCycle.idx + (forward ? 1 : -1) + matches.length) % matches.length;
    } else {
      idx = 0;
    }
    tabCycle = { key, prefix: lower, idx };

    const chosen = matches[idx] ?? matches[0];
    if (chosen === undefined) return null;
    const newInput = input.slice(0, start) + chosen + input.slice(cursor);
    const newCursor = start + chosen.length;
    return { newInput, newCursor };
  };

  return {
    composeByChannel,
    getDraft,
    setDraft,
    recallPrev,
    recallNext,
    submit,
    tabComplete,
  };
});

export const composeByChannel = exports.composeByChannel;
export const getDraft = exports.getDraft;
export const setDraft = exports.setDraft;
export const recallPrev = exports.recallPrev;
export const recallNext = exports.recallNext;
export const submit = exports.submit;
export const tabComplete = exports.tabComplete;
```

Note: `compose.ts`'s `:join` / `:part` arms call `api.postJoin` and `api.postPart`. Add these helpers to `cicchetto/src/lib/api.ts` if absent — they wrap the existing POST/DELETE on `/networks/:slug/channels`:

```typescript
export async function postJoin(
  token: string,
  networkSlug: string,
  channelName: string,
): Promise<void> {
  const res = await fetch(
    `/networks/${encodeURIComponent(networkSlug)}/channels`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name: channelName }),
    },
  );
  if (!res.ok) throw await readError(res);
}

export async function postPart(
  token: string,
  networkSlug: string,
  channelName: string,
): Promise<void> {
  const res = await fetch(
    `/networks/${encodeURIComponent(networkSlug)}/channels/${encodeURIComponent(channelName)}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  if (!res.ok) throw await readError(res);
}
```

- [ ] **Step 4: Run tests — must pass**

```bash
bun --cwd cicchetto run test cicchetto/src/__tests__/compose.test.ts
bun --cwd cicchetto run test cicchetto/src/__tests__/api.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add cicchetto/src/lib/compose.ts cicchetto/src/lib/api.ts cicchetto/src/__tests__/compose.test.ts cicchetto/src/__tests__/api.test.ts
git commit -m "$(cat <<'EOF'
feat(cicchetto): add compose.ts verb store + slash dispatch + tab complete

Per-channel compose state (draft + history + historyCursor). Verbs:
  - getDraft / setDraft
  - recallPrev / recallNext (up/down history walk)
  - submit(key, slug, channel) — parses slash via parseSlash, dispatches
    to /privmsg /me /join /part /topic /nick /msg endpoints; pushes
    non-empty bodies to history; clears draft + cursor on success
  - tabComplete(key, input, cursor, forward) — members-only completion
    (Q6 pinned); cycles through alphabetical matches

api.ts: new postJoin / postPart helpers (used by /join /part).

Identity-scoped on(token) cleanup arm. Mirrors scrollback / selection /
members module-singleton shape.

Cluster: P4-1.
EOF
)"
```

---

## Phase 8 — Cicchetto: three-pane shell + components

### Task 22: ScrollbackPane refactor — drop compose, add mention highlight

Remove the inline compose form from `ScrollbackPane.tsx`; the new `ComposeBox` (Task 23) takes over. Add mention-highlight class to lines whose body case-insensitively word-boundary-matches the operator's nick.

**Files:**
- Modify: `cicchetto/src/ScrollbackPane.tsx`
- Modify: `cicchetto/src/__tests__/ScrollbackPane.test.tsx`

- [ ] **Step 1: Failing tests — mention highlight**

Append to `cicchetto/src/__tests__/ScrollbackPane.test.tsx` a new describe block:

```typescript
describe("mention highlight (P4-1)", () => {
  it("adds .scrollback-mention to lines that mention the user's nick", async () => {
    // Setup: user.name = "vjt"; one line containing "hi vjt!".
    // Mock networks.user() to return {name: "vjt"}.
    // Render ScrollbackPane with a privmsg whose body mentions "vjt".
    // Assert the rendered line has classList "scrollback-mention".

    vi.doMock("../lib/networks", () => ({
      user: () => ({ name: "vjt" }),
      networks: () => [],
      channelsBySlug: () => ({}),
    }));

    const sb = await import("../lib/scrollback");
    sb.appendToScrollback(channelKey("freenode", "#a"), {
      id: 1,
      network: "freenode",
      channel: "#a",
      server_time: 100,
      kind: "privmsg",
      sender: "alice",
      body: "hi vjt!",
      meta: {},
    });

    const { default: ScrollbackPane } = await import("../ScrollbackPane");
    const { container } = render(() => (
      <ScrollbackPane networkSlug="freenode" channelName="#a" />
    ));

    const line = container.querySelector('[data-kind="privmsg"]');
    expect(line?.classList.contains("scrollback-mention")).toBe(true);
  });

  it("case-insensitive + word-boundary match (does not match VJT inside another word)", async () => {
    vi.doMock("../lib/networks", () => ({
      user: () => ({ name: "vjt" }),
      networks: () => [],
      channelsBySlug: () => ({}),
    }));

    const sb = await import("../lib/scrollback");
    sb.appendToScrollback(channelKey("freenode", "#a"), {
      id: 2,
      network: "freenode",
      channel: "#a",
      server_time: 100,
      kind: "privmsg",
      sender: "alice",
      body: "vjtfoo bar",
      meta: {},
    });

    const { default: ScrollbackPane } = await import("../ScrollbackPane");
    const { container } = render(() => (
      <ScrollbackPane networkSlug="freenode" channelName="#a" />
    ));

    const line = container.querySelector('[data-kind="privmsg"]');
    expect(line?.classList.contains("scrollback-mention")).toBe(false);
  });

  it("does NOT show inline compose form anymore (P4-1 split)", async () => {
    const { default: ScrollbackPane } = await import("../ScrollbackPane");
    const { container } = render(() => (
      <ScrollbackPane networkSlug="freenode" channelName="#a" />
    ));
    expect(container.querySelector("textarea")).toBeNull();
  });
});
```

(Existing tests in `ScrollbackPane.test.tsx` that exercised the compose form need to migrate to `ComposeBox.test.tsx` in Task 23. Mark them with `it.skip` for now — Task 23 picks them up.)

- [ ] **Step 2: Implement — refactor `ScrollbackPane.tsx`**

Edit `cicchetto/src/ScrollbackPane.tsx`. Two changes:

1. **Remove** the `ComposeForm` block + `draft`/`error`/`sending` signals + `onSubmit` + `onKeyDown` handlers. Keep only the scrollback list + auto-scroll. The new shape:

```typescript
import { type Component, createEffect, For, on, Show } from "solid-js";
import type { ScrollbackMessage } from "./lib/api";
import { channelKey } from "./lib/channelKey";
import { user } from "./lib/networks";
import { scrollbackByChannel } from "./lib/scrollback";

export type Props = {
  networkSlug: string;
  channelName: string;
};

const SCROLL_BOTTOM_THRESHOLD_PX = 50;

const formatTime = (epochMs: number): string => {
  const d = new Date(epochMs);
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  const ss = d.getSeconds().toString().padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
};

// (renderBody, PRESENCE_KINDS unchanged from pre-P4-1; copy verbatim)

// Mention matcher: case-insensitive word-boundary match against the
// operator's own nick. Only checks `body` (sender / channel / topic
// content are not "mentions" in the IRC UX sense). Plain regex with
// \b boundaries — Unicode-naive but matches mIRC/irssi convention.
const mentionsUser = (body: string | null, nick: string | null): boolean => {
  if (!body || !nick) return false;
  // Escape regex metacharacters in the nick (e.g. brackets are valid
  // RFC 2812 nick chars).
  const escaped = nick.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(body);
};

const ScrollbackLine: Component<{ msg: ScrollbackMessage; userNick: string | null }> = (
  props,
) => {
  const isMention = () =>
    props.msg.kind === "privmsg" && mentionsUser(props.msg.body, props.userNick);

  return (
    <div
      class="scrollback-line"
      classList={{
        "scrollback-action": props.msg.kind === "action",
        "scrollback-notice": props.msg.kind === "notice",
        "scrollback-presence": PRESENCE_KINDS.has(props.msg.kind),
        "scrollback-mention": isMention(),
      }}
      data-testid="scrollback-line"
      data-kind={props.msg.kind}
    >
      <span class="scrollback-time">{formatTime(props.msg.server_time)}</span>{" "}
      {renderBody(props.msg)}
    </div>
  );
};

const ScrollbackPane: Component<Props> = (props) => {
  let listRef!: HTMLDivElement;
  const [atBottom, setAtBottom] = createSignal(true);

  const messages = () => scrollbackByChannel()[channelKey(props.networkSlug, props.channelName)];
  const userNick = () => user()?.name ?? null;

  createEffect(
    on(
      () => messages()?.length ?? 0,
      () => {
        if (!listRef) return;
        if (atBottom()) listRef.scrollTop = listRef.scrollHeight;
      },
    ),
  );

  const onScroll = () => {
    if (!listRef) return;
    const distance = listRef.scrollHeight - listRef.scrollTop - listRef.clientHeight;
    setAtBottom(distance <= SCROLL_BOTTOM_THRESHOLD_PX);
  };

  return (
    <div class="scrollback-pane">
      <div ref={listRef} class="scrollback" onScroll={onScroll} data-testid="scrollback">
        <Show
          when={(messages()?.length ?? 0) > 0}
          fallback={<p class="muted scrollback-empty">no messages yet</p>}
        >
          <For each={messages()}>
            {(msg) => <ScrollbackLine msg={msg} userNick={userNick()} />}
          </For>
        </Show>
      </div>
    </div>
  );
};

export default ScrollbackPane;
```

(Keep `renderBody` + `PRESENCE_KINDS` + `reasonOf` blocks from the pre-P4-1 file verbatim — they're unchanged.)

- [ ] **Step 3: Run tests + check**

```bash
bun --cwd cicchetto run test cicchetto/src/__tests__/ScrollbackPane.test.tsx
bun --cwd cicchetto run check
```

Expected: new mention-highlight tests pass; legacy compose tests in this file skipped (will move to ComposeBox.test.tsx in Task 23).

- [ ] **Step 4: Commit**

```bash
git add cicchetto/src/ScrollbackPane.tsx cicchetto/src/__tests__/ScrollbackPane.test.tsx
git commit -m "$(cat <<'EOF'
refactor(scrollback-pane): pure-render list + mention highlight

Drop the inline compose form (moves to ComposeBox in Task 23). Pure
projection of scrollbackByChannel signal + user nick mention matcher.
Mention regex is word-boundary case-insensitive against networks.user()
.name; matched lines get .scrollback-mention class (yellow tint via
themes/default.css).

Cluster: P4-1.
EOF
)"
```

---

### Task 23: New `ComposeBox.tsx` component

The sticky-bottom textarea + send button. Consumes `compose.ts` verb store. Wires Enter / Shift+Enter / Up/Down arrow / Tab / Shift+Tab to the right verbs. Surfaces errors as inline banner.

**Files:**
- Create: `cicchetto/src/ComposeBox.tsx`
- Create: `cicchetto/src/__tests__/ComposeBox.test.tsx`

- [ ] **Step 1: Failing tests**

Create `cicchetto/src/__tests__/ComposeBox.test.tsx`:

```typescript
import { fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ComposeBox from "../ComposeBox";

vi.mock("../lib/compose", () => ({
  getDraft: vi.fn(() => ""),
  setDraft: vi.fn(),
  submit: vi.fn(),
  recallPrev: vi.fn(),
  recallNext: vi.fn(),
  tabComplete: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {});

describe("ComposeBox", () => {
  it("renders a textarea + send button with channel placeholder", () => {
    render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
    expect(screen.getByPlaceholderText(/message #a/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /send/i })).toBeInTheDocument();
  });

  it("typing fires compose.setDraft", async () => {
    const compose = await import("../lib/compose");
    render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
    fireEvent.input(screen.getByPlaceholderText(/message #a/i), { target: { value: "hi" } });
    expect(compose.setDraft).toHaveBeenCalled();
  });

  it("Enter (no shift) submits", async () => {
    const compose = await import("../lib/compose");
    vi.mocked(compose.submit).mockResolvedValue({ ok: true });
    render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
    const ta = screen.getByPlaceholderText(/message #a/i);
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(compose.submit).toHaveBeenCalledWith(expect.anything(), "freenode", "#a");
  });

  it("Shift+Enter inserts a newline (does NOT submit)", async () => {
    const compose = await import("../lib/compose");
    render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
    const ta = screen.getByPlaceholderText(/message #a/i);
    fireEvent.keyDown(ta, { key: "Enter", shiftKey: true });
    expect(compose.submit).not.toHaveBeenCalled();
  });

  it("Up arrow on empty cursor calls recallPrev", async () => {
    const compose = await import("../lib/compose");
    render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
    const ta = screen.getByPlaceholderText(/message #a/i);
    fireEvent.keyDown(ta, { key: "ArrowUp" });
    expect(compose.recallPrev).toHaveBeenCalled();
  });

  it("error from submit renders an alert banner", async () => {
    const compose = await import("../lib/compose");
    vi.mocked(compose.submit).mockResolvedValue({ error: "unknown command: /whois" });
    render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
    const ta = screen.getByPlaceholderText(/message #a/i);
    fireEvent.keyDown(ta, { key: "Enter" });
    await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent(/unknown command/i);
  });
});
```

- [ ] **Step 2: Implement — `ComposeBox.tsx`**

Create `cicchetto/src/ComposeBox.tsx`:

```typescript
import { type Component, createSignal, Show } from "solid-js";
import { channelKey } from "./lib/channelKey";
import { getDraft, setDraft, submit, recallPrev, recallNext } from "./lib/compose";

// Sticky-bottom compose surface. Reads + writes compose.ts state;
// dispatches submit on Enter; arrow keys walk history.
//
// Tab-complete is wired by keybindings.ts (Phase 5) which fires
// cycleNickComplete on Tab in the textarea — keybindings.ts dispatches
// to a handler that Shell.tsx wires to compose.tabComplete. That two-
// hop indirection avoids ComposeBox having to know about the global
// keybinding install; selecting a different focused element won't fire
// the wrong tab handler.

export type Props = {
  networkSlug: string;
  channelName: string;
};

const ComposeBox: Component<Props> = (props) => {
  const key = () => channelKey(props.networkSlug, props.channelName);
  const [error, setError] = createSignal<string | null>(null);
  const [sending, setSending] = createSignal(false);

  const onInput = (e: Event) => {
    const value = (e.currentTarget as HTMLTextAreaElement).value;
    setDraft(key(), value);
    setError(null);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void doSubmit();
      return;
    }
    if (e.key === "ArrowUp") {
      const ta = e.currentTarget as HTMLTextAreaElement;
      // Only walk history if cursor is on first line; otherwise let
      // native cursor movement handle it.
      const before = ta.value.slice(0, ta.selectionStart);
      if (!before.includes("\n")) {
        e.preventDefault();
        recallPrev(key());
      }
      return;
    }
    if (e.key === "ArrowDown") {
      const ta = e.currentTarget as HTMLTextAreaElement;
      const after = ta.value.slice(ta.selectionEnd);
      if (!after.includes("\n")) {
        e.preventDefault();
        recallNext(key());
      }
      return;
    }
  };

  const doSubmit = async (): Promise<void> => {
    if (sending()) return;
    setSending(true);
    setError(null);
    try {
      const result = await submit(key(), props.networkSlug, props.channelName);
      if ("error" in result && result.error !== "empty") {
        setError(result.error);
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <form class="compose-box" onSubmit={(e) => { e.preventDefault(); void doSubmit(); }}>
        <textarea
          value={getDraft(key())}
          onInput={onInput}
          onKeyDown={onKeyDown}
          placeholder={`message ${props.channelName}`}
          rows={1}
          disabled={sending()}
          aria-label="compose message"
        />
        <button type="submit" disabled={sending() || getDraft(key()).trim() === ""}>
          send
        </button>
      </form>
      <Show when={error()}>
        {(msg) => (
          <p class="compose-box-error" role="alert">
            {msg()}
          </p>
        )}
      </Show>
    </>
  );
};

export default ComposeBox;
```

- [ ] **Step 3: Run tests + check + commit**

```bash
bun --cwd cicchetto run test cicchetto/src/__tests__/ComposeBox.test.tsx
bun --cwd cicchetto run check
```

```bash
git add cicchetto/src/ComposeBox.tsx cicchetto/src/__tests__/ComposeBox.test.tsx
git commit -m "$(cat <<'EOF'
feat(cicchetto): new ComposeBox component (P4-1)

Sticky-bottom textarea + send button. Consumes compose.ts verb store.
Enter submits; Shift+Enter inserts newline; Up/Down on first/last line
walks history (recallPrev / recallNext); Tab cycle wired via
keybindings.ts in Shell.tsx.

Errors from submit (unknown command, network failure) surface as an
inline alert banner.

Cluster: P4-1.
EOF
)"
```

---

### Task 24: New `Sidebar.tsx` component (extracted from Shell)

Renders the network → channel tree. Consumes the new `ChannelEntry` shape (`joined`, `source`); parted channels styled `.parted`. Mention badge + unread count rendered separately.

**Files:**
- Create: `cicchetto/src/Sidebar.tsx`
- Create: `cicchetto/src/__tests__/Sidebar.test.tsx`

- [ ] **Step 1: Failing tests** — render under known networks/channels mock; expect channel list with correct classes for joined / parted; expect mention badge for channels with mentions.

```typescript
import { fireEvent, render, screen } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/networks", () => ({
  networks: () => [{ id: 1, slug: "freenode", inserted_at: "", updated_at: "" }],
  channelsBySlug: () => ({
    freenode: [
      { name: "#italia", joined: true, source: "autojoin" },
      { name: "#azzurra", joined: false, source: "autojoin" },
      { name: "#bnc", joined: true, source: "joined" },
    ],
  }),
}));

vi.mock("../lib/selection", () => ({
  selectedChannel: () => null,
  setSelectedChannel: vi.fn(),
  unreadCounts: () => ({ "freenode #bnc": 3 }),
}));

vi.mock("../lib/mentions", () => ({
  mentionCounts: () => ({ "freenode #italia": 2 }),
}));

import Sidebar from "../Sidebar";

describe("Sidebar", () => {
  it("renders all channels grouped by network", () => {
    render(() => <Sidebar onSelect={vi.fn()} />);
    expect(screen.getByText("#italia")).toBeInTheDocument();
    expect(screen.getByText("#azzurra")).toBeInTheDocument();
    expect(screen.getByText("#bnc")).toBeInTheDocument();
  });

  it("parted channels (joined: false) get the .parted class", () => {
    render(() => <Sidebar onSelect={vi.fn()} />);
    const parted = screen.getByText("#azzurra");
    expect(parted.classList.contains("parted")).toBe(true);
  });

  it("renders unread count for channels with messages while away", () => {
    render(() => <Sidebar onSelect={vi.fn()} />);
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("renders mention badge for channels with mentions", () => {
    render(() => <Sidebar onSelect={vi.fn()} />);
    // The mention badge is "@2" or similar; class is sidebar-mention.
    const allBadges = document.querySelectorAll(".sidebar-mention");
    expect(allBadges.length).toBeGreaterThan(0);
  });

  it("clicking a channel calls onSelect + setSelectedChannel", async () => {
    const sel = await import("../lib/selection");
    const onSelect = vi.fn();
    render(() => <Sidebar onSelect={onSelect} />);
    fireEvent.click(screen.getByText("#italia"));
    expect(sel.setSelectedChannel).toHaveBeenCalledWith({
      networkSlug: "freenode",
      channelName: "#italia",
    });
    expect(onSelect).toHaveBeenCalled();
  });
});
```

(Note: `lib/mentions.ts` is a tiny store added in Task 28's behavioral-detail pass; for this task, mock it in tests + accept that the import line exists. If creating it as part of Task 24 is cleaner: a 30-line module mirroring `selection.ts`'s `unreadCounts` shape — `mentionCounts: Record<ChannelKey, number>` + `bumpMention(key)`. ScrollbackPane in Task 22 already detects mentions; subscribe.ts in Task 28 wires `bumpMention(key)` after `bumpUnread(key)` when `mentionsUser(msg.body, user.name)` is true.)

- [ ] **Step 2: Implement — `Sidebar.tsx`**

Create `cicchetto/src/Sidebar.tsx`:

```typescript
import { type Component, For, Show } from "solid-js";
import { channelKey } from "./lib/channelKey";
import { mentionCounts } from "./lib/mentions";
import { channelsBySlug, networks } from "./lib/networks";
import { selectedChannel, setSelectedChannel, unreadCounts } from "./lib/selection";

// Left-pane sidebar: network → channel tree. Consumes the post-A5
// ChannelEntry shape (joined + source); parted channels render greyed
// + italic via .parted class. Unread count + mention badge are
// separate visual signals (count = blue accent pill; mention = red
// pill).
//
// onSelect is fired AFTER the selection state is updated — Shell.tsx
// uses it to auto-close the mobile sidebar drawer.

export type Props = {
  onSelect?: () => void;
};

const Sidebar: Component<Props> = (props) => {
  const isSelected = (slug: string, name: string): boolean => {
    const s = selectedChannel();
    return s !== null && s.networkSlug === slug && s.channelName === name;
  };

  const handleClick = (slug: string, name: string) => {
    setSelectedChannel({ networkSlug: slug, channelName: name });
    props.onSelect?.();
  };

  return (
    <Show
      when={(networks()?.length ?? 0) > 0}
      fallback={<p class="muted sidebar-empty">no networks</p>}
    >
      <For each={networks()}>
        {(network) => (
          <section class="sidebar-network">
            <h3>{network.slug}</h3>
            <ul>
              <For each={channelsBySlug()?.[network.slug] ?? []}>
                {(channel) => {
                  const key = channelKey(network.slug, channel.name);
                  return (
                    <li classList={{ selected: isSelected(network.slug, channel.name) }}>
                      <button
                        type="button"
                        onClick={() => handleClick(network.slug, channel.name)}
                      >
                        <span
                          class="sidebar-channel-name"
                          classList={{ parted: !channel.joined }}
                        >
                          {channel.name}
                        </span>
                        <Show when={(unreadCounts()[key] ?? 0) > 0}>
                          <span class="sidebar-unread">{unreadCounts()[key]}</span>
                        </Show>
                        <Show when={(mentionCounts()[key] ?? 0) > 0}>
                          <span class="sidebar-mention">@{mentionCounts()[key]}</span>
                        </Show>
                      </button>
                    </li>
                  );
                }}
              </For>
            </ul>
          </section>
        )}
      </For>
    </Show>
  );
};

export default Sidebar;
```

- [ ] **Step 3: Create `lib/mentions.ts`** (tiny store, mirror of selection's `unreadCounts`)

```typescript
import { createEffect, createRoot, createSignal, on } from "solid-js";
import { token } from "./auth";
import { type ChannelKey, channelKey } from "./channelKey";
import { selectedChannel } from "./selection";

const exports = createRoot(() => {
  const [mentionCounts, setMentionCounts] = createSignal<Record<ChannelKey, number>>({});

  createEffect(
    on(token, (t, prev) => {
      if (prev != null && t !== prev) setMentionCounts({});
    }),
  );

  // Selection clears mention count for the just-selected channel,
  // mirroring selection's unread-clear behavior.
  createEffect(
    on(selectedChannel, (sel) => {
      if (!sel) return;
      const key = channelKey(sel.networkSlug, sel.channelName);
      setMentionCounts((prev) => {
        if (!(key in prev) || prev[key] === 0) return prev;
        const { [key]: _drop, ...rest } = prev;
        return rest;
      });
    }),
  );

  const bumpMention = (key: ChannelKey) => {
    setMentionCounts((prev) => ({ ...prev, [key]: (prev[key] ?? 0) + 1 }));
  };

  return { mentionCounts, bumpMention };
});

export const mentionCounts = exports.mentionCounts;
export const bumpMention = exports.bumpMention;
```

- [ ] **Step 4: Run tests + check + commit**

```bash
bun --cwd cicchetto run test cicchetto/src/__tests__/Sidebar.test.tsx
bun --cwd cicchetto run check
```

```bash
git add cicchetto/src/Sidebar.tsx cicchetto/src/lib/mentions.ts cicchetto/src/__tests__/Sidebar.test.tsx
git commit -m "$(cat <<'EOF'
feat(cicchetto): new Sidebar component + mentions.ts store

Sidebar extracts the network→channel tree from Shell. Consumes the
post-A5 ChannelEntry shape: parted channels (joined: false) render
greyed + italic via .parted class.

Two signal pills: unread count (blue, from selection.unreadCounts)
and mention count (red, from new mentions.bumpMention store).
Selection clears both.

Cluster: P4-1.
EOF
)"
```

---

### Task 25: New `TopicBar.tsx` component

Renders selected channel name + topic + nick count + the two ☰ hamburger buttons (mobile-only — hidden via CSS on desktop). Settings button opens SettingsDrawer.

**Files:**
- Create: `cicchetto/src/TopicBar.tsx`
- Create: `cicchetto/src/__tests__/TopicBar.test.tsx`

- [ ] **Step 1: Failing tests** — minimal: renders channel name; clicking ☰ left fires onToggleSidebar; clicking ☰ right fires onToggleMembers; clicking settings fires onOpenSettings.

```typescript
import { fireEvent, render, screen } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/members", () => ({
  membersByChannel: () => ({}),
}));

import TopicBar from "../TopicBar";

describe("TopicBar", () => {
  const baseProps = {
    networkSlug: "freenode",
    channelName: "#italia",
    onToggleSidebar: vi.fn(),
    onToggleMembers: vi.fn(),
    onOpenSettings: vi.fn(),
  };

  it("renders the selected channel name", () => {
    render(() => <TopicBar {...baseProps} />);
    expect(screen.getByText("#italia")).toBeInTheDocument();
  });

  it("clicking left hamburger fires onToggleSidebar", () => {
    const onToggleSidebar = vi.fn();
    render(() => <TopicBar {...baseProps} onToggleSidebar={onToggleSidebar} />);
    fireEvent.click(screen.getByLabelText(/open channel sidebar/i));
    expect(onToggleSidebar).toHaveBeenCalled();
  });

  it("clicking right hamburger fires onToggleMembers", () => {
    const onToggleMembers = vi.fn();
    render(() => <TopicBar {...baseProps} onToggleMembers={onToggleMembers} />);
    fireEvent.click(screen.getByLabelText(/open members sidebar/i));
    expect(onToggleMembers).toHaveBeenCalled();
  });

  it("clicking ⚙ settings fires onOpenSettings", () => {
    const onOpenSettings = vi.fn();
    render(() => <TopicBar {...baseProps} onOpenSettings={onOpenSettings} />);
    fireEvent.click(screen.getByLabelText(/open settings/i));
    expect(onOpenSettings).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Implement — `TopicBar.tsx`**

```typescript
import { type Component } from "solid-js";
import { channelKey } from "./lib/channelKey";
import { membersByChannel } from "./lib/members";

// Top bar of the middle pane. Hosts:
//  * left ☰ hamburger — opens the channel sidebar drawer (mobile only)
//  * channel name (bold accent)
//  * topic text (current topic — derived from latest :topic scrollback row;
//    P4-1 leaves topic-extraction simple — read state.topic from a
//    future store, OR pull last :topic message body from scrollback;
//    walking-skeleton path: empty string + a TODO for a topic store
//    in M-cluster polish)
//  * nick count (members.length)
//  * right ☰ hamburger — opens members drawer (mobile only)
//  * ⚙ settings button — opens SettingsDrawer
//
// Topic display in P4-1 ship: empty / placeholder. The full topic-
// derivation store lands in M-cluster polish.

export type Props = {
  networkSlug: string;
  channelName: string;
  onToggleSidebar: () => void;
  onToggleMembers: () => void;
  onOpenSettings: () => void;
};

const TopicBar: Component<Props> = (props) => {
  const key = () => channelKey(props.networkSlug, props.channelName);
  const memberCount = () => membersByChannel()[key()]?.length ?? 0;

  return (
    <div class="topic-bar">
      <button
        type="button"
        class="topic-bar-hamburger"
        aria-label="open channel sidebar"
        onClick={props.onToggleSidebar}
      >
        ☰
      </button>
      <span class="topic-bar-channel">{props.channelName}</span>
      <span class="topic-bar-topic">
        {/* P4-1 placeholder; topic store in M-cluster */}
      </span>
      <span class="topic-bar-count">{memberCount()} nicks</span>
      <button
        type="button"
        class="topic-bar-hamburger"
        aria-label="open members sidebar"
        onClick={props.onToggleMembers}
      >
        ☰
      </button>
      <button
        type="button"
        class="topic-bar-settings"
        aria-label="open settings"
        onClick={props.onOpenSettings}
      >
        ⚙
      </button>
    </div>
  );
};

export default TopicBar;
```

- [ ] **Step 3: Run tests + check + commit**

```bash
bun --cwd cicchetto run test cicchetto/src/__tests__/TopicBar.test.tsx
```

```bash
git add cicchetto/src/TopicBar.tsx cicchetto/src/__tests__/TopicBar.test.tsx
git commit -m "$(cat <<'EOF'
feat(cicchetto): new TopicBar component (P4-1)

Top of middle pane: ☰ left (sidebar drawer) + channel name + topic
placeholder + nick count + ☰ right (members drawer) + ⚙ settings.
Hamburger buttons are display: none on desktop via CSS media query;
visible at ≤768px.

Topic rendering in P4-1 is placeholder — the topic-derivation store
lands in M-cluster polish.

Cluster: P4-1.
EOF
)"
```

---

### Task 26: New `MembersPane.tsx` component

Right-pane member list. Reads from `membersByChannel()`; renders each entry with the mode-prefix coloring (.member-op / .member-voiced / .member-plain). Mounts `members.loadMembers` on first render of a channel.

**Files:**
- Create: `cicchetto/src/MembersPane.tsx`
- Create: `cicchetto/src/__tests__/MembersPane.test.tsx`

- [ ] **Step 1: Failing tests** — render with seeded members; assert nicks + mode classes.

```typescript
import { render, screen } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import { channelKey } from "../lib/channelKey";

vi.mock("../lib/members", () => ({
  membersByChannel: () => ({
    [channelKey("freenode", "#italia")]: [
      { nick: "vjt", modes: ["@"] },
      { nick: "alice", modes: ["+"] },
      { nick: "bob", modes: [] },
    ],
  }),
  loadMembers: vi.fn(),
}));

import MembersPane from "../MembersPane";

describe("MembersPane", () => {
  it("renders members with mode-tier classes", () => {
    render(() => <MembersPane networkSlug="freenode" channelName="#italia" />);
    const ops = document.querySelector(".member-op");
    expect(ops?.textContent).toContain("vjt");
    const voiced = document.querySelector(".member-voiced");
    expect(voiced?.textContent).toContain("alice");
    const plain = document.querySelector(".member-plain");
    expect(plain?.textContent).toContain("bob");
  });

  it("calls loadMembers on first render", async () => {
    const m = await import("../lib/members");
    render(() => <MembersPane networkSlug="freenode" channelName="#x" />);
    expect(m.loadMembers).toHaveBeenCalledWith("freenode", "#x");
  });

  it("renders 'no members yet' fallback when list is empty", () => {
    render(() => <MembersPane networkSlug="freenode" channelName="#empty" />);
    expect(screen.getByText(/no members yet/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Implement — `MembersPane.tsx`**

```typescript
import { type Component, createEffect, For, Show } from "solid-js";
import { channelKey } from "./lib/channelKey";
import { loadMembers, membersByChannel, type MemberEntry } from "./lib/members";

export type Props = {
  networkSlug: string;
  channelName: string;
};

const tierClass = (modes: string[]): string => {
  if (modes.includes("@")) return "member-op";
  if (modes.includes("+")) return "member-voiced";
  return "member-plain";
};

const MembersPane: Component<Props> = (props) => {
  const key = () => channelKey(props.networkSlug, props.channelName);
  const list = (): MemberEntry[] => membersByChannel()[key()] ?? [];

  // Load on first render of a (slug, channel) pair. The verb's once-
  // per-channel gate handles repeated mounts.
  createEffect(() => {
    void loadMembers(props.networkSlug, props.channelName);
  });

  return (
    <div class="members-pane">
      <h3>members ({list().length})</h3>
      <Show
        when={list().length > 0}
        fallback={<p class="muted">no members yet</p>}
      >
        <ul>
          <For each={list()}>
            {(m) => <li class={tierClass(m.modes)}>{m.nick}</li>}
          </For>
        </ul>
      </Show>
    </div>
  );
};

export default MembersPane;
```

- [ ] **Step 3: Run tests + check + commit**

```bash
bun --cwd cicchetto run test cicchetto/src/__tests__/MembersPane.test.tsx
```

```bash
git add cicchetto/src/MembersPane.tsx cicchetto/src/__tests__/MembersPane.test.tsx
git commit -m "$(cat <<'EOF'
feat(cicchetto): new MembersPane component (P4-1)

Right-pane member list. Reads from membersByChannel; renders each
entry with mode-tier class (.member-op / .member-voiced / .member-plain)
for mIRC-style coloring. Calls loadMembers on first render of a (slug,
channel) pair (idempotent via the once-per-channel gate).

"no members yet" fallback while the snapshot is in flight or for
channels with no NAMES bootstrap yet.

Cluster: P4-1.
EOF
)"
```

---

### Task 27: New `SettingsDrawer.tsx` component

Right-side overlay drawer with theme toggle (auto / mIRC / irssi radios) + logout button. Backdrop closes on tap-outside; Esc closes via keybindings.

**Files:**
- Create: `cicchetto/src/SettingsDrawer.tsx`
- Create: `cicchetto/src/__tests__/SettingsDrawer.test.tsx`

- [ ] **Step 1: Implement** (tests + component as a bundled task — minimal surface):

```typescript
// SettingsDrawer.tsx
import { useNavigate } from "@solidjs/router";
import { type Component, createSignal, Show } from "solid-js";
import * as auth from "./lib/auth";
import { getTheme, setTheme, type ThemePref } from "./lib/theme";

export type Props = {
  open: boolean;
  onClose: () => void;
};

const SettingsDrawer: Component<Props> = (props) => {
  const navigate = useNavigate();
  const [pref, setPref] = createSignal<ThemePref>(getTheme());

  const onChange = (e: Event) => {
    const value = (e.currentTarget as HTMLInputElement).value as ThemePref;
    setPref(value);
    setTheme(value);
  };

  const onLogout = async () => {
    await auth.logout();
    navigate("/login", { replace: true });
  };

  return (
    <>
      <div
        class="settings-drawer-backdrop"
        classList={{ open: props.open }}
        onClick={props.onClose}
      />
      <aside
        class="settings-drawer"
        classList={{ open: props.open }}
        role="dialog"
        aria-label="settings"
      >
        <h2>settings</h2>
        <fieldset>
          <legend>theme</legend>
          <label>
            <input
              type="radio"
              name="theme"
              value="auto"
              checked={pref() === "auto"}
              onChange={onChange}
            />
            auto (follow system)
          </label>
          <label>
            <input
              type="radio"
              name="theme"
              value="mirc-light"
              checked={pref() === "mirc-light"}
              onChange={onChange}
            />
            mIRC light
          </label>
          <label>
            <input
              type="radio"
              name="theme"
              value="irssi-dark"
              checked={pref() === "irssi-dark"}
              onChange={onChange}
            />
            irssi dark
          </label>
        </fieldset>
        <button type="button" class="logout" onClick={onLogout}>
          log out
        </button>
      </aside>
    </>
  );
};

export default SettingsDrawer;
```

```typescript
// __tests__/SettingsDrawer.test.tsx — minimal smoke
import { Route, Router } from "@solidjs/router";
import { fireEvent, render, screen } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/theme", () => ({
  getTheme: vi.fn(() => "auto"),
  setTheme: vi.fn(),
}));

vi.mock("../lib/auth", () => ({
  logout: vi.fn().mockResolvedValue(undefined),
}));

import SettingsDrawer from "../SettingsDrawer";

const wrap = (open: boolean, onClose = vi.fn()) =>
  render(() => (
    <Router>
      <Route path="/" component={() => <SettingsDrawer open={open} onClose={onClose} />} />
    </Router>
  ));

describe("SettingsDrawer", () => {
  it("renders theme radios", () => {
    wrap(true);
    expect(screen.getByLabelText(/auto/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/mirc light/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/irssi dark/i)).toBeInTheDocument();
  });

  it("changing radio fires setTheme", async () => {
    const theme = await import("../lib/theme");
    wrap(true);
    fireEvent.click(screen.getByLabelText(/mirc light/i));
    expect(theme.setTheme).toHaveBeenCalledWith("mirc-light");
  });

  it("logout button calls auth.logout", async () => {
    const auth = await import("../lib/auth");
    wrap(true);
    fireEvent.click(screen.getByText(/log out/i));
    // logout is async; assert it was at least called
    expect(auth.logout).toHaveBeenCalled();
  });

  it("backdrop click fires onClose", () => {
    const onClose = vi.fn();
    wrap(true, onClose);
    const backdrop = document.querySelector(".settings-drawer-backdrop");
    fireEvent.click(backdrop as Element);
    expect(onClose).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests + check + commit**

```bash
bun --cwd cicchetto run test cicchetto/src/__tests__/SettingsDrawer.test.tsx
```

```bash
git add cicchetto/src/SettingsDrawer.tsx cicchetto/src/__tests__/SettingsDrawer.test.tsx
git commit -m "$(cat <<'EOF'
feat(cicchetto): new SettingsDrawer component (P4-1)

Right-overlay drawer: theme toggle (auto/mIRC/irssi radios) + logout
button. Backdrop closes on tap-outside; Esc closes via keybindings
(handled in Shell.tsx).

Cluster: P4-1.
EOF
)"
```

---

### Task 28: Rewrite `Shell.tsx` — three-pane responsive shell + drawer state + keybindings wiring

The big integration step. Shell.tsx becomes the composition root for Sidebar / TopicBar / ScrollbackPane / ComposeBox / MembersPane / SettingsDrawer. Owns drawer state. Wires keybinding handlers via `keybindings.registerHandlers + install`. Selecting a channel auto-closes the sidebar drawer (mobile).

**Files:**
- Modify: `cicchetto/src/Shell.tsx`
- Create: `cicchetto/src/__tests__/Shell.test.tsx`

- [ ] **Step 1: Implementation** — full Shell.tsx (Solid wiring; TDD via the integration tests in Step 2):

```typescript
import { type Component, createEffect, createSignal, on, onCleanup, Show } from "solid-js";
import ComposeBox from "./ComposeBox";
import MembersPane from "./MembersPane";
import ScrollbackPane from "./ScrollbackPane";
import SettingsDrawer from "./SettingsDrawer";
import Sidebar from "./Sidebar";
import TopicBar from "./TopicBar";
import { channelsBySlug, networks } from "./lib/networks";
import { install, registerHandlers, uninstall } from "./lib/keybindings";
import { selectedChannel, setSelectedChannel, unreadCounts } from "./lib/selection";
import { tabComplete, getDraft, setDraft } from "./lib/compose";
import { channelKey } from "./lib/channelKey";

const Shell: Component = () => {
  const [sidebarOpen, setSidebarOpen] = createSignal(false);
  const [membersOpen, setMembersOpen] = createSignal(false);
  const [settingsOpen, setSettingsOpen] = createSignal(false);

  // Helper: linear flat list of (slug, channel) tuples for Alt+1..9 +
  // next/prev unread navigation.
  const flatChannels = (): { slug: string; name: string }[] => {
    const cbs = channelsBySlug() ?? {};
    const out: { slug: string; name: string }[] = [];
    for (const net of networks() ?? []) {
      for (const ch of cbs[net.slug] ?? []) {
        out.push({ slug: net.slug, name: ch.name });
      }
    }
    return out;
  };

  // Wire keybindings handlers. Registered each render; the install()
  // call is idempotent per the keybindings module contract.
  registerHandlers({
    selectChannelByIndex: (idx) => {
      const list = flatChannels();
      const target = list[idx];
      if (target) setSelectedChannel({ networkSlug: target.slug, channelName: target.name });
    },
    nextUnread: () => {
      const list = flatChannels();
      const counts = unreadCounts();
      const sel = selectedChannel();
      const startIdx = sel
        ? list.findIndex((c) => c.slug === sel.networkSlug && c.name === sel.channelName)
        : -1;
      // Search forward (wrap) for first channel with unreadCounts[key] > 0.
      for (let i = 1; i <= list.length; i += 1) {
        const idx = (startIdx + i) % list.length;
        const c = list[idx];
        if (!c) continue;
        if ((counts[channelKey(c.slug, c.name)] ?? 0) > 0) {
          setSelectedChannel({ networkSlug: c.slug, channelName: c.name });
          return;
        }
      }
    },
    prevUnread: () => {
      const list = flatChannels();
      const counts = unreadCounts();
      const sel = selectedChannel();
      const startIdx = sel
        ? list.findIndex((c) => c.slug === sel.networkSlug && c.name === sel.channelName)
        : list.length;
      for (let i = 1; i <= list.length; i += 1) {
        const idx = (startIdx - i + list.length) % list.length;
        const c = list[idx];
        if (!c) continue;
        if ((counts[channelKey(c.slug, c.name)] ?? 0) > 0) {
          setSelectedChannel({ networkSlug: c.slug, channelName: c.name });
          return;
        }
      }
    },
    focusCompose: () => {
      const ta = document.querySelector<HTMLTextAreaElement>(".compose-box textarea");
      ta?.focus();
    },
    closeDrawer: () => {
      setSidebarOpen(false);
      setMembersOpen(false);
      setSettingsOpen(false);
    },
    cycleNickComplete: (forward) => {
      const sel = selectedChannel();
      if (!sel) return;
      const ta = document.activeElement as HTMLTextAreaElement | null;
      if (!ta || ta.tagName.toLowerCase() !== "textarea") return;
      const key = channelKey(sel.networkSlug, sel.channelName);
      const result = tabComplete(key, ta.value, ta.selectionStart, forward);
      if (!result) return;
      setDraft(key, result.newInput);
      // Solid signal write doesn't immediately reflect in the textarea
      // — schedule the cursor placement on the next tick.
      queueMicrotask(() => {
        ta.setSelectionRange(result.newCursor, result.newCursor);
      });
    },
  });
  install();
  onCleanup(uninstall);

  // Auto-close sidebar drawer when a channel is selected (mobile UX).
  createEffect(
    on(selectedChannel, () => {
      setSidebarOpen(false);
    }, { defer: true }),
  );

  return (
    <div class="shell">
      <aside class="shell-sidebar" classList={{ open: sidebarOpen() }}>
        <Sidebar onSelect={() => setSidebarOpen(false)} />
      </aside>

      <Show when={sidebarOpen() || membersOpen()}>
        <div
          class="shell-drawer-backdrop open"
          onClick={() => {
            setSidebarOpen(false);
            setMembersOpen(false);
          }}
        />
      </Show>

      <section class="shell-main">
        <Show
          when={selectedChannel()}
          fallback={<p class="muted">select a channel to view scrollback</p>}
        >
          {(sel) => (
            <>
              <TopicBar
                networkSlug={sel().networkSlug}
                channelName={sel().channelName}
                onToggleSidebar={() => setSidebarOpen((v) => !v)}
                onToggleMembers={() => setMembersOpen((v) => !v)}
                onOpenSettings={() => setSettingsOpen(true)}
              />
              <ScrollbackPane
                networkSlug={sel().networkSlug}
                channelName={sel().channelName}
              />
              <ComposeBox
                networkSlug={sel().networkSlug}
                channelName={sel().channelName}
              />
            </>
          )}
        </Show>
      </section>

      <aside class="shell-members" classList={{ open: membersOpen() }}>
        <Show when={selectedChannel()}>
          {(sel) => (
            <MembersPane
              networkSlug={sel().networkSlug}
              channelName={sel().channelName}
            />
          )}
        </Show>
      </aside>

      <SettingsDrawer open={settingsOpen()} onClose={() => setSettingsOpen(false)} />
    </div>
  );
};

export default Shell;
```

- [ ] **Step 2: Integration tests — Shell.test.tsx**

Create `cicchetto/src/__tests__/Shell.test.tsx`:

```typescript
import { Route, Router } from "@solidjs/router";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/networks", () => ({
  networks: () => [{ id: 1, slug: "freenode", inserted_at: "", updated_at: "" }],
  channelsBySlug: () => ({
    freenode: [
      { name: "#a", joined: true, source: "autojoin" },
      { name: "#b", joined: true, source: "autojoin" },
    ],
  }),
  user: () => ({ name: "vjt" }),
}));

vi.mock("../lib/selection", async () => {
  const actual = await vi.importActual<object>("../lib/selection");
  return {
    ...actual,
  };
});

vi.mock("../lib/scrollback", () => ({
  scrollbackByChannel: () => ({}),
  appendToScrollback: vi.fn(),
  loadInitialScrollback: vi.fn(),
  loadMore: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock("../lib/members", () => ({
  membersByChannel: () => ({}),
  loadMembers: vi.fn(),
  applyPresenceEvent: vi.fn(),
  seedFromTest: vi.fn(),
}));

vi.mock("../lib/mentions", () => ({
  mentionCounts: () => ({}),
  bumpMention: vi.fn(),
}));

vi.mock("../lib/compose", () => ({
  getDraft: () => "",
  setDraft: vi.fn(),
  submit: vi.fn(),
  recallPrev: vi.fn(),
  recallNext: vi.fn(),
  tabComplete: vi.fn(),
}));

import Shell from "../Shell";

const renderShell = () =>
  render(() => (
    <Router>
      <Route path="/" component={() => <Shell />} />
    </Router>
  ));

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {});

describe("Shell — three-pane integration", () => {
  it("renders sidebar + main + members aside", () => {
    renderShell();
    expect(document.querySelector(".shell-sidebar")).toBeTruthy();
    expect(document.querySelector(".shell-main")).toBeTruthy();
    expect(document.querySelector(".shell-members")).toBeTruthy();
  });

  it("Alt+1 selects the first flat channel via keybindings", async () => {
    const sel = await import("../lib/selection");
    const setSel = vi.spyOn(sel, "setSelectedChannel");
    renderShell();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "1", altKey: true }));
    expect(setSel).toHaveBeenCalledWith({
      networkSlug: "freenode",
      channelName: "#a",
    });
  });

  it("Esc closes any open drawer", async () => {
    renderShell();
    // open the sidebar by clicking the topic bar hamburger (only
    // visible at ≤768px in CSS, but the button is in the DOM so
    // testing-library can click it). Actually, no channel selected yet
    // so TopicBar isn't rendered. Select via keybinding first.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "1", altKey: true }));
    await waitFor(() =>
      expect(screen.getByLabelText(/open channel sidebar/i)).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByLabelText(/open channel sidebar/i));
    // sidebar should be open
    expect(document.querySelector(".shell-sidebar")?.classList.contains("open")).toBe(
      true,
    );
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await waitFor(() =>
      expect(
        document.querySelector(".shell-sidebar")?.classList.contains("open"),
      ).toBe(false),
    );
  });
});
```

- [ ] **Step 3: Run tests + check + visual smoke (dev server)**

```bash
bun --cwd cicchetto run test
bun --cwd cicchetto run check
```

Expected: full vitest suite passes (all 100+ tests; pre-P4-1 baseline 55 + ~70 new).

Visual smoke:

```bash
bun --cwd cicchetto run dev
```

Open `http://localhost:5173` in browser. Login → expect three-pane layout (sidebar / main with topic+scrollback+compose / members). Toggle theme via ⚙ → see palette flip. Resize window below 768px → both panes collapse to drawers; ☰ buttons appear.

- [ ] **Step 4: Commit**

```bash
git add cicchetto/src/Shell.tsx cicchetto/src/__tests__/Shell.test.tsx
git commit -m "$(cat <<'EOF'
feat(cicchetto): three-pane responsive Shell rewrite (P4-1)

Shell.tsx becomes the integration root for the new components:
Sidebar / TopicBar / ScrollbackPane / ComposeBox / MembersPane /
SettingsDrawer. Owns drawer state (sidebarOpen, membersOpen,
settingsOpen). Wires keybindings.registerHandlers + install with
handlers backed by selection / unread / compose stores.

Mobile (≤768px): sidebar + members aside collapse to overlay drawers
toggled by ☰ buttons in TopicBar; backdrop tap-outside + Esc close.
Selecting a channel auto-closes the sidebar drawer.

Closes the cicchetto-side surface for P4-1.

Cluster: P4-1.
EOF
)"
```

---

### Task 29: Wire mention bump into subscribe.ts

`subscribe.ts`'s WS handler already calls `appendToScrollback` + `applyPresenceEvent` + `bumpUnread`. Add the mention bump: when the message body case-insensitively word-boundary-matches the operator's nick, also call `bumpMention(key)`. Reuses `mentionsUser()` from `ScrollbackPane.tsx` — extract it to a small shared helper for symmetry.

**Files:**
- Modify: `cicchetto/src/lib/subscribe.ts`
- Create: `cicchetto/src/lib/mentionMatch.ts` (extracted)
- Modify: `cicchetto/src/ScrollbackPane.tsx` (import from mentionMatch)
- Modify: `cicchetto/src/__tests__/subscribe.test.ts`

- [ ] **Step 1: Extract `lib/mentionMatch.ts`**

Create `cicchetto/src/lib/mentionMatch.ts`:

```typescript
// Pure mention matcher. Case-insensitive word-boundary match against
// the operator's own nick. Used by:
//   - ScrollbackPane (highlight class on rendered line)
//   - subscribe.ts (bumpMention dispatch)
// Same predicate, two consumers — extract once.

export const mentionsUser = (body: string | null, nick: string | null): boolean => {
  if (!body || !nick) return false;
  const escaped = nick.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(body);
};
```

Update `ScrollbackPane.tsx`:

```typescript
import { mentionsUser } from "./lib/mentionMatch";
// remove the local copy of mentionsUser
```

- [ ] **Step 2: Wire into subscribe.ts**

Edit `cicchetto/src/lib/subscribe.ts`:

```typescript
import { user } from "./networks";
import { bumpMention } from "./mentions";
import { mentionsUser } from "./mentionMatch";
// ... in the createEffect handler:
phx.on("event", (payload: ChannelEvent) => {
  if (payload.kind !== "message") return;
  appendToScrollback(key, payload.message);
  applyPresenceEvent(key, payload.message);
  const sel = untrack(selectedChannel);
  const isSelected =
    sel && sel.networkSlug === slug && sel.channelName === ch.name;
  if (!isSelected) bumpUnread(key);
  // Mention bump fires regardless of selected — irssi convention is
  // that a mention is always "noticed", even on the active window
  // (the ScrollbackPane's mention-highlight class is the visual signal).
  // For the sidebar badge, only bump when not currently viewing the
  // channel (so tabbing to it clears the count).
  if (!isSelected && payload.message.kind === "privmsg") {
    const u = untrack(user);
    if (u && mentionsUser(payload.message.body, u.name)) {
      bumpMention(key);
    }
  }
});
```

- [ ] **Step 3: Test + commit**

Add test to `subscribe.test.ts` covering the mention-bump path. Run:

```bash
bun --cwd cicchetto run test cicchetto/src/__tests__/subscribe.test.ts
bun --cwd cicchetto run check
```

```bash
git add cicchetto/src/lib/{subscribe,mentionMatch,mentions}.ts cicchetto/src/ScrollbackPane.tsx cicchetto/src/__tests__/subscribe.test.ts
git commit -m "$(cat <<'EOF'
feat(cicchetto): wire mention badge into subscribe.ts

Extract mentionsUser to lib/mentionMatch.ts so ScrollbackPane (line
highlight) + subscribe.ts (sidebar mention badge) share one matcher.
subscribe.ts now bumpMention(key) on PRIVMSG events whose body
mentions the operator's nick, gated on the channel NOT being currently
selected (tabbing to a channel clears the badge).

Cluster: P4-1.
EOF
)"
```

---

## Phase 9 — Final gates + DESIGN_NOTES + merge + deploy

### Task 30: Update `docs/DESIGN_NOTES.md`

Add a new entry: P4-1 / A5 closure, 5th application of the verb-keyed sub-context principle (cicchetto store split: networks/scrollback/selection/subscribe → +theme/keybindings/members/compose/mentions).

**Files:**
- Modify: `docs/DESIGN_NOTES.md`

- [ ] **Step 1: Append new entry**

```markdown
## 2026-04-XX — P4-1 / A5 closure: three-pane shell + 5th verb-keyed split

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
`mentionMatch`, `memberTypes`) and one shared low-level type module
(`memberTypes`) — same shape as `channelKey.ts` for the D3 split.

Total: post-P4-1 cicchetto `lib/` = 14 modules, all verb-keyed.

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
banners.

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

### A20 (Broadcaster fold-in)

Still deferred (Phase 5 candidate). The `Session.Server`'s outbound
PRIVMSG (`handle_call({:send_privmsg, ...})`) gained `:topic`
sibling (`handle_call({:send_topic, ...})`) — same persist-then-
broadcast-then-send shape, two callsites for the same logic. A20's
extraction would consolidate them; P4-1 leaves the duplication
(small, contained, two callsites) for Phase 5.
```

(Replace `2026-04-XX` with the actual landing date once the cluster ships.)

- [ ] **Step 2: Commit**

```bash
git add docs/DESIGN_NOTES.md
git commit -m "$(cat <<'EOF'
docs(design-notes): P4-1 / A5 closure entry

5th application of the verb-keyed sub-context principle: cicchetto
adds 5 new verb stores (theme/keybindings/members/compose/mentions)
+ 4 pure-function helpers, all mirroring the D3 module-singleton +
createRoot + on(token) cleanup shape. Q4 (presence-from-existing-
message-stream) is the load-bearing reuse decision.

Server-side A5 close + new TOPIC/NICK outbound endpoints recorded.

Cluster: P4-1.
EOF
)"
```

---

### Task 31: Final gates — server + cicchetto

- [ ] **Step 1: Full server gates**

```bash
scripts/check.sh
```

Expected: every gate green (format, credo --strict, sobelow, dialyzer, deps.audit, hex.audit, doctor, test --warnings-as-errors --cover). Coverage for the new modules: `Session.list_channels/2` + EventRouter self-leave + ChannelsController source-merge + NickController + Session.send_topic/send_nick — all line-covered by Tasks 1-12.

- [ ] **Step 2: Full cicchetto gates**

```bash
bun --cwd cicchetto run check
bun --cwd cicchetto run test
bun --cwd cicchetto run build
```

Expected:
- `check`: biome clean, tsc clean.
- `test`: full vitest suite passes. Pre-P4-1 baseline 55 tests; post-P4-1 ~125+ (5 new verb-store test files × ~8-10 tests each + 6 new component test files × ~4-6 tests each + extensions to ScrollbackPane/api/subscribe).
- `build`: production bundle compiles clean. Note the bundle size — pre-P4-1 was ~96KB precache; post-P4-1 should stay ≤150KB gzip per Phase 4 brainstorm spec budget. Investigate any overage.

- [ ] **Step 3: No commit** — tests are run as gate; no source changes here.

---

### Task 32: Rebase + merge to main

- [ ] **Step 1: Fetch + rebase the cluster branch onto main**

```bash
cd ~/code/IRC/grappa-task-p4-1-impl
git fetch origin main
git rebase origin/main
```

Expected: clean rebase or trivial conflict on docs/checkpoints (if S18 was already merged from this plan branch). Resolve by keeping all entries; re-run `scripts/check.sh` after.

- [ ] **Step 2: Re-run full gates after rebase**

```bash
scripts/check.sh
bun --cwd cicchetto run check
bun --cwd cicchetto run test
```

Expected: green.

- [ ] **Step 3: Merge to main from /srv/grappa**

```bash
cd /srv/grappa
git merge --no-ff cluster/p4-1-first-ship
git log --oneline | head -10
```

Expected: merge commit lands; the cluster's commits visible in `git log`. The `--no-ff` records the cluster boundary even when fast-forward would be possible — same pattern as E1 close.

- [ ] **Step 4: Run check.sh on main post-merge**

```bash
scripts/check.sh
bun --cwd cicchetto run check
bun --cwd cicchetto run test
```

Expected: green on main.

- [ ] **Step 5: Push main**

```bash
git push origin main
```

---

### Task 33: Deploy + health check + smoke test

- [ ] **Step 1: Deploy**

```bash
cd /srv/grappa
scripts/deploy.sh
```

Expected: builds prod image (cicchetto + server bundled), runs migrations (none for P4-1 — schema unchanged), restarts container.

- [ ] **Step 2: Health check**

```bash
scripts/healthcheck.sh
```

Expected: 200.

- [ ] **Step 3: Live smoke test (desktop)**

Open `http://grappa.bad.ass` in a desktop browser. Login with operator credentials. Expectations:
- Three-pane layout renders.
- Sidebar shows network slug + autojoin channels with `joined: true` (assuming session has connected and 353 has populated).
- Selecting a channel → ScrollbackPane fills with history; ComposeBox appears at the bottom; MembersPane shows the nick list with mode-tier coloring.
- Theme toggle via ⚙ → palette flips. localStorage `grappa-theme` reflects choice.
- Type `/me waves` + Enter → ACTION line appears in scrollback.
- Type `/topic ciao mondo` → topic-set persists to scrollback; upstream IRC server receives `TOPIC #channel :ciao mondo`.
- `Alt+1` switches to first channel; `Ctrl+N` jumps to next channel with unread.
- Open browser dev console — zero error messages from cicchetto code.

- [ ] **Step 4: Live smoke test (mobile / responsive)**

Open dev tools, switch viewport to iPhone or 375×812. Expectations:
- Layout collapses to single pane with TopicBar at top.
- ☰ left button opens sidebar drawer with backdrop; tap-outside closes.
- ☰ right button opens members drawer.
- Esc closes any open drawer.
- Selecting a channel from the sidebar drawer auto-closes the drawer.

- [ ] **Step 5: Live verification — A5 wire close**

Browser dev console:

```javascript
fetch('/networks/azzurra/channels', {
  headers: { Authorization: 'Bearer ' + localStorage.getItem('grappa-token') }
}).then(r => r.json()).then(console.log)
```

Expected: array of `{name, joined, source}` entries. At least one with `source: "autojoin"`. If the operator has manually `/join`'ed an extra channel, that one shows `source: "joined"`.

---

### Task 34: Update CP10 with S19 (P4-1 LANDED)

**Files:**
- Modify: `docs/checkpoints/2026-04-27-cp10.md`

- [ ] **Step 1: Append S19 entry**

```markdown
## S19 — 2026-04-XX — P4-1 cluster LANDED + deployed (A5 closed)

**What:** P4-1 cluster implementation per the 2026-04-27 plan
(`docs/plans/2026-04-27-p4-1-first-ship-ui.md`). 34 tasks across
9 phases. Server-side A5 close + cicchetto three-pane responsive
shell + mIRC/irssi theme system + irssi keybindings + members
sidebar consumer + compose with tab-complete + slash commands.

**Module changes — server (~280 LOC):**

- REFACTOR `lib/grappa/session/event_router.ex` — self-PART / self-
  KICK now `Map.delete(state.members, channel)` (symmetric with self-
  JOIN). Invariant: `Map.keys(state.members)` is the currently-joined
  set.
- UPDATE `lib/grappa/session/server.ex` — new `handle_call({:list_channels})`,
  `handle_call({:send_topic, channel, body})`, `handle_call({:send_nick, new})`.
- UPDATE `lib/grappa/session.ex` — `list_channels/2` + `send_topic/4`
  + `send_nick/3` facades.
- UPDATE `lib/grappa/irc/client.ex` — `send_topic/3` + `send_nick/2`
  outbound helpers.
- REFACTOR `lib/grappa_web/controllers/channels_controller.ex` —
  `index/2` composes credential autojoin + session list into
  `{name, joined, source}` wire shape; new `topic/2` action.
- UPDATE `lib/grappa_web/controllers/channels_json.ex` — pass-through
  to new `Wire.channel_to_json/3`.
- NEW `lib/grappa_web/controllers/nick_controller.ex` — `POST /networks/
  :net/nick`.
- UPDATE `lib/grappa/networks/wire.ex` — `channel_to_json/1` → `/3`;
  type `channel_json` extends `{name, joined, source}`.
- UPDATE `lib/grappa_web/router.ex` — new TOPIC + NICK routes.

**Module changes — cicchetto (~1700 LOC):**

5 new verb-keyed `lib/` modules:
- NEW `cicchetto/src/lib/theme.ts` — theme state + `applyTheme` boot
  entry + `isMobile` reactive signal.
- NEW `cicchetto/src/lib/keybindings.ts` — vanilla keydown dispatch.
- NEW `cicchetto/src/lib/members.ts` — per-channel member list;
  `loadMembers` snapshot + `applyPresenceEvent` delta.
- NEW `cicchetto/src/lib/compose.ts` — per-channel draft + history +
  slash-dispatch + tab-complete.
- NEW `cicchetto/src/lib/mentions.ts` — per-channel mention count.

4 new pure-function helpers:
- NEW `cicchetto/src/lib/modeApply.ts` — pure mode-string parser.
- NEW `cicchetto/src/lib/slashCommands.ts` — pure slash parser.
- NEW `cicchetto/src/lib/mentionMatch.ts` — shared mention regex.
- NEW `cicchetto/src/lib/memberTypes.ts` — shared low-level types.

6 new components:
- NEW `cicchetto/src/Sidebar.tsx` — channel tree + unread + mention.
- NEW `cicchetto/src/TopicBar.tsx` — topic + hamburgers + settings.
- NEW `cicchetto/src/MembersPane.tsx` — member list w/ mode-tier.
- NEW `cicchetto/src/ComposeBox.tsx` — sticky-bottom textarea.
- NEW `cicchetto/src/SettingsDrawer.tsx` — theme + logout.
- REFACTOR `cicchetto/src/ScrollbackPane.tsx` — pure-render + mention.
- REWRITE `cicchetto/src/Shell.tsx` — three-pane responsive shell +
  drawer state + keybindings handler wiring.
- REFACTOR `cicchetto/src/themes/default.css` — `:root[data-theme]`
  blocks + new selectors + mobile media queries.
- UPDATE `cicchetto/src/lib/api.ts` — `ChannelEntry` shape + new POST
  helpers.
- UPDATE `cicchetto/src/lib/subscribe.ts` — dispatch presence to
  members + bumpMention.
- UPDATE `cicchetto/src/main.tsx` — `applyTheme()` pre-render; install
  keybindings.

**Tests added:** ~70 new tests across 11 new test files (5 verb-store
test files + 4 pure-helper test files + 6 component test files +
extensions to api / subscribe / ScrollbackPane). Pre-P4-1 baseline 55
vitest passes + ~330 server tests; post-P4-1 ~125+ vitest + ~340+
server tests.

**Gates:** `scripts/check.sh` green on cluster branch + on main post-
merge. `bun --cwd cicchetto run check` clean (biome + tsc). `bun
--cwd cicchetto run test` green. Production build: bundle hash
bumped; size delta ~+50KB gzip estimate (within Phase 4 brainstorm
budget of ≤150KB).

**LOC:** lib +/- ~280 server, ~1700 cicchetto, total ~2000 line
diff (estimated; actual may vary by ±15%). Cluster duration: one
or two sessions (paused-resumed checkpoint OK; D-cluster pattern).

**Code review:** `superpowers:code-reviewer` subagent ran against the
cluster branch + plan. (Verdict + minors recorded in CP10 sub-entry
post-review.)

**Live deploy state:** `scripts/deploy.sh` ran. Production at
`http://grappa.bad.ass` serves the new build. Healthcheck 200.
`/networks/<slug>/channels` returns `{name, joined, source}` shape;
`/members` snapshot consumed by MembersPane. Three-pane shell renders;
mobile drawers tested via DevTools viewport emulation.

**Quality follow-ups (NOT P4-1 blockers):**
- TopicBar topic display is placeholder; topic-derivation store is
  M-cluster polish.
- Tab-completion is members-only; recent-sender fallback in M-cluster.
- Edge-swipe drawer trigger deferred (Q7); hamburger-only ships.
- PREFIX ISUPPORT-driven mode-prefix table for both server + client
  in Phase 5+.

**Deferred per spec / per cluster:**
- A20 Broadcaster fold-in: still Phase 5 candidate. P4-1 added a
  second `:topic` callsite to Session.Server (mirror of `:privmsg`)
  — two callsites for the same persist-broadcast-send logic;
  consolidation lands when either A20 ships or a third callsite
  arrives.
- P4-V (voice I/O) is the next cluster — closes Phase 4.
- M2 (NickServ-as-IDP) + M3 (anon ephemeral) + M3-A (anon abuse
  posture) are post-Phase-4 clusters, additive on top of mode 1
  (P4-1's first-ship audience).

**Next session:** P4-V cluster (browser-native TTS + STT toggle in
cicchetto). New brainstorm not required — Phase 4 product-shape spec
covers P4-V in detail. Open writing-plans against the spec's
"P4-V — Voice I/O" section.
```

(Replace `2026-04-XX` with the actual landing date.)

- [ ] **Step 2: Commit + push**

```bash
git add docs/checkpoints/2026-04-27-cp10.md
git commit -m "docs: CP10 S19 — P4-1 cluster LANDED + deployed (A5 closed)"
git push origin main
```

- [ ] **Step 3: Cleanup worktrees + branches**

```bash
git worktree remove ~/code/IRC/grappa-task-p4-1-impl
git branch -d cluster/p4-1-first-ship
```

(The planning worktree at `~/code/IRC/grappa-task-p4-1` on `plan/p4-1` is cleaned up immediately after the plan merges to main — long before the implementation cluster opens. The implementation worktree at `~/code/IRC/grappa-task-p4-1-impl` is the one being cleaned here.)

---

## Exit criteria — P4-1 LANDED

The cluster is "LANDED" when ALL of the following hold:

1. **Server-side**:
   - `Grappa.Session.EventRouter` self-PART + self-KICK semantics implemented; tests pass.
   - `Grappa.Session.list_channels/2` facade returns sorted `[String.t()]`.
   - `GrappaWeb.ChannelsController.index/2` returns `[%{name, joined, source}]` per the three-category merge; `:autojoin` wins on overlap.
   - `POST /networks/:net/channels/:chan/topic` + `POST /networks/:net/nick` ship.
   - `scripts/check.sh` green: format / credo --strict / sobelow / dialyzer / deps.audit / hex.audit / doctor / test --warnings-as-errors --cover.

2. **Cicchetto-side**:
   - `Shell.tsx` three-pane responsive layout renders.
   - Five new verb-keyed `lib/` modules ship: `theme`, `keybindings`, `members`, `compose`, `mentions`. Plus four pure helpers.
   - Six new components ship: `Sidebar`, `TopicBar`, `MembersPane`, `ComposeBox`, `SettingsDrawer` + Shell rewrite + ScrollbackPane refactor.
   - Themes: `mirc-light` + `irssi-dark` via `:root[data-theme]` blocks; `applyTheme()` boot-time; `prefers-color-scheme` auto.
   - Keybindings: `Alt+1..9`, `Ctrl+N/P`, `/`, `Esc`, `Tab`/`Shift+Tab` all wired.
   - Slash commands: `/me`, `/join`, `/part`, `/topic`, `/nick`, `/msg` all dispatch.
   - Members sidebar: snapshot via `GET /members`, live updates via existing message stream.
   - Mention highlight + sidebar mention badge.
   - Mobile (≤768px): hamburger-toggled drawers; backdrop tap-out; Esc closes; channel-select auto-closes sidebar drawer.
   - `bun --cwd cicchetto run check` clean; `bun --cwd cicchetto run test` green.

3. **Deploy**:
   - `scripts/deploy.sh` runs successfully.
   - `scripts/healthcheck.sh` returns 200.
   - Live smoke test on `http://grappa.bad.ass` (desktop + mobile viewport) passes.
   - Production browser-console clean of cicchetto-side errors.

4. **Docs**:
   - `docs/DESIGN_NOTES.md` has the P4-1 / A5 closure entry.
   - `docs/checkpoints/2026-04-27-cp10.md` has the S19 entry recording cluster landing + deploy state.
   - `docs/plans/2026-04-27-p4-1-first-ship-ui.md` (this plan) is on main; no follow-up plan edits needed.

5. **Code review** (`superpowers:code-reviewer` agent run against the cluster branch + plan): NO BLOCKERS, NO MAJORS. Verdict surfaces in CP10 S19 sub-entry.

If any criterion fails, the cluster is NOT closed — surface to vjt and resolve before merging to main.

---

## Self-review

Before opening the implementation session, the planning author runs through this checklist with fresh eyes (CLAUDE.md "Read MORE than 30 lines of logs" — same discipline for plans):

### 1. Spec coverage

Map each item from `docs/plans/2026-04-27-phase-4-product-shape.md` § "P4-1 — Phase 4 first ship UI" to a task in this plan:

| Spec item | Plan task |
|---|---|
| A5 fix: ChannelsController returns session-tracked + autojoin | Tasks 4-7 (server-side); Task 13 (cicchetto wire consumer); Task 24 (Sidebar consumer) |
| `theme.ts` module | Task 14 |
| `keybindings.ts` module | Task 18 |
| `members.ts` module | Task 19; Task 20 (subscribe wiring) |
| `compose.ts` module | Task 21 |
| `Sidebar.tsx` | Task 24 |
| `MembersPane.tsx` | Task 26 |
| `TopicBar.tsx` | Task 25 |
| `ComposeBox.tsx` | Task 23 |
| `SettingsDrawer.tsx` | Task 27 |
| `App.tsx` (Shell) rewrite — three-pane responsive | Task 28 |
| `ScrollbackPane.tsx` light edits | Task 22 (refactor — pure render + mention highlight) |
| Auto-scroll-on-new-message-when-at-bottom (sticky) | Task 22 (preserved from pre-P4-1) |
| Mention highlight | Tasks 22, 28 (mentionMatch + bumpMention via subscribe.ts in Task 29) |
| Unread distinction (count + ring on inactive) | Task 24 (Sidebar) + existing selection.unreadCounts (E1 baseline) |
| Mobile drawers | Task 28 (drawer state + wiring) + Task 15 (CSS @media rules) |
| Tab-completion | Task 21 (compose.tabComplete) + Task 18 (Tab keybinding) + Task 28 (Shell wiring) |
| Slash commands `/me`, `/join`, `/part`, `/topic`, `/nick`, `/msg` | Task 17 (parser) + Task 21 (dispatcher) |
| `/raw` slash command | DROPPED — needs server endpoint that doesn't exist; M-cluster |

Every spec item maps to a task. Two scope reductions noted explicitly:
- TopicBar's topic-text rendering is placeholder (M-cluster polish; spec did not require it for first ship).
- `/raw` slash command dropped (server-endpoint-missing).

### 2. Placeholder scan

Search the plan for the patterns CLAUDE.md / writing-plans warn against:

- `TBD` / `TODO` / `fill in` / `implement later` — none in task bodies. Three legitimate uses in test stubs (Task 20's subscribe.test.ts dispatch test mentions "flesh out: see existing subscribe.test.ts fixture setup pattern" — this is a pointer to an existing file, not a "TBD"; the pattern is concrete + reproducible).
- "Add appropriate error handling" / "validate" — none.
- "Similar to Task N" — none. Code blocks are repeated verbatim where reused.
- "Write tests for the above" without test code — none. Every test step has the test code.

### 3. Type consistency

Cross-check function signatures + property names across tasks:

- `ChannelEntry`: `{name, joined, source}` consistent in api.ts (Task 13), Sidebar.tsx (Task 24), Networks.Wire.channel_json (Task 6, 7).
- `ChannelMembers` / `MemberEntry`: `{nick, modes}` consistent in memberTypes.ts (Task 16), members.ts (Task 19), MembersPane.tsx (Task 26), modeApply.ts (Task 16).
- `KeybindingHandlers` interface: 6 fields consistent across keybindings.ts (Task 18) + Shell.tsx (Task 28).
- `SlashCommand` discriminated union: 9 kinds consistent across slashCommands.ts (Task 17) + compose.ts (Task 21).
- `tabComplete(key, input, cursor, forward)` signature: consistent in compose.ts (Task 21) + Shell.tsx wiring (Task 28).
- `applyPresenceEvent(key, msg)` signature: consistent in members.ts (Task 19) + subscribe.ts (Task 20).
- `Session.list_channels/2` signature: consistent in Session facade (Task 5) + Server callback (Task 4) + ChannelsController consumer (Task 7).
- `Session.send_topic/4` signature: consistent in Client (Task 9) + Server (Task 10) + Session facade (Task 10) + REST controller (Task 11).
- `Session.send_nick/3` signature: consistent in Client (Task 9) + Server (Task 10) + Session facade (Task 10) + REST controller (Task 11).

### 4. CLAUDE.md cross-check

- **No `\\` defaults** — every new function (Elixir + TS) requires its args explicitly. ✓
- **Atoms / literal unions for closed sets** — `:autojoin | :joined`, `"mirc-light" | "irssi-dark" | "auto"`, `kind: "privmsg" | ... | "unknown"` — all literal unions, never bare `string`. ✓
- **One feature, one code path, every door** — A5 wire shape `{name, joined, source}` flows through one chain: Server.list_channels → Session facade → ChannelsController.merge_channel_sources → Wire.channel_to_json → cicchetto api.ChannelEntry → Sidebar consumer. No second definition. ✓
- **Reuse the verbs, not the nouns** — 5 new verb-keyed cicchetto modules, none of which are "Settings" or "UIState" noun buckets. ✓
- **Implement once, reuse everywhere** — `mentionMatch.ts` extracted (Task 29) so ScrollbackPane + subscribe.ts share one matcher. members.ts presence delta consumes the SAME WS stream as scrollback (Q4 pinning). Mode-prefix table hard-coded same on server + client (will swap together at PREFIX ISUPPORT in Phase 5). ✓
- **Crash boundary alignment** — server-side: a Session.Server crash resets only that session's state (members map, nick, autojoin); cicchetto-side: identity transitions (logout / token rotation) flush all module-singleton state via on(token) cleanup arms (theme NOT scoped to identity — it's a UI preference, not user-data; intentional). ✓
- **Phoenix Channels = the event push surface** — no new SSE / polling for member updates. Q4 pinned the existing message stream. ✓
- **Test patterns** — server: `async: false` for Session-touching tests (singleton supervisors); cicchetto: vitest with vi.mock at boundaries. ✓
- **No backwards-compat hacks** — `Wire.channel_to_json/1` deleted in Task 6 (atomic with /3 introduction in Task 7); no half-migrated state. ✓

---

## Execution handoff

Plan complete and saved to `docs/plans/2026-04-27-p4-1-first-ship-ui.md`. Two execution options:

**1. Subagent-Driven (recommended)** — orchestrator dispatches a fresh subagent per task, reviews between tasks, fast iteration. Same pattern as E1.

**2. Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints for review.

The cluster is large (34 tasks; estimated 1-2 sessions). The pause-resume checkpoint pattern from D-cluster + E1 lets either path span sessions cleanly.

**Which approach?** — vjt to pin at implementation-session opening.

---
