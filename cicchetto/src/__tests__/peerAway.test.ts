import { afterEach, describe, expect, it } from "vitest";
import { dismissPeerAway, peerAwayBySlug, setPeerAway } from "../lib/peerAway";

// P-0b — peer-away store. The banner's render assertions live in
// PeerAwayBanner.test.tsx; these pin the store itself.

describe("peerAway store", () => {
  afterEach(() => {
    dismissPeerAway("azzurra", "alice");
  });

  // issue 2453 — a nick is the peer's to choose, and `constructor` and
  // `__proto__` are valid ones; "bob" runs first as the control.
  it.each(["bob", "constructor", "__proto__"])(
    "dismissing %s, which has no entry, leaves the store as it was",
    (peer) => {
      setPeerAway("azzurra", "alice", "Gone fishing");
      const before = peerAwayBySlug();

      dismissPeerAway("azzurra", peer);

      expect(peerAwayBySlug()).toBe(before);
    },
  );
});
