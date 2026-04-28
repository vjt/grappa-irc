# Text-polish cluster — Phase 4 acceptance bug-fix sweep: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four iPhone-acceptance text-functionality gaps blocking the auth-triangle clusters (M2 NickServ-IDP + anon webirc) — (1) compose textarea retains focus across submit, (2) mobile no-channel state has reachable ☰ + ⚙ navigation, (3) light/dark theme toggle is reachable from the same surface (collapses with bug 2), (4) `/join <channel>` produces a live channel entry without a page refresh, including live WS subscription.

**Architecture:** Server-side adds one effect: `Grappa.Session.Server.delegate/2` post-route compares `Map.keys(state.members)` between input + derived states and broadcasts `%{kind: "channels_changed"}` on `Grappa.PubSub.Topic.user(state.user_name)` when the keyset changes. EventRouter remains pure (no new effect type — keyset-delta detection lives at the GenServer boundary where transport concerns already live). Cicchetto-side adds one new `lib/` module (`userTopic.ts`) that joins the per-user Phoenix topic at boot and calls `refetchChannels()` on `channels_changed` events; `networks.ts` exposes `refetchChannels` (already-built `createResource` `refetch` callback), `socket.ts` re-exports the previously-dropped `joinUser/1` helper. `subscribe.ts` is unchanged — its existing createEffect re-runs when `channelsBySlug()` mutates and joins WS topics for the new channels automatically. The empty-state navigation is fixed via inline JSX in `Shell.tsx`'s `<Show>` fallback (no new component); ComposeBox focus retention drops the `disabled={sending()}` attr from the textarea (keeps it on the submit button).

**Tech Stack:** Server: Elixir 1.19 + OTP 28 + Phoenix 1.8 + Phoenix.PubSub + ExUnit. Cicchetto: SolidJS 1.9 + TypeScript 6 + Vite 8 + Bun 1.3 + Vitest 4 + `@solidjs/testing-library` + phoenix.js. All gates: `scripts/check.sh` (mix format / credo --strict / sobelow / dialyzer / deps.audit / hex.audit / doctor / test --warnings-as-errors --cover); cicchetto `bun --cwd cicchetto run check` + `bun --cwd cicchetto run test`.

---

## Pinned decisions

The four bugs were root-caused 2026-04-28 (CP10 S20 plan-session). Each fix shape pinned by vjt:

- **Q-A1 → (b) Server broadcasts on `grappa:user:{name}` topic.** When `Map.keys(state.members)` changes between input + derived state in `Session.Server.delegate/2`, broadcast `%{kind: "channels_changed"}` on `Topic.user(state.user_name)`. Cicchetto's new `userTopic.ts` consumes the event + calls `networks.refetchChannels()`. Multi-tab consistent. CLAUDE.md "Phoenix Channels = event push surface" canonical shape. Sets up M2 / anon clusters cleanly (those will need user-topic for auth-state push).
- **Q-A2 → (a) Inline empty-state buttons in `Shell.tsx` fallback.** No new component. `<Show>` fallback renders a small inline `<header class="shell-empty-toolbar">` with the same ☰-left + ⚙-right buttons that `TopicBar` hosts when a channel IS selected. Duplication is local + shallow (~6 LOC of JSX). Factoring out a reusable `Topbar.tsx` deferred to M-cluster polish — too much P4-1 surgery for a 4-bug fix sweep.
- **Q-A3 → ComposeBox.tsx textarea drops `disabled={sending()}`.** Submit button keeps it (prevents double-submit). Browser un-focuses disabled elements; the existing test suite has no focus assertion (regression invisible to gates).
- **Q-A4 → `channels_changed` payload is the heartbeat shape (no body).** Cicchetto refetches `GET /channels` on receipt; the REST endpoint is the single source of truth for the channel list with `{name, joined, source}` envelopes. Sending the new keyset inline would force the client to construct the full envelope from a partial signal — not worth the savings.

Other resolved (non-blocking, pinned in plan steps below):

- **`socket.ts` re-export `joinUser/1`:** the helper was dropped per the comment at `socket.ts:73-77` ("bring them back when a real consumer needs them"). `userTopic.ts` is the real consumer. Restored verbatim from the pre-S49 shape — `getSocket().channel("grappa:user:" + userName)`.
- **`networks.ts` exposes `refetchChannels: () => void`:** destructure the second tuple element of the existing `createResource` for `channelsBySlug`. No conversion to a verb-keyed module — that's M-cluster polish (turning `channelsBySlug` into a verb store with `applyChannelJoinedEvent` / `applyChannelLeftEvent` patches is a bigger refactor and not needed for this sweep).
- **No `:notify_channels_changed` EventRouter effect type.** Keyset-delta detection lives in `Session.Server.delegate/2` post-route. The router stays pure (`@type effect :: {:persist, ...} | {:reply, ...}` unchanged). Decision rationale: the broadcast is a transport-side concern (knows about `Phoenix.PubSub`, `Topic.user/1`, `state.user_name`) — keeping it out of the pure router preserves the A6 boundary.
- **`maybe_broadcast_channels_changed/2` is fire-and-forget (`:ok` return).** No retry, no error path. PubSub failure is exotic; logging the error and continuing matches the existing `:persist` arm's posture (see `apply_effects/2` line 429-434).
- **Multi-tab semantics:** all tabs of the same user share the user topic. A `/join` from tab A fires the broadcast; both tabs A and B refetch + re-subscribe. Tab A's request-side optimism is unchanged — `compose.ts:144` already awaits `postJoin` before clearing the draft, so the user sees a "send" complete before the broadcast lands.
- **Self-PART / self-KICK collapse to the same broadcast.** The keyset-delta detection is direction-agnostic (`prev_keys != next_keys` covers both grow + shrink). Channels-list mutation IS the event; the cause is irrelevant to subscribers.

---

## File structure

### Server-side

```
lib/grappa/session/server.ex                         (UPDATE)
  - delegate/2: capture prev_keys before route, derived_keys after apply_effects
  - new private maybe_broadcast_channels_changed/2 — fire-and-forget broadcast
    on Topic.user(state.user_name) with %{kind: "channels_changed"} payload

test/grappa/session/server_test.exs                  (UPDATE)
  - new test: self-JOIN broadcasts channels_changed on user topic
  - new test: self-PART broadcasts channels_changed on user topic
  - new test: self-KICK broadcasts channels_changed on user topic
  - new test: other-user JOIN does NOT broadcast (keyset unchanged)
  - new test: PRIVMSG does NOT broadcast (keyset unchanged)
```

### Cicchetto-side

```
cicchetto/src/lib/socket.ts                          (UPDATE)
  - re-export joinUser(userName: string): Channel
    (was dropped per S49 — comment at lines 73-77 already anticipates this)

cicchetto/src/lib/networks.ts                        (UPDATE)
  - destructure [resource, { refetch }] for channelsBySlug
  - export refetchChannels: () => void

cicchetto/src/lib/userTopic.ts                       (NEW)
  - createRoot side-effect module
  - createEffect on user() — when user resolves, joinUser(user.name)
  - on "event" with payload.kind === "channels_changed", call refetchChannels()
  - on(token) cleanup arm — same shape as scrollback.ts / members.ts / subscribe.ts

cicchetto/src/main.tsx                               (UPDATE)
  - import "./lib/userTopic" (side-effect install) alongside subscribe.ts

cicchetto/src/Shell.tsx                              (UPDATE)
  - <Show> fallback: replace the bare <p> with an inline header containing
    ☰-left + ⚙-right buttons + the empty-state copy

cicchetto/src/ComposeBox.tsx                         (UPDATE)
  - drop `disabled={sending()}` from the textarea
  - keep `disabled={sending() || getDraft(key).trim() === ""}` on the button

cicchetto/src/themes/default.css                     (UPDATE)
  - new .shell-empty-toolbar block — height/border/flex matching .topic-bar
  - mobile media query unchanged (the existing .topic-bar-hamburger rules
    apply since the empty-toolbar reuses the same button class names)

cicchetto/src/__tests__/networks.test.ts             (UPDATE)
  - new test: refetchChannels is exported and is a function

cicchetto/src/__tests__/userTopic.test.ts            (NEW)
  - mocks ../lib/socket joinUser, ../lib/networks refetchChannels, ../lib/auth token
  - asserts joinUser called when user resolves
  - asserts refetchChannels called on "event" with kind "channels_changed"
  - asserts refetchChannels NOT called on unrelated event payloads

cicchetto/src/__tests__/Shell.test.tsx               (UPDATE)
  - new test: empty-state renders ☰ button (aria-label "open channel sidebar")
  - new test: empty-state renders ⚙ button (aria-label "open settings")
  - new test: clicking empty-state ☰ opens sidebar drawer
  - new test: clicking empty-state ⚙ opens settings drawer

cicchetto/src/__tests__/ComposeBox.test.tsx          (UPDATE)
  - new test: textarea retains focus after a successful submit
  - new test: textarea has no `disabled` attribute (regression guard)
```

### Docs

```
docs/DESIGN_NOTES.md                                 (UPDATE)
  - new entry: "text-polish cluster — channels-list user-topic broadcast +
    iPhone acceptance bug sweep"; documents the keyset-delta detection at
    Session.Server.delegate/2; first real consumer of the user-level
    Phoenix topic shape (Topic.user/1 was reserved infrastructure
    pre-cluster, broadcast surface starts here)

docs/checkpoints/2026-04-27-cp10.md                  (UPDATE)
  - S20 entry: text-polish cluster opening, plan landed, Q-A1..A4 resolved
  - S21 entry (after impl): text-polish LANDED + deployed
```

---

## Phase 0 — Setup

### Task 0: Worktree + baseline check

The plan-session already created the worktree; the impl session should resume in it.

**Files:** none (preflight only).

- [ ] **Step 0.1: Locate the worktree**

```bash
cd ~/code/IRC/grappa-task-text-polish
git status --short
git branch --show-current
```

Expected: clean working tree on `plan/text-polish`, branched off `38dd936`.

- [ ] **Step 0.2: Confirm zero baseline errors before starting**

Run from the worktree (scripts auto-detect worktree → mounts worktree source over container):

```bash
scripts/check.sh
```

Expected: green. Mix tests / format / credo --strict / sobelow / dialyzer / deps.audit / hex.audit / doctor / coverage all pass. Zero warnings.

```bash
bun --cwd cicchetto run check
bun --cwd cicchetto run test
```

Expected: biome clean / tsc clean / vitest 87/87 pass (P4-1 baseline).

If anything fails: STOP, fix in the first commit on this branch (CLAUDE.md "Fix pre-existing errors first"). Do not proceed to Phase 1 until baseline is green.

---

## Phase 1 — Cicchetto: ComposeBox focus retention (Bug 1)

Smallest fix first to build momentum + verify the test harness works.

### Task 1: Failing test — textarea retains focus after submit

**Files:**
- Test: `cicchetto/src/__tests__/ComposeBox.test.tsx`

- [ ] **Step 1.1: Add failing test for focus retention**

Append to the `describe("ComposeBox", () => { ... })` block in `cicchetto/src/__tests__/ComposeBox.test.tsx`:

```tsx
  it("textarea retains focus after a successful submit", async () => {
    const compose = await import("../lib/compose");
    vi.mocked(compose.submit).mockResolvedValue({ ok: true });
    render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
    const ta = screen.getByPlaceholderText(/message #a/i) as HTMLTextAreaElement;
    ta.focus();
    expect(document.activeElement).toBe(ta);
    fireEvent.keyDown(ta, { key: "Enter" });
    // Wait for the async submit to settle.
    await new Promise((r) => setTimeout(r, 0));
    expect(document.activeElement).toBe(ta);
  });

  it("textarea has no `disabled` attribute (regression guard for focus loss)", () => {
    render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
    const ta = screen.getByPlaceholderText(/message #a/i) as HTMLTextAreaElement;
    expect(ta.hasAttribute("disabled")).toBe(false);
  });
```

- [ ] **Step 1.2: Run tests; expect FAIL**

```bash
bun --cwd cicchetto run test -- ComposeBox.test.tsx
```

Expected: 2 new tests fail. `textarea retains focus...` fails because `sending()` flips true during await → textarea gets `disabled=""` → browser un-focuses → activeElement is no longer ta. `regression guard` fails because the textarea currently HAS `disabled={sending()}` rendering as `disabled=""` on the initial pass-through (sending() is false, but the attribute may still serialize present-empty in jsdom — verify the actual failure mode and adjust assertion to match if needed; the focus test is the load-bearing one).

- [ ] **Step 1.3: Fix ComposeBox.tsx**

Edit `cicchetto/src/ComposeBox.tsx`. Locate the `<textarea ...>` block (lines 82-90) and remove the `disabled={sending()}` attribute:

```tsx
        <textarea
          value={getDraft(key())}
          onInput={onInput}
          onKeyDown={onKeyDown}
          placeholder={`message ${props.channelName}`}
          rows={1}
          aria-label="compose message"
        />
```

The submit button on lines 91-93 keeps its `disabled` attribute as the double-submit guard:

```tsx
        <button type="submit" disabled={sending() || getDraft(key()).trim() === ""}>
          send
        </button>
```

- [ ] **Step 1.4: Run tests; expect PASS**

```bash
bun --cwd cicchetto run test -- ComposeBox.test.tsx
```

Expected: all ComposeBox tests pass (existing 8 + new 2 = 10).

- [ ] **Step 1.5: Run full cicchetto check + test**

```bash
bun --cwd cicchetto run check
bun --cwd cicchetto run test
```

Expected: green. Biome / tsc / 89/89 vitest pass.

- [ ] **Step 1.6: Commit**

```bash
git add cicchetto/src/ComposeBox.tsx cicchetto/src/__tests__/ComposeBox.test.tsx
git commit -m "$(cat <<'EOF'
fix(compose): textarea retains focus across submit

`disabled={sending()}` on the textarea caused the browser to un-focus
the element while the submit promise was in flight; on resolve the
attribute flipped back but focus was gone — the user had to click
back into the textarea to type the next line.

The submit button keeps its disabled state as the double-submit
guard. Two new tests pin the contract: focus persists across a
mocked submit, and the textarea must not carry a `disabled`
attribute at any point (regression guard since the test suite had
no focus assertion before).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Phase 2 — Cicchetto: Empty-state navigation toolbar (Bugs 2 + 3)

### Task 2: Failing tests — empty-state ☰ + ⚙ buttons

**Files:**
- Test: `cicchetto/src/__tests__/Shell.test.tsx`

- [ ] **Step 2.1: Add failing tests for empty-state toolbar**

Append to the `describe("Shell — three-pane integration", () => { ... })` block in `cicchetto/src/__tests__/Shell.test.tsx`:

```tsx
  it("empty-state renders the ☰ open-sidebar button (mobile escape hatch)", () => {
    render(() => <Shell />);
    // selectionState set to null in beforeEach — empty state.
    expect(screen.getByLabelText(/open channel sidebar/i)).toBeInTheDocument();
  });

  it("empty-state renders the ⚙ settings button", () => {
    render(() => <Shell />);
    expect(screen.getByLabelText(/open settings/i)).toBeInTheDocument();
  });

  it("clicking empty-state ☰ opens the sidebar drawer", () => {
    const { container } = render(() => <Shell />);
    const sidebar = container.querySelector(".shell-sidebar");
    expect(sidebar?.classList.contains("open")).toBe(false);
    fireEvent.click(screen.getByLabelText(/open channel sidebar/i));
    expect(sidebar?.classList.contains("open")).toBe(true);
  });

  it("clicking empty-state ⚙ opens the settings drawer", () => {
    const { container } = render(() => <Shell />);
    fireEvent.click(screen.getByLabelText(/open settings/i));
    const settings = container.querySelector(".settings-drawer");
    expect(settings?.classList.contains("open")).toBe(true);
  });
```

- [ ] **Step 2.2: Run tests; expect FAIL**

```bash
bun --cwd cicchetto run test -- Shell.test.tsx
```

Expected: 4 new tests fail. The current empty-state renders only `<p class="muted">select a channel...</p>` — no `aria-label="open channel sidebar"` nor `aria-label="open settings"` nodes exist.

Note: an EXISTING test at line 102-109 ("renders TopicBar + ScrollbackPane + ComposeBox once a channel is selected") asserts `getByLabelText(/open channel sidebar/i)` after setting selectionState. That test must continue to pass — the new empty-state buttons share the same aria-label, so vitest's `getByLabelText` will match either node depending on whether selectionState is null. Both tests remain unambiguous because each scenario only renders ONE such node.

- [ ] **Step 2.3: Fix Shell.tsx — inline empty-state toolbar**

Edit `cicchetto/src/Shell.tsx`. Locate the `<Show>` block at lines 152-171. Replace the `fallback` prop:

```tsx
        <Show
          when={selectedChannel()}
          fallback={
            <>
              <header class="shell-empty-toolbar">
                <button
                  type="button"
                  class="topic-bar-hamburger"
                  aria-label="open channel sidebar"
                  onClick={() => setSidebarOpen((v) => !v)}
                >
                  ☰
                </button>
                <span class="shell-empty-toolbar-spacer" />
                <button
                  type="button"
                  class="topic-bar-settings"
                  aria-label="open settings"
                  onClick={() => setSettingsOpen(true)}
                >
                  ⚙
                </button>
              </header>
              <p class="muted">select a channel to view scrollback</p>
            </>
          }
        >
```

The `.topic-bar-hamburger` + `.topic-bar-settings` class reuse means existing CSS rules (default.css lines 282-314) already style the buttons; only the parent `.shell-empty-toolbar` block is new.

- [ ] **Step 2.4: Add CSS for the empty-state toolbar**

Edit `cicchetto/src/themes/default.css`. After the existing `.topic-bar` block (around line 280, before `.topic-bar-hamburger`), add:

```css
.shell-empty-toolbar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  height: 2.5rem;
  padding: 0 0.5rem;
  border-bottom: 1px solid var(--border);
  background: var(--bg-elevated);
}

.shell-empty-toolbar-spacer {
  flex: 1;
}
```

The button styles (`.topic-bar-hamburger`, `.topic-bar-settings`) already cover the buttons themselves — they're not gated by a `.topic-bar` ancestor selector (verify with `grep -n 'topic-bar-hamburger\|topic-bar-settings' cicchetto/src/themes/default.css` — the rules are flat per-class, not descendant-scoped).

If the rules ARE descendant-scoped under `.topic-bar`, generalize them: change `.topic-bar .topic-bar-hamburger` → `.topic-bar-hamburger`, etc. Verify by reading lines 282-314 before editing.

- [ ] **Step 2.5: Run tests; expect PASS**

```bash
bun --cwd cicchetto run test -- Shell.test.tsx
```

Expected: 4 new tests pass. Existing Shell tests (12) also pass.

- [ ] **Step 2.6: Run full cicchetto check + test**

```bash
bun --cwd cicchetto run check
bun --cwd cicchetto run test
```

Expected: green. 93/93 vitest.

- [ ] **Step 2.7: Commit**

```bash
git add cicchetto/src/Shell.tsx cicchetto/src/themes/default.css cicchetto/src/__tests__/Shell.test.tsx
git commit -m "$(cat <<'EOF'
fix(shell): empty-state ☰ + ⚙ buttons in the no-channel fallback

The TopicBar (host of the ☰ + ⚙ buttons) was gated on
`<Show when={selectedChannel()}>`. On mobile a user with no
default selection had no way to open the channel sidebar drawer
or the settings drawer — the entire viewport was the
"select a channel" fallback message.

The fallback now renders an inline header with the same two
buttons, wired to the same `setSidebarOpen` / `setSettingsOpen`
signals that TopicBar uses. Both selected and unselected states
have the navigation affordance.

A new `.shell-empty-toolbar` CSS block styles the row; the
existing `.topic-bar-hamburger` + `.topic-bar-settings` rules
already cover the buttons themselves (flat per-class selectors,
not descendant-scoped).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Phase 3 — Server: user-topic broadcast on channels-list mutation (Bug 4, server-side)

### Task 3: Failing tests — channels_changed broadcast on self-JOIN/PART/KICK

**Files:**
- Test: `test/grappa/session/server_test.exs`

- [ ] **Step 3.1: Locate the existing self-JOIN test pattern**

Read `test/grappa/session/server_test.exs` — search for an existing test that exercises self-JOIN through `Session.Server` (`grep -n 'self.JOIN\|self_join\|"#chan' test/grappa/session/server_test.exs`). The new tests follow that pattern: spin up a server with a fake `Grappa.IRCServer` upstream, connect, send a JOIN echo for `state.nick`, assert side-effects.

The helper `Grappa.IRCServer` is the in-process fake IRC server — see `test/support/irc_server.ex`. Existing tests use `subscribe_user_topic/1` if it exists; if not, subscribe via `Phoenix.PubSub.subscribe(Grappa.PubSub, Grappa.PubSub.Topic.user(user_name))` directly in the test setup.

- [ ] **Step 3.2: Add failing tests**

Add to `test/grappa/session/server_test.exs` (in the appropriate `describe` block — likely "EventRouter delegation" or similar; if no fitting block, add a new `describe "channels_changed broadcast" do`):

```elixir
  describe "channels_changed broadcast on user topic" do
    setup do
      {:ok, _} = start_supervised({Phoenix.PubSub, name: Grappa.PubSub})
      :ok
    end

    test "self-JOIN broadcasts channels_changed on user topic", %{...} = ctx do
      # Build state + start server fixture per existing helpers — placeholder
      # below; substitute the real fixture call (see existing self-NICK test
      # at line 504 for the shape).
      {server, state} = start_session_for_test(ctx)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Grappa.PubSub.Topic.user(state.user_name))

      # Inject self-JOIN into the EventRouter via the fake upstream's
      # send_to_session helper.
      send_irc(server, ":#{state.nick}!u@h JOIN #newchan")

      assert_receive {:event, %{kind: "channels_changed"}}, 500
    end

    test "self-PART broadcasts channels_changed on user topic", %{...} = ctx do
      {server, state} = start_session_with_channel(ctx, "#existing")
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Grappa.PubSub.Topic.user(state.user_name))

      send_irc(server, ":#{state.nick}!u@h PART #existing :bye")

      assert_receive {:event, %{kind: "channels_changed"}}, 500
    end

    test "self-KICK broadcasts channels_changed on user topic", %{...} = ctx do
      {server, state} = start_session_with_channel(ctx, "#existing")
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Grappa.PubSub.Topic.user(state.user_name))

      send_irc(server, ":op!u@h KICK #existing #{state.nick} :reason")

      assert_receive {:event, %{kind: "channels_changed"}}, 500
    end

    test "other-user JOIN does NOT broadcast (keyset unchanged)", %{...} = ctx do
      {server, state} = start_session_with_channel(ctx, "#existing")
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Grappa.PubSub.Topic.user(state.user_name))

      send_irc(server, ":alice!u@h JOIN #existing")

      refute_receive {:event, %{kind: "channels_changed"}}, 200
    end

    test "PRIVMSG does NOT broadcast (keyset unchanged)", %{...} = ctx do
      {server, state} = start_session_with_channel(ctx, "#existing")
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Grappa.PubSub.Topic.user(state.user_name))

      send_irc(server, ":alice!u@h PRIVMSG #existing :hello")

      refute_receive {:event, %{kind: "channels_changed"}}, 200
    end
  end
```

The helper functions `start_session_for_test/1`, `start_session_with_channel/2`, `send_irc/2` are placeholders for whatever the existing test file uses (read the existing setup blocks first). The exact call shapes are: build a Session.Server bound to a fake IRCServer, deliver a wire-format IRC line into it, and observe the user-topic PubSub event.

- [ ] **Step 3.3: Run tests; expect FAIL**

```bash
scripts/test.sh test/grappa/session/server_test.exs
```

Expected: 3 tests fail with `assert_receive` timeout (broadcast not implemented yet); 2 tests pass (`refute_receive` is satisfied trivially when no broadcast happens). Confirm the failure mode is the timeout, not a setup error.

- [ ] **Step 3.4: Implement maybe_broadcast_channels_changed/2 in Session.Server**

Edit `lib/grappa/session/server.ex`. Modify `delegate/2` (currently lines 403-407):

```elixir
  # `EventRouter.route/2` returns `{:cont, new_state, [effect]}`. Effects
  # are flushed in arrival order via `apply_effects/2`. The router owns
  # state derivation (members map, nick reconcile); Server owns the
  # transport — Client.send_line for `:reply`, Scrollback.persist_event
  # + PubSub.broadcast for `:persist`.
  #
  # Channels-list mutation (self-JOIN / self-PART / self-KICK changes the
  # `state.members` keyset) fires a fan-out broadcast on the per-user
  # topic so every connected tab refetches GET /channels and re-subscribes
  # to per-channel WS topics. Direction-agnostic: grow + shrink share the
  # same heartbeat shape; the cause is irrelevant to subscribers, the
  # REST endpoint is the source of truth for the new list.
  @spec delegate(Message.t(), state()) :: {:noreply, state()}
  defp delegate(msg, state) do
    {:cont, derived_state, effects} = EventRouter.route(msg, state)
    next_state = apply_effects(effects, derived_state)
    maybe_broadcast_channels_changed(state, next_state)
    {:noreply, next_state}
  end

  @spec maybe_broadcast_channels_changed(state(), state()) :: :ok
  defp maybe_broadcast_channels_changed(prev, next) do
    prev_keys = prev.members |> Map.keys() |> Enum.sort()
    next_keys = next.members |> Map.keys() |> Enum.sort()

    if prev_keys != next_keys do
      :ok =
        Phoenix.PubSub.broadcast(
          Grappa.PubSub,
          Topic.user(prev.user_name),
          {:event, %{kind: "channels_changed"}}
        )
    end

    :ok
  end
```

The `Topic.user/1` import is already present (`alias Grappa.PubSub.Topic` at the top of the module). Verify with `grep -n 'alias.*Topic' lib/grappa/session/server.ex`.

- [ ] **Step 3.5: Run tests; expect PASS**

```bash
scripts/test.sh test/grappa/session/server_test.exs
```

Expected: 5 new tests pass. Existing tests in the file also pass.

- [ ] **Step 3.6: Run server-side full gates**

```bash
scripts/check.sh
```

Expected: green. Format / credo --strict / sobelow / dialyzer / deps.audit / hex.audit / doctor / all server tests / coverage all pass.

- [ ] **Step 3.7: Commit**

```bash
git add lib/grappa/session/server.ex test/grappa/session/server_test.exs
git commit -m "$(cat <<'EOF'
feat(session): broadcast channels_changed on user topic on keyset delta

`Grappa.Session.Server.delegate/2` now compares Map.keys(state.members)
between the pre-route state and the post-effect-flush state; on diff
fires a fire-and-forget broadcast `%{kind: "channels_changed"}` on
`Topic.user(state.user_name)`.

Fixes the cicchetto-side gap where `/join #foo` produced no live
channel entry — `channelsBySlug` is a one-shot createResource keyed
on `networks`, so until something explicitly invalidated it the new
channel never appeared in the sidebar (and the new per-channel WS
topic was never subscribed to).

Detection lives in `delegate/2` (transport boundary) — EventRouter
stays pure (`@type effect` unchanged). The broadcast is direction-
agnostic: self-PART / self-KICK collapse to the same heartbeat
shape, since channels-list mutation IS the event the subscriber
acts on; the cause is irrelevant. The payload is empty (no body) —
cicchetto refetches GET /channels on receipt; the REST endpoint is
the single source of truth for the channel list.

First real consumer of `Topic.user/1` (reserved infrastructure
since Phase 2 sub-task 2h; the broadcast surface starts here).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Phase 4 — Cicchetto: networks.ts refetchChannels export (Bug 4, cicchetto-side prep)

### Task 4: Failing test — refetchChannels exported

**Files:**
- Test: `cicchetto/src/__tests__/networks.test.ts`

- [ ] **Step 4.1: Add failing test**

Append to `cicchetto/src/__tests__/networks.test.ts`:

```ts
  it("exports refetchChannels as a function", async () => {
    const networks = await import("../lib/networks");
    expect(typeof networks.refetchChannels).toBe("function");
  });
```

- [ ] **Step 4.2: Run tests; expect FAIL**

```bash
bun --cwd cicchetto run test -- networks.test.ts
```

Expected: TypeScript compile error — `Property 'refetchChannels' does not exist on type ...`. (Bun + tsc surfaces this before the test runs.) Treat the compile error as the "fail" signal.

- [ ] **Step 4.3: Implement refetchChannels in networks.ts**

Edit `cicchetto/src/lib/networks.ts`. Modify lines 48-59 (the `channelsBySlug` createResource block):

```ts
  const [channelsBySlug, { refetch: refetchChannelsResource }] = createResource<
    Record<string, ChannelEntry[]>,
    Network[]
  >(networks, async (nets) => {
    if (!nets || nets.length === 0) return {};
    const t = token();
    if (!t) return {};
    const entries = await Promise.all(
      nets.map(async (n) => [n.slug, await listChannels(t, n.slug)] as const),
    );
    return Object.fromEntries(entries);
  });

  const refetchChannels = (): void => {
    void refetchChannelsResource();
  };

  return { networks, user, channelsBySlug, refetchChannels };
```

Add the new export at the bottom (line 64-66 area):

```ts
export const networks = exports.networks;
export const user = exports.user;
export const channelsBySlug = exports.channelsBySlug;
export const refetchChannels = exports.refetchChannels;
```

The `refetchChannels` wrapper sheds the resource's promise return so the consumer (`userTopic.ts`) can call it as `() => void` without unhandled-promise concerns.

- [ ] **Step 4.4: Run tests; expect PASS**

```bash
bun --cwd cicchetto run test -- networks.test.ts
```

Expected: new test passes. Existing networks tests also pass.

- [ ] **Step 4.5: Run full cicchetto check + test**

```bash
bun --cwd cicchetto run check
bun --cwd cicchetto run test
```

Expected: green.

- [ ] **Step 4.6: Commit**

```bash
git add cicchetto/src/lib/networks.ts cicchetto/src/__tests__/networks.test.ts
git commit -m "$(cat <<'EOF'
feat(networks): expose refetchChannels for user-topic event consumer

`channelsBySlug` createResource exposes its `refetch` callback as a
public `refetchChannels: () => void`. Prep for the new userTopic.ts
consumer that fires this on `channels_changed` events from the
per-user PubSub topic.

The wrapper sheds the resource refetch's promise return so callers
don't have to handle it — the resource takes care of its own
in-flight tracking.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Phase 5 — Cicchetto: userTopic.ts module (Bug 4, cicchetto-side wiring)

### Task 5: socket.ts re-export joinUser

**Files:**
- Modify: `cicchetto/src/lib/socket.ts`

- [ ] **Step 5.1: Re-export joinUser**

Edit `cicchetto/src/lib/socket.ts`. Replace the existing comment at lines 72-77 + the `joinChannel` export with:

```ts
export function joinUser(userName: string): Channel {
  const topic = `grappa:user:${userName}`;
  const ch = getSocket().channel(topic);
  ch.join()
    .receive("error", (err: unknown) => {
      console.error("[grappa] channel join failed", topic, err);
    })
    .receive("timeout", () => {
      console.error("[grappa] channel join timed out", topic);
    });
  return ch;
}

export function joinChannel(userName: string, networkSlug: string, channelName: string): Channel {
  const topic = `grappa:user:${userName}/network:${networkSlug}/channel:${channelName}`;
  const ch = getSocket().channel(topic);
  ch.join()
    .receive("error", (err: unknown) => {
      console.error("[grappa] channel join failed", topic, err);
    })
    .receive("timeout", () => {
      console.error("[grappa] channel join timed out", topic);
    });
  return ch;
}
```

The `joinUser/1` shape mirrors `joinChannel/3` exactly — same getSocket / channel / join / error+timeout receive handlers.

The dropped-and-restored note in the prior comment is no longer needed; if a brief reminder of the topic-shape symmetry is desired, a one-line `// joinUser + joinChannel mirror Topic.user/1 + Topic.channel/3 from the server` above `joinUser` is enough.

- [ ] **Step 5.2: tsc compile check**

```bash
bun --cwd cicchetto run check
```

Expected: clean. The new export doesn't break any existing import.

### Task 6: Failing test — userTopic.ts dispatches channels_changed

**Files:**
- Create: `cicchetto/src/__tests__/userTopic.test.ts`

- [ ] **Step 6.1: Write the failing test**

Create `cicchetto/src/__tests__/userTopic.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type EventHandler = (payload: { kind: string; [k: string]: unknown }) => void;

const channelMock = vi.hoisted(() => {
  const handlers: EventHandler[] = [];
  return {
    handlers,
    on: vi.fn((event: string, fn: EventHandler) => {
      if (event === "event") handlers.push(fn);
    }),
    fireEvent: (payload: { kind: string; [k: string]: unknown }) => {
      for (const h of handlers) h(payload);
    },
    reset: () => {
      handlers.length = 0;
    },
  };
});

vi.mock("../lib/socket", () => ({
  joinUser: vi.fn(() => ({ on: channelMock.on })),
  joinChannel: vi.fn(),
}));

vi.mock("../lib/networks", () => ({
  user: vi.fn(() => ({ id: "u1", name: "vjt", inserted_at: "x" })),
  refetchChannels: vi.fn(),
  networks: vi.fn(() => []),
  channelsBySlug: vi.fn(() => ({})),
}));

vi.mock("../lib/auth", () => ({
  token: vi.fn(() => "t1"),
}));

describe("userTopic", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    channelMock.reset();
    // Re-import to trigger the createRoot side-effect anew per test.
    vi.resetModules();
    await import("../lib/userTopic");
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("joins the user topic when user resolves", async () => {
    const socket = await import("../lib/socket");
    expect(socket.joinUser).toHaveBeenCalledWith("vjt");
  });

  it("calls refetchChannels on channels_changed event", async () => {
    const networks = await import("../lib/networks");
    channelMock.fireEvent({ kind: "channels_changed" });
    expect(networks.refetchChannels).toHaveBeenCalled();
  });

  it("does NOT call refetchChannels on unrelated event payloads", async () => {
    const networks = await import("../lib/networks");
    channelMock.fireEvent({ kind: "message", body: "hi" });
    expect(networks.refetchChannels).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 6.2: Run tests; expect FAIL**

```bash
bun --cwd cicchetto run test -- userTopic.test.ts
```

Expected: TypeScript / module-resolution failure — `Cannot find module '../lib/userTopic'`. The module doesn't exist yet.

- [ ] **Step 6.3: Implement userTopic.ts**

Create `cicchetto/src/lib/userTopic.ts`:

```ts
import { createEffect, createRoot } from "solid-js";
import { token } from "./auth";
import { refetchChannels, user } from "./networks";
import { joinUser } from "./socket";

// Per-user PubSub topic subscriber. Module-singleton side-effect:
// imports for effect, exports nothing public. `main.tsx` imports this
// alongside `subscribe.ts` so the createRoot evaluates at boot.
//
// Wires the server-side `channels_changed` heartbeat (broadcast on
// `Topic.user(user_name)` whenever `Map.keys(Session.Server.state.members)`
// mutates) to a `refetchChannels()` call. The cicchetto `channelsBySlug`
// createResource then re-resolves with the canonical {name, joined,
// source} envelopes from `GET /channels`, and `subscribe.ts`'s
// createEffect re-runs to join WS topics for the new channels.
//
// Identity-scoped: re-evaluates when `user()` resolves under a fresh
// bearer. The Phoenix Channel handle is per-tab and persists across
// `user()` rotations through the Socket's connect/disconnect lifecycle
// in socket.ts; we don't need a `leave()` arm here.

createRoot(() => {
  let joined = false;

  createEffect(() => {
    // Track the bearer + user identity; on rotation Solid re-runs this
    // effect against fresh resources.
    const t = token();
    const u = user();
    if (!t || !u) return;
    if (joined) return;
    joined = true;

    const channel = joinUser(u.name);
    channel.on("event", (payload: { kind?: string }) => {
      if (payload.kind === "channels_changed") {
        refetchChannels();
      }
    });
  });
});
```

The `joined` guard prevents double-subscription on the same identity (Solid's createEffect can re-fire on resource invalidation; phoenix.js is idempotent on `socket.channel(topic)` but the `.on` handler accumulates without the guard).

- [ ] **Step 6.4: Wire up in main.tsx**

Edit `cicchetto/src/main.tsx`. Find the existing `import "./lib/subscribe";` line; add right after:

```ts
import "./lib/userTopic";
```

If `subscribe.ts` is not imported there yet, the import order is: socket → subscribe → userTopic (any order works since each is a side-effect module guarded by createRoot, but human-readable ordering is alphabetical-after-side-effect-tier).

- [ ] **Step 6.5: Run tests; expect PASS**

```bash
bun --cwd cicchetto run test -- userTopic.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 6.6: Run full cicchetto check + test**

```bash
bun --cwd cicchetto run check
bun --cwd cicchetto run test
```

Expected: green. 96/96 vitest.

- [ ] **Step 6.7: Commit**

```bash
git add cicchetto/src/lib/socket.ts cicchetto/src/lib/userTopic.ts cicchetto/src/main.tsx cicchetto/src/__tests__/userTopic.test.ts
git commit -m "$(cat <<'EOF'
feat(userTopic): subscribe to per-user PubSub topic, refetch on channels_changed

New `lib/userTopic.ts` joins `grappa:user:{name}` at boot and calls
`networks.refetchChannels()` on incoming `channels_changed` events.
Closes the live-channel-on-/join gap: server broadcasts on the user
topic when its `state.members` keyset mutates; cicchetto refetches
GET /channels; subscribe.ts createEffect re-runs and joins WS
topics for any new channels.

`socket.ts` re-exports the previously-dropped `joinUser/1` (the
helper was removed per S49 with a "bring it back when a real
consumer needs it" note — userTopic.ts is the real consumer).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Phase 6 — Final gates + DESIGN_NOTES + merge + deploy

### Task 7: Full server + cicchetto gates

**Files:** none (verification only).

- [ ] **Step 7.1: Server gates**

```bash
scripts/check.sh
```

Expected: green. All gates pass.

- [ ] **Step 7.2: Cicchetto gates**

```bash
bun --cwd cicchetto run check
bun --cwd cicchetto run test
```

Expected: green.

If anything fails: stop, fix, retry. Do NOT proceed until both are clean.

### Task 8: DESIGN_NOTES update

**Files:**
- Modify: `docs/DESIGN_NOTES.md`

- [ ] **Step 8.1: Append a new entry**

Append to `docs/DESIGN_NOTES.md` at the appropriate location (after the most recent dated entry):

```markdown
## 2026-04-XX — text-polish: channels_changed user-topic broadcast + iPhone bug sweep

Cluster pinned 2026-04-28. Fixes four iPhone-acceptance gaps blocking
the M2 NickServ-IDP + anon webirc auth-triangle clusters.

### Server-side

- `Grappa.Session.Server.delegate/2` post-route compares
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
```

- [ ] **Step 8.2: Commit**

```bash
git add docs/DESIGN_NOTES.md
git commit -m "$(cat <<'EOF'
docs(design): text-polish cluster — channels_changed broadcast + iPhone bug sweep

DESIGN_NOTES entry documenting the keyset-delta detection at
Session.Server.delegate/2, the user-topic broadcast surface
(first real consumer of Topic.user/1), the cicchetto-side
userTopic.ts module, and the Shell + ComposeBox bug fixes.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

### Task 9: Rebase + merge to main + deploy

**Files:** none (git + deploy operations).

- [ ] **Step 9.1: Rebase the cluster branch onto main**

From the worktree:

```bash
git fetch origin
git rebase main
```

Expected: clean rebase (main has not advanced since branch was created — single-author + sequential cluster pattern).

- [ ] **Step 9.2: Switch to /srv/grappa main and merge**

```bash
git -C /srv/grappa checkout main
git -C /srv/grappa merge --no-ff cluster/text-polish -m "$(cat <<'EOF'
Merge cluster/text-polish — text-polish LANDED

Closes 4 iPhone-acceptance bugs blocking M2 / anon clusters:
- ComposeBox textarea retains focus across submit
- Mobile no-channel empty-state has ☰ + ⚙ navigation
- Light/dark theme toggle reachable from empty state (collapses with above)
- /join produces a live channel via channels_changed user-topic broadcast

EOF
)"
```

NOTE: the branch name in Step 9.2 should match what was used. This plan was authored on `plan/text-polish` (plan-only branch); the implementation session may rename to `cluster/text-polish` per the cluster-naming convention. Verify the branch name with `git branch -a` before merging.

- [ ] **Step 9.3: Deploy**

```bash
scripts/deploy.sh
```

Expected: build succeeds, container restarts. Refuses if not on main (CLAUDE.md guard).

- [ ] **Step 9.4: Health check**

```bash
scripts/healthcheck.sh
```

Expected: 200 OK from `/healthz`.

- [ ] **Step 9.5: Live smoke test**

Open `http://grappa.bad.ass` in browser. Verify:
- iPhone viewport (or emulated mobile): empty-state shows ☰ + ⚙ buttons; tapping ☰ opens sidebar drawer; tapping ⚙ opens settings drawer with theme radios.
- Desktop: light/dark toggle reachable from empty state via ⚙ button.
- Compose: type, hit Enter, observe textarea retains focus (cursor remains; can keep typing without re-clicking).
- `/join #grappa-test` (or any new channel): observe new channel appears in sidebar without page refresh; new channel's scrollback populates as messages arrive.

If any smoke-test step fails: surface to vjt; do NOT consider cluster LANDED until fixed.

- [ ] **Step 9.6: Push main**

```bash
git -C /srv/grappa push origin main
```

### Task 10: Update CP10 with S21 entry

**Files:**
- Modify: `docs/checkpoints/2026-04-27-cp10.md`

- [ ] **Step 10.1: Append S21 entry**

Append a new `## S21 — 2026-04-XX — text-polish cluster LANDED + deployed` section to `docs/checkpoints/2026-04-27-cp10.md`. Match the S19 entry's shape (post-impl session, deploy state, smoke-test result, follow-up items). Note the next-cluster opening (M2 NickServ-IDP).

- [ ] **Step 10.2: Commit on main directly (docs-only, per CLAUDE.md)**

```bash
git -C /srv/grappa add docs/checkpoints/2026-04-27-cp10.md
git -C /srv/grappa commit -m "$(cat <<'EOF'
docs: CP10 S21 — text-polish cluster LANDED + deployed

Closes the 4-bug iPhone acceptance sweep. Auth-triangle (M2 +
anon) clusters unblocked.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"

git -C /srv/grappa push origin main
```

- [ ] **Step 10.3: Cleanup worktree + branch**

```bash
git worktree remove ~/code/IRC/grappa-task-text-polish
git -C /srv/grappa branch -d cluster/text-polish  # or plan/text-polish if not renamed
```

---

## Exit criteria — text-polish LANDED

The cluster is "LANDED" when ALL of the following hold:

1. **Server-side**:
   - `Grappa.Session.Server.delegate/2` broadcasts `channels_changed` on `Topic.user(state.user_name)` when the channels-keyset changes.
   - 5 new tests in `test/grappa/session/server_test.exs` pass: self-JOIN broadcasts, self-PART broadcasts, self-KICK broadcasts, other-user JOIN does NOT broadcast, PRIVMSG does NOT broadcast.
   - `scripts/check.sh` green: format / credo --strict / sobelow / dialyzer / deps.audit / hex.audit / doctor / test --warnings-as-errors --cover.

2. **Cicchetto-side**:
   - `cicchetto/src/lib/userTopic.ts` ships, joins user topic at boot, calls `refetchChannels()` on `channels_changed`.
   - `cicchetto/src/lib/socket.ts` re-exports `joinUser/1`.
   - `cicchetto/src/lib/networks.ts` exposes `refetchChannels: () => void`.
   - `cicchetto/src/Shell.tsx` empty-state renders the inline ☰ + ⚙ toolbar.
   - `cicchetto/src/ComposeBox.tsx` textarea no longer carries `disabled={sending()}`.
   - `cicchetto/src/main.tsx` imports `./lib/userTopic` for side-effect.
   - 9 new tests pass (2 ComposeBox focus, 4 Shell empty-state, 1 networks refetch export, 3 userTopic).
   - `bun --cwd cicchetto run check` clean; `bun --cwd cicchetto run test` green.

3. **Deploy**:
   - `scripts/deploy.sh` runs successfully.
   - `scripts/healthcheck.sh` returns 200.
   - Live smoke test passes all 4 bug-fix scenarios on desktop + mobile viewport.
   - Production browser console clean of new errors.

4. **Docs**:
   - `docs/DESIGN_NOTES.md` has the text-polish entry.
   - `docs/checkpoints/2026-04-27-cp10.md` has the S21 entry recording cluster landing + deploy state.
   - `docs/plans/2026-04-28-text-polish.md` (this plan) is on main.

5. **Code review** (`superpowers:code-reviewer` agent against the cluster branch + plan): NO BLOCKERS, NO MAJORS. Verdict surfaces in CP10 S21.

If any criterion fails, the cluster is NOT closed — surface to vjt and resolve before merging to main.

---

## Self-review

### 1. Spec coverage

The "spec" for this cluster is the 4-bug list vjt provided 2026-04-28. Coverage table:

| Bug | Plan task |
|---|---|
| 1. Enter on textarea loses focus | Phase 1 (Tasks 1.1-1.6) |
| 2. Mobile no-channel state has no escape hatch | Phase 2 (Tasks 2.1-2.7) |
| 3. Light/dark switch invisible from empty state | Phase 2 (collapses with bug 2 — same fix) |
| 4. /join produces no live channel without refresh | Phases 3+4+5 (Tasks 3.1-6.7) |

Every bug maps to at least one task. Bug 4 is the largest (server + 3 cicchetto modules); the others are localized to one component each.

### 2. Placeholder scan

- `TBD` / `TODO` / `fill in` / `implement later` — none in task bodies. Two legitimate uses: "see existing self-NICK test at line 504 for the shape" (pointer to existing pattern) and "the helper functions ... are placeholders for whatever the existing test file uses" (instruction to read the existing setup before mimicking — concrete, not a TODO). Both are pointers to existing patterns the impl session resolves at read-time.
- "Add appropriate error handling" / "validate" — none.
- "Similar to Task N" — none. Code blocks are repeated verbatim where reused (Task 5's `joinChannel` is shown alongside the new `joinUser` for clarity even though it already exists in the file).
- "Write tests for the above" without test code — none. Every test step has the test code.

### 3. Type consistency

- `channels_changed` payload: `%{kind: "channels_changed"}` consistent in Session.Server (Task 3) + userTopic.ts (Task 6) + Shell.test.tsx (where applicable, but it doesn't reference the payload type).
- `refetchChannels: () => void` consistent in networks.ts export (Task 4) + userTopic.ts import (Task 6) + networks.test.ts (Task 4).
- `joinUser(userName: string): Channel` consistent in socket.ts export (Task 5) + userTopic.ts import (Task 6) + userTopic.test.ts mock (Task 6).
- `Topic.user/1` arity + return type consistent (already in the codebase per `lib/grappa/pubsub/topic.ex:39-42` — re-used unchanged).
- `aria-label="open channel sidebar"` + `aria-label="open settings"` strings consistent in Shell.tsx empty-state (Task 2) + TopicBar.tsx (existing) + Shell.test.tsx assertions (Task 2).

### 4. CLAUDE.md cross-check

- **No `\\` defaults** — every new function (Elixir + TS) requires its args explicitly. ✓
- **Atoms / literal unions for closed sets** — `kind: "channels_changed"` is a literal string in TS (TS doesn't have atoms; the closed-set discipline is encoded as the discriminant of the union). On the server side the broadcast payload is a map with a string-typed `:kind` value matching the wire shape consumers parse — JSON is the boundary, atoms don't traverse. ✓
- **One feature, one code path, every door** — `channels_changed` flows through one chain: Session.Server.delegate → Topic.user(user_name) PubSub → GrappaChannel handle_info → cicchetto userTopic.ts → networks.refetchChannels → channelsBySlug createResource → subscribe.ts createEffect → joinChannel for new entries. No second definition. ✓
- **Reuse the verbs, not the nouns** — `userTopic.ts` is verb-keyed (subscribes-to-user-topic-and-refetches), not "UserStore" or "ChannelsManager" nouns. ✓
- **Implement once, reuse everywhere** — `joinUser/1` extracted alongside existing `joinChannel/3` in socket.ts (one socket-join helper shape, two arity-specific exports). The keyset-delta detection lives in one place (Session.Server.delegate). ✓
- **Crash boundary alignment** — server-side: a Session.Server crash resets only that session's state; the broadcast is fire-and-forget so no in-flight broadcast survives a crash (Phoenix.PubSub is in-memory + per-node, so a node crash drops the message — acceptable since the next reconnect refetches GET /channels at boot anyway). ✓
- **Phoenix Channels = the event push surface** — channels-list mutation broadcasts on `Topic.user/1` per the canonical pattern. No new SSE / polling. ✓
- **No backwards-compat hacks** — `channelsBySlug` createResource is augmented, not replaced; `joinUser/1` was previously dropped + restored (S49 marker honored, no half-state). The empty-state JSX is added inline rather than adding a backwards-compat shim around TopicBar's gated rendering. ✓

---

## Execution handoff

Plan complete and saved to `docs/plans/2026-04-28-text-polish.md`. Two execution options:

**1. Subagent-Driven (recommended)** — orchestrator dispatches a fresh subagent per task, reviews between tasks. Same pattern as P4-1 / E1.

**2. Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints.

The cluster is small (10 task groups; estimated 1 session). Inline execution likely sufficient.

**Which approach?** — vjt to pin at implementation-session opening.

---
