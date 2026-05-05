import { createEffect, createRoot, createSignal, on } from "solid-js";
import { ApiError, patchNetwork, postJoin, postNick, postPart, postTopic } from "./api";
import { logout, token } from "./auth";
import type { ChannelKey } from "./channelKey";
import { membersByChannel } from "./members";
import { networks } from "./networks";
import { openQueryWindowState } from "./queryWindows";
import { sendMessage as sendPrivmsg } from "./scrollback";
import { selectedChannel, setSelectedChannel } from "./selection";
import { parseSlash } from "./slashCommands";
import {
  pushAwaySet,
  pushAwayUnset,
  pushChannelBan,
  pushChannelBanlist,
  pushChannelDeop,
  pushChannelDevoice,
  pushChannelInvite,
  pushChannelKick,
  pushChannelMode,
  pushChannelOp,
  pushChannelTopicClear,
  pushChannelUmode,
  pushChannelUnban,
  pushChannelVoice,
} from "./socket";

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

    // Active-channel context helper. Returns the channel name for the
    // current active window, or null if not in a channel window (which
    // would reject ops verbs that require a channel).
    const getActiveChannel = (): string | null => {
      const sel = selectedChannel();
      if (!sel) return null;
      const name = sel.channelName;
      // Channel windows start with '#', '&', '+', or '!' per IRC spec.
      // Query windows use a nick (no # prefix). Server/list/mentions
      // pseudo-windows use synthetic keys that don't start with '#'.
      if (!/^[#&+!]/.test(name)) return null;
      return name;
    };

    // Require a channel window; emit inline error if not in one.
    const requireChannel = (verb: string): string | { error: string } => {
      const ch = getActiveChannel();
      if (!ch) return { error: `/${verb} requires an active channel window` };
      return ch;
    };

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
        case "topic-show": {
          // Bare /topic — render cached topic inline. The cached topic
          // lives in userTopic.ts; rendering is pure UI. Return a
          // special error that ComposeBox can display inline.
          // TODO(C3): wire to TopicBar's cached topic for inline render.
          return { error: "/topic (bare) — inline render wired in C3 (TopicBar)" };
        }
        case "topic-set": {
          // /topic <text> — set topic via REST (existing postTopic path).
          await postTopic(t, networkSlug, channelName, cmd.text);
          result = { ok: true };
          break;
        }
        case "topic-clear": {
          // /topic -delete — clear topic via channel event.
          const sel = selectedChannel();
          if (!sel) return { error: "/topic -delete requires an active channel window" };
          const networkId = networks()?.find((n) => n.slug === networkSlug)?.id;
          if (networkId === undefined) return { error: "/topic -delete: network not found" };
          pushChannelTopicClear(networkId, sel.channelName);
          result = { ok: true };
          break;
        }
        case "nick":
          await postNick(t, networkSlug, cmd.nick);
          result = { ok: true };
          break;
        case "msg": {
          // /msg <target> <text> — open query window, switch focus (user
          // action per spec #1), then send the PRIVMSG immediately.
          const networkId = networks()?.find((n) => n.slug === networkSlug)?.id;
          if (networkId === undefined) return { error: "/msg: network not found" };
          openQueryWindowState(networkId, cmd.target, new Date().toISOString());
          setSelectedChannel({ networkSlug, channelName: cmd.target, kind: "query" });
          await sendPrivmsg(networkSlug, cmd.target, cmd.body);
          result = { ok: true };
          break;
        }
        case "query": {
          // /query <nick> / /q <nick> — open query window and switch focus.
          // No message sent (spec #1: /query opens window without sending).
          const networkId = networks()?.find((n) => n.slug === networkSlug)?.id;
          if (networkId === undefined) return { error: "/query: network not found" };
          openQueryWindowState(networkId, cmd.target, new Date().toISOString());
          setSelectedChannel({ networkSlug, channelName: cmd.target, kind: "query" });
          result = { ok: true };
          break;
        }
        case "quit": {
          // Nuclear: park ALL bound networks, then logout.
          // `Promise.allSettled` — partial PATCH failures do NOT block the
          // logout. The user wants OUT regardless of individual network
          // PATCH success. One failed PATCH means that network may auto-
          // respawn on next boot (Bootstrap skips :parked only), but the
          // session is still terminated from cicchetto's perspective.
          const allNets = networks() ?? [];
          const parkBody: { connection_state: "parked"; reason?: string } = {
            connection_state: "parked",
          };
          if (cmd.reason !== null) parkBody.reason = cmd.reason;
          await Promise.allSettled(allNets.map((n) => patchNetwork(t, n.slug, parkBody)));
          // logout() clears auth (setToken(null)), which triggers:
          //   1. socket.ts createEffect → WS disconnect
          //   2. RequireAuth → redirect to /login
          await logout();
          // After logout the component tree will unmount — no further
          // result processing needed. Return early to skip history push.
          return { ok: true };
        }
        case "disconnect": {
          // Surgical: park one network. `network` from parser is null
          // (bare /disconnect) or a named slug. Null → use active-window's
          // networkSlug (already in scope from submit's args).
          const targetSlug = cmd.network ?? networkSlug;
          const disconnBody: { connection_state: "parked"; reason?: string } = {
            connection_state: "parked",
          };
          if (cmd.reason !== null) disconnBody.reason = cmd.reason;
          await patchNetwork(t, targetSlug, disconnBody);
          result = { ok: true };
          break;
        }
        case "connect": {
          // Unpark + respawn. Network slug guaranteed by parser
          // (bare /connect surfaces as kind: "error" instead).
          await patchNetwork(t, cmd.network, { connection_state: "connected" });
          result = { ok: true };
          break;
        }
        case "away": {
          // S3.4 — explicit away set/unset via the user-level Phoenix Channel.
          // The channel push reaches GrappaChannel.handle_in("away", ...) which
          // routes to Session.set_explicit_away / Session.unset_explicit_away.
          // networkSlug from submit args is the active window's network.
          if (cmd.action === "set") {
            await pushAwaySet(networkSlug, cmd.reason);
          } else {
            await pushAwayUnset(networkSlug);
          }
          result = { ok: true };
          break;
        }
        // ---------------------------------------------------------------
        // Channel ops verbs — push on user-level channel to GrappaChannel.
        // All require a channel window context (except umode and mode which
        // accept their target explicitly).
        // ---------------------------------------------------------------
        case "op": {
          const chanOrErr = requireChannel("op");
          if (typeof chanOrErr !== "string") return chanOrErr;
          const networkId = networks()?.find((n) => n.slug === networkSlug)?.id;
          if (networkId === undefined) return { error: "/op: network not found" };
          pushChannelOp(networkId, chanOrErr, cmd.nicks);
          result = { ok: true };
          break;
        }
        case "deop": {
          const chanOrErr = requireChannel("deop");
          if (typeof chanOrErr !== "string") return chanOrErr;
          const networkId = networks()?.find((n) => n.slug === networkSlug)?.id;
          if (networkId === undefined) return { error: "/deop: network not found" };
          pushChannelDeop(networkId, chanOrErr, cmd.nicks);
          result = { ok: true };
          break;
        }
        case "voice": {
          const chanOrErr = requireChannel("voice");
          if (typeof chanOrErr !== "string") return chanOrErr;
          const networkId = networks()?.find((n) => n.slug === networkSlug)?.id;
          if (networkId === undefined) return { error: "/voice: network not found" };
          pushChannelVoice(networkId, chanOrErr, cmd.nicks);
          result = { ok: true };
          break;
        }
        case "devoice": {
          const chanOrErr = requireChannel("devoice");
          if (typeof chanOrErr !== "string") return chanOrErr;
          const networkId = networks()?.find((n) => n.slug === networkSlug)?.id;
          if (networkId === undefined) return { error: "/devoice: network not found" };
          pushChannelDevoice(networkId, chanOrErr, cmd.nicks);
          result = { ok: true };
          break;
        }
        case "kick": {
          const chanOrErr = requireChannel("kick");
          if (typeof chanOrErr !== "string") return chanOrErr;
          const networkId = networks()?.find((n) => n.slug === networkSlug)?.id;
          if (networkId === undefined) return { error: "/kick: network not found" };
          pushChannelKick(networkId, chanOrErr, cmd.nick, cmd.reason);
          result = { ok: true };
          break;
        }
        case "ban": {
          const chanOrErr = requireChannel("ban");
          if (typeof chanOrErr !== "string") return chanOrErr;
          const networkId = networks()?.find((n) => n.slug === networkSlug)?.id;
          if (networkId === undefined) return { error: "/ban: network not found" };
          pushChannelBan(networkId, chanOrErr, cmd.mask);
          result = { ok: true };
          break;
        }
        case "unban": {
          const chanOrErr = requireChannel("unban");
          if (typeof chanOrErr !== "string") return chanOrErr;
          const networkId = networks()?.find((n) => n.slug === networkSlug)?.id;
          if (networkId === undefined) return { error: "/unban: network not found" };
          pushChannelUnban(networkId, chanOrErr, cmd.mask);
          result = { ok: true };
          break;
        }
        case "banlist": {
          const chanOrErr = requireChannel("banlist");
          if (typeof chanOrErr !== "string") return chanOrErr;
          const networkId = networks()?.find((n) => n.slug === networkSlug)?.id;
          if (networkId === undefined) return { error: "/banlist: network not found" };
          pushChannelBanlist(networkId, chanOrErr);
          result = { ok: true };
          break;
        }
        case "invite": {
          // /invite <nick> [#chan] — channel defaults to active window.
          const chanOrErr = requireChannel("invite");
          if (typeof chanOrErr !== "string") return chanOrErr;
          const chan = cmd.channel ?? chanOrErr;
          const networkId = networks()?.find((n) => n.slug === networkSlug)?.id;
          if (networkId === undefined) return { error: "/invite: network not found" };
          pushChannelInvite(networkId, chan, cmd.nick);
          result = { ok: true };
          break;
        }
        case "umode": {
          // /umode — user-mode on own nick, no channel context required.
          const networkId = networks()?.find((n) => n.slug === networkSlug)?.id;
          if (networkId === undefined) return { error: "/umode: network not found" };
          pushChannelUmode(networkId, cmd.modes);
          result = { ok: true };
          break;
        }
        case "mode": {
          // /mode — raw verbatim, target explicit in args. No channel required.
          const networkId = networks()?.find((n) => n.slug === networkSlug)?.id;
          if (networkId === undefined) return { error: "/mode: network not found" };
          pushChannelMode(networkId, cmd.target, cmd.modes, cmd.params);
          result = { ok: true };
          break;
        }
        // ---------------------------------------------------------------
        // Info verbs — server-side handlers not yet implemented.
        // Emit inline errors as TODO stubs (future bucket wiring).
        // ---------------------------------------------------------------
        case "who":
          return { error: "/who: server-side handler not yet implemented (future bucket)" };
        case "names":
          return { error: "/names: server-side handler not yet implemented (future bucket)" };
        case "list":
          return { error: "/list: server-side handler not yet implemented (future bucket)" };
        case "links":
          return { error: "/links: server-side handler not yet implemented (future bucket)" };
        // ---------------------------------------------------------------
        // Watchlist verbs — server-side /user_settings API not yet implemented.
        // Emit inline errors as TODO stubs.
        // ---------------------------------------------------------------
        case "watchlist":
          return {
            error: "/watch /highlight: user_settings API not yet implemented (future bucket)",
          };
        // ---------------------------------------------------------------
        // Parser-level error (unknown verb or validation failure).
        // ---------------------------------------------------------------
        case "error":
          return { error: cmd.message };
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
