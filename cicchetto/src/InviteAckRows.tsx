import { type Component, For, Show } from "solid-js";
import { inviteAckBySlug } from "./lib/inviteAck";

// P-0e — invite-ack ephemeral synthetic rows. Renders one inline row
// per invite_ack event for (networkSlug, channelName), in arrival
// order. NOT persisted; lost on refresh / scrollback refetch.
//
// Mount only on channel windows (not query) — server only broadcasts
// invite_ack on per-channel topics; the DM-listener defensive-drops it.
//
// Per `feedback_no_localized_strings_server_side` cic owns the human-
// readable rendering ("→ invited <peer>"). Server emits structured
// (network, channel, peer) only.
type Props = {
  networkSlug: string;
  channelName: string;
};

const InviteAckRows: Component<Props> = (props) => {
  const entries = () => {
    const channelKey = props.channelName.toLowerCase();
    return inviteAckBySlug()[props.networkSlug]?.[channelKey] ?? [];
  };

  return (
    <Show when={entries().length > 0}>
      <For each={entries()}>
        {(entry) => (
          <div class="invite-ack-row" data-testid="invite-ack-row">
            <span class="invite-ack-arrow">→</span>
            <span class="invite-ack-text">
              invited <span class="invite-ack-peer">{entry.peer}</span>
            </span>
          </div>
        )}
      </For>
    </Show>
  );
};

export default InviteAckRows;
