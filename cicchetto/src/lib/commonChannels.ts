import { createSignal } from "solid-js";
import { listCommonChannels } from "./api";
import { atKey, type ByKey, keyEntries, withKey, withoutKey } from "./byKey";
import { casemappingForSlug } from "./casemapping";
import { channelKey } from "./channelKey";
import { identityScopedStore } from "./identityScopedStore";
import { joinedChannelsOnNetwork } from "./joinedChannels";
import { membersByChannel } from "./members";
import { nickEquals, normalizeNick } from "./nickEquals";

// Issue 2449 — channels in common with the peer in a query window.
//
// M2 (brief): HYBRID — initial REST fetch + local recompute from the
// existing JOIN/PART events; NO new push event. The two halves:
//
//   * LOCAL DERIVATION (`deriveCommonChannels`): joined channels on the
//     network (`joinedChannelsOnNetwork`) filtered by peer membership in
//     `membersByChannel`, with `nickEquals` under the network
//     casemapping. It updates live on all five presence kinds because
//     `applyPresenceEvent` already maintains the map for join/part/
//     quit/kick/nick_change — this module adds no event handling of its
//     own. A channel with NO member list seeded is skipped, not counted:
//     locally "peer absent" and "list not loaded yet" are the same empty
//     read, which is exactly the gap the fetch closes.
//   * REST FETCH (`fetchCommonChannels`): `GET /networks/:slug/
//     common-channels?nick=<nick>` on query open, closing the two gaps a
//     purely local derivation cannot: (a) presence pause (#1680/#1769 —
//     a channel unread for 2 min is re-joined with `{presence: false}`,
//     the server stops pushing its peer join/part/quit, the local map
//     goes stale by design and is healed only by the `listMembers`
//     refetch on resume); (b) cold start / zero-shared-channels
//     ambiguity — locally "no shared channels" is indistinguishable
//     from "lists not loaded yet".
//
// MERGE (`commonChannelsForPeer`): the fetched snapshot is the
// readiness gate — until it lands, `loaded` is false and the banner
// renders nothing rather than a false "no channels in common". Once
// loaded, the rendered list is the local derivation, EXCEPT for joined
// channels with no member list seeded, where the fetched snapshot's
// verdict stands (the local map has nothing to say about them yet).
// Where the list IS seeded, local wins: it is live, the snapshot is a
// point in time. (With the pause kill-switched off, #1848, every joined
// channel's list is live; when the pause returns, a resumed channel's
// `listMembers` refetch heals the map the derivation reads.)
//
// Identity-scoped like `peerAway.ts`: cleared on logout / token
// rotation. Per-peer key is the folded nick (issue 2453 — a nick is the
// peer's to choose, so `ByKey`).

const exports_ = identityScopedStore((onIdentityChange) => {
  // Slug → folded peer nick → fetched snapshot (sorted). Presence in
  // the map IS the loaded flag: no entry means no fetch has landed for
  // this peer yet, and the banner must not claim zero.
  const [commonChannelsBySlug, setCommonChannelsBySlug] = createSignal<
    Record<string, ByKey<string[]>>
  >({});

  onIdentityChange(() => setCommonChannelsBySlug({}));

  const setCommonChannels = (networkSlug: string, peer: string, channels: string[]): void => {
    const peerKey = normalizeNick(peer, casemappingForSlug(networkSlug));
    setCommonChannelsBySlug((prev) => ({
      ...prev,
      [networkSlug]: withKey(prev[networkSlug], peerKey, [...channels].sort()),
    }));
  };

  const clearCommonChannels = (networkSlug: string, peer: string): void => {
    const peerKey = normalizeNick(peer, casemappingForSlug(networkSlug));
    setCommonChannelsBySlug((prev) => {
      const networkEntries = prev[networkSlug];
      if (networkEntries === undefined || atKey(networkEntries, peerKey) === undefined) {
        return prev;
      }
      const next = { ...prev };
      const nextNetwork = withoutKey(networkEntries, peerKey);
      if (keyEntries(nextNetwork).length === 0) {
        delete next[networkSlug];
      } else {
        next[networkSlug] = nextNetwork;
      }
      return next;
    });
  };

  return { commonChannelsBySlug, setCommonChannels, clearCommonChannels };
});

export const commonChannelsBySlug = exports_.commonChannelsBySlug;
export const setCommonChannels = exports_.setCommonChannels;
export const clearCommonChannels = exports_.clearCommonChannels;

// Local derivation: joined channels on the network whose seeded member
// list holds the peer. Reads the `membersByChannel` + `windowStateByChannel`
// signals, so a component calling this inside a render re-runs on every
// presence event — the live half of M2. Sorted: the server sorts its
// answer, and the two halves must agree on order.
export const deriveCommonChannels = (networkSlug: string, peer: string): string[] => {
  const casemapping = casemappingForSlug(networkSlug);
  const members = membersByChannel();
  const out: string[] = [];
  for (const name of joinedChannelsOnNetwork(channelKey(networkSlug, peer))) {
    const list = members[channelKey(networkSlug, name)];
    if (list === undefined) continue;
    if (list.some((m) => nickEquals(m.nick, peer, casemapping))) out.push(name);
  }
  return out.sort();
};

// Merged view for the banner: `{ channels, loaded }`. `loaded` is false
// until the REST fetch lands; the banner renders nothing while false.
// Once loaded, the local derivation is the list, with the fetched
// snapshot filling in joined channels whose member list is not seeded
// yet (cold start, or a channel still pre-NAMES).
export const commonChannelsForPeer = (
  networkSlug: string,
  peer: string,
): { channels: string[]; loaded: boolean } => {
  const fetched = atKey(
    commonChannelsBySlug()[networkSlug],
    normalizeNick(peer, casemappingForSlug(networkSlug)),
  );
  const local = deriveCommonChannels(networkSlug, peer);
  if (fetched === undefined) return { channels: local, loaded: false };
  const members = membersByChannel();
  const merged = new Set(local);
  for (const name of fetched) {
    if (members[channelKey(networkSlug, name)] === undefined) merged.add(name);
  }
  return { channels: [...merged].sort(), loaded: true };
};

// In-flight dedupe per (slug, folded peer): a query re-render or a
// re-mount must not stack a second fetch on the one already flying.
// A failed fetch leaves `loaded` false (the banner stays hidden rather
// than claiming zero) and logs — the next query open retries.
const inFlight = new Map<string, Promise<void>>();

export const fetchCommonChannels = (
  token: string,
  networkSlug: string,
  peer: string,
): Promise<void> => {
  const key = `${networkSlug}\0${normalizeNick(peer, casemappingForSlug(networkSlug))}`;
  const existing = inFlight.get(key);
  if (existing !== undefined) return existing;
  const p = listCommonChannels(token, networkSlug, peer)
    .then((channels) => {
      setCommonChannels(networkSlug, peer, channels);
    })
    .catch((err: unknown) => {
      console.warn("[commonChannels] fetch failed", networkSlug, peer, err);
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, p);
  return p;
};
