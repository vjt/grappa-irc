import { describe, expect, it } from "vitest";
import { type ActiveWindow, orderUnreadWindows } from "../lib/activeWindows";
import { type ChannelKey, channelKey } from "../lib/channelKey";

// GH #235 — pure ordering for the "jump to next active window" (Alt+A)
// affordance. The fn must:
//   * include ONLY windows with unread activity (unreadCounts > 0),
//   * put mention/highlight channels AND query (DM) windows in the
//     first tier, ahead of ordinary channel traffic,
//   * within a tier, order chronologically by activity time (oldest
//     first — the natural "clear your backlog in order" cycle),
//   * break activity-time ties by stable flat (sidebar) order.
//
// Inputs are plain data so the fn is unit-testable without a reactive
// context — the reactive `activeWindows` memo feeds it the live signals.

const ck = channelKey;

// Build the map inputs from (window, value) pairs using the PRODUCTION
// key derivation (channelKey) — never hand-craft `"slug name"` strings,
// so the test folds channel names exactly as production does.
const counts = (pairs: Array<[ActiveWindow, number]>): Record<ChannelKey, number> => {
  const out: Record<ChannelKey, number> = {};
  for (const [w, n] of pairs) out[ck(w.networkSlug, w.channelName)] = n;
  return out;
};

const chan = (name: string): ActiveWindow => ({
  networkSlug: "net",
  channelName: name,
  kind: "channel",
});
const query = (nick: string): ActiveWindow => ({
  networkSlug: "net",
  channelName: nick,
  kind: "query",
});

const names = (list: ActiveWindow[]): string[] => list.map((w) => w.channelName);

describe("orderUnreadWindows", () => {
  it("returns empty when there are no candidates", () => {
    expect(
      orderUnreadWindows({ candidates: [], unread: {}, mentions: {}, activityId: {} }),
    ).toEqual([]);
  });

  it("returns empty when no candidate has unread activity", () => {
    const c = [chan("#a"), query("bob")];
    expect(orderUnreadWindows({ candidates: c, unread: {}, mentions: {}, activityId: {} })).toEqual(
      [],
    );
  });

  it("includes only windows whose unread count is greater than zero", () => {
    const a = chan("#a");
    const b = chan("#b");
    const out = orderUnreadWindows({
      candidates: [a, b],
      unread: counts([
        [a, 0],
        [b, 3],
      ]),
      mentions: {},
      activityId: {},
    });
    expect(names(out)).toEqual(["#b"]);
  });

  it("puts a query (DM) window ahead of an ordinary channel even when the channel's activity is newer", () => {
    const a = chan("#a");
    const bob = query("bob");
    const out = orderUnreadWindows({
      candidates: [a, bob],
      unread: counts([
        [a, 3],
        [bob, 1],
      ]),
      mentions: {},
      // channel #a has the NEWER activity, yet the query still wins on tier.
      activityId: counts([
        [a, 200],
        [bob, 100],
      ]),
    });
    expect(names(out)).toEqual(["bob", "#a"]);
  });

  it("puts a mentioned channel ahead of an ordinary channel even when the mention is older", () => {
    const ment = chan("#ment");
    const plain = chan("#plain");
    const out = orderUnreadWindows({
      candidates: [ment, plain],
      unread: counts([
        [ment, 1],
        [plain, 5],
      ]),
      mentions: counts([[ment, 1]]),
      // the mention is OLDER than the plain traffic; tier still wins.
      activityId: counts([
        [ment, 50],
        [plain, 300],
      ]),
    });
    expect(names(out)).toEqual(["#ment", "#plain"]);
  });

  it("orders within a tier chronologically (oldest activity first)", () => {
    const a = chan("#a");
    const b = chan("#b");
    const c = chan("#c");
    const out = orderUnreadWindows({
      // flat order c,a,b — but chronology must override it.
      candidates: [c, a, b],
      unread: counts([
        [a, 1],
        [b, 1],
        [c, 1],
      ]),
      mentions: {},
      activityId: counts([
        [c, 300],
        [a, 100],
        [b, 200],
      ]),
    });
    expect(names(out)).toEqual(["#a", "#b", "#c"]);
  });

  it("breaks activity-time ties by stable flat (sidebar) order", () => {
    const x = chan("#x");
    const y = chan("#y");
    const out = orderUnreadWindows({
      candidates: [x, y],
      unread: counts([
        [x, 1],
        [y, 1],
      ]),
      mentions: {},
      // both seed-only (no local rows) → activityId 0 → tie → flat order.
      activityId: {},
    });
    expect(names(out)).toEqual(["#x", "#y"]);
  });

  it("orders an all-query set chronologically within the first tier", () => {
    const zoe = query("zoe");
    const alice = query("alice");
    const out = orderUnreadWindows({
      candidates: [zoe, alice],
      unread: counts([
        [zoe, 1],
        [alice, 1],
      ]),
      mentions: {},
      activityId: counts([
        [zoe, 200],
        [alice, 100],
      ]),
    });
    expect(names(out)).toEqual(["alice", "zoe"]);
  });

  it("excludes a window that has a mention count but zero unread", () => {
    const m = chan("#m");
    const o = chan("#o");
    const out = orderUnreadWindows({
      candidates: [m, o],
      unread: counts([[o, 1]]),
      // #m carries a mention but nothing unread — no jump target.
      mentions: counts([[m, 2]]),
      activityId: {},
    });
    expect(names(out)).toEqual(["#o"]);
  });
});
