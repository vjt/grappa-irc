import { type Component, Show } from "solid-js";
import { dismissPeerAway, peerAwayBySlug } from "./lib/peerAway";
import NickText from "./NickText";

// P-0b — peer-away banner. Renders inline at the top of the scrollback
// pane when:
//   * the selected window is a DM window (channel name == peer nick), and
//   * `peerAwayBySlug()[networkSlug][peerLower]` exists.
//
// Triggered by upstream's standalone 301 RPL_AWAY when the operator
// /msg'd an away peer. Per `feedback_no_localized_strings_server_side`
// the human "is away" framing is built here from the server-emitted
// (peer, message) pair.
//
// Operator dismisses via the × button. Server fires one event per
// upstream 301; cic store replaces last-write-wins, so re-/msg'ing
// the same away peer simply updates the visible message.

export type Props = {
  networkSlug: string;
  peer: string;
};

const PeerAwayBanner: Component<Props> = (props) => {
  const message = (): string | undefined => {
    const peerKey = props.peer.toLowerCase();
    return peerAwayBySlug()[props.networkSlug]?.[peerKey];
  };

  return (
    <Show when={message()}>
      {(msg) => (
        <div class="peer-away-banner" data-testid="peer-away-banner">
          <span class="peer-away-banner-label">
            <NickText nick={props.peer} extraClass="peer-away-banner-peer" /> is away:{" "}
            <span class="peer-away-banner-message">{msg()}</span>
          </span>
          <button
            type="button"
            class="peer-away-banner-close"
            aria-label="Dismiss away notice"
            onClick={() => dismissPeerAway(props.networkSlug, props.peer)}
          >
            ×
          </button>
        </div>
      )}
    </Show>
  );
};

export default PeerAwayBanner;
