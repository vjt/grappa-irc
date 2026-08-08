import { describe, expect, it } from "vitest";
import {
  type ActiveWindow,
  classifyNextActive,
  isPriorityWindow,
  orderUnreadWindows,
} from "../lib/activeWindows";
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
      orderUnreadWindows({ candidates: [], unread: {}, mentions: {}, activityId: {}, muted: {} }),
    ).toEqual([]);
  });

  it("returns empty when no candidate has unread activity", () => {
    const c = [chan("#a"), query("bob")];
    expect(
      orderUnreadWindows({ candidates: c, unread: {}, mentions: {}, activityId: {}, muted: {} }),
    ).toEqual([]);
  });

  it("includes only windows whose unread count is greater than zero", () => {
    const a = chan("#a");
    const b = chan("#b");
    const out = orderUnreadWindows({
      candidates: [a, b],
      muted: {},
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
      muted: {},
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
      muted: {},
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
      muted: {},
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
      muted: {},
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
      muted: {},
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
      muted: {},
      unread: counts([[o, 1]]),
      // #m carries a mention but nothing unread — no jump target.
      mentions: counts([[m, 2]]),
      activityId: {},
    });
    expect(names(out)).toEqual(["#o"]);
  });
});

// #1018 — a conversation the operator MUTED (#866) is not a stop on the
// cycle. The mute is keyed by the FOLDED conversation, per-subject and
// network-agnostic (`MutedTargets`), and expiry was already resolved by
// the reader (`notificationPrefs()`), so the ordering takes the live map
// and asks a pure membership question — no clock, no second fold.
//
// Badges and counters are NOT touched (#866 Q4): this filters the
// NAVIGATION order only.

describe("orderUnreadWindows — muted conversations (#1018)", () => {
  // #1038 — mute keys are the composite ChannelKey, built with the SAME
  // production `ck` the unread/activity maps above use. These were bare
  // channel names until the network entered the key; a bare one now matches
  // nothing, which is the intended fail-OPEN direction.
  it("skips a muted channel and lands on the next unread window", () => {
    const noisy = chan("#noisy");
    const quiet = chan("#quiet");
    const out = orderUnreadWindows({
      candidates: [noisy, quiet],
      muted: { [ck("net", "#noisy")]: { until: null } },
      unread: counts([
        [noisy, 9],
        [quiet, 1],
      ]),
      mentions: {},
      // the muted channel is the OLDER activity, so without the filter it
      // would head the list.
      activityId: counts([
        [noisy, 100],
        [quiet, 200],
      ]),
    });
    expect(names(out)).toEqual(["#quiet"]);
  });

  it("keys a muted QUERY on the PEER, never on own nick", () => {
    const bob = query("bob");
    const carol = query("carol");
    const out = orderUnreadWindows({
      candidates: [bob, carol],
      // "vjt" is the operator's own nick — an inbound DM row carries it in
      // `channel`, and keying on that would collapse every DM onto ONE mute
      // entry. Muting own nick must silence NOTHING here.
      muted: { [ck("net", "vjt")]: { until: null } },
      unread: counts([
        [bob, 1],
        [carol, 1],
      ]),
      mentions: {},
      activityId: counts([
        [bob, 100],
        [carol, 200],
      ]),
    });
    expect(names(out)).toEqual(["bob", "carol"]);

    const outMutedPeer = orderUnreadWindows({
      candidates: [bob, carol],
      muted: { [ck("net", "bob")]: { until: null } },
      unread: counts([
        [bob, 1],
        [carol, 1],
      ]),
      mentions: {},
      activityId: counts([
        [bob, 100],
        [carol, 200],
      ]),
    });
    expect(names(outMutedPeer)).toEqual(["carol"]);
  });

  it("folds the window name against the stored key (a mute is case-insensitive, A-Z only)", () => {
    const shouty = chan("#NoIsY");
    const bracket = chan("#chan{1}");
    const out = orderUnreadWindows({
      candidates: [shouty, bracket],
      // `#chan[1]` is a DIFFERENT conversation from `#chan{1}` — the fold
      // touches `A-Z` only (#525), so the bracket window is NOT muted.
      muted: { [ck("net", "#noisy")]: { until: null }, [ck("net", "#chan[1]")]: { until: null } },
      unread: counts([
        [shouty, 1],
        [bracket, 1],
      ]),
      mentions: {},
      activityId: {},
    });
    expect(names(out)).toEqual(["#chan{1}"]);
  });

  it("keeps skipping a muted window that carries a MENTION (#866 Q2: the mute wins)", () => {
    const muted = chan("#muted");
    const plain = chan("#plain");
    const out = orderUnreadWindows({
      candidates: [muted, plain],
      muted: { [ck("net", "#muted")]: { until: null } },
      unread: counts([
        [muted, 1],
        [plain, 1],
      ]),
      mentions: counts([[muted, 3]]),
      activityId: {},
    });
    expect(names(out)).toEqual(["#plain"]);
  });

  it("returns empty when EVERY unread window is muted — the cycle is a no-op", () => {
    const a = chan("#a");
    const bob = query("bob");
    const out = orderUnreadWindows({
      candidates: [a, bob],
      muted: { [ck("net", "#a")]: { until: null }, [ck("net", "bob")]: { until: null } },
      unread: counts([
        [a, 1],
        [bob, 1],
      ]),
      mentions: {},
      activityId: {},
    });
    expect(out).toEqual([]);
  });

  it("a mute on ONE network leaves the same-named window on another a stop (#1038)", () => {
    // The cycle half of #1038. Pre-fix both windows shared the bare key
    // `#linux`, so muting one dropped BOTH from the Alt+A cycle and the
    // operator could not reach the network they had not silenced.
    const here: ActiveWindow = { networkSlug: "azzurra", channelName: "#linux", kind: "channel" };
    const there: ActiveWindow = { networkSlug: "libera", channelName: "#linux", kind: "channel" };
    const out = orderUnreadWindows({
      candidates: [here, there],
      muted: { [ck("azzurra", "#linux")]: { until: null } },
      unread: counts([
        [here, 1],
        [there, 1],
      ]),
      mentions: {},
      activityId: {},
    });

    expect(out).toEqual([there]);
  });

  it("a BARE (pre-#1038) stored key silences nothing — it fails OPEN", () => {
    const noisy = chan("#noisy");
    const out = orderUnreadWindows({
      candidates: [noisy],
      muted: { "#noisy": { until: null } },
      unread: counts([[noisy, 1]]),
      mentions: {},
      activityId: {},
    });

    expect(names(out)).toEqual(["#noisy"]);
  });

  it("tolerates a server that sends no muted_targets at all (cic ships ahead of the BEAM)", () => {
    const a = chan("#a");
    const out = orderUnreadWindows({
      candidates: [a],
      muted: undefined,
      unread: counts([[a, 1]]),
      mentions: {},
      activityId: {},
    });
    expect(names(out)).toEqual(["#a"]);
  });

  it("does not skip a window whose mute has ELAPSED — the reader already dropped it", () => {
    // `notificationPrefs()` (withLiveMutes) resolves expiry before the map
    // reaches here, so an elapsed snooze arrives as an ABSENT key. This
    // pins that the ordering adds no second clock of its own: an entry that
    // is still present silences, whatever its `until` says.
    const a = chan("#a");
    const out = orderUnreadWindows({
      candidates: [a],
      muted: {},
      unread: counts([[a, 1]]),
      mentions: {},
      activityId: {},
    });
    expect(names(out)).toEqual(["#a"]);
  });
});

// #280 — the "next" badge COLOR derives from the TIER of the highest-
// priority pending window (the ordered-list HEAD): RED (priority) when
// that window is a query (DM) OR carries a mention; BLUE (normal) when it
// is an ordinary channel. The tier predicate is SHARED with
// orderUnreadWindows (isPriorityWindow) so the badge color can never
// disagree with the ordering / auto-hide. #267's client→server mention-
// counter migration is orthogonal (the color needs the target's KIND,
// not the provenance of the count) and is deferred to #267.

describe("isPriorityWindow", () => {
  it("a query (DM) window is priority regardless of mentions", () => {
    expect(isPriorityWindow(query("bob"), {})).toBe(true);
  });

  it("a channel with mentions > 0 is priority", () => {
    const m = chan("#ment");
    expect(isPriorityWindow(m, counts([[m, 1]]))).toBe(true);
  });

  it("a plain channel with no mention entry is not priority", () => {
    expect(isPriorityWindow(chan("#plain"), {})).toBe(false);
  });

  it("a channel with a zero mention entry is not priority", () => {
    const c = chan("#c");
    expect(isPriorityWindow(c, counts([[c, 0]]))).toBe(false);
  });
});

describe("classifyNextActive", () => {
  it("returns null when the ordered list is empty", () => {
    expect(classifyNextActive([], {})).toBeNull();
  });

  it("priority when the head is a query (DM)", () => {
    expect(classifyNextActive([query("bob"), chan("#a")], {})).toBe("priority");
  });

  it("priority when the head is a mentioned channel", () => {
    const ment = chan("#ment");
    expect(classifyNextActive([ment, chan("#a")], counts([[ment, 2]]))).toBe("priority");
  });

  it("normal when the head is an ordinary channel", () => {
    expect(classifyNextActive([chan("#a"), chan("#b")], {})).toBe("normal");
  });

  it("classifies the HEAD only — trusts the list is already tier-ordered", () => {
    // A deliberately mis-ordered list (normal head, priority tail): the fn
    // reads the head, so it reports "normal". Ordering is orderUnreadWindows'
    // job; this documents that classifyNextActive does not re-scan.
    expect(classifyNextActive([chan("#a"), query("bob")], {})).toBe("normal");
  });
});
