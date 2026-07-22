import { createSignal } from "solid-js";
import {
  ownNickForNetwork,
  patchNetwork,
  postJoin,
  postNick,
  postNotifyAdd,
  postPart,
  postTopic,
} from "./api";
import { token } from "./auth";
import { setQuery } from "./channelDirectory";
import type { ChannelKey } from "./channelKey";
import { friendlyError } from "./friendlyError";
import { addHighlight, delHighlight } from "./highlightList";
import { identityScopedStore } from "./identityScopedStore";
import { markLusersRequested } from "./lusersBundle";
import { membersByChannel } from "./members";
import { clearMentionsBundle } from "./mentionsWindow";
import { splitMessageLines } from "./messageLines";
import { openModeModal } from "./modeModal";
import { networkBySlug, networkIdBySlug, user } from "./networks";
import { nickEquals } from "./nickEquals";
import { ensureQueryTopicJoined } from "./queryTopicJoin";
import { canonicalQueryNick, openQueryWindowState } from "./queryWindows";
import { quitAll } from "./quit";
import { sendMessage as sendPrivmsg } from "./scrollback";
import { selectedChannel, setSelectedChannel } from "./selection";
import { openServiceModal } from "./serviceModal";
import { isServicesSender } from "./servicesSender";
import { requestOpenSettings } from "./settingsNav";
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
  pushInfo,
  pushLusers,
  pushMotd,
  pushNames,
  pushOper,
  pushRaw,
  pushVersion,
  pushWho,
  pushWhois,
  pushWhowas,
} from "./socket";
import { openUmodeModal } from "./umodeModal";
import { closeQueryWindow } from "./windowClose";
import { LIST_WINDOW_NAME, SERVER_WINDOW_NAME } from "./windowKinds";

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
// Identity-scoped via identityScopedStore — logout flushes ALL drafts
// + histories + the tab-cycle anchor (dup-A3 close).
//
// History semantics: most-recent-last; cursor walks BACKWARDS from the
// tail (recallPrev decrements cursor index). At index 0 (oldest)
// recallPrev clamps; at history.length (one past newest) recallNext
// returns the user to a fresh empty draft.

type ComposeState = {
  draft: string;
  history: string[];
  historyCursor: number | null; // null = bottom (live draft)
  // Live, unsent draft parked when the user walks UP into history; restored
  // verbatim when recallNext returns to the bottom. Without it the first
  // ArrowUp on a half-typed line silently ate the text (history[next]
  // overwrote draft) and recallNext handed back "" instead of the draft.
  stashedDraft: string;
};

// ok: true = silent success (draft cleared, no feedback to user).
// ok: string = success with inline feedback (e.g. watchlist list output).
// error: string = failure, displayed inline; draft preserved.
type SubmitResult = { ok: true | string } | { error: string };

const empty = (): ComposeState => ({
  draft: "",
  history: [],
  historyCursor: null,
  stashedDraft: "",
});

// Multiline fan-out: split a free-text body into one PRIVMSG per line
// (see messageLines.ts for the wire-framing why) and send each.
// `action` wraps every line in CTCP ACTION framing for /me. Sequential
// await preserves wire order; a single-line body loops exactly once, so
// the common path is unchanged from the pre-split behavior. Shared by
// the privmsg, me, and msg send sites — the only free-text paths whose
// body can contain an operator-typed newline.
export const sendBodyLines = async (
  slug: string,
  target: string,
  body: string,
  action: boolean,
): Promise<void> => {
  for (const line of splitMessageLines(body)) {
    await sendPrivmsg(slug, target, action ? `\x01ACTION ${line}\x01` : line);
  }
};

const exports_ = identityScopedStore((onIdentityChange) => {
  const [composeByChannel, setComposeByChannel] = createSignal<Record<ChannelKey, ComposeState>>(
    {},
  );

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

  onIdentityChange(() => setComposeByChannel({}));
  onIdentityChange(() => {
    tabCycle = null;
  });

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
      // Leaving the bottom: park the live draft so recallNext can restore it.
      // Mid-walk (cursor non-null) the live draft is already stashed — keep it.
      const stashedDraft = s.historyCursor === null ? s.draft : s.stashedDraft;
      const cur = s.historyCursor ?? s.history.length;
      const next = Math.max(0, cur - 1);
      const draft = s.history[next] ?? s.draft;
      return { ...s, draft, historyCursor: next, stashedDraft };
    });
  };

  const recallNext = (key: ChannelKey): void => {
    writeState(key, (s) => {
      if (s.historyCursor === null) return s;
      const next = s.historyCursor + 1;
      if (next >= s.history.length) {
        // Back at the bottom — restore the parked live draft, not "".
        return { ...s, draft: s.stashedDraft, historyCursor: null };
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

    // CP13 S9 — server-window only accepts slash-commands. The window
    // has no IRC target a PRIVMSG could go to. Plain text gets a friendly
    // error instead of silently failing or vanishing.
    if (channelName === SERVER_WINDOW_NAME && cmd.kind === "privmsg") {
      return { error: "Server window accepts only slash-commands. Try /raw <line>" };
    }

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

    // #122 + #132 + #137 — bare /whois (and /w alias) context-default
    // resolver, the nick twin of requireChannel. The rule collapses to:
    //   * query window → the query partner's nick (#122).
    //   * every OTHER network-scoped window (channel, server, …) → SELF:
    //     the operator's own current nick on this network, via
    //     ownNickForNetwork(net, me) — the canonical resolver (visitor →
    //     me.nick; user → per-credential net.nick), NOT re-implemented
    //     here. #132 introduced the self path for channels; #137 widened
    //     it to every network-scoped window (a server window has a
    //     perfectly good self target — erroring there was a dead-end).
    // The network-less home/admin windows resolve no network here, so the
    // `!own` guard errors — acceptable: they have no nick to self-whois
    // (and in practice no ComposeBox to reach this path: only channel /
    // query / server windows mount one — `kindHasScrollback`).
    const resolveBareWhoisNick = (verb: string): string | { error: string } => {
      const sel = selectedChannel();
      if (sel?.kind === "query") return sel.channelName;
      const net = networkBySlug(networkSlug);
      const own = net ? ownNickForNetwork(net, user()) : null;
      // `!own` (not `=== null`): an empty string is a server-contract
      // violation we still must not forward as a malformed bare WHOIS.
      if (!own) {
        return { error: `/${verb}: own nick for this network is unknown` };
      }
      return own;
    };

    let result: SubmitResult;
    try {
      switch (cmd.kind) {
        case "privmsg":
          // One PRIVMSG per line — an embedded newline can't ride a
          // single IRC frame (server rejects as :invalid_line).
          await sendBodyLines(networkSlug, channelName, cmd.body, false);
          result = { ok: true };
          break;
        case "me":
          // CTCP ACTION framing per line: \x01ACTION <text>\x01.
          await sendBodyLines(networkSlug, channelName, cmd.body, true);
          result = { ok: true };
          break;
        case "join":
          await postJoin(t, networkSlug, cmd.channel, cmd.key);
          // CP17: server-driven `:pending` window-state origination.
          // Server's `record_in_flight_join/2` writes
          // `window_states[ch] = :pending` and broadcasts
          // `kind: "window_pending"` on `Topic.user/1` — userTopic.ts
          // dispatches into setPending(...). Pre-CP17 cic mutated
          // setPending here optimistically (the only cic-originated
          // state mutation in the codebase) — closed the CLAUDE.md
          // "cic NEVER originates state" hard-invariant violation.
          //
          // Auto-focus the new channel client-side, mirroring the
          // /msg + /query handlers below. The user just typed /join
          // — focus follows intent. Doing this here (instead of
          // relying on subscribe.ts BUG4 self-JOIN handler) closes
          // a race: the JOIN message is broadcast on the per-channel
          // WS topic IMMEDIATELY after channels_changed fires, but
          // cic's subscribe.ts only joins that topic AFTER the REST
          // refetch from channels_changed completes. Phoenix PubSub
          // doesn't replay to late subscribers, so the BUG4 handler's
          // setSelectedChannel never fired in practice. With user-
          // intent-driven focus here, the autojoin / sajoin / NickServ-
          // driven JOIN paths still go through the subscribe.ts handler
          // (no race for those — channel was already joined when JOIN
          // event arrives via WS).
          setSelectedChannel({ networkSlug, channelName: cmd.channel, kind: "channel" });
          result = { ok: true };
          break;
        case "part": {
          const target = cmd.channel ?? channelName;
          await postPart(t, networkSlug, target);
          result = { ok: true };
          break;
        }
        case "topic-show": {
          // Bare /topic or /topic #chan — render cached topic inline.
          // The cached topic lives in channelTopic.ts; rendering is pure UI.
          // TODO(C3): wire to TopicBar's cached topic for inline render.
          const ch = cmd.channel ?? getActiveChannel();
          if (!ch)
            return { error: "/topic requires a channel — switch to one or use /topic #chan" };
          return { error: `/topic ${ch} (bare) — inline render wired in C3 (TopicBar)` };
        }
        case "topic-set": {
          // /topic <text> or /topic #chan <text> — set topic via REST.
          // Explicit channel wins; otherwise current channel; otherwise bail.
          const ch = cmd.channel ?? getActiveChannel();
          if (!ch)
            return {
              error: "/topic requires a channel — switch to one or use /topic #chan <text>",
            };
          await postTopic(t, networkSlug, ch, cmd.text);
          result = { ok: true };
          break;
        }
        case "topic-clear": {
          // /topic -delete or /topic #chan -delete — clear topic via channel event.
          const ch = cmd.channel ?? getActiveChannel();
          if (!ch)
            return {
              error:
                "/topic -delete requires a channel — switch to one or use /topic #chan -delete",
            };
          const networkId = networkIdBySlug(networkSlug);
          if (networkId === undefined) return { error: "/topic -delete: network not found" };
          // S21: AWAIT the verb ack (#154 no-silent-drops). A WS-down / server
          // {:error,_} now rejects into the shared catch → friendlyChannelError
          // inline alert, instead of painting a green ✓ on a dropped frame.
          await pushChannelTopicClear(networkId, ch);
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
          //
          // canonicalQueryNick: resolve user-input casing to the existing
          // window's stored casing (RFC 2812 §2.2 — IRC nicks are case-
          // insensitive). `/msg GRAPPA hi` when a `grappa` window already
          // exists MUST focus the existing row and route the send through
          // its ChannelKey — using cmd.target as-is would create a dead
          // "slug GRAPPA" key that no sidebar / scrollback store knows.
          //
          // UX-4 bucket G: *serv targets (NickServ IDENTIFY etc.) skip
          // the open-query + focus-switch — services responses route to
          // the `$server` window server-side (Identifier.services_sender?
          // closed allowlist + EventRouter persist-to-$server), so a
          // services query window would just sit empty. The wire frame
          // still ships (operator's IDENTIFY reaches NickServ); only
          // the optimistic UI-state mutations are skipped.
          const networkId = networkIdBySlug(networkSlug);
          if (networkId === undefined) return { error: "/msg: network not found" };
          if (isServicesSender(cmd.target)) {
            await sendBodyLines(networkSlug, cmd.target, cmd.body, false);
            result = { ok: true };
            break;
          }
          const canonical = canonicalQueryNick(networkId, cmd.target);
          openQueryWindowState(networkId, canonical, new Date().toISOString());
          setSelectedChannel({ networkSlug, channelName: canonical, kind: "query" });
          // #254 — subscribe-before-send: make the (slug,target) query topic's
          // WS subscription READY (await the join ACK) BEFORE the first PRIVMSG
          // POST, so the server's own-echo broadcast has a live listener and
          // renders live. Pre-fix the join raced the POST (it's gated on the
          // open_query_window → query_windows_list round-trip) and the echo
          // fastlaned to nobody — the row then only reappeared on reload. The
          // echo stays the sole render path (no optimistic local render — cf.
          // the #251 source_address abolition).
          await ensureQueryTopicJoined(networkSlug, canonical);
          await sendBodyLines(networkSlug, canonical, cmd.body, false);
          result = { ok: true };
          break;
        }
        case "service-modal": {
          // #290 — a BARE services command (`/ns`, `/cs`, `/ms`, …) opens
          // the dedicated services console modal and fires `help`, so the
          // service's multi-NOTICE help wall lands confined in the modal
          // (ServiceModal mirrors the $server service notices) instead of
          // flooding the server window. `openServiceModal` FIRST captures the
          // $server high-water mark, THEN `help` is sent, so the reply
          // notices count as while-open arrivals (spec: capture only while
          // open). A full command WITH args stays the `msg` arm above (inline
          // execute, reply inline) — no unsolicited popup for power users.
          openServiceModal(networkSlug, cmd.service);
          await sendBodyLines(networkSlug, cmd.service, "help", false);
          result = { ok: true };
          break;
        }
        case "query": {
          // /query <nick> / /q <nick> — open query window and switch focus.
          // No message sent (spec #1: /query opens window without sending).
          // /query (bare) / /q (bare) on a query-kind window → CLOSES it
          // (irssi convention; this bundle, issue follow-up to #12). Bare
          // /query on any other window kind → error (parser still emits
          // {target: null} for both — semantics resolved here).
          //
          // canonicalQueryNick: see /msg case above.
          //
          // UX-4 bucket G: *serv targets reject — opening a query window
          // for NickServ would be a dead window (services route to $server
          // server-side). Surface as a user-facing error so the operator
          // can re-issue `/msg <Xserv> ...` if they wanted to send.
          //
          // Cross-network safety (bare-close path): resolve the network
          // ID from the SELECTED window's own networkSlug, not from
          // compose's `networkSlug` arg — the two can diverge if the
          // submit was queued before a window switch. Using compose's
          // networkSlug with sel.channelName would no-op or close a
          // wrong-network row when they disagree.
          if (cmd.target === null) {
            const sel = selectedChannel();
            if (sel?.kind === "query") {
              const selNetId = networkIdBySlug(sel.networkSlug);
              if (selNetId === undefined)
                return { error: "/query: selected window's network not found" };
              closeQueryWindow(selNetId, sel.channelName);
              result = { ok: true };
              break;
            }
            return {
              error: "/query <nick> required (bare /query closes the current query window only)",
            };
          }
          const networkId = networkIdBySlug(networkSlug);
          if (networkId === undefined) return { error: "/query: network not found" };
          if (isServicesSender(cmd.target)) {
            return {
              error: `/query: ${cmd.target} is a services nick; responses land in the server window — use /msg ${cmd.target} <command>`,
            };
          }
          const canonical = canonicalQueryNick(networkId, cmd.target);
          openQueryWindowState(networkId, canonical, new Date().toISOString());
          setSelectedChannel({ networkSlug, channelName: canonical, kind: "query" });
          result = { ok: true };
          break;
        }
        case "quit": {
          // Nuclear: park ALL bound networks, then logout. The
          // implementation lives in `lib/quit.ts` so the sidebar
          // server-window × (UX-4 bucket D) can call the same path for
          // visitors without re-parsing through here.
          await quitAll(cmd.reason);
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
            // #268 — clear this network's stale mentions bundle HERE, on the
            // user's own GOING-away action, NOT on the `away_confirmed:"away"`
            // echo. The clear MUST be causally ordered with the away lifecycle:
            // the return-from-away `mentions_bundle` is broadcast SYNCHRONOUSLY
            // by grappa on the un-away command, but `away_confirmed` is emitted
            // only on the upstream 305/306 numeric echo (event_router.ex) — a
            // different-latency channel. Under bahamut fake-lag a going-away's
            // delayed 306 could arrive AFTER a subsequent return's bundle and
            // clobber it (the "0 messages in 0 channels" bug). Triggering the
            // clear on the compose action makes it ordered with the user's own
            // commands, so a fresh bundle set on RETURN can never be wiped by a
            // stale echo. The mentions bundle is a client-ephemeral render store
            // (not server-mirrored window/away state), so clearing it on a user
            // action does not violate the "cic never originates state" invariant.
            // Tradeoff: auto-away / cross-device going-away (no compose) no
            // longer clear, so a stale bundle can linger IF the next return
            // carries zero new mentions (the server suppresses the empty
            // broadcast) — a timestamped, secondary-button digest, strictly
            // less harmful than the fresh-bundle-wipe it replaces. A robust
            // auto-away clear would need a server sync-broadcast (out of the
            // "lato client" scope). See docs/DESIGN_NOTES.md 2026-07-16.
            clearMentionsBundle(networkSlug);
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
        // #154(1) — state-changing ops verbs (op/deop/voice/devoice/kick/
        // ban/unban/mode/umode) now `await` their push. Pre-fix these were
        // fire-and-forget: a server `{:error,_}` (invalid_*, no_session,
        // upstream_unavailable, body_too_large) or a WS-down was swallowed
        // and the arm painted a synchronous green ✓ on a dropped frame.
        // AWAIT propagates a rejection to the shared catch below, which maps
        // the `ChannelPushError` to friendly copy via `friendlyChannelError`
        // and surfaces it inline in the compose box — the same contract as
        // `case "oper"` / `case "quote"`.
        case "op": {
          const chanOrErr = requireChannel("op");
          if (typeof chanOrErr !== "string") return chanOrErr;
          const networkId = networkIdBySlug(networkSlug);
          if (networkId === undefined) return { error: "/op: network not found" };
          await pushChannelOp(networkId, chanOrErr, cmd.nicks);
          result = { ok: true };
          break;
        }
        case "deop": {
          const chanOrErr = requireChannel("deop");
          if (typeof chanOrErr !== "string") return chanOrErr;
          const networkId = networkIdBySlug(networkSlug);
          if (networkId === undefined) return { error: "/deop: network not found" };
          await pushChannelDeop(networkId, chanOrErr, cmd.nicks);
          result = { ok: true };
          break;
        }
        case "voice": {
          const chanOrErr = requireChannel("voice");
          if (typeof chanOrErr !== "string") return chanOrErr;
          const networkId = networkIdBySlug(networkSlug);
          if (networkId === undefined) return { error: "/voice: network not found" };
          await pushChannelVoice(networkId, chanOrErr, cmd.nicks);
          result = { ok: true };
          break;
        }
        case "devoice": {
          const chanOrErr = requireChannel("devoice");
          if (typeof chanOrErr !== "string") return chanOrErr;
          const networkId = networkIdBySlug(networkSlug);
          if (networkId === undefined) return { error: "/devoice: network not found" };
          await pushChannelDevoice(networkId, chanOrErr, cmd.nicks);
          result = { ok: true };
          break;
        }
        case "kick": {
          const chanOrErr = requireChannel("kick");
          if (typeof chanOrErr !== "string") return chanOrErr;
          const networkId = networkIdBySlug(networkSlug);
          if (networkId === undefined) return { error: "/kick: network not found" };
          await pushChannelKick(networkId, chanOrErr, cmd.nick, cmd.reason);
          result = { ok: true };
          break;
        }
        case "ban": {
          const chanOrErr = requireChannel("ban");
          if (typeof chanOrErr !== "string") return chanOrErr;
          const networkId = networkIdBySlug(networkSlug);
          if (networkId === undefined) return { error: "/ban: network not found" };
          await pushChannelBan(networkId, chanOrErr, cmd.mask);
          result = { ok: true };
          break;
        }
        case "unban": {
          const chanOrErr = requireChannel("unban");
          if (typeof chanOrErr !== "string") return chanOrErr;
          const networkId = networkIdBySlug(networkSlug);
          if (networkId === undefined) return { error: "/unban: network not found" };
          await pushChannelUnban(networkId, chanOrErr, cmd.mask);
          result = { ok: true };
          break;
        }
        case "banlist": {
          const chanOrErr = requireChannel("banlist");
          if (typeof chanOrErr !== "string") return chanOrErr;
          const networkId = networkIdBySlug(networkSlug);
          if (networkId === undefined) return { error: "/banlist: network not found" };
          pushChannelBanlist(networkId, chanOrErr);
          result = { ok: true };
          break;
        }
        case "invite": {
          // /invite <nick> [#chan] — channel defaults to active window.
          // P-0f follow-up (no-silent-drops bucket 0): when the channel
          // arg is supplied explicitly, SKIP requireChannel — typing
          // `/invite foo #it-opers` from $server (or any non-channel
          // window) was the common workflow that pre-fix silently
          // errored ("requires an active channel window") because
          // requireChannel was unconditionally evaluated.
          let chan: string;
          if (cmd.channel !== null) {
            chan = cmd.channel;
          } else {
            const chanOrErr = requireChannel("invite");
            if (typeof chanOrErr !== "string") return chanOrErr;
            chan = chanOrErr;
          }
          const networkId = networkIdBySlug(networkSlug);
          if (networkId === undefined) return { error: "/invite: network not found" };
          // S6 (#364): await the verb-ack so a server {:error,_} / WS-down
          // surfaces inline (shared catch → friendlyChannelError), not a
          // false green ✓. Mirror of kick/ban.
          await pushChannelInvite(networkId, chan, cmd.nick);
          result = { ok: true };
          break;
        }
        case "umode": {
          // /umode — user-mode on own nick, no channel context required.
          const networkId = networkIdBySlug(networkSlug);
          if (networkId === undefined) return { error: "/umode: network not found" };
          await pushChannelUmode(networkId, cmd.modes);
          result = { ok: true };
          break;
        }
        case "umode-view": {
          // #229 — bare /umode: open the umode viewer/editor modal for the
          // active window's network. Umodes are per-session (no channel
          // context needed), so any window kind can open it.
          openUmodeModal(networkSlug);
          result = { ok: true };
          break;
        }
        case "umode-target-view": {
          // #229 — /mode <nick> with no mode args. Open the umode modal
          // ONLY when the target resolves to the operator's OWN nick (the
          // modal edits your own umodes; there's no viewer for another
          // user's). Resolve via ownNickForNetwork (visitor → me.nick;
          // user → per-credential net.nick) — the same canonical resolver
          // /whois self-default uses; nickEquals for rfc1459-insensitive
          // compare (#121). A non-self target is a friendly error rather
          // than a phantom modal.
          const net = networkBySlug(networkSlug);
          const own = net ? ownNickForNetwork(net, user()) : null;
          if (own && nickEquals(cmd.target, own)) {
            openUmodeModal(networkSlug);
            result = { ok: true };
            break;
          }
          return {
            error: `/mode ${cmd.target}: viewing another user's modes isn't supported — use /mode <#channel> for a channel, or /mode ${own ?? "<yournick>"} for your own user modes`,
          };
        }
        case "mode": {
          // /mode <#chan> <modes> [params] — execute directly, raw
          // verbatim, target explicit in args. No modal, no channel-window
          // requirement (#216: mode-args present → apply).
          const networkId = networkIdBySlug(networkSlug);
          if (networkId === undefined) return { error: "/mode: network not found" };
          await pushChannelMode(networkId, cmd.target, cmd.modes, cmd.params);
          result = { ok: true };
          break;
        }
        case "mode-view": {
          // #216 — no mode-args: open the viewer/editor modal. Explicit
          // `/mode #chan` targets that channel; bare `/mode` targets the
          // current channel window (error if not in one — the same
          // resolver every channel-scoped verb uses).
          const ch = cmd.channel ?? getActiveChannel();
          if (!ch) return { error: "/mode requires a channel — switch to one or use /mode #chan" };
          openModeModal(networkSlug, ch);
          result = { ok: true };
          break;
        }
        case "mode-apply-current": {
          // #216 — `/mode +s` (mode string, no channel token) applies to
          // the current channel. Mode-args present → execute directly, no
          // modal; requires a channel window.
          const chanOrErr = requireChannel("mode");
          if (typeof chanOrErr !== "string") return chanOrErr;
          const networkId = networkIdBySlug(networkSlug);
          if (networkId === undefined) return { error: "/mode: network not found" };
          await pushChannelMode(networkId, chanOrErr, cmd.modes, cmd.params);
          result = { ok: true };
          break;
        }
        // ---------------------------------------------------------------
        // Info verbs — server-side handlers not yet implemented.
        // Emit inline errors as TODO stubs (future bucket wiring).
        // ---------------------------------------------------------------
        // ---------------------------------------------------------------
        // #169 — /who <#chan|nick>. Push on the user-level channel; the
        // server primes who_pending and emits WHO upstream. The 352 burst
        // folds server-side (each also upserting userhost_cache) and 315
        // RPL_ENDOFWHO drains into ONE ephemeral `who_reply` event on the
        // user topic; WhoModal renders the parsed per-user table. NOTHING
        // lands in scrollback (mirrors /names).
        //
        // /who without target → default to the current channel (#122);
        // reject inline only when the active window is not a channel
        // (server requires a channel target — RFC 2812 §3.6.1 allows mask
        // form, out of MVP scope).
        // ---------------------------------------------------------------
        case "who": {
          // #122 — bare /who defaults to the current channel (shares the
          // requireChannel resolver with /names); errors only outside one.
          const target = cmd.target ?? requireChannel("who");
          if (typeof target !== "string") return target;
          const networkId = networkIdBySlug(networkSlug);
          if (networkId === undefined) return { error: "/who: network not found" };
          await pushWho(networkId, target); // S6 (#364): await verb-ack
          result = { ok: true };
          break;
        }
        case "names": {
          // #140 — /names [#channel]. Server buffers the 353/366 burst and
          // emits ONE ephemeral `names_reply` on the user topic; NamesModal
          // renders the grouped, scrollable, dismissable roster. The modal
          // is network-scoped (last-write-wins), so the originating window
          // is irrelevant — no origin passed.
          // #122 — bare /names (and /n alias) defaults to the current
          // channel (shares the requireChannel resolver with /who).
          const target = cmd.target ?? requireChannel("names");
          if (typeof target !== "string") return target;
          const networkId = networkIdBySlug(networkSlug);
          if (networkId === undefined) return { error: "/names: network not found" };
          await pushNames(networkId, target); // S6 (#364): await verb-ack
          result = { ok: true };
          break;
        }
        case "list": {
          // Channel directory browser (#84). Open the per-network $list
          // pseudo-window (DirectoryPane); the pane loads the snapshot on
          // mount (server auto-refreshes on empty). A pattern pre-seeds the
          // directory search (setQuery re-GETs filtered). No raw LIST is
          // sent here — the directory's own refresh path owns that.
          setSelectedChannel({ networkSlug, channelName: LIST_WINDOW_NAME, kind: "list" });
          if (cmd.pattern !== null && cmd.pattern !== "") {
            void setQuery(networkSlug, cmd.pattern);
          }
          result = { ok: true };
          break;
        }
        case "links":
          return { error: "/links: server-side handler not yet implemented (future bucket)" };
        // P-0d — /lusers. Bare verb, no args. Pushes on user-level channel;
        // server emits the 7-numeric LUSERS bundle. cic dispatches the
        // typed `:lusers_bundle` wire event in userTopic.ts and renders
        // the LusersCard pinned at the top of the current window (#231).
        case "lusers": {
          const networkId = networkIdBySlug(networkSlug);
          if (networkId === undefined) return { error: "/lusers: network not found" };
          // #248 — mark the request solicited BEFORE pushing so the
          // incoming bundle surfaces the card. The store's gate drops
          // any unsolicited bundle (the Bahamut connect-welcome
          // auto-emit), so an operator /lusers that skipped this mark
          // would show nothing.
          markLusersRequested(networkSlug);
          await pushLusers(networkId); // S6 (#364): await verb-ack
          result = { ok: true };
          break;
        }
        // #127 — /info, /version, /motd. No-arg server-text queries; server
        // primes the matching accumulator + emits the command, the reply
        // burst drains a typed `server_reply` event that userTopic.ts routes
        // into the serverReplyModal store (ServerReplyModal renders it).
        case "info": {
          const networkId = networkIdBySlug(networkSlug);
          if (networkId === undefined) return { error: "/info: network not found" };
          await pushInfo(networkId); // S6 (#364): await verb-ack
          result = { ok: true };
          break;
        }
        case "version": {
          const networkId = networkIdBySlug(networkSlug);
          if (networkId === undefined) return { error: "/version: network not found" };
          await pushVersion(networkId); // S6 (#364): await verb-ack
          result = { ok: true };
          break;
        }
        case "motd": {
          const networkId = networkIdBySlug(networkSlug);
          if (networkId === undefined) return { error: "/motd: network not found" };
          await pushMotd(networkId); // S6 (#364): await verb-ack
          result = { ok: true };
          break;
        }
        // #155 — /stats [query] [server] + /rehash. Native parser sugar over
        // the #153-de-gated raw transport (mirrors /quote): build the raw
        // STATS/REHASH frame and ship it via pushRaw. Server routing: the
        // STATS reply family (211-219, 240-250) is server-directed — grappa's
        // numeric_router pins the whole family to the `$server` window as
        // :notice rows via its @active_numerics deny list (#184). Before that
        // fix the terminating 219 RPL_ENDOFSTATS's stats-letter param was
        // mis-read by the scan fallback as a query target, forking a bogus
        // window named after the letter; #155's original "no server change"
        // premise was wrong. REHASH/permission numerics (e.g. 481) land on
        // `$server` too. AWAIT the push so a WS-disconnected / server
        // {:error,_} surfaces as an inline compose error instead of a silent
        // green ✓ (the #154 no-silent-drop lesson).
        case "stats": {
          const networkId = networkIdBySlug(networkSlug);
          if (networkId === undefined) return { error: "/stats: network not found" };
          // STATS [query] [server] — omit trailing nulls. IRC STATS is a
          // 2-arg frame; the parser guarantees target is only set when query
          // is, so filtering nulls preserves positional order.
          const line = ["STATS", cmd.query, cmd.target]
            .filter((t): t is string => t !== null)
            .join(" ");
          await pushRaw(networkId, line);
          result = { ok: true };
          break;
        }
        case "rehash": {
          const networkId = networkIdBySlug(networkSlug);
          if (networkId === undefined) return { error: "/rehash: network not found" };
          await pushRaw(networkId, "REHASH");
          result = { ok: true };
          break;
        }
        // ---------------------------------------------------------------
        // C2 — /whois <nick>. Push on the user-level channel; the server
        // primes its accumulator and emits WHOIS upstream. The bundle
        // arrives later as `whois_bundle` on the user topic
        // (handled by userTopic.ts → setWhoisBundle). WHOIS with an
        // explicit nick works from any window kind; the bundle render
        // targets the active window at arrival time. (Bare /whois resolves
        // a context default — query partner, or self on any network-scoped
        // window; see resolveBareWhoisNick below.)
        // ---------------------------------------------------------------
        case "whois": {
          // #122 + #132 + #137 — bare /whois (and /w alias) context-default:
          // query window → partner; every other network-scoped window → self.
          const nick = cmd.nick ?? resolveBareWhoisNick("whois");
          if (typeof nick !== "string") return nick;
          const networkId = networkIdBySlug(networkSlug);
          if (networkId === undefined) return { error: "/whois: network not found" };
          // #198 — cmd.server is set only for the two-arg `/whois <server>
          // <nick>` form; null for single-arg + bare. The bouncer emits
          // `WHOIS <server> <nick>` upstream when present, plain `WHOIS
          // <nick>` otherwise.
          // S6 (#364): await so a validation reject (e.g. invalid_nick, which
          // fires BEFORE the upstream write → no bundle, no numeric) surfaces
          // inline instead of leaving the operator with nothing.
          await pushWhois(networkId, nick, cmd.server);
          result = { ok: true };
          break;
        }
        // P-0c — /whowas <nick>. Push on the user-level channel; the
        // server primes whowas_pending and emits WHOWAS upstream. The
        // bundle arrives later as `whowas_bundle` on the user topic
        // (handled by userTopic.ts → setWhowasBundle), or as a
        // not_found bundle on 406 ERR_WASNOSUCHNICK.
        case "whowas": {
          const networkId = networkIdBySlug(networkSlug);
          if (networkId === undefined) return { error: "/whowas: network not found" };
          await pushWhowas(networkId, cmd.nick); // S6 (#364): await verb-ack
          result = { ok: true };
          break;
        }
        // ---------------------------------------------------------------
        // #356 — keyword highlight (/hilight add, /dehilight del; /highlight
        // alias). Routed through the highlightList store so the command AND
        // the watch-lists settings section share ONE authoritative list
        // (the server round-trip returns {patterns}, mirrored into the
        // store). The full post-mutation list renders inline as a green
        // auto-dismissing notice (ComposeBox #356) — the response IS the
        // list, so this is race-free.
        // ---------------------------------------------------------------
        case "watchlist": {
          const patterns =
            cmd.action === "add"
              ? await addHighlight(cmd.pattern)
              : await delHighlight(cmd.pattern);
          result = {
            ok: `highlight (${patterns.length}): ${patterns.join(", ") || "(empty)"}`,
          };
          break;
        }
        // #247/#356 — /notify + /watch presence watch (irssi-direct add).
        // POST to the per-network REST surface; the server broadcasts the
        // updated notify_list + live-syncs the session's MONITOR/WATCH. The
        // green confirmation names the nicks from the COMMAND input, not the
        // store — the notify_list broadcast that would let us re-render the
        // full list may not have landed by the time the POST resolves, so
        // reading watchByNetwork() here would race. Removal is the settings
        // × (bare /notify opens it). Per-network: the active window's network.
        case "notify": {
          if (networkIdBySlug(networkSlug) === undefined)
            return { error: "/notify: network not found" };
          await postNotifyAdd(t, networkSlug, cmd.nicks);
          result = { ok: `notify: watching ${cmd.nicks.join(", ")}` };
          break;
        }
        // #356 — a bare watch-family verb (/notify, /watch, /hilight,
        // /highlight, /dehilight) opens the unified watch-lists settings
        // section rather than printing inline. Opening the drawer IS the
        // feedback, so this is a silent success.
        case "open-settings": {
          requestOpenSettings(cmd.section);
          result = { ok: true };
          break;
        }
        // Bundle C (#20 follow-up) — /quote <raw IRC line>. Push to
        // GrappaChannel.handle_in("raw", _); server validates CRLF/NUL
        // then ships verbatim to the upstream socket. AWAIT the push
        // so disconnected/error replies surface as inline compose-box
        // alerts (no silent green ✓ on a dropped escape-hatch frame).
        case "quote": {
          const networkId = networkIdBySlug(networkSlug);
          if (networkId === undefined) return { error: "/quote: network not found" };
          await pushRaw(networkId, cmd.line);
          result = { ok: true };
          break;
        }
        // Bundle C (#20 follow-up) — /oper <name> <password>. The password
        // travels over the WS frame; bouncer redacts it from logs by
        // emitting a static log body before sending OPER upstream.
        // Result lands as a 381 RPL_YOUREOPER (success) / 491 (bad host)
        // / 464 (bad pw) numeric — the existing numeric-routing path
        // persists those as :notice rows. AWAIT the push: a credential-
        // bearing verb MUST NOT silently no-op when the WS is down or
        // the server-side validator rejects (CLAUDE.md
        // `feedback_no_silent_drops_closed`).
        case "oper": {
          const networkId = networkIdBySlug(networkSlug);
          if (networkId === undefined) return { error: "/oper: network not found" };
          await pushOper(networkId, cmd.name, cmd.password);
          result = { ok: true };
          break;
        }
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
      //
      // U-3 (UD3): typed ApiErrors get the shared `friendlyApiError`
      // copy treatment so /connect failures (network_busy,
      // too_many_sessions, network_unreachable, ...) render the same
      // human copy as the Login banner does, instead of leaking the
      // raw snake_case wire token into operator-visible alerts.
      // `feedback_no_localized_strings_server_side`.
      //
      // Issue #62: channel-push rejections (ChannelPushError — `/away`
      // set/unset) get the sibling `friendlyChannelError` treatment.
      // Pre-fix every channel-push error collapsed into the generic
      // "send failed" string, swallowing the real reason (the live
      // incident: a visitor's `/away` showed "Send failed" with no clue).
      return { error: friendlyError(e) };
    }

    // Success: push the original draft (NOT the parsed cmd) onto history,
    // clear the draft, reset cursor.
    if (state.draft.trim() !== "") pushHistory(key, state.draft);
    writeState(key, (s) => ({ ...s, draft: "", historyCursor: null }));
    tabCycle = null;
    // #356: a string `result.ok` (the /notify + /hilight confirmation /
    // list output) IS now surfaced — ComposeBox routes it through the
    // severity-tagged feedback signal as a green, auto-dismissing
    // `.compose-box-notice` (role=status). `result.ok: true` is a silent
    // success. (Pre-#356 this string was computed then discarded: CP13
    // removed the numericInline row that used to render it and never
    // rewired a consumer — the gap #356 closed.)
    return result;
  };

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
