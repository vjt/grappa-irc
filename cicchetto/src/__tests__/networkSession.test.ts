import { describe, expect, it } from "vitest";
import type { Network } from "../lib/api";
import { hasNoLiveSession } from "../lib/networkSession";

// issue 2719 — the ONE statement of "this network has no live session, and the
// way back is a reconnect". Two kinds of caller read it: ComposeBox greys the
// compose box on it, and the join verb (`channelJoin.joinChannel`) reconnects
// before it joins. A join sent to a network with no session answers 404 and
// opens nothing, so the two must never disagree about which states those are.
//
// The `as unknown as Network` cast is the networkParked.test.ts posture: the
// four `connection_state` values are the inputs, and naming each one through
// the type would only let the compiler restate what it already knows.
const net = (connection_state: string): Network =>
  ({
    kind: "user",
    id: 1,
    slug: "azzurra",
    nick: "vjt",
    connection_state,
    connection_state_reason: null,
    connection_state_changed_at: null,
    inserted_at: "",
    updated_at: "",
  }) as unknown as Network;

describe("issue 2719 — hasNoLiveSession", () => {
  it("says yes to parked: the session was stopped on purpose", () => {
    expect(hasNoLiveSession(net("parked"))).toBe(true);
  });

  it("says yes to failed: the session was stopped by mark_failed", () => {
    expect(hasNoLiveSession(net("failed"))).toBe(true);
  });

  it("says no to connected", () => {
    expect(hasNoLiveSession(net("connected"))).toBe(false);
  });

  // #1675 — a failing network's session is alive and retrying, and the
  // server holds a JOIN sent to it until 001 (issue 2114). Reconnecting it
  // would park-and-respawn a session that is already on its way back.
  it("says no to failing: the session is alive and retrying on its own", () => {
    expect(hasNoLiveSession(net("failing"))).toBe(false);
  });

  // A slug the store does not hold is not "disconnected": it is a network
  // this subject has no binding for, and the server's answer is the honest
  // one. Saying yes here would send a reconnect PATCH for a network the
  // subject cannot reconnect.
  it("says no to an absent network", () => {
    expect(hasNoLiveSession(undefined)).toBe(false);
  });
});
