import { type Component, For, Show } from "solid-js";
import { inviteAckBySlug } from "./lib/inviteAck";
import NickText from "./NickText";

// P-0e + P-0f — invite-ack ephemeral synthetic rows. Renders one
// inline row per invite_ack event for `networkSlug`, in arrival
// order across all target channels. NOT persisted; lost on refresh.
//
// Mount: $server window for the network. P-0f flipped from per-channel
// scrollback (which silent-dropped when the operator wasn't in the
// target channel) to the always-visible $server window. The row text
// includes the target channel since one $server window aggregates
// invites issued to any channel on the network.
//
// Per `feedback_no_localized_strings_server_side` cic owns the human-
// readable rendering ("→ invited <peer> to <channel>"). Server emits
// structured (network, channel, peer) only.
type Props = {
  networkSlug: string;
};

const InviteAckRows: Component<Props> = (props) => {
  const entries = () => {
    const networkEntries = inviteAckBySlug()[props.networkSlug];
    if (!networkEntries) return [];
    // Flatten across all per-channel buckets, then sort by ts so the
    // operator sees them in true arrival order regardless of which
    // channel was invited to.
    const all = Object.entries(networkEntries).flatMap(([channelKey, list]) =>
      list.map((e) => ({ ...e, channel: channelKey })),
    );
    return all.sort((a, b) => a.ts - b.ts);
  };

  return (
    <Show when={entries().length > 0}>
      <For each={entries()}>
        {(entry) => (
          <div class="invite-ack-row" data-testid="invite-ack-row">
            <span class="invite-ack-arrow">→</span>
            <span class="invite-ack-text">
              invited <NickText nick={entry.peer} extraClass="invite-ack-peer" /> to{" "}
              <span class="invite-ack-channel">{entry.channel}</span>
            </span>
          </div>
        )}
      </For>
    </Show>
  );
};

export default InviteAckRows;
