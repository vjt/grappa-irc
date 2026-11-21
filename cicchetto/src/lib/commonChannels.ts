import { createSignal } from "solid-js";
import { listCommonChannels } from "./api";
import { atKey, type ByKey, withKey, withoutKey } from "./byKey";
import { casemappingForSlug } from "./casemapping";
import { channelKey } from "./channelKey";
import { identityScopedStore } from "./identityScopedStore";
import { joinedChannelsOnNetwork } from "./joinedChannels";
import { membersByChannel } from "./members";
import { nickEquals, normalizeNick } from "./nickEquals";

// Issue 2449 — channels in common with a query peer.
//
// Two sources, one display:
//   * The REST snapshot (`GET /networks/:slug/common-channels?nick=`,
//     `listCommonChannels`): authoritative at fetch time. It closes the
//     cold-start gap and the "zero shared channels vs lists not loaded
//     yet" ambiguity — a purely local derivation cannot tell those
//     apart. Seeded channels only, per the server contract.
//   * The live derivation (`deriveCommonChannels`): joined channels on
//     the network filtered by the peer's membership in `membersByChannel`,
//     which `applyPresenceEvent` already maintains from the existing
//     JOIN/PART/KICK/QUIT/NICK pushes. No new push event exists or is
//     needed for this UI.
//
// The display rule (in `CommonChannelsBanner`): until the snapshot
// arrives the banner reads "loading…"; after it arrives the banner
// shows the LIVE derivation, falling back to the snapshot for any
// channel whose member list was never seeded (a peer there is
// unknowable locally, so the snapshot's word stands). A paused channel
// (#1769) keeps its last member list, so the derivation can go stale
// for backgrounded channels exactly like the MembersPane does — the
// banner refetches on every mount (query focus), which heals it.
//
// Identity-scoped: cleared on logout / token rotation, like
// `peerAway.ts`.

const exports_ = identityScopedStore((onIdentityChange) => {
  // Slug → folded peer nick → fetched snapshot, or `null` when the fetch
  // failed (the banner hides rather than asserting "no channels in
  // common" on a failed read). Absent = not fetched yet.
  const [commonChannelsBySlug, setCommonChannelsBySlug] = createSignal<
    Record<string, ByKey<string[] | null>>
  >({});

  onIdentityChange(() => setCommonChannelsBySlug({}));

  const peerKeyFor = (networkSlug: string, peer: string): string =>
    normalizeNick(peer, casemappingForSlug(networkSlug));

  const setCommonChannels = (networkSlug: string, peer: string, channels: string[]): void => {
    const peerKey = peerKeyFor(networkSlug, peer);
    setCommonChannelsBySlug((prev) => ({
      ...prev,
      [networkSlug]: withKey(prev[networkSlug], peerKey, channels),
    }));
  };

  const setCommonChannelsFailed = (networkSlug: string, peer: string): void => {
    const peerKey = peerKeyFor(networkSlug, peer);
    setCommonChannelsBySlug((prev) => ({
      ...prev,
      [networkSlug]: withKey(prev[networkSlug], peerKey, null),
    }));
  };

  const clearCommonChannels = (networkSlug: string, peer: string): void => {
    const peerKey = peerKeyFor(networkSlug, peer);
    setCommonChannelsBySlug((prev) => {
      const networkEntries = prev[networkSlug];
      if (!networkEntries || atKey(networkEntries, peerKey) === undefined) return prev;
      const next = { ...prev, [networkSlug]: withoutKey(networkEntries, peerKey) };
      return next;
    });
  };

  // One in-flight fetch per (slug, peer): a remount while a fetch is
  // already running (StrictMode double-mount, fast selection flips)
  // reuses it instead of stacking a second GET.
  const inFlight = new Set<string>();

  const fetchCommonChannels = (token: string, networkSlug: string, peer: string): Promise<void> => {
    const key = `${networkSlug} ${peerKeyFor(networkSlug, peer)}`;
    if (inFlight.has(key)) return Promise.resolve();
    inFlight.add(key);
    return listCommonChannels(token, networkSlug, peer)
      .then((channels) => {
        setCommonChannels(networkSlug, peer, channels);
      })
      .catch((err: unknown) => {
        // A fetch that throws must not take the banner down with it —
        // the members map simply stays as it was, and the banner hides
        // (null) rather than asserting an empty list.
        console.warn("[commonChannels] fetch failed", networkSlug, peer, err);
        setCommonChannelsFailed(networkSlug, peer);
      })
      .finally(() => {
        inFlight.delete(key);
      });
  };

  return {
    commonChannelsBySlug,
    setCommonChannels,
    setCommonChannelsFailed,
    clearCommonChannels,
    fetchCommonChannels,
  };
});

export const commonChannelsBySlug = exports_.commonChannelsBySlug;
export const setCommonChannels = exports_.setCommonChannels;
export const setCommonChannelsFailed = exports_.setCommonChannelsFailed;
export const clearCommonChannels = exports_.clearCommonChannels;
export const fetchCommonChannels = exports_.fetchCommonChannels;

// Pure derivation over the client's own member lists: the joined
// channels on `networkSlug` whose seeded member list contains `peer`
// (case-insensitive under the network's casemapping). Channels whose
// member list was never seeded fall back to `fetched` — the snapshot's
// word stands where the client has no list at all. Both inputs are
// already network-folded, so the comparison is exact.
export const deriveCommonChannels = (
  networkSlug: string,
  peer: string,
  fetched: string[],
): string[] => {
  const casemapping = casemappingForSlug(networkSlug);
  const out: string[] = [];
  for (const channel of joinedChannelsOnNetwork(channelKey(networkSlug, peer))) {
    const list = membersByChannel()[channelKey(networkSlug, channel)];
    if (list === undefined) {
      if (fetched.includes(channel)) out.push(channel);
    } else if (list.some((m) => nickEquals(m.nick, peer, casemapping))) {
      out.push(channel);
    }
  }
  return out.sort();
};
