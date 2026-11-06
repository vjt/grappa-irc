import { createSignal } from "solid-js";
import { atKey, type ByKey, keyEntries, withKey, withoutKey } from "./byKey";
import { casemappingForSlug } from "./casemapping";
import { identityScopedStore } from "./identityScopedStore";
import { normalizeNick } from "./nickEquals";

// P-0b — peer-away ephemeral store. Holds at most one away message per
// (network slug, peer-nick folded under this network's CASEMAPPING) pair. Populated by the
// `peer_away` push event on the user-level Phoenix Channel topic
// (broadcast by Session.Server's apply_effects arm when a standalone
// 301 RPL_AWAY arrives — i.e. the operator /msg'd a peer who is away
// and upstream replied with the away message).
//
// Display rules:
//   * Banner renders inline at the top of the scrollback pane ONLY
//     when the selected window matches (slug, peer). On window
//     switch the banner unmounts; coming back re-mounts with the
//     stored entry.
//   * One entry per peer per network — a second 301 for the same peer
//     replaces the first. Server fires one event per upstream 301; the
//     "rate-limit" is the cic-side replacement (last-write-wins).
//   * Operator dismisses via the × on the banner.
//
// Identity-scoped: cleared on logout / token rotation. Per
// `feedback_no_localized_strings_server_side` cic owns the
// human-readable "is away" rendering — server emits structured fields
// only.

const exports_ = identityScopedStore((onIdentityChange) => {
  // Slug → folded peer nick → message. A nick is the peer's to choose, so the
  // inner record is a `ByKey` (issue 2453).
  const [peerAwayBySlug, setPeerAwayBySlug] = createSignal<Record<string, ByKey<string>>>({});

  onIdentityChange(() => setPeerAwayBySlug({}));

  const setPeerAway = (networkSlug: string, peer: string, message: string): void => {
    const peerKey = normalizeNick(peer, casemappingForSlug(networkSlug));
    setPeerAwayBySlug((prev) => ({
      ...prev,
      [networkSlug]: withKey(prev[networkSlug], peerKey, message),
    }));
  };

  const dismissPeerAway = (networkSlug: string, peer: string): void => {
    const peerKey = normalizeNick(peer, casemappingForSlug(networkSlug));
    setPeerAwayBySlug((prev) => {
      const networkEntries = prev[networkSlug];
      if (!networkEntries || atKey(networkEntries, peerKey) === undefined) return prev;
      const nextNetwork = withoutKey(networkEntries, peerKey);
      const next = { ...prev };
      if (keyEntries(nextNetwork).length === 0) {
        delete next[networkSlug];
      } else {
        next[networkSlug] = nextNetwork;
      }
      return next;
    });
  };

  return { peerAwayBySlug, setPeerAway, dismissPeerAway };
});

export const peerAwayBySlug = exports_.peerAwayBySlug;
export const setPeerAway = exports_.setPeerAway;
export const dismissPeerAway = exports_.dismissPeerAway;
