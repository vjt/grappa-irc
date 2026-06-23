# Nick completion — keyboard-free, irssi-exact

**Date:** 2026-06-23
**Status:** design, approved by vjt
**Adjacent:** `2026-06-14-irc-keyboard-design.md` (the custom keyboard this
makes optional)

## Goal

Make nick tab-completion usable without the custom IRC keyboard, so a user on
a stock mobile keyboard (which has no Tab key) can complete + cycle nicks. Fix
the existing completion to match irssi semantics while we're in there.

## What already exists

`cicchetto/src/lib/compose.ts:738` — `tabComplete(key, input, cursor, forward)`,
members-only case-insensitive prefix match, cycles forward/back. Wired through
**three** trigger paths, all consuming `result.newCursor`:

- physical Tab — `keybindings.ts:43` → `Shell.tsx:351` `cycleNickComplete`
- custom-keyboard Tab key — `KeyboardHost.tsx:235`
- (Shell is the shared landing for both keybinding + host)

Members are bare nicks (`{nick, modes}`) — no `@`/`+` sigil to strip.

### Gaps vs. spec

1. No suffix. Spec wants `nick: ` at line start, `nick ` mid-sentence.
2. Cycle **wraps forever** (`% matches.length`, line 768). Spec wants the
   cycle to pass back through the **originally typed text** after the last
   match.
3. State (`tabCycle`) only clears on submit. Spec wants it discarded on any
   keystroke other than Tab.
4. No touch trigger — Tab key is the only way in on a stock keyboard.

## Decisions (forks resolved with vjt)

- **Scope:** double-tap-Tab only. No `@`-tooltip popup. (`@` is not an IRC
  sigil — it's the op prefix in NAMES; importing Slack/Discord muscle memory
  was rejected.)
- **Trigger:** double-tap the textarea, accepting the native-word-select
  collision. We do NOT fight the OS `preventDefault`; we let the OS select,
  then override value + caret. Untestable in Playwright (iOS gesture physics)
  — dogfood-only, per prior burn.
- **Suffix:** irssi-exact positional — `": "` only when the completed word is
  the first token on the line, `" "` otherwise.
- **Revert-on-exhaust + discard-on-keystroke:** as stated in the request.

## Design

No new modules. Extend `compose.ts`, touch `ComposeBox.tsx` and
`KeyboardHost.tsx`. `tabComplete`'s **signature is unchanged** — all three
callers keep working untouched.

### 1. `tabComplete` rewrite (compose.ts)

Today's continuation test is `wordAtCursor === tabCycle.lastChosen`. That
breaks the instant a suffix sits after the caret (the "word at cursor" becomes
empty). Replace with a **range-based** anchor.

`tabCycle` state:

```
{ key, typedWord, prefix, idx, anchorStart, anchorEnd, lastChosen, suffix }
```

**Continuation** iff all hold:
- `tabCycle.key === key`
- `cursor ∈ [anchorStart, anchorEnd]`
- `input.slice(anchorStart, anchorEnd) === lastChosen + suffix`

Any edit, or a tap on a different word, fails the check ⇒ fresh cycle. The
range membership (not exact-caret) is also what lets a **second double-tap** —
which re-selects the just-inserted nick, landing the caret somewhere inside
the range — register as a continuation rather than restarting.

**Positional suffix:**
`input.slice(0, anchorStart).trim() === "" ? ": " : " "`.

**Revert slot.** Cycle space is `[match0 … matchN-1, <typed>]`, so
`idx ∈ [0, matches.length]`:
- forward: `idx = (idx + 1) % (matches.length + 1)`
- backward (Shift+Tab): `idx = (idx - 1 + matches.length + 1) % (matches.length + 1)`
- at `idx === matches.length`: restore `typedWord` (original case, **no
  suffix**); next forward step wraps to `match0`.

**Fresh cycle:** walk back from `cursor` to whitespace/start for the word;
empty ⇒ return `null`. `idx = 0`, `typedWord = wordAtCursor` (original case),
`prefix = wordAtCursor.toLowerCase()`. Matches = members filtered by prefix,
sorted `localeCompare`. `null` if no matches.

Single-match case still gives a revert slot: `nick: ` → `<typed>` → `nick: `.

### 2. Double-tap trigger (ComposeBox.tsx)

Track tap timestamps on the textarea (`Date.now()` is fine in browser code).
Two taps within ~300ms (and within a few px) ⇒
`tabComplete(key, draft, ta.selectionEnd, true)`, then `setDraft`, then
`setSelectionRange(newCursor, newCursor)` on the next microtask (mirrors the
`Shell.tsx` caret-after-store-write pattern; collapses the OS word-selection).
`selectionEnd` is the cursor so the OS-selected word is the completion target.

### 3. State discard

Export `resetTabCycle()`. Call it from:
- `ComposeBox.onInput` (the real-keystroke path — the whole point for stock
  keyboards)
- `KeyboardHost` insertText branch (custom-keyboard printable keys)

Belt-and-suspenders with the strict range check; explicit per spec.

## Testing

- **Rewrite** the 3 existing `tabComplete` tests in `compose.test.ts` — they
  assert the old no-suffix / wrap behavior, which is now the *wrong* spec.
  (Not "asserting buggy behavior" — the behavior changed by design.)
- **Add:** positional suffix (line-start `": "` vs mid-sentence `" "`),
  revert-on-exhaust, range-continuation after a suffix is present,
  Shift+Tab backward through the revert slot, single-match revert,
  `resetTabCycle` clears continuation.
- **Double-tap gesture:** unit-test the tap-timing reducer in isolation; do
  NOT e2e the gesture (Playwright webkit ≠ iOS scroll/gesture physics).
  Dogfood on device.

## Out of scope

`@`-tooltip popup; command/`/verb` completion; channel-name completion;
fighting the OS double-tap `preventDefault`.
