import { createSignal } from "solid-js";
import { type ChannelKey, channelKey } from "./channelKey";

// issue 2333 — imperative "land the pane on this message" command, the
// sibling of `jumpToUnreadCommand` (#1765) and here for the same reason: the
// caller owns the GESTURE (a tap on a mention row), ScrollbackPane owns the
// machinery (the #168 activation latch and the #608 scroll applier). A caller
// that reached `scrollback.jumpToMessage` directly would swap the rows and
// leave the pane parked wherever it was.
//
// Unlike its siblings it carries a PAYLOAD — the window and the message — so
// it cannot be a bare counter. The `nonce` keeps two taps on the same row
// distinct transitions (Solid's `===` would swallow an equal object only if
// it were the same object, but the pane consumes by nonce so a request it has
// already served is never served twice). `key` names the window: the pane
// serves the request only once it IS that window, which lets the caller set
// the selection and the request in one batch without ordering them.
export type JumpToMessageRequest = { key: ChannelKey; id: number; nonce: number };

const [jumpToMessageRequest, setJumpToMessageRequest] = createSignal<JumpToMessageRequest | null>(
  null,
);

export { jumpToMessageRequest };

let nonce = 0;

export const requestJumpToMessage = (
  networkSlug: string,
  channelName: string,
  id: number,
): void => {
  nonce += 1;
  setJumpToMessageRequest({ key: channelKey(networkSlug, channelName), id, nonce });
};
