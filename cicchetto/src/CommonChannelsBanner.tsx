import { type Component, createEffect, createMemo, Show } from "solid-js";
import { token } from "./lib/auth";
import { commonChannelsForPeer, fetchCommonChannels } from "./lib/commonChannels";
import NickText from "./NickText";

// Issue 2449 — channels in common with the peer, as an IN-FLOW top row
// in the query window. The #270 PeerAwayBanner pattern, same mount site
// (ScrollbackPane, `kind === "query"`): an in-flow row reserves its own
// space at the top of the scroll list instead of floating over the y=0
// first row, and it renders even in an empty DM.
//
// The fetch fires on mount / peer change (query open): the REST snapshot
// is the readiness gate — until it lands the banner renders nothing,
// because locally "no shared channels" is indistinguishable from
// "lists not loaded yet" (brief M2, cold start). Once loaded, the row
// shows the live merged list (`commonChannelsForPeer`): the local
// derivation re-runs on every presence event, so a peer joining or
// leaving a shared channel moves the row without any new push event.
// No dismiss: this is window state, not an ephemeral notice.

export type Props = {
  networkSlug: string;
  peer: string;
};

const CommonChannelsBanner: Component<Props> = (props) => {
  createEffect(() => {
    const t = token();
    if (t === null) return;
    void fetchCommonChannels(t, props.networkSlug, props.peer);
  });

  const view = createMemo(() => commonChannelsForPeer(props.networkSlug, props.peer));

  return (
    <Show when={view().loaded}>
      <div class="common-channels-banner" data-testid="common-channels-banner">
        <Show
          when={view().channels.length > 0}
          fallback={
            <span class="common-channels-banner-label">
              No channels in common with{" "}
              <NickText nick={props.peer} extraClass="common-channels-banner-peer" />
            </span>
          }
        >
          <span class="common-channels-banner-label">
            Channels in common with{" "}
            <NickText nick={props.peer} extraClass="common-channels-banner-peer" />:{" "}
            <span class="common-channels-banner-list">{view().channels.join(", ")}</span>
          </span>
        </Show>
      </div>
    </Show>
  );
};

export default CommonChannelsBanner;
