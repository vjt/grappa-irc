import { postJoin } from "./api";
import { token } from "./auth";
import { canonicalChannel, channelKey } from "./channelKey";
import { requestConfirm } from "./confirmDialog";
import { setSelectedChannel } from "./selection";
import { windowStateByChannel } from "./windowState";

// #648 — the verb behind a click-to-join `#channel` affordance rendered in
// scrollback (linkify.ts `channel` segment → MircText.renderChannel). It is a
// thin COMPOSITION of verbs that already exist — it opens no new socket call
// and holds no parallel state:
//
//   * postJoin            — THE join REST call, shared with compose.ts `/join`
//                           and DirectoryPane row taps.
//   * setSelectedChannel  — the ONLY cic-originated focus origin (#244): the
//                           tap. Automatic re-joins never steal focus.
//   * windowStateByChannel — the server-owned window_states projection, the
//                           already-joined source of truth.
//   * requestConfirm      — the shared confirm-modal store (#195), the sibling
//                           of windowClose.ts's confirmLeaveChannel.
//
// The confirm gate is the 20% that differs from a DirectoryPane row tap: a
// `#channel` in prose is NOT an unambiguous join intent (a row tap is), so a
// scrollback click asks first — UNLESS we're already in the channel, where a
// confirm to "join" a window that's already open is noise (#648): switch to it
// directly.
//
// Casing split, mirroring compose.ts `/join` (#510/#516/#525): the JOIN goes on
// the wire RAW/display-cased (`#Sniffo` — the server does its own casemapping);
// focus + the already-joined lookup use the FOLDED key (`canonicalChannel` /
// `channelKey`, which folds internally), because window_states + selection are
// keyed folded — a mixed-case focus target opens a phantom window.

// Exported for #793's invite-link route, which reaches the already-in-the-
// channel outcome from a URL instead of a tap and must not grow a second
// spelling of "focus this channel window".
export function switchToChannelWindow(networkSlug: string, rawChannel: string): void {
  setSelectedChannel({
    networkSlug,
    channelName: canonicalChannel(rawChannel),
    kind: "channel",
  });
}

async function performJoin(networkSlug: string, rawChannel: string): Promise<void> {
  const t = token();
  if (!t) return; // post-logout race — nothing to join with.
  try {
    // RAW on the wire (display spelling); the server casemaps it.
    await postJoin(t, networkSlug, rawChannel, null);
    // Focus originates HERE (the tap), AFTER the awaited join — a rejected
    // join (+i / +k / +b) never foregrounds a phantom window (#244).
    switchToChannelWindow(networkSlug, rawChannel);
  } catch (err) {
    // Fire-and-forget UI action with no dedicated error surface (unlike the
    // DirectoryPane row's inline error signal). Log, don't throw — the same
    // posture windowClose.ts's disconnectNetwork PATCH takes. A join
    // REJECTION (channel modes) is not this path: postJoin succeeds and the
    // server reports the failure as a window_state broadcast; this catch is
    // only the REST-level failure (401 / network down).
    console.warn(`[#648 join] failed to join ${rawChannel} on ${networkSlug}:`, err);
  }
}

// #902 — THE invite-acceptance verb: join and foreground, no confirm.
//
// The 20% that differs from `confirmJoinChannel` below is intent. A
// `#channel` in prose is ambiguous, so a scrollback click asks first. An
// [Join] button ON an invite is not ambiguous — the operator is answering a
// question that was put to them — so asking again is noise.
//
// Both of its callers used to own a private copy of this body: the invite
// row's CTA (`ScrollbackPane.handleJoinChannel`) and, as of #902, the invite
// BANNER. Two copies of "postJoin then foreground the folded key" is exactly
// the drift CLAUDE.md's one-feature-one-code-path rule exists to stop, and
// the banner made the second copy unavoidable — the scrollback one was
// component-local, closed over `props.networkSlug`.
//
// Casing split as everywhere else (#510/#516/#525): RAW on the wire, FOLDED
// for focus. Focus moves only AFTER the await, so a rejected join (+i/+k/+b)
// never foregrounds a phantom window (#244).
export function acceptInvite(networkSlug: string, rawChannel: string): void {
  void performJoin(networkSlug, rawChannel);
}

// Already in the channel ⇒ switch, no modal. Otherwise confirm, then join on
// yes. The confirm body names the RAW channel (display casing).
export function confirmJoinChannel(networkSlug: string, rawChannel: string): void {
  const joined = windowStateByChannel()[channelKey(networkSlug, rawChannel)] === "joined";
  if (joined) {
    switchToChannelWindow(networkSlug, rawChannel);
    return;
  }
  requestConfirm({
    title: "Join channel",
    body: `Join ${rawChannel}?`,
    confirmLabel: "Join",
    onConfirm: () => void performJoin(networkSlug, rawChannel),
  });
}
