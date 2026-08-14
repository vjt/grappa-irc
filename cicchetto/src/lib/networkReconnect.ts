import { type Accessor, createSignal } from "solid-js";
import { ApiError, patchNetwork } from "./api";
import { token } from "./auth";
import { friendlyApiError } from "./friendlyApiError";

// #1331 — the unpark verb, shared by every surface that offers it.
//
// The PATCH itself is one line, but the UX around it is not: an awaited
// request with a pending latch (the button disables and relabels) and a
// friendly-mapped failure the operator must read
// (feedback_silent_retry_anti_pattern). That trio lived inside HomePane's
// `DisconnectedRow`; #1331 puts a second reconnect in the greyed compose
// seam, where the operator actually meets a parked network, and a second
// hand-rolled copy would be the drift this repo keeps paying for.
//
// Deliberately NOT `lib/reconnect.ts`: despite the name, that is the #282
// vhost bounce — it selects `connected` networks and does park-THEN-connect.
// Pointing it at a parked network would be the wrong verb on the wrong set.
//
// NO confirmation modal, and that is a decision on record, not an omission:
// #283 (2026-07-20) settled that Reconnect is the awaited-PATCH UX while
// DISCONNECT is the one behind the #195 confirm modal — see the comment on
// `HomePane`'s `onDisconnect`. Reconnect is also trivially reversible, which
// is the property the modal exists to protect. Every caller must keep that
// shape or the surfaces diverge again.
//
// The error SINK is the caller's, because each surface already owns an error
// line and inventing a second one next to it is how a component ends up with
// two contradictory alerts: HomePane has its `role="alert"` span, ComposeBox
// has the #356 feedback seam. `null` means "clear it" and is emitted once at
// the start of every attempt, so a previous failure never outlives the retry
// that supersedes it.

export type NetworkReconnect = {
  pending: Accessor<boolean>;
  reconnect: (networkSlug: string) => Promise<void>;
};

export function createNetworkReconnect(
  onError: (message: string | null) => void,
): NetworkReconnect {
  const [pending, setPending] = createSignal(false);

  const reconnect = async (networkSlug: string): Promise<void> => {
    const t = token();
    if (t === null) return;
    onError(null);
    setPending(true);
    try {
      await patchNetwork(t, networkSlug, { connection_state: "connected" });
      // No success state to set: the server emits connection_state_changed,
      // userTopic patches the networks store in place, and every surface
      // reading that store re-renders itself out of the parked shape.
    } catch (err) {
      onError(err instanceof ApiError ? friendlyApiError(err) : "reconnect failed (unknown error)");
    } finally {
      setPending(false);
    }
  };

  return { pending, reconnect };
}
