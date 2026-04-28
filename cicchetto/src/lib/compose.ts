import { createEffect, createRoot, createSignal, on } from "solid-js";
import { ApiError, postJoin, postNick, postPart, postTopic } from "./api";
import { token } from "./auth";
import type { ChannelKey } from "./channelKey";
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

const exports_ = createRoot(() => {
  const [composeByChannel, setComposeByChannel] = createSignal<Record<ChannelKey, ComposeState>>(
    {},
  );

  // Tab-complete cycle state (NOT per-channel — there's one focused
  // textarea at a time). Tracks the prefix + index across consecutive
  // tab presses; reset by setDraft on a non-tab edit.
  // Cycle anchor:
  //   - prefix: the original text (lowercased) the user typed BEFORE
  //     the first tab — held constant across repeated tabs.
  //   - idx: which match we last returned, so the next tab advances.
  //   - lastChosen: what we wrote into the input last time. On the
  //     subsequent tab the input contains lastChosen at start..cursor;
  //     matching it tells us we're continuing the cycle (prefix stays
  //     "al" even though the input now reads "alex"). If the user
  //     typed something else, the slice won't match and we restart.
  let tabCycle: {
    key: ChannelKey;
    prefix: string;
    idx: number;
    lastChosen: string;
  } | null = null;

  createEffect(
    on(token, (t, prev) => {
      if (prev != null && t !== prev) {
        setComposeByChannel({});
        tabCycle = null;
      }
    }),
  );

  const getState = (key: ChannelKey): ComposeState => composeByChannel()[key] ?? empty();

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
    const state = getState(key);
    const cmd = parseSlash(state.draft);
    // Empty short-circuits before the token check — an empty submit is
    // a no-op regardless of session state, and the consumer (ComposeBox)
    // wants the same outcome whether or not a token is in play.
    if (cmd.kind === "empty") return { error: "empty" };

    const t = token();
    if (!t) return { error: "no session" };

    let result: SubmitResult;
    try {
      switch (cmd.kind) {
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
          await postJoin(t, networkSlug, cmd.channel);
          result = { ok: true };
          break;
        case "part": {
          const target = cmd.channel ?? channelName;
          await postPart(t, networkSlug, target);
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
    } catch (e) {
      // REST/PubSub failure surfaces here. Preserve the draft (no
      // history push, no draft clear) so the user can retry without
      // re-typing; the {error} arm fires the ComposeBox alert banner.
      return { error: e instanceof ApiError ? e.code : "send failed" };
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
    const wordAtCursor = input.slice(start, cursor);
    if (wordAtCursor.length === 0) return null;

    // Continuation? If the slice equals the previously-written nick, the
    // cycle anchor's prefix stays — we're advancing through matches for
    // the original prefix, not starting a fresh cycle on the full nick.
    const continuing =
      tabCycle !== null && tabCycle.key === key && wordAtCursor === tabCycle.lastChosen;
    const effectivePrefix = continuing ? (tabCycle?.prefix ?? "") : wordAtCursor.toLowerCase();

    const matches = all
      .filter((m) => m.nick.toLowerCase().startsWith(effectivePrefix))
      .map((m) => m.nick)
      .sort((a, b) => a.localeCompare(b));
    if (matches.length === 0) return null;

    let idx: number;
    if (continuing && tabCycle !== null) {
      idx = (tabCycle.idx + (forward ? 1 : -1) + matches.length) % matches.length;
    } else {
      idx = 0;
    }

    const chosen = matches[idx] ?? matches[0];
    if (chosen === undefined) return null;
    tabCycle = { key, prefix: effectivePrefix, idx, lastChosen: chosen };

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

export const composeByChannel = exports_.composeByChannel;
export const getDraft = exports_.getDraft;
export const setDraft = exports_.setDraft;
export const recallPrev = exports_.recallPrev;
export const recallNext = exports_.recallNext;
export const submit = exports_.submit;
export const tabComplete = exports_.tabComplete;
