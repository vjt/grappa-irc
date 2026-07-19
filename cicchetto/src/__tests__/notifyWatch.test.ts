// #247 — notifyWatch store: rfc1459 key folding, snapshot/list
// ingestion, and the baseline-vs-transition toast gate.
import { beforeEach, describe, expect, it } from "vitest";
import {
  _setScheduleExpiryForTest,
  applyPresenceChange,
  applyPresenceError,
  applyPresenceSnapshot,
  dismissToast,
  presenceByNetwork,
  presenceFor,
  presenceToasts,
  resetNotifyWatch,
  rfc1459Fold,
  setNotifyList,
  watchByNetwork,
} from "../lib/notifyWatch";

describe("rfc1459Fold", () => {
  it("mirrors the server fold: A-Z plus [ ] \\ ~ → { } | ^", () => {
    expect(rfc1459Fold("Foo[1]")).toBe("foo{1}");
    expect(rfc1459Fold("BAR]x")).toBe("bar}x");
    expect(rfc1459Fold("a\\b~c")).toBe("a|b^c");
  });
});

describe("notifyWatch store", () => {
  beforeEach(() => {
    resetNotifyWatch();
    // No auto-expiry during tests — expiry is driven explicitly.
    _setScheduleExpiryForTest(() => {});
  });

  it("setNotifyList coerces string network keys and drops junk", () => {
    setNotifyList({
      "42": [{ network_id: 42, nick: "Foo", added_at: "2026-07-18T00:00:00Z" }],
      junk: [{ network_id: 1, nick: "x", added_at: "" }],
    });

    expect(watchByNetwork()[42]?.map((e) => e.nick)).toEqual(["Foo"]);
    expect(Object.keys(watchByNetwork())).toEqual(["42"]);
  });

  it("applyPresenceSnapshot paints dots wholesale", () => {
    applyPresenceSnapshot(42, { "foo{1}": "online", bar: "offline" });

    expect(presenceFor(42, "Foo[1]")).toBe("online");
    expect(presenceFor(42, "BAR")).toBe("offline");
    expect(presenceFor(42, "stranger")).toBe("unknown");
  });

  it("initial reports paint the dot but never toast", () => {
    applyPresenceChange({
      network_id: 42,
      nick: "Foo",
      presence: "online",
      initial: true,
      ts: "2026-07-18T12:00:00Z",
    });

    expect(presenceFor(42, "foo")).toBe("online");
    expect(presenceToasts()).toEqual([]);
  });

  it("genuine transitions toast and are dismissable", () => {
    applyPresenceChange({
      network_id: 42,
      nick: "Foo",
      presence: "offline",
      initial: false,
      ts: "2026-07-18T12:00:00Z",
    });

    const toasts = presenceToasts();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({
      kind: "transition",
      networkId: 42,
      nick: "Foo",
      presence: "offline",
    });

    dismissToast(toasts[0]!.id);
    expect(presenceToasts()).toEqual([]);
  });

  it("presence_error queues an error toast (review R2: production-visible)", () => {
    applyPresenceError({ network_id: 42, detail: "aaa,bbb" });

    const toasts = presenceToasts();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({ kind: "error", networkId: 42, detail: "aaa,bbb" });

    dismissToast(toasts[0]!.id);
    expect(presenceToasts()).toEqual([]);
  });

  it("error toasts self-expire like transition toasts", () => {
    const scheduled: Array<() => void> = [];
    _setScheduleExpiryForTest((fn) => {
      scheduled.push(fn);
    });

    applyPresenceError({ network_id: 1, detail: "" });

    expect(presenceToasts()).toHaveLength(1);
    scheduled[0]!();
    expect(presenceToasts()).toEqual([]);
  });

  it("toasts self-expire via the injected scheduler", () => {
    const scheduled: Array<() => void> = [];
    _setScheduleExpiryForTest((fn) => {
      scheduled.push(fn);
    });

    applyPresenceChange({
      network_id: 1,
      nick: "Foo",
      presence: "online",
      initial: false,
      ts: "t",
    });

    expect(presenceToasts()).toHaveLength(1);
    scheduled[0]!();
    expect(presenceToasts()).toEqual([]);
  });

  it("resetNotifyWatch wipes everything", () => {
    setNotifyList({ "1": [{ network_id: 1, nick: "Foo", added_at: "t" }] });
    applyPresenceSnapshot(1, { foo: "online" });
    applyPresenceChange({
      network_id: 1,
      nick: "Foo",
      presence: "offline",
      initial: false,
      ts: "t",
    });

    resetNotifyWatch();

    expect(watchByNetwork()).toEqual({});
    expect(presenceByNetwork()).toEqual({});
    expect(presenceToasts()).toEqual([]);
  });
});
