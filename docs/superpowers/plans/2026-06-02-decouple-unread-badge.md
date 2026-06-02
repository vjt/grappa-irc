# Decouple Unread Badge From Read Cursor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clear a window's sidebar unread badge the moment the operator selects it (while the tab is visible), without touching the read cursor — so the in-pane unread marker survives the select.

**Architecture:** Add a final "focused-window suppression" overwrite to the `perChannelUnread` memo in `cicchetto/src/lib/selection.ts`. It zeros the `{messages, events}` count for the channel that is BOTH `selectedChannel` AND `isDocumentVisible`. Derived from existing signals — no new state, no cursor write. All three public memos (`messagesUnread` / `eventsUnread` / `unreadCounts`) and every consumer read through `perChannelUnread`, so suppression is consistent everywhere. Marker, send, scroll, blur, and cursor machinery are untouched.

**Tech Stack:** SolidJS (signals + `createMemo`), TypeScript, vitest (jsdom). Run inside the bun container via `scripts/bun.sh`.

**Spec:** `docs/superpowers/specs/2026-06-02-decouple-unread-badge-design.md`

---

## Pre-flight

- [ ] **Worktree first.** Per CLAUDE.md dev cycle, all code changes go in a worktree branched from local `main`. Create it via the `superpowers:using-git-worktrees` skill (or `git checkout main && git worktree add ../grappa-unread-badge -b feat/decouple-unread-badge`). `cicchetto/` is bind-mounted from the worktree's SRC_ROOT, so `scripts/bun.sh` builds from the worktree source automatically.

- [ ] **Baseline green.** Before any change, confirm the cic suite is clean:

```bash
scripts/bun.sh run test
```

Expected: all suites pass. If anything fails, fix it in the first commit (CLAUDE.md: zero errors is the baseline).

---

## File Structure

- **Modify:** `cicchetto/src/lib/selection.ts`
  - `perChannelUnread` memo (currently lines ~212-251) — add the suppression overwrite before `return result;`.
  - Module doc bullet (currently lines ~32-41) — note the new suppression so the next reader doesn't believe "badges only drop as the cursor advances".
- **Modify:** `cicchetto/src/__tests__/selection.test.ts`
  - Add a `describe("focused-window badge suppression …")` block.
- **Modify:** `cicchetto/src/ScrollbackPane.tsx`
  - Fix the stale comment at lines ~829-833 ("cursor only advances when the user navigates AWAY") — no longer true (scroll-settle, send, blur also advance it). Comment-only.

---

### Task 1: Core suppression — selecting a visible window zeros its own badge

**Files:**
- Test: `cicchetto/src/__tests__/selection.test.ts`
- Modify: `cicchetto/src/lib/selection.ts` (`perChannelUnread` memo)

- [ ] **Step 1: Write the failing test**

Add this `describe` block inside the top-level `describe("selection store", …)` in `selection.test.ts`, after the `describe("UX-6 bucket K …")` block (before the final closing `});` of `"selection store"`). The harness mocks `readCursor` so `getReadCursor → null` → every appended row is unread; pre-`appendToScrollback` rows are synchronous and survive the mocked-empty `loadInitialScrollback`.

```ts
  // 2026-06-02 — decouple the sidebar badge from the read cursor. The
  // badge means "have I opened this window?" and must clear on SELECT,
  // independent of the cursor (which the in-pane marker still rides on,
  // so the marker survives the select). selection.ts suppresses the
  // focused-AND-visible window's message/event counts in perChannelUnread;
  // the cursor is never written here (ScrollbackPane owns cursor writes).
  // Spec: docs/superpowers/specs/2026-06-02-decouple-unread-badge-design.md
  describe("focused-window badge suppression (2026-06-02)", () => {
    it("selecting a visible window zeros its own message badge", async () => {
      localStorage.setItem("grappa-token", "tok");
      const api = await import("../lib/api");
      vi.mocked(api.listMessages).mockResolvedValue([]);
      const selection = await import("../lib/selection");
      const scrollback = await import("../lib/scrollback");
      const key = channelKey("freenode", "#grappa");
      // Three unread privmsgs (cursor is mocked null → all unread).
      for (const id of [1, 2, 3]) {
        scrollback.appendToScrollback(key, {
          id,
          network: "freenode",
          channel: "#grappa",
          server_time: id,
          kind: "privmsg",
          sender: "bob",
          body: "x",
          meta: {},
        });
      }
      // Sanity: before selecting, the badge shows 3.
      expect(selection.messagesUnread()[key]).toBe(3);

      selection.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "#grappa",
        kind: "channel",
      });

      // Focused + visible (beforeEach default) → suppressed → key dropped.
      expect(selection.messagesUnread()[key]).toBeUndefined();
      expect(selection.unreadCounts()[key]).toBeUndefined();
    });
  });
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
scripts/bun.sh run test selection
```

Expected: FAIL — `expect(selection.messagesUnread()[key]).toBeUndefined()` receives `3` (no suppression yet). The "before selecting … toBe(3)" assertion passes.

- [ ] **Step 3: Implement the suppression**

In `cicchetto/src/lib/selection.ts`, in the `perChannelUnread` memo, insert the suppression block immediately before the closing `return result;`. The memo already has `selectedChannel`, `isDocumentVisible`, and `channelKey` in scope (closure + imports at the top of the file).

Find:

```ts
      result[key] = { messages: msgs, events: evts };
    }

    return result;
  });
```

Replace with:

```ts
      result[key] = { messages: msgs, events: evts };
    }

    // 2026-06-02 — focused-window badge suppression. The operator is
    // looking at this window (and the browser tab is visible), so it has
    // nothing unread TO THEM right now: zero its count. Derived from
    // selectedChannel + isDocumentVisible — the read cursor is NOT
    // advanced, so the in-pane `── N unread ──` marker survives the
    // select and clears on its own settle events (scroll / defocus /
    // send). Gating on isDocumentVisible keeps a selected-but-backgrounded
    // tab accruing its badge so a returning operator sees activity.
    // Final overwrite so it covers both the seed-only and hydrated
    // branches above. Spec:
    // docs/superpowers/specs/2026-06-02-decouple-unread-badge-design.md
    const focused = selectedChannel();
    if (focused !== null && isDocumentVisible()) {
      result[channelKey(focused.networkSlug, focused.channelName)] = {
        messages: 0,
        events: 0,
      };
    }

    return result;
  });
```

- [ ] **Step 4: Run the test, verify it passes**

```bash
scripts/bun.sh run test selection
```

Expected: PASS — the new test is green; all pre-existing `selection.test.ts` tests stay green (the focus-regain test at the `#has-unread` key and the UX-6 K "OTHER windows" test both use a NON-selected key, so suppression does not touch them).

- [ ] **Step 5: Commit**

```bash
git add cicchetto/src/lib/selection.ts cicchetto/src/__tests__/selection.test.ts
git commit -m "$(cat <<'EOF'
feat(cic): clear sidebar badge on window select

The badge means "have I opened this window?" and must clear the moment
the operator selects it — independent of the read cursor. perChannelUnread
now zeros the focused window's message/event counts as a final overwrite,
derived from selectedChannel. The cursor is untouched, so the in-pane
unread marker survives the select (it rides the cursor, not the badge).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Visibility gate — a backgrounded selected window still accrues its badge

**Files:**
- Test: `cicchetto/src/__tests__/selection.test.ts`
- Modify: `cicchetto/src/lib/selection.ts` (already gated in Task 1 — this task pins the gate with a test-first that would fail WITHOUT the `&& isDocumentVisible()` conjunct)

> If you implemented Task 1 exactly (with the `&& isDocumentVisible()` gate), this test passes immediately. Write it anyway: it is the regression guard that pins the gate. To honor test-first, you may temporarily drop the `&& isDocumentVisible()` conjunct, watch this test fail, then restore it.

- [ ] **Step 1: Write the test**

Add inside the `describe("focused-window badge suppression (2026-06-02)", …)` block:

```ts
    it("does NOT suppress when the document is hidden (selected ≠ looking)", async () => {
      localStorage.setItem("grappa-token", "tok");
      const api = await import("../lib/api");
      vi.mocked(api.listMessages).mockResolvedValue([]);
      const selection = await import("../lib/selection");
      const scrollback = await import("../lib/scrollback");
      const key = channelKey("freenode", "#grappa");
      for (const id of [1, 2, 3]) {
        scrollback.appendToScrollback(key, {
          id,
          network: "freenode",
          channel: "#grappa",
          server_time: id,
          kind: "privmsg",
          sender: "bob",
          body: "x",
          meta: {},
        });
      }
      // Tab goes hidden, THEN the window is selected.
      setVisibilityForTest(false);
      await Promise.resolve();
      selection.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "#grappa",
        kind: "channel",
      });

      // Hidden → not suppressed → the badge keeps accruing.
      expect(selection.messagesUnread()[key]).toBe(3);

      // Returning to the tab suppresses it.
      setVisibilityForTest(true);
      await Promise.resolve();
      expect(selection.messagesUnread()[key]).toBeUndefined();
    });
```

- [ ] **Step 2: Run the test**

```bash
scripts/bun.sh run test selection
```

Expected: PASS (gate already present). If you dropped the gate to see red: FAIL with `messagesUnread()[key]` === `undefined` where `3` was expected; restore `&& isDocumentVisible()` to go green.

- [ ] **Step 3: Commit**

```bash
git add cicchetto/src/__tests__/selection.test.ts
git commit -m "$(cat <<'EOF'
test(cic): pin badge-suppression visibility gate

A selected-but-backgrounded tab must keep accruing its badge so a
returning operator sees activity ("selected" ≠ "looking"). Guards the
isDocumentVisible conjunct in perChannelUnread's suppression.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Regression guards — events suppression, deselect re-exposes, other windows untouched

**Files:**
- Test: `cicchetto/src/__tests__/selection.test.ts`

These pass with the Task 1 implementation; they lock the remaining spec behaviors.

- [ ] **Step 1: Write the tests**

Add inside the `describe("focused-window badge suppression (2026-06-02)", …)` block:

```ts
    it("suppresses the event badge too (presence kinds)", async () => {
      localStorage.setItem("grappa-token", "tok");
      const api = await import("../lib/api");
      vi.mocked(api.listMessages).mockResolvedValue([]);
      const selection = await import("../lib/selection");
      const scrollback = await import("../lib/scrollback");
      const key = channelKey("freenode", "#grappa");
      scrollback.appendToScrollback(key, {
        id: 1,
        network: "freenode",
        channel: "#grappa",
        server_time: 1,
        kind: "join",
        sender: "bob",
        body: "",
        meta: {},
      });
      expect(selection.eventsUnread()[key]).toBe(1);

      selection.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "#grappa",
        kind: "channel",
      });

      expect(selection.eventsUnread()[key]).toBeUndefined();
    });

    it("re-exposes the count when the operator leaves the window", async () => {
      // The cursor is owned by ScrollbackPane (mocked null here), so this
      // pins the suppression LIFTING on deselect: leftover unread re-badges.
      localStorage.setItem("grappa-token", "tok");
      const api = await import("../lib/api");
      vi.mocked(api.listMessages).mockResolvedValue([]);
      const selection = await import("../lib/selection");
      const scrollback = await import("../lib/scrollback");
      const key = channelKey("freenode", "#grappa");
      for (const id of [1, 2, 3]) {
        scrollback.appendToScrollback(key, {
          id,
          network: "freenode",
          channel: "#grappa",
          server_time: id,
          kind: "privmsg",
          sender: "bob",
          body: "x",
          meta: {},
        });
      }
      selection.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "#grappa",
        kind: "channel",
      });
      expect(selection.messagesUnread()[key]).toBeUndefined();

      // Switch to a different window — #grappa is no longer focused.
      selection.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "#other",
        kind: "channel",
      });

      expect(selection.messagesUnread()[key]).toBe(3);
    });

    it("does NOT suppress OTHER (non-selected) windows", async () => {
      localStorage.setItem("grappa-token", "tok");
      const api = await import("../lib/api");
      vi.mocked(api.listMessages).mockResolvedValue([]);
      const selection = await import("../lib/selection");
      const scrollback = await import("../lib/scrollback");
      const selKey = channelKey("freenode", "#grappa");
      const otherKey = channelKey("freenode", "#cicchetto");
      scrollback.appendToScrollback(otherKey, {
        id: 1,
        network: "freenode",
        channel: "#cicchetto",
        server_time: 1,
        kind: "privmsg",
        sender: "bob",
        body: "x",
        meta: {},
      });
      selection.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "#grappa",
        kind: "channel",
      });

      // Selecting #grappa must not touch #cicchetto's badge.
      expect(selection.messagesUnread()[otherKey]).toBe(1);
    });
```

- [ ] **Step 2: Run the tests, verify they pass**

```bash
scripts/bun.sh run test selection
```

Expected: PASS — all three plus the Task 1/2 tests green.

- [ ] **Step 3: Commit**

```bash
git add cicchetto/src/__tests__/selection.test.ts
git commit -m "$(cat <<'EOF'
test(cic): regression guards for badge suppression

Pins: event-badge suppression, suppression lifting on deselect (leftover
unread re-badges), and that selecting one window never zeros another's
badge.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Doc honesty — module doc + stale ScrollbackPane comment

**Files:**
- Modify: `cicchetto/src/lib/selection.ts` (module doc bullet, ~lines 32-41)
- Modify: `cicchetto/src/ScrollbackPane.tsx` (comment, ~lines 829-833)

- [ ] **Step 1: Update the selection.ts module-doc bullet**

Find (in the moduledoc near the top of `selection.ts`):

```ts
//   * `unreadCounts` / `messagesUnread` / `eventsUnread` — DERIVED memos
//     over `(scrollbackByChannel, readCursors, serverSeedCounts)`. For
//     each known channel, the memo counts local rows with `id > cursor`
//     split by content vs presence kind. When local scrollback is empty
//     for a channel, falls back to `serverSeedCounts[key]`.
```

Replace with:

```ts
//   * `unreadCounts` / `messagesUnread` / `eventsUnread` — DERIVED memos
//     over `(scrollbackByChannel, readCursors, serverSeedCounts)`. For
//     each known channel, the memo counts local rows with `id > cursor`
//     split by content vs presence kind. When local scrollback is empty
//     for a channel, falls back to `serverSeedCounts[key]`. The
//     focused-AND-visible window's count is then force-zeroed (2026-06-02):
//     the badge clears on SELECT without advancing the cursor, so the
//     in-pane unread marker survives. The cursor still drives the marker
//     and the non-focused windows' counts.
```

- [ ] **Step 2: Fix the stale ScrollbackPane comment**

Find (in `ScrollbackPane.tsx`, in the `rows` memo's unread-computation comment):

```tsx
  //   The cursor is a stable value for the lifetime of this channel view;
  //   it only advances when the user navigates AWAY from the window
  //   (selection.ts on(selectedChannel)'s focus-leave hook). The
  //   sessionTopId bound prevents NEW arrivals during the focus session
  //   from spawning a fresh marker — they're live-read by definition.
```

Replace with:

```tsx
  //   The cursor advances on the operator's settle events — scroll-settle,
  //   focus-leave, browser-blur, and send (this pane + scrollback.ts own
  //   those writes; selection.ts does not). It does NOT advance on mere
  //   window selection: selecting clears the sidebar badge (selection.ts's
  //   focused-window suppression) but leaves the cursor put, so this marker
  //   survives the select. The sessionTopId bound prevents NEW arrivals
  //   during the focus session from spawning a fresh marker — they're
  //   live-read by definition.
```

- [ ] **Step 3: Verify nothing broke (comment-only, but re-run + typecheck)**

```bash
scripts/bun.sh run test selection && scripts/bun.sh run check
```

Expected: tests PASS; `check` (biome + tsc) PASS with zero warnings.

- [ ] **Step 4: Commit**

```bash
git add cicchetto/src/lib/selection.ts cicchetto/src/ScrollbackPane.tsx
git commit -m "$(cat <<'EOF'
docs(cic): correct cursor/badge/marker mental model in comments

selection.ts moduledoc now records the focused-window badge suppression;
ScrollbackPane's stale "cursor only advances on navigate-away" comment is
corrected (scroll-settle + send + blur advance it too) and now explains
why the marker survives a select while the badge clears.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Full gate, integrate, deploy

- [ ] **Step 1: Full cic suite + check**

```bash
scripts/bun.sh run test
scripts/bun.sh run check
```

Expected: full vitest suite PASS; biome + tsc clean.

- [ ] **Step 2: Code review.** Per CLAUDE.md, code review is never optional. Run `/code-review` (or the `code-review` skill) on the diff; address findings; commit fixes.

- [ ] **Step 3: Integrate.** Rebase the worktree onto local `main`, then merge:

```bash
# from the worktree
git rebase main
# from /srv/grappa
git merge --ff-only feat/decouple-unread-badge
```

- [ ] **Step 4: Deploy + verify.** This is a cic (front-end) change. `scripts/deploy.sh` runs the `cicchetto-build` oneshot into the nginx-served dist. Deploy from `/srv/grappa` (main), then dogfood on a real device — Playwright webkit does not reproduce iOS scroll/focus physics (see memory `feedback_playwright_webkit_not_ios_scroll`). Manually verify:
  - Select a window with unread → badge clears immediately; the `── N unread ──` marker is still shown.
  - Scroll past some unread, then switch away → leftover unread re-badges.
  - Background the tab on a busy selected channel → badge accrues; returning clears it.

- [ ] **Step 5: Update checkpoint + close.** Update the active checkpoint/todo; if the session was significant, add a `docs/project-story.md` episode. Use the `close` skill.

---

## Self-Review

**Spec coverage:**
- "badge clears on select" → Task 1. ✓
- "cursor untouched / marker survives" → Task 1 implementation (no cursor write) + Task 4 comment; asserted indirectly by the mocked-null-cursor tests and the re-expose test. ✓
- "visibility gate" → Task 2. ✓
- "leftover re-badges on leave" → Task 3 re-expose test. ✓
- "single code path / consumers agree" → suppression lives in `perChannelUnread`, which all three public memos derive from. ✓
- "events suppressed too" → Task 3. ✓
- "other windows untouched" → Task 3. ✓
- "stale comment cleanup" → Task 4. ✓
- Out-of-scope (mentions, send, scroll, blur, server cursor) → not modified. ✓

**Placeholder scan:** none — every step has concrete code/commands.

**Type/name consistency:** `selectedChannel()` returns `SelectedChannel` (`{networkSlug, channelName, kind} | null`); `channelKey(slug, name)` returns `ChannelKey`; `isDocumentVisible()` returns `boolean`; `Computed = {messages, events}`. The suppression block uses exactly these. `appendToScrollback(key, row)` row shape matches existing tests. `messagesUnread`/`eventsUnread`/`unreadCounts` are the exported memos used throughout.
