import { ownNickForNetwork, postJoin, postPart } from "../api";
import { casemappingForSlug } from "../casemapping";
import { setQuery } from "../channelDirectory";
import { canonicalChannel } from "../channelKey";
import { isChannelName } from "../chantypes";
import { openEncryptedWindow } from "../encryptedWindow";
import { networkBySlug, networkIdBySlug, user } from "../networks";
import { nickEquals } from "../nickEquals";
import { canonicalQueryNick, openQueryWindowState } from "../queryWindows";
import { selectedChannel, setSelectedChannel } from "../selection";
import { isServicesSender } from "../servicesSender";
import { closeQueryWindow } from "../windowClose";
import { LIST_WINDOW_NAME } from "../windowKinds";
import type { CommandHandler } from "./context";

/**
 * The verbs that decide WHICH window the operator is in: channel membership,
 * and the two that open a pseudo-window.
 *
 * #1396 — a note on `ctx.submittedFrom`, because this file is where the trap
 * lives. Only `part` reads it, and it reads it as a DEFAULT TARGET. The other
 * three never read it: they WRITE a different channel into the selection. The
 * record therefore carries the submitting window as ONE raw fact, named for
 * the fact — pre-resolving it into something like a "default target" field is
 * what would collapse that meaning against the relay verbs' one, so nothing
 * here does that.
 */

/**
 * `/part [#chan] [reason]` — the channel argument defaults to the window the
 * command was typed in. This is the one genuine `target == context`
 * degeneration in the dispatch table: a context resolved from the wrong window
 * parts the wrong channel, silently and successfully.
 */
export const partCommand: CommandHandler<"part"> = async (cmd, ctx) => {
  const target = cmd.channel ?? ctx.submittedFrom;
  await postPart(ctx.token, ctx.networkSlug, target, cmd.reason);
  return { ok: true };
};

/**
 * `/join #a[,#b] [key]`.
 *
 * #516 — the parser returns `channels: string[]`; rejoin with `,` to reproduce
 * the RFC1459 comma-list on the wire byte-for-byte (the server splits it and
 * opens a `:pending` window per channel, #382).
 *
 * CP17 — window state is server-driven: `record_in_flight_join/2` writes
 * `window_states[ch] = :pending` and broadcasts `window_pending` on
 * `Topic.user/1`, which userTopic.ts dispatches into setPending(...). Pre-CP17
 * cic mutated setPending here optimistically — the only cic-originated state
 * mutation in the codebase, and a violation of the "cic NEVER originates state"
 * hard-invariant.
 *
 * The focus switch, however, IS ours: the operator just typed /join, so focus
 * follows intent. Doing it here rather than leaning on subscribe.ts's self-JOIN
 * handler closes a race — the JOIN is broadcast on the per-channel WS topic
 * immediately after channels_changed fires, but cic only joins that topic AFTER
 * the REST refetch completes, and Phoenix PubSub does not replay to late
 * subscribers, so that handler's setSelectedChannel never fired in practice.
 * The autojoin / sajoin / NickServ-driven JOINs still go through subscribe.ts
 * (no race there — the channel was already joined when the event arrives).
 *
 * #510/#516 — focus must land on the FIRST channel, folded the SAME way the
 * server folds window keys (`canonicalChannel` = the
 * `Identifier.canonical_channel/1` twin, CASEMAPPING=ascii — A-Z only, brackets
 * untouched; #525). A mixed-case or bracketed first element targets a key no
 * `window_states` entry matches, which opens the empty phantom window #510
 * reported.
 */
export const joinCommand: CommandHandler<"join"> = async (cmd, ctx) => {
  await postJoin(ctx.token, ctx.networkSlug, cmd.channels.join(","), cmd.key);
  setSelectedChannel({
    networkSlug: ctx.networkSlug,
    // `channels` is non-empty (the parser errors on a missing name), so `[0]`
    // is never undefined at runtime; the `?? join(",")` fallback exists only to
    // satisfy TS noUncheckedIndexedAccess.
    channelName: canonicalChannel(cmd.channels[0] ?? cmd.channels.join(",")),
    kind: "channel",
  });
  return { ok: true };
};

/**
 * #1796 — `/cycle [#chan] [message]`: part then join, and nothing else.
 * irssi's CYCLE, and channel-scoped like irssi's (the NETWORK bounce is
 * `/reconnect`, in `commands/network.ts`).
 *
 * Composed from the two handlers above rather than from two `post*` calls, so
 * a step either verb grows later is inherited here instead of being forgotten
 * here. The target is resolved ONCE and passed to both legs explicitly, which
 * is also what stops `part`'s own `?? ctx.submittedFrom` fallback from
 * answering a second time for the JOIN.
 *
 * SEQUENTIAL: the JOIN runs only if the PART resolved. A part that failed
 * leaves the operator in the channel, so rejoining would be a JOIN to a
 * channel they never left. Same rule, same reason, as `/reconnect`'s two legs.
 *
 * The guard has no `/part` twin and needs one here: `/part` in a non-channel
 * window merely posts a DELETE the server refuses, whereas `/cycle`'s second
 * leg would JOIN whatever the window is called — manufacturing a channel out
 * of a peer nick or `$server`. Same family as the #1208 phantom, one layer
 * down, so it is refused before either leg rather than after the first.
 *
 * FOCUS follows the join, inherited from `joinCommand` and wanted twice over:
 * for `/cycle #other` it is what `/join #other` already does, and for the bare
 * form it is the repair for a yank — parting the focused window drops it from
 * `channelsBySlug`, and selection.ts's close-window picker (UX-4 bucket E)
 * moves focus off it before the JOIN puts it back.
 *
 * NO key: irssi's grammar has no slot for one (`CYCLE [<channel>]
 * [<message>]`), so a `+k` channel cannot be cycled from here. Named rather
 * than papered over — `/part` + `/join #chan <key>` is the two-command form
 * that still works.
 */
export const cycleCommand: CommandHandler<"cycle"> = async (cmd, ctx) => {
  const target = cmd.channel ?? ctx.submittedFrom;
  if (!isChannelName(target, ctx.sigils())) {
    return { error: `/cycle: ${target} is not a channel — use /cycle <#channel> [message]` };
  }
  const parted = await partCommand({ kind: "part", channel: target, reason: cmd.reason }, ctx);
  if ("error" in parted) return parted;
  return await joinCommand({ kind: "join", channels: [target], key: null }, ctx);
};

/**
 * `/list [pattern]` — the channel directory browser (#84). Opens the
 * per-network $list pseudo-window (DirectoryPane); the pane loads the snapshot
 * on mount (the server auto-refreshes on empty). A pattern pre-seeds the
 * directory search (setQuery re-GETs filtered). No raw LIST is sent here — the
 * directory's own refresh path owns that.
 */
export const listCommand: CommandHandler<"list"> = async (cmd, ctx) => {
  setSelectedChannel({
    networkSlug: ctx.networkSlug,
    channelName: LIST_WINDOW_NAME,
    kind: "list",
  });
  if (cmd.pattern !== null && cmd.pattern !== "") {
    void setQuery(ctx.networkSlug, cmd.pattern);
  }
  return { ok: true };
};

/**
 * `/query <nick>` — open a query window and switch focus. No message is sent
 * (spec #1). Bare `/query` on a query-kind window CLOSES it (irssi convention);
 * bare /query on any other window kind is an error — the parser emits
 * `{target: null}` for both and the semantics are resolved here.
 *
 * UX-4 bucket G: *serv targets reject. Opening a query window for NickServ
 * would be a dead window (services route to $server server-side), so this is a
 * user-facing error the operator can answer with `/msg <Xserv> ...`.
 */
export const queryCommand: CommandHandler<"query"> = async (cmd, ctx) => {
  if (cmd.target === null) {
    // Cross-network safety on the bare-close path: resolve the network ID from
    // the SELECTED window's own networkSlug, not from the submitting one — the
    // two diverge when the submit was queued across a window switch, and using
    // the submitting slug with `sel.channelName` would no-op or close a
    // wrong-network row.
    const sel = selectedChannel();
    if (sel?.kind === "query") {
      // #1396 — the one guard NOT routed through `requireNetworkId`. It is not
      // the same guard: every other site asks "is the network this operator is
      // typing in live?", this one asks it of a DIFFERENT network, and its copy
      // has always said so. The shared message is `/<subject>: network not
      // found`, which cannot spell "selected window's network" without an extra
      // colon — so forcing it through would change operator-visible copy to buy
      // uniformity, which is the wrong trade in a refactor.
      const selNetId = networkIdBySlug(sel.networkSlug);
      if (selNetId === undefined) return { error: "/query: selected window's network not found" };
      closeQueryWindow(selNetId, sel.channelName);
      return { ok: true };
    }
    return {
      error: "/query <nick> required (bare /query closes the current query window only)",
    };
  }
  const networkId = ctx.requireNetworkId(ctx.networkSlug, "query");
  if (typeof networkId !== "number") return networkId;
  if (isServicesSender(cmd.target)) {
    return {
      error: `/query: ${cmd.target} is a services nick; responses land in the server window — use /msg ${cmd.target} <command>`,
    };
  }
  // canonicalQueryNick: resolve user-input casing to the existing window's
  // ChannelKey — using cmd.target as-is would create a dead key no sidebar or
  // scrollback store knows.
  const canonical = canonicalQueryNick(networkId, cmd.target);
  openQueryWindowState(networkId, canonical, new Date().toISOString());
  setSelectedChannel({ networkSlug: ctx.networkSlug, channelName: canonical, kind: "query" });
  return { ok: true };
};

/**
 * issue 2430 — `/equery <nick>`: open an encrypted query with `nick` and focus
 * it (the window is cic-local, see `encryptedWindow.ts`). No bare close, unlike
 * `/query`: the encrypted window has no compose box that takes commands, and
 * its × closes it. A channel, a services nick or our own nick has no
 * encrypted query.
 */
export const equeryCommand: CommandHandler<"equery"> = async (cmd, ctx) => {
  if (cmd.target === null) return { error: "/equery <nick> required" };
  const networkId = ctx.requireNetworkId(ctx.networkSlug, "equery");
  if (typeof networkId !== "number") return networkId;
  if (isChannelName(cmd.target, ctx.sigils())) {
    return { error: `/equery: ${cmd.target} is a channel; an encrypted query is with one nick` };
  }
  if (isServicesSender(cmd.target)) {
    return { error: `/equery: ${cmd.target} is a services nick` };
  }
  const net = networkBySlug(ctx.networkSlug);
  const own = net ? ownNickForNetwork(net, user()) : null;
  if (own && nickEquals(cmd.target, own, casemappingForSlug(ctx.networkSlug))) {
    return { error: "/equery: that is your own nick" };
  }
  await openEncryptedWindow(ctx.networkSlug, cmd.target);
  return { ok: true };
};
