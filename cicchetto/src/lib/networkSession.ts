import type { ConnectionState, Network } from "./api";

// issue 2719 — the ONE statement of "this network has no live session, and the
// way back is a reconnect".
//
// It lived as ComposeBox's private `NETWORK_GREYED_STATES` Set, which greys
// the compose box and offers the #1331 Reconnect. The join verb needs the same
// fact for the opposite reason: a JOIN sent to a network with no session
// answers 404 `not_found` (S14 collapses `:no_session` into it), so the verb
// reconnects first. Two copies of the set would drift into a compose box
// greyed on a state the join does not reconnect, or the reverse.
//
// A `Record` checked with `satisfies`, not a `Set`: a fifth connection state
// the server adds is then a tsc error HERE until somebody decides whether it
// has a session. A `Set` of the members that say yes would file it under "no"
// without a word — issue 2693's rule for `WindowState`, applied to
// `ConnectionState` by analogy.
//
// `failing` is NO, deliberately (#1675): its session is alive and retrying on
// its own, and the server holds a JOIN sent to it until 001 (issue 2114).
//
// NOT the Sidebar's rule, and not `isNetworkParked`. The Sidebar greys only
// `failed`, because a `parked` network has left it (issue 1985) and has no
// header left to grey; `networkParked.ts` answers "is it in the UI at all".
// Each of the three asks a different question of the same column.
const NO_LIVE_SESSION = {
  connected: false,
  failing: false,
  parked: true,
  failed: true,
} as const satisfies Record<ConnectionState, boolean>;

/**
 * True when `net` has no session process to serve a request, so the way back
 * is a reconnect. An absent network is `false`: a slug the store does not hold
 * is not a disconnected network, and the server's answer is the honest one.
 */
export function hasNoLiveSession(net: Network | undefined): boolean {
  return net !== undefined && NO_LIVE_SESSION[net.connection_state];
}
