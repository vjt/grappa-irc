import { ownNickForNetwork } from "./api";
import type { ChannelKey } from "./channelKey";
import { editorSigils } from "./channelModes";
import { isupportForNetwork } from "./isupport";
import { membersByChannel } from "./members";
import { networkBySlug, user } from "./networks";
import { nickEquals } from "./nickEquals";

// #74 — the single editor-sigil derivation shared by ModeModal (the
// channel-mode edit gate) and TopicBar (the +t topic-lock edit gate).
//
// Both ask the same question: does the operator's own nick hold an editing
// sigil in this channel? "Editing" = op (`@`), halfop (`%`), or any PREFIX
// rank above op (founder `~` / admin `&`), derived from the network's own
// ISUPPORT PREFIX order via `editorSigils/1` — NOT a hardcoded `@`/`%`, so
// PREFIX-rich networks that separate founder/admin from op aren't wrongly
// locked out.
//
// Pure projection of server-owned state (membersByChannel + ISUPPORT); cic
// originates nothing (CLAUDE.md: cic mirrors the server, no parallel state
// machine). It degrades CLOSED — returns false when own membership isn't in
// state (a not-yet-seeded window, or own nick not found). The ircd remains
// the real authority: it rejects an unauthorized MODE/TOPIC with 482, and
// that rejection is surfaced inline at the call site, so a slightly-strict
// gate only risks momentarily hiding an affordance from a legit op (self-
// healing once NAMES seeds), never granting one that would silently fail.

/**
 * True when the operator's own nick holds a channel-EDITING sigil in `key`
 * on the given network. Reads the reactive `membersByChannel` +
 * `isupportForNetwork` stores, so call it inside an accessor/memo to stay
 * reactive. Degrades to false when own membership isn't resolvable.
 */
export function ownHoldsChannelEditorSigil(
  networkSlug: string,
  key: ChannelKey,
  networkId: number,
): boolean {
  const net = networkBySlug(networkSlug);
  const me = user();
  if (!net || !me) return false;
  const nick = ownNickForNetwork(net, me);
  if (!nick) return false;
  const entry = (membersByChannel()[key] ?? []).find((m) => nickEquals(m.nick, nick));
  const modes = entry?.modes ?? [];
  const editors = editorSigils(isupportForNetwork(networkId));
  return modes.some((m) => editors.has(m));
}
