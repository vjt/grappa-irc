import { createSignal } from "solid-js";
import { identityScopedStore } from "./identityScopedStore";

// P-0e — invite-ack ephemeral store. Append-only list of (peer, ts) per
// (network slug, channel-name lowercased). Populated by the `invite_ack`
// push event on the channel's per-channel topic (broadcast by
// Session.Server's apply_effects arm when 341 RPL_INVITING arrives —
// i.e. the operator issued `/invite peer #chan` and upstream confirmed
// the relay).
//
// Display rules:
//   * Synthetic inline rows render at the bottom of the channel's
//     ScrollbackPane, ordered by arrival time. Multiple invites in a
//     row → multiple rows (history of operator intent — banner-shape
//     would lose the second invite under last-write-wins).
//   * NOT persisted — invite-ack is immediate-feedback, not audit log.
//     Lost on full scrollback refetch / page refresh; that's fine,
//     operators only need the immediate confirmation.
//
// Identity-scoped: cleared on logout / token rotation. Per
// `feedback_no_localized_strings_server_side` cic owns the
// human-readable "→ invited <peer>" rendering — server emits structured
// fields only.

export type InviteAckEntry = {
  peer: string;
  // Monotonic insertion sequence (closure-local counter, NOT a clock).
  // Used as stable sort key by `InviteAckRows` when aggregating rows
  // across multiple target-channel buckets — `Date.now()`-resolution
  // collisions in same-millisecond appends would otherwise reorder
  // arrivals from different buckets unpredictably.
  ts: number;
};

const exports_ = identityScopedStore((onIdentityChange) => {
  const [inviteAckBySlug, setInviteAckBySlug] = createSignal<
    Record<string, Record<string, InviteAckEntry[]>>
  >({});

  // Monotonic insertion counter — never resets across the identity
  // lifecycle. Reset alongside the store on identity change so the
  // ordering invariant holds within a session.
  let seq = 0;

  onIdentityChange(() => {
    setInviteAckBySlug({});
    seq = 0;
  });

  const appendInviteAck = (networkSlug: string, channel: string, peer: string): void => {
    const channelKey = channel.toLowerCase();
    seq += 1;
    const entry: InviteAckEntry = { peer, ts: seq };
    setInviteAckBySlug((prev) => {
      const networkEntries = prev[networkSlug] ?? {};
      const channelEntries = networkEntries[channelKey] ?? [];
      return {
        ...prev,
        [networkSlug]: {
          ...networkEntries,
          [channelKey]: [...channelEntries, entry],
        },
      };
    });
  };

  return { inviteAckBySlug, appendInviteAck };
});

export const inviteAckBySlug = exports_.inviteAckBySlug;
export const appendInviteAck = exports_.appendInviteAck;
