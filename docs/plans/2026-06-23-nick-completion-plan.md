# Nick completion (keyboard-free, irssi-exact) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make nick tab-completion work without the custom IRC keyboard (double-tap trigger), fix it to irssi-exact semantics (positional `": "`/`" "` suffix, revert-through-typed-text), and fix the latent in-app cycle bug.

**Architecture:** Rewrite the existing `tabComplete` in `cicchetto/src/lib/compose.ts` — same signature/return shape, but range-based continuation, a revert slot, a positional suffix, and an internal draft write (so the cycle survives). Callers (`Shell.tsx`, `KeyboardHost.tsx`) drop their post-call `setDraft`. Add a double-tap trigger in `ComposeBox.tsx` backed by a pure, unit-tested tap reducer.

**Tech Stack:** SolidJS + TypeScript, Vitest (jsdom). Tests/lint/build run in a bun container via `scripts/bun.sh`.

**Design:** `docs/plans/2026-06-23-nick-completion-design.md`.

**Worktree:** cic changes are code — create a worktree off local `main` first (`git checkout main` then worktree). The cicchetto submodule lives at `cicchetto/`.

---

### Task 1: Rewrite `tabComplete` — range continuation, revert slot, positional suffix, internal draft write

**Files:**
- Modify: `cicchetto/src/lib/compose.ts` (`tabCycle` decl at :120-125; `tabComplete` at :738-780)
- Test: `cicchetto/src/__tests__/compose.test.ts` (`describe("compose tabComplete …")` at :547-592)

- [ ] **Step 1: Rewrite the 3 existing tests + add the new ones**

The 3 existing tests assert the OLD spec (no suffix, wrap-forever, threading `newInput` by hand). Replace the whole `describe("compose tabComplete (members-only, P4-1 Q6)", …)` block (lines 547-592) with this. The new tests read the draft back via `getDraft` between cycles so they exercise the real (post-fix) path.

```typescript
describe("compose tabComplete (members-only, irssi-exact)", () => {
  const k = channelKey("freenode", "#a");

  const setMembers = async (nicks: string[]) => {
    const members = await import("../lib/members");
    vi.mocked(members.membersByChannel).mockReturnValue({
      [k]: nicks.map((nick) => ({ nick, modes: [] })),
    });
  };

  it("returns null when no members", async () => {
    const compose = await import("../lib/compose");
    expect(compose.tabComplete(k, "hello al", 8, true)).toBeNull();
  });

  it("returns null when the word has no prefix match", async () => {
    await setMembers(["bob"]);
    const compose = await import("../lib/compose");
    expect(compose.tabComplete(k, "al", 2, true)).toBeNull();
  });

  it("appends ': ' at line start", async () => {
    await setMembers(["alice", "alex", "bob"]);
    const compose = await import("../lib/compose");
    const r = compose.tabComplete(k, "al", 2, true);
    expect(r?.newInput).toBe("alex: "); // first alphabetically
    expect(r?.newCursor).toBe(6);
  });

  it("appends ' ' (no colon) mid-sentence", async () => {
    await setMembers(["alice", "alex"]);
    const compose = await import("../lib/compose");
    const r = compose.tabComplete(k, "hi al", 5, true);
    expect(r?.newInput).toBe("hi alex ");
    expect(r?.newCursor).toBe(8);
  });

  it("cycles forward through matches then reverts to typed text, then wraps", async () => {
    await setMembers(["alice", "alex"]);
    const compose = await import("../lib/compose");
    // First tab.
    expect(compose.tabComplete(k, "al", 2, true)?.newInput).toBe("alex: ");
    // Continue by reading the draft back (real caller path).
    let draft = compose.getDraft(k);
    expect(compose.tabComplete(k, draft, draft.length, true)?.newInput).toBe("alice: ");
    draft = compose.getDraft(k);
    // After last match → revert to the originally typed "al".
    expect(compose.tabComplete(k, draft, draft.length, true)?.newInput).toBe("al");
    draft = compose.getDraft(k);
    // Wrap back to the first match.
    expect(compose.tabComplete(k, draft, draft.length, true)?.newInput).toBe("alex: ");
  });

  it("Shift+Tab from the first match steps back into the revert slot", async () => {
    await setMembers(["alice", "alex"]);
    const compose = await import("../lib/compose");
    expect(compose.tabComplete(k, "al", 2, true)?.newInput).toBe("alex: ");
    const draft = compose.getDraft(k);
    expect(compose.tabComplete(k, draft, draft.length, false)?.newInput).toBe("al");
  });

  it("single match still offers a revert slot", async () => {
    await setMembers(["alex"]);
    const compose = await import("../lib/compose");
    expect(compose.tabComplete(k, "al", 2, true)?.newInput).toBe("alex: ");
    let draft = compose.getDraft(k);
    expect(compose.tabComplete(k, draft, draft.length, true)?.newInput).toBe("al");
    draft = compose.getDraft(k);
    expect(compose.tabComplete(k, draft, draft.length, true)?.newInput).toBe("alex: ");
  });

  it("continues the cycle when the caret lands inside the inserted nick (re-tap)", async () => {
    await setMembers(["alice", "alex"]);
    const compose = await import("../lib/compose");
    expect(compose.tabComplete(k, "al", 2, true)?.newInput).toBe("alex: ");
    const draft = compose.getDraft(k); // "alex: "
    // Caret at 2 (inside the nick), not at the end — still same cycle.
    expect(compose.tabComplete(k, draft, 2, true)?.newInput).toBe("alice: ");
  });

  it("preserves the originally typed case on revert", async () => {
    await setMembers(["alex"]);
    const compose = await import("../lib/compose");
    expect(compose.tabComplete(k, "AL", 2, true)?.newInput).toBe("alex: ");
    const draft = compose.getDraft(k);
    expect(compose.tabComplete(k, draft, draft.length, true)?.newInput).toBe("AL");
  });

  it("writes the completed draft into the store", async () => {
    await setMembers(["alex"]);
    const compose = await import("../lib/compose");
    compose.tabComplete(k, "al", 2, true);
    expect(compose.getDraft(k)).toBe("alex: ");
  });

  it("a real keystroke (setDraft) discards the cycle", async () => {
    await setMembers(["alice", "alex"]);
    const compose = await import("../lib/compose");
    compose.tabComplete(k, "al", 2, true); // draft now "alex: "
    compose.setDraft(k, "alex: x"); // user typed → cycle must reset
    // Next tab starts fresh on the word "x" — no match → null.
    expect(compose.tabComplete(k, "alex: x", 7, true)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `scripts/bun.sh run test compose`
Expected: FAIL — current `tabComplete` produces `"alex"` (no suffix), wraps instead of reverting, and `getDraft` is empty (no internal write).

- [ ] **Step 3: Widen the `tabCycle` state shape**

In `cicchetto/src/lib/compose.ts`, replace the `tabCycle` declaration (lines 120-125, including the preceding comment block at ~108-119) with:

```typescript
  // Tab-complete cycle anchor. Continuation is detected by RANGE, not by
  // word equality, so it survives the ": "/" " suffix that sits after the
  // caret and a re-tap that lands the caret anywhere inside the inserted
  // nick. `suffix` is the persistent positional suffix for the whole cycle;
  // `lastInsertion` is the exact text written last (nick+suffix, OR the
  // typed word in the revert slot) — the continuation guard compares the
  // anchored span against it.
  let tabCycle: {
    key: ChannelKey;
    typedWord: string; // original-case word the user typed; restored in revert slot
    prefix: string; // lowercased typedWord; the match filter
    idx: number; // 0..matches.length; === matches.length is the revert slot
    anchorStart: number;
    anchorEnd: number;
    lastInsertion: string;
    suffix: string; // ": " (line start) or " " (mid-sentence)
  } | null = null;
```

- [ ] **Step 4: Rewrite `tabComplete`**

Replace the whole `tabComplete` function (lines 738-780) with:

```typescript
  // Tab-complete: members-only. Cycles nick matches for the word at the
  // cursor, irssi-style. Cycle space is [match0 … matchN-1, <typed>]: after
  // the last match the next forward step restores the originally-typed text,
  // then wraps to match0. Writes the completed draft itself via writeState
  // (NOT setDraft, which nulls tabCycle and would kill the cycle) — callers
  // only place the caret. Returns the new input + caret, or null when
  // there's nothing to complete.
  const tabComplete = (
    key: ChannelKey,
    input: string,
    cursor: number,
    forward: boolean,
  ): { newInput: string; newCursor: number } | null => {
    const all = membersByChannel()[key] ?? [];
    if (all.length === 0) return null;

    const continuing =
      tabCycle !== null &&
      tabCycle.key === key &&
      cursor >= tabCycle.anchorStart &&
      cursor <= tabCycle.anchorEnd &&
      input.slice(tabCycle.anchorStart, tabCycle.anchorEnd) === tabCycle.lastInsertion;

    let anchorStart: number;
    let typedWord: string;
    let prefix: string;
    let suffix: string;
    let oldEnd: number;

    if (continuing && tabCycle !== null) {
      anchorStart = tabCycle.anchorStart;
      typedWord = tabCycle.typedWord;
      prefix = tabCycle.prefix;
      suffix = tabCycle.suffix;
      oldEnd = tabCycle.anchorEnd;
    } else {
      // Fresh cycle: find the word ending at the cursor.
      let start = cursor;
      while (start > 0 && !/\s/.test(input[start - 1] ?? "")) start -= 1;
      typedWord = input.slice(start, cursor);
      if (typedWord.length === 0) return null;
      anchorStart = start;
      prefix = typedWord.toLowerCase();
      // ": " only when the word is the first token on the line.
      suffix = input.slice(0, anchorStart).trim() === "" ? ": " : " ";
      oldEnd = cursor;
    }

    const matches = all
      .filter((m) => m.nick.toLowerCase().startsWith(prefix))
      .map((m) => m.nick)
      .sort((a, b) => a.localeCompare(b));
    if (matches.length === 0) return null;

    const span = matches.length + 1; // matches + the revert slot
    const idx =
      continuing && tabCycle !== null
        ? (((tabCycle.idx + (forward ? 1 : -1)) % span) + span) % span
        : 0;

    // idx === matches.length is the revert slot: restore the typed text.
    const insertion = idx === matches.length ? typedWord : matches[idx] + suffix;
    const newInput = input.slice(0, anchorStart) + insertion + input.slice(oldEnd);
    const anchorEnd = anchorStart + insertion.length;

    tabCycle = {
      key,
      typedWord,
      prefix,
      idx,
      anchorStart,
      anchorEnd,
      lastInsertion: insertion,
      suffix,
    };
    writeState(key, (s) => ({ ...s, draft: newInput }));
    return { newInput, newCursor: anchorEnd };
  };
```

- [ ] **Step 5: Run the tests, verify they pass**

Run: `scripts/bun.sh run test compose`
Expected: PASS (all cases in the rewritten describe block).

- [ ] **Step 6: Typecheck + lint**

Run: `scripts/bun.sh run check`
Expected: no biome or tsc errors. (Per the cic check gotcha: a red biome silently skips tsc — confirm biome is green so tsc actually ran.)

- [ ] **Step 7: Commit**

```bash
git add cicchetto/src/lib/compose.ts cicchetto/src/__tests__/compose.test.ts
git commit -m "$(cat <<'EOF'
fix(cic): irssi-exact nick completion + fix dead in-app cycle

tabComplete now: appends ": " at line start / " " mid-sentence; cycles
[match0..matchN-1, <typed>] so the last tab reverts to the typed text
before wrapping; detects continuation by anchor RANGE (survives the
suffix after the caret + a re-tap inside the nick); and writes the draft
itself via writeState.

The last point fixes a latent bug: both callers (Shell, KeyboardHost)
called setDraft after tabComplete, and setDraft nulls tabCycle — so the
second Tab always restarted and cycling never worked in-app. The old
unit tests passed only by bypassing setDraft. Callers drop setDraft in
the next commit.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Callers stop calling `setDraft` after `tabComplete`

**Files:**
- Modify: `cicchetto/src/Shell.tsx:361-368` (`cycleNickComplete`)
- Modify: `cicchetto/src/KeyboardHost.tsx:234-238` (Tab accessory branch)
- Test: `cicchetto/src/__tests__/Shell.test.tsx`, `cicchetto/src/__tests__/KeyboardHost.test.tsx` (existing mocks)

- [ ] **Step 1: Drop `setDraft` in `Shell.tsx`**

`tabComplete` now writes the draft. Remove the `setDraft` line so it doesn't null the cycle. Replace lines 361-368:

```typescript
      const result = tabComplete(key, current, ta.selectionStart, forward);
      if (!result) return;
      // tabComplete wrote the draft via writeState (calling setDraft here
      // would null the cycle). We only place the caret. Solid signal write
      // doesn't reflect immediately — schedule on the next microtask.
      queueMicrotask(() => {
        ta.setSelectionRange(result.newCursor, result.newCursor);
      });
```

Then drop the now-unused `setDraft` from the import on line 25 if nothing else in `Shell.tsx` uses it.

- [ ] **Step 2: Verify `setDraft` still imported only if used in Shell**

Run: `grep -n "setDraft" cicchetto/src/Shell.tsx`
Expected: either no hits (then remove from the `import … from "./lib/compose"` on line 25) or hits unrelated to `cycleNickComplete` (then keep the import). Fix the import to match.

- [ ] **Step 3: Drop `setDraft` in `KeyboardHost.tsx`**

Replace lines 234-238 (the `intent.id === "tab"` body):

```typescript
          const current = getDraft(key);
          const result = tabComplete(key, current, caretStart, true);
          if (!result) return;
          // tabComplete wrote the draft itself; only move the host caret.
          setCaret(result.newCursor, result.newCursor, ta);
```

`setDraft` is still used by `applyEdit` (line 200), so leave the import alone.

- [ ] **Step 4: Run the affected component tests**

Run: `scripts/bun.sh run test Shell KeyboardHost`
Expected: PASS. If a test asserted `setDraft` was called by `cycleNickComplete`, update it to assert the caret/`tabComplete` interaction instead (do NOT re-add `setDraft` to satisfy a mirror test).

- [ ] **Step 5: Typecheck + lint + full unit suite**

Run: `scripts/bun.sh run check && scripts/bun.sh run test`
Expected: no errors; all unit tests pass.

- [ ] **Step 6: Commit**

```bash
git add cicchetto/src/Shell.tsx cicchetto/src/KeyboardHost.tsx cicchetto/src/__tests__/Shell.test.tsx cicchetto/src/__tests__/KeyboardHost.test.tsx
git commit -m "$(cat <<'EOF'
fix(cic): drop setDraft after tabComplete so the cycle survives

tabComplete now writes the draft via writeState; callers calling setDraft
afterward nulled tabCycle and broke cycling. Shell + KeyboardHost now only
place the caret.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Double-tap trigger in `ComposeBox` (pure reducer + wiring)

**Files:**
- Create: `cicchetto/src/lib/doubleTap.ts`
- Create: `cicchetto/src/__tests__/doubleTap.test.ts`
- Modify: `cicchetto/src/ComposeBox.tsx` (textarea at :234-248; `onInput` at :83-87)

- [ ] **Step 1: Write the failing test for the pure reducer**

Create `cicchetto/src/__tests__/doubleTap.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { isDoubleTap } from "../lib/doubleTap";

describe("isDoubleTap", () => {
  it("is false with no previous tap", () => {
    expect(isDoubleTap(null, { t: 100, x: 10, y: 10 })).toBe(false);
  });

  it("is true for two close taps within the delay + distance", () => {
    expect(isDoubleTap({ t: 100, x: 10, y: 10 }, { t: 350, x: 14, y: 12 })).toBe(true);
  });

  it("is false when the second tap is too slow", () => {
    expect(isDoubleTap({ t: 100, x: 10, y: 10 }, { t: 500, x: 10, y: 10 })).toBe(false);
  });

  it("is false when the second tap is too far", () => {
    expect(isDoubleTap({ t: 100, x: 10, y: 10 }, { t: 200, x: 60, y: 10 })).toBe(false);
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `scripts/bun.sh run test doubleTap`
Expected: FAIL — `Cannot find module '../lib/doubleTap'`.

- [ ] **Step 3: Write the reducer**

Create `cicchetto/src/lib/doubleTap.ts`:

```typescript
// Pure double-tap detector for the compose textarea. DOM-free so it's
// unit-testable — the gesture itself is dogfood-only (Playwright webkit
// ≠ iOS gesture physics). A "tap" is {t: epoch ms, x, y: client px}.
export type Tap = { t: number; x: number; y: number };

export const DOUBLE_TAP_MS = 300;
export const DOUBLE_TAP_PX = 24;

export const isDoubleTap = (
  prev: Tap | null,
  next: Tap,
  maxDelayMs: number = DOUBLE_TAP_MS,
  maxDistPx: number = DOUBLE_TAP_PX,
): boolean =>
  prev !== null &&
  next.t - prev.t <= maxDelayMs &&
  Math.abs(next.x - prev.x) <= maxDistPx &&
  Math.abs(next.y - prev.y) <= maxDistPx;
```

- [ ] **Step 4: Run it, verify it passes**

Run: `scripts/bun.sh run test doubleTap`
Expected: PASS.

- [ ] **Step 5: Wire the gesture into `ComposeBox`**

In `cicchetto/src/ComposeBox.tsx`:

(a) Add the imports near the top (with the other `./lib/*` imports):

```typescript
import { getDraft, recallNext, recallPrev, setDraft, submit, tabComplete } from "./lib/compose";
import { type Tap, isDoubleTap } from "./lib/doubleTap";
```

(`tabComplete` is added to the existing `./lib/compose` import; `setDraft`, `getDraft`, etc. stay.)

(b) Inside the component, add a textarea ref + tap tracker (near `let pickerInput`):

```typescript
  let taRef: HTMLTextAreaElement | undefined;
  let lastTap: Tap | null = null;

  // Double-tap the textarea = press Tab (nick completion) without a Tab
  // key on a stock mobile keyboard. We let the OS do its native
  // word-select, then override value + caret — fighting the gesture's
  // preventDefault is unreliable on iOS. tabComplete writes the draft
  // itself; we only place the caret (next microtask, after the controlled
  // textarea re-renders). selectionEnd is the cursor so the OS-selected
  // word is the completion target.
  const onPointerUp = (e: PointerEvent) => {
    const ta = e.currentTarget as HTMLTextAreaElement;
    const tap: Tap = { t: Date.now(), x: e.clientX, y: e.clientY };
    if (isDoubleTap(lastTap, tap)) {
      lastTap = null;
      const result = tabComplete(key(), getDraft(key()), ta.selectionEnd, true);
      if (!result) return;
      queueMicrotask(() => {
        ta.setSelectionRange(result.newCursor, result.newCursor);
      });
      return;
    }
    lastTap = tap;
  };
```

(c) Add `ref={taRef}` and `onPointerUp={onPointerUp}` to the `<textarea>` (lines 234-248):

```tsx
        <textarea
          ref={taRef}
          value={getDraft(key())}
          onInput={onInput}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onPointerUp={onPointerUp}
          placeholder={`message ${props.channelName}`}
          rows={1}
          aria-label="compose message"
          inputmode={ircKeyboardEnabled() ? "none" : undefined}
        />
```

(`taRef` is assigned for symmetry with other panes; the handler reads the
event's `currentTarget` so it works even before any ref effect runs.)

- [ ] **Step 6: Typecheck + lint + full unit suite**

Run: `scripts/bun.sh run check && scripts/bun.sh run test`
Expected: no errors; all unit tests pass.

- [ ] **Step 7: Build (the real type gate)**

Run: `scripts/bun.sh run build`
Expected: clean `tsc --noEmit` + vite build (per the cic gotcha, this is the gate that proves types, since a red biome can mask tsc in `check`).

- [ ] **Step 8: Commit**

```bash
git add cicchetto/src/lib/doubleTap.ts cicchetto/src/__tests__/doubleTap.test.ts cicchetto/src/ComposeBox.tsx
git commit -m "$(cat <<'EOF'
feat(cic): double-tap the compose box to complete a nick

Two quick taps (<=300ms, <=24px) on the textarea fire tabComplete — the
keyboard-free path to nick completion + cycling on a stock mobile
keyboard. We override the OS word-selection rather than fight its
preventDefault. The tap reducer is pure + unit-tested; the gesture is
dogfood-only (Playwright can't repro iOS gesture physics).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Docs + dogfood checklist

**Files:**
- Modify: `docs/DESIGN_NOTES.md` (append a dated entry)

- [ ] **Step 1: Append a DESIGN_NOTES entry**

Add a `2026-06-23` entry: the completion rewrite (irssi-exact suffix, revert slot, range continuation), the latent in-app-cycle bug it fixed (setDraft nulling tabCycle), and the double-tap trigger with the OS-override decision + dogfood-only testing note. Keep it a coherent record — if it touches the earlier IRC-keyboard note, reconcile, don't bolt on a caveat.

- [ ] **Step 2: Commit**

```bash
git add docs/DESIGN_NOTES.md
git commit -m "$(cat <<'EOF'
docs(design-notes): record nick-completion rewrite + double-tap trigger

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 3: Dogfood on a real device (manual — cannot be automated)**

After merge + deploy of the cic bundle, on an iOS device with the stock
keyboard (IRC keyboard OFF), in a channel with ≥2 prefix-sharing nicks:
1. Type a prefix at line start, double-tap it → `nick: ` appears.
2. Double-tap again → cycles to the next match; again → reverts to typed.
3. Type the prefix mid-sentence, double-tap → `nick ` (no colon).
4. Type any character → next double-tap starts a fresh cycle.

---

## Self-Review

**Spec coverage:**
- irssi-exact positional suffix → Task 1 Steps 3-5 (tests: "appends ': ' at line start", "appends ' ' mid-sentence"). ✓
- revert-through-typed-text → Task 1 ("cycles forward … then reverts … then wraps", "single match still offers a revert slot"). ✓
- discard on non-Tab keystroke → satisfied by existing `setDraft` reset once the completion path stops abusing `setDraft` (Task 2); guarded by Task 1 "a real keystroke discards the cycle". ✓
- double-tap trigger → Task 3. ✓
- latent in-app cycle bug → Task 1 (internal `writeState`) + Task 2 (callers drop `setDraft`); guarded by "writes the completed draft into the store" + the read-draft-back cycle test. ✓
- `@`-tooltip, command/channel completion → explicitly out of scope (design doc). ✓

**Placeholder scan:** none — every code/test step has full content. ✓

**Type consistency:** `tabComplete(key, input, cursor, forward) → {newInput, newCursor} | null` unchanged across Tasks 1-3 and all three callers; `tabCycle` fields (`typedWord/prefix/idx/anchorStart/anchorEnd/lastInsertion/suffix`) used consistently; `Tap`/`isDoubleTap` signatures match between `doubleTap.ts` and its test + `ComposeBox`. ✓
