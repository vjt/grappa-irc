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

function switchTo(networkSlug: string, rawChannel: string): void {
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
    switchTo(networkSlug, rawChannel);
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

// Already in the channel ⇒ switch, no modal. Otherwise confirm, then join on
// yes. The confirm body names the RAW channel (display casing).
export function confirmJoinChannel(networkSlug: string, rawChannel: string): void {
  const joined = windowStateByChannel()[channelKey(networkSlug, rawChannel)] === "joined";
  if (joined) {
    switchTo(networkSlug, rawChannel);
    return;
  }
  requestConfirm({
    title: "Join channel",
    body: `Join ${rawChannel}?`,
    confirmLabel: "Join",
    onConfirm: () => void performJoin(networkSlug, rawChannel),
  });
}
