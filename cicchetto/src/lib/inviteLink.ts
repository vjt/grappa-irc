import { confirmJoinChannel, switchToChannelWindow } from "./channelJoin";
import { canonicalChannel } from "./channelKey";
import { channelsBySlug, networkBySlug } from "./networks";
import type { PushTarget } from "./pushPayload";
import { createToastQueue } from "./toasts";

// #793 — shareable channel invite links: paste `https://irc.sindro.me/azzurra/sniffo`
// anywhere, the recipient clicks, gets a confirm, and lands in the channel.
//
// This is the READ side (decision 5 of the issue): consuming a link. The
// "copy invite link" affordance in the channel UI is a separate shipment.
//
// It is a second ENTRY POINT into the deep-link machinery, not a second
// subsystem. `pushTarget.ts` already reads `?network=&channel=` at boot,
// normalises it into a `PushTarget`, and defers routing until `networks()`
// seeds; the invite path normalises into the SAME `PushTarget` and reuses the
// SAME reader and the SAME defer (see `applyDeepLinkFromUrl`). Only two things
// are genuinely new: parsing the PATH (the old reader looked at
// `location.search` only), and routing to a JOIN instead of a selection.
//
// The join itself is the #648 verb — `confirmJoinChannel` — untouched: it
// already owns confirm -> `postJoin` -> switch, and already switches with no
// modal when we are in the channel. No new socket call, no second confirm
// implementation, no parallel window state.

// RFC 2812 chantypes. A segment that already starts with one is taken
// verbatim; a bare segment gets `#` (vjt's `irc.sindro.me/azzurra/sniffo`
// example — the overwhelming case, and the only spelling a normal person
// will ever type).
//
// A literal `#` cannot travel in a path: the browser reads it as the start of
// the fragment and the server never sees the segment at all. #755 is the
// precedent for getting this wrong — the room segment there was the one URL
// component never encoded. So `#` MUST arrive percent-encoded (`%23`), which
// is also why the bare form exists: `/azzurra/sniffo` is what people paste.
const CHANTYPES = "#&+!";

// Two-segment client routes that are NOT invites. `/share/:token` (the visitor
// session-sharing landing) is the only one today; `/login` and `/` are single
// segment and cannot collide. Everything else two-segment reaching the SPA is
// an invite — real API/asset paths are answered by the server before the
// `GET /*path` SPA fallback (#399) ever runs.
const RESERVED_FIRST_SEGMENT = new Set(["share"]);

// Bytes RFC 2812 forbids inside a channel name, rejected rather than escaped.
// The comma is the one that matters: JOIN takes a comma-separated LIST, so an
// unfiltered `/azzurra/sniffo,bofh` would turn one invite into a multi-channel
// join the sender never wrote. Everything at or below 0x20 covers
// NUL/BEL/CR/LF/space, which cannot appear in a real channel and are the shape
// a frame-injection attempt takes. Deliberately NOT rejecting `:` — also
// illegal per the RFC, but harmless in a JSON body, and a false reject breaks
// a link for no gain.
//
// A codepoint scan rather than a regex character class: the bytes in question
// are invisible in source, and a class that silently loses one of them is
// exactly the kind of edit nobody spots in review.
const COMMA = 0x2c;
const DEL = 0x7f;
function hasForbiddenChannelByte(name: string): boolean {
  for (const ch of name) {
    const code = ch.codePointAt(0);
    if (code === undefined) continue;
    if (code <= 0x20 || code === COMMA || code === DEL) return true;
  }
  return false;
}

/**
 * Parses `/<network>/<channel>` into the same `PushTarget` the push deep-link
 * reader produces. Returns null for anything that is not an invite — a
 * reserved route, a wrong segment count, an undecodable escape, or a channel
 * name carrying bytes IRC forbids.
 *
 * `kind` is always `"channel"`: unlike `parsePushTargetUrl` there is no
 * sigil-sniffing for a DM target, because a DM invite link is meaningless —
 * the whole point is joining a room.
 */
export function parseInviteLinkPath(pathname: string): PushTarget | null {
  const [rawNetwork, rawChannel, ...rest] = pathname.split("/").filter((s) => s.length > 0);
  if (rawNetwork === undefined || rawChannel === undefined || rest.length > 0) return null;
  if (RESERVED_FIRST_SEGMENT.has(rawNetwork)) return null;

  let networkSlug: string;
  let channel: string;
  try {
    networkSlug = decodeURIComponent(rawNetwork);
    channel = decodeURIComponent(rawChannel);
  } catch {
    // Malformed percent-escape — `decodeURIComponent` throws URIError.
    return null;
  }

  if (networkSlug.length === 0 || channel.length === 0) return null;
  if (hasForbiddenChannelByte(channel)) return null;

  const channelName = CHANTYPES.includes(channel.charAt(0)) ? channel : `#${channel}`;
  // A bare sigil names nothing.
  if (channelName.length < 2) return null;

  return { networkSlug, channelName, kind: "channel" };
}

// Open decision 1 of #793, deliberately NOT settled here: `networkBySlug`
// resolves against THIS user's bound networks, but an invite is cross-user by
// definition, so the recipient may have no `azzurra` at all. Whether the path
// segment becomes a globally-resolvable network identifier or the flow grows
// an "add this network, then join" step is a product decision that has not
// been taken. What this branch must not do is fail silently: somebody clicked
// a link and is owed an answer, so it says what it observed and stops.
type InviteToast = { networkSlug: string };

const queue = createToastQueue<InviteToast>();

export const inviteToasts = queue.toasts;
export const dismissInviteToast = queue.dismiss;

/**
 * Applies a parsed invite: confirm-then-join on a bound network, a plain
 * switch when we are already in the channel, a visible notice when the
 * network is not bound for this recipient.
 */
export function routeInviteTarget(target: PushTarget): void {
  if (networkBySlug(target.networkSlug) === undefined) {
    queue.queue({ networkSlug: target.networkSlug });
    return;
  }
  if (alreadyInChannel(target.networkSlug, target.channelName)) {
    switchToChannelWindow(target.networkSlug, target.channelName);
    return;
  }
  confirmJoinChannel(target.networkSlug, target.channelName);
}

// "Already in that channel -> just switch, no modal" (#648's rule, restated by
// #793). The source is the SERVER's channel list rather than
// `windowStateByChannel`, which is what `confirmJoinChannel` consults on its
// own: an invite fires at BOOT, and the window states arrive later, per
// channel, off the per-channel WS join replies that `channelsBySlug` itself
// drives. Reading the live projection here would race it and pop a modal for
// a channel we are sitting in. Same fact, the source that is ready at the
// moment this question gets asked.
function alreadyInChannel(networkSlug: string, rawChannel: string): boolean {
  const list = channelsBySlug()?.[networkSlug];
  if (list === undefined) return false;
  const key = canonicalChannel(rawChannel);
  return list.some((c) => canonicalChannel(c.name) === key);
}
