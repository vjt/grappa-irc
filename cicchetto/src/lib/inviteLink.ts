import { createEffect, createRoot, untrack } from "solid-js";
import { ApiError, assertNever } from "./api";
import { token } from "./auth";
import { confirmJoinChannel, switchToChannelWindow } from "./channelJoin";
import { canonicalChannel } from "./channelKey";
import { errorMessage } from "./friendlyApiError";
import { homeData } from "./home";
import { identityMoved } from "./identityMoved";
import { attachNetwork } from "./networkAttach";
import { channelsBySlug, networkBySlug } from "./networks";
import type { PushTarget } from "./pushPayload";
import { createToastQueue } from "./toasts";

// #793 — shareable channel invite links: paste `https://irc.sindro.me/?go=azzurra/sniffo`
// anywhere, the recipient clicks, gets a confirm, and lands in the channel.
//
// This is the READ side (decision 5 of the issue): consuming a link. Links are
// written BY HAND — vjt ruled out a generation UI, a token and an expiry — so
// there is no builder here. The canonical spelling is therefore written down
// rather than generated: this comment, the parse tests, `inviteUrl` in the
// #793 e2e spec, and the DESIGN_NOTES entry. Nothing in the product composes
// one, and nothing should until the write side (decision 5) is asked for.
//
// **`?go=` is the canonical form, and it is a query param on purpose.** vjt's
// words: *"a query param, deliberately, to avoid the fronting problem (no
// path-prefix collision with the SPA routes)"*. The first shipment read
// `/<network>/<channel>` from `location.pathname` instead, which put every
// invite in the same namespace as every present and future client route —
// `/login`, `/share`, and whatever comes next — and needed a
// reserved-segment denylist to keep them apart. A query param has no such
// namespace to share, so the denylist is gone with it.
//
// It is a second ENTRY POINT into the deep-link machinery, not a second
// subsystem. `pushTarget.ts` already reads `?network=&channel=` at boot,
// normalises it into a `PushTarget`, and defers routing until its store seeds;
// the invite normalises into the SAME `PushTarget` and reuses the SAME reader
// and the SAME defer (see `applyDeepLinkFromUrl`). Only two things are
// genuinely new: a second param spelling, and routing to a JOIN instead of a
// selection.
//
// The join itself is the #648 verb — `confirmJoinChannel`: it owns confirm ->
// `joinChannel` -> switch, and already switches with no modal when we are in
// the channel. Since issue 2719 a network with no session is reconnected by the
// same yes, and the question says so. No new socket call, no second confirm
// implementation, no parallel window state.

// RFC 2812 chantypes. A segment that already starts with one is taken
// verbatim; a bare segment gets `#` (vjt's `?go=azzurra/sniffo` example —
// "the `#` is implied", the overwhelming case, and the only spelling a normal
// person will ever type).
//
// Inside a query param the three delimiters bite differently, and all three
// are pinned by measurement in `inviteLink.test.ts` rather than by reasoning:
// a literal `#` starts the FRAGMENT (the value truncates and the channel never
// reaches the app), a literal `&` starts the NEXT PARAM (same truncation), and
// a literal `+` decodes to a SPACE (the value survives but says something
// else). Truncation costs a segment, so those two refuse the whole invite;
// the space is caught by the forbidden-byte scan below. Encoded — `%23`,
// `%26`, `%2B` — each arrives intact. #755 is the precedent for getting this
// wrong: the room segment was the one URL component never encoded.
const CHANTYPES = "#&+!";

// The sigils that may stand alone as a WHOLE channel name — the server's rule
// in `Identifier.valid_channel?/1` (issue 2424). A lone `#` or `&` is an
// ordinary channel upstream; a lone `+` or `!` names nothing.
const LONE_CHANNEL_SIGILS = "#&";

// Bytes RFC 2812 forbids inside a channel name, rejected rather than escaped.
// The comma is the one that matters: JOIN takes a comma-separated LIST, so an
// unfiltered `?go=azzurra/sniffo,bofh` would turn one invite into a
// multi-channel join the sender never wrote. Everything at or below 0x20 covers
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
 * Parses `?go=<network>/<channel>` into the same `PushTarget` the push
 * deep-link reader produces. Returns null for anything that is not an invite —
 * no `go` param, a wrong segment count, or a channel name carrying bytes IRC
 * forbids.
 *
 * Takes a whole URL rather than a query string, absolute or relative, so the
 * boot reader can hand it `location.href` exactly as it hands the same value
 * to `parsePushTargetUrl`. The PATH is read for nothing, and that is the whole
 * point of the shape: a parser that still glanced at the path would keep the
 * route collision `?go=` was chosen to remove.
 *
 * Decoding is `URLSearchParams`', not `decodeURIComponent`'s, and the
 * difference is deliberate: the WHATWG rules leave an undecodable escape as
 * its own bytes instead of throwing, so `%ZZ` names a silly channel rather
 * than being refused. The consent modal prints the channel before anyone
 * joins it, which is where a typo gets caught by the only reader that can
 * judge it.
 *
 * A value split on `/` also tolerates further components LATER (vjt: "further
 * path components may be added later") — today anything past the second is
 * refused rather than ignored, because a silently-dropped component is a lie
 * about what the link asked for.
 *
 * `kind` is always `"channel"`: unlike `parsePushTargetUrl` there is no
 * sigil-sniffing for a DM target, because a DM invite link is meaningless —
 * the whole point is joining a room.
 */
export function parseInviteLinkUrl(rawUrl: string): PushTarget | null {
  let url: URL;
  try {
    url = new URL(rawUrl, "https://placeholder.invalid");
  } catch {
    return null;
  }

  const value = url.searchParams.get("go");
  if (value === null) return null;

  const [networkSlug, channel, ...rest] = value.split("/").filter((s) => s.length > 0);
  if (networkSlug === undefined || channel === undefined || rest.length > 0) return null;
  if (hasForbiddenChannelByte(channel)) return null;

  const channelName = CHANTYPES.includes(channel.charAt(0)) ? channel : `#${channel}`;
  // A one-char name can only be a sigil (a bare segment got `#` prepended).
  if (channelName.length === 1 && !LONE_CHANNEL_SIGILS.includes(channelName)) return null;

  return { networkSlug, channelName, kind: "channel" };
}

// Issue 2703 settles #793's open decision 1. The network segment stays a slug
// on THIS server, never a global identifier. When the recipient has not bound
// that network, `/me`'s `home_data.available_networks` gives the server's
// answer to "may this subject bind it?". A visitor is offered the
// `visitor_enabled` networks; a user is offered those plus their own detached
// ones, minus what is attached. That list is exactly what
// `POST /session/networks` accepts, so it is the gate, and cic keeps no list of
// its own.
//
//   * Bound          -> the #648 confirm-then-join (or a plain switch).
//   * Available      -> attach it with NO modal of its own (vjt: "senza modale
//                       autoconnect"), then the same #648 question once the
//                       network is in the list. The join consent stays: an
//                       attached network is a session, and a joined channel is
//                       a presence other people see.
//   * Neither        -> the toast. "Not on this server" and "not for you" read
//                       the same, deliberately: two answers would let a
//                       stranger enumerate what a deployment carries.
//
// The attach can fail (403, 503 caps, a network blip), and the person who
// clicked is owed the reason, so the toast carries the server's refusal in its
// localized copy. The one refusal it does NOT raise is 409 `already_attached`:
// that means another tab of the same account won the race, the network IS
// there, and the join goes ahead.
type InviteToast =
  | { networkSlug: string; reason: "unavailable" }
  | { networkSlug: string; reason: "attach_failed"; message: string };

const queue = createToastQueue<InviteToast>();

export const inviteToasts = queue.toasts;
export const dismissInviteToast = queue.dismiss;

/**
 * The toast's sentence. It sits beside the producer rather than inline in
 * Toasts.tsx so that a new `reason` fails tsc right here (`assertNever`), and
 * so that the unit tests can match the production copy instead of a retyped
 * string. The e2e cannot import it (a Playwright spec imports only types from
 * `src`, and this module pulls in solid and the stores), so the #793 spec pins
 * the "unavailable" sentence as a literal, on purpose: a copy change shows up
 * there as a red.
 */
export function inviteToastText(toast: InviteToast): string {
  switch (toast.reason) {
    case "unavailable":
      return `Invite for ${toast.networkSlug} — that network is not available here.`;
    case "attach_failed":
      return `Invite for ${toast.networkSlug} — ${toast.message}`;
    default:
      return assertNever(toast);
  }
}

/**
 * Applies a parsed invite: confirm-then-join on a bound network, a plain
 * switch when we are already in the channel, attach-then-confirm on a network
 * the recipient may bind, and a visible notice for any other slug.
 */
export function routeInviteTarget(target: PushTarget): void {
  if (networkBySlug(target.networkSlug) !== undefined) {
    routeBoundTarget(target);
    return;
  }
  if (!isAvailable(target.networkSlug)) {
    queue.queue({ networkSlug: target.networkSlug, reason: "unavailable" });
    return;
  }
  void attachThenJoin(target);
}

function routeBoundTarget(target: PushTarget): void {
  if (alreadyInChannel(target.networkSlug, target.channelName)) {
    switchToChannelWindow(target.networkSlug, target.channelName);
    return;
  }
  confirmJoinChannel(target.networkSlug, target.channelName);
}

function isAvailable(networkSlug: string): boolean {
  const available = homeData()?.available_networks ?? [];
  return available.some((n) => n.slug === networkSlug);
}

async function attachThenJoin(target: PushTarget): Promise<void> {
  const t = token();
  if (t === null) {
    // The post-logout race. Rare, but it is an exit like any other and the
    // person who clicked is owed an answer for it too.
    queue.queue({
      networkSlug: target.networkSlug,
      reason: "attach_failed",
      message: "not signed in",
    });
    return;
  }
  try {
    await attachNetwork(t, target.networkSlug);
  } catch (err) {
    if (identityMoved(t)) return;
    if (!(err instanceof ApiError && err.code === "already_attached")) {
      queue.queue({
        networkSlug: target.networkSlug,
        reason: "attach_failed",
        message: errorMessage(err),
      });
      return;
    }
  }
  if (identityMoved(t)) return;
  whenBound(t, target);
}

// The attach answers 204 (or 409, when another tab won the race) before the
// network is in `networks()`: the verb's two re-reads, which run on either
// answer, bring it in a round-trip later. The join question waits for it, for two
// reasons. A modal naming a network the sidebar does not show yet would be
// strange. And the window the join opens belongs under a network row that
// exists. Same shape as `deferUntilReady` in pushTarget.ts: a one-shot effect
// on the store the next step reads.
//
// It is bounded by the IDENTITY, not by a timer. If the account that clicked
// logs out, or another one logs in, the effect ends without acting
// (`identityMoved`), so the consent question never reaches an account that did
// not click. A network that never appears leaves the effect waiting until that
// identity ends. After a 204 or a 409 the server holds the row the re-reads
// fetch, so the data rules that out; a re-read that itself fails does not, and
// that exit has no answer of its own yet, issue 2723 (the re-reads are
// fire-and-forget, so the verb cannot see them fail).
function whenBound(t: string, target: PushTarget): void {
  createRoot((dispose) => {
    createEffect(() => {
      if (identityMoved(t)) {
        dispose();
        return;
      }
      if (networkBySlug(target.networkSlug) === undefined) return;
      dispose();
      untrack(() => routeBoundTarget(target));
    });
  });
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
