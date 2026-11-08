import { type Component, createEffect, For, Show } from "solid-js";
import { token } from "./lib/auth";
import { atKey } from "./lib/byKey";
import { casemappingForSlug } from "./lib/casemapping";
import {
  clearCommonChannels,
  commonChannelsBySlug,
  deriveCommonChannels,
  fetchCommonChannels,
} from "./lib/commonChannels";
import { normalizeNick } from "./lib/nickEquals";
import { setSelectedChannel } from "./lib/selection";

// Issue 2449 — channels-in-common banner. Renders inline at the top of
// the scrollback pane in DM windows, in the same in-flow slot as the
// #270 PeerAwayBanner (a row in the scroll flow, not a floating card),
// so it stays at the top even in an empty DM.
//
//   * Mount (query focus) fetches the authoritative snapshot
//     (`GET /networks/:slug/common-channels?nick=`) — that closes the
//     cold-start gap and the "zero shared channels vs lists not loaded
//     yet" ambiguity.
//   * After the snapshot lands, the list shown is the LIVE derivation
//     from `membersByChannel` (JOIN/PART/KICK/QUIT/NICK already flow
//     through `applyPresenceEvent`), falling back to the snapshot for
//     channels whose member list was never seeded. No new push event.
//   * States: snapshot pending → "shared channels…"; snapshot failed
//     → no banner at all (a failed read must not assert an empty list);
//     derived empty → "No channels in common"; otherwise the channel
//     names, each a button that jumps to that channel.
export type Props = {
  networkSlug: string;
  peer: string;
};

const CommonChannelsBanner: Component<Props> = (props) => {
  createEffect(() => {
    const t = token();
    const slug = props.networkSlug;
    const peer = props.peer;
    if (!t) return;
    // Clear first so a remount never flashes the previous fetch's
    // snapshot while the fresh one is in flight.
    clearCommonChannels(slug, peer);
    void fetchCommonChannels(t, slug, peer);
  });

  // The fetched snapshot: `undefined` = not fetched yet, `null` = the
  // fetch failed, `string[]` = the authoritative list at fetch time.
  const fetched = (): string[] | null | undefined => {
    const peerKey = normalizeNick(props.peer, casemappingForSlug(props.networkSlug));
    return atKey(commonChannelsBySlug()[props.networkSlug], peerKey);
  };

  // `undefined` = loading, `null` = failed (hide), `string[]` = show
  // the live derivation.
  const displayed = (): string[] | null | undefined => {
    const f = fetched();
    if (f === undefined) return undefined;
    if (f === null) return null;
    return deriveCommonChannels(props.networkSlug, props.peer, f);
  };

  return (
    <Show when={displayed() !== null}>
      <div class="common-channels-banner" data-testid="common-channels-banner">
        <Show when={displayed()} fallback={<span class="muted">shared channels…</span>}>
          {(channels) => (
            <Show
              when={channels().length > 0}
              fallback={<span class="muted">No channels in common</span>}
            >
              <span class="common-channels-label">Also in </span>
              <For each={channels()}>
                {(channel, i) => (
                  <>
                    {i() > 0 && <span class="common-channels-sep"> · </span>}
                    <button
                      type="button"
                      class="common-channels-channel"
                      onClick={() =>
                        setSelectedChannel({
                          networkSlug: props.networkSlug,
                          channelName: channel,
                          kind: "channel",
                        })
                      }
                    >
                      {channel}
                    </button>
                  </>
                )}
              </For>
            </Show>
          )}
        </Show>
      </div>
    </Show>
  );
};

export default CommonChannelsBanner;
