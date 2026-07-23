// #247 — notifyWatch store: rfc1459 key folding, snapshot/list
// ingestion, and the baseline-vs-transition toast gate.
import { beforeEach, describe, expect, it, vi } from "vitest";
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

  // #364 cicchetto S4 — the fold must be ASCII-byte-level, EXACTLY
  // mirroring Grappa.IRC.Identifier.canonical_nick/1 (folds bytes A-Z
  // only). JS String.prototype.toLowerCase() is Unicode-aware and
  // OVER-folds non-ASCII, which the server never does — so a
  // Unicode-only-equal nick pair the server keeps distinct must stay
  // distinct here, or bracket/accented presence dots light the wrong row.
  it("case/bracket-differing nicks fold EQUAL under rfc1459", () => {
    expect(rfc1459Fold("Foo[1]")).toBe(rfc1459Fold("foo{1}"));
    expect(rfc1459Fold("Ni[k")).toBe(rfc1459Fold("ni{k"));
  });

  it("leaves non-ASCII bytes untouched (no Unicode over-fold)", () => {
    // Unicode toLowerCase would map É→é and merge these two into one
    // key; the server (ASCII lower()) keeps É, so we must too.
    expect(rfc1459Fold("CAFÉ")).toBe("cafÉ");
    expect(rfc1459Fold("CAFÉ")).not.toBe(rfc1459Fold("café"));
    // Turkish dotted capital-I: Unicode toLowerCase → "i̇" (i + combining
    // dot); the ASCII fold leaves it verbatim.
    expect(rfc1459Fold("İ")).toBe("İ");
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

// #364 cicchetto S3 — the store is now built inside `identityScopedStore`,
// so a logout / account switch auto-clears it. Pre-fix `resetNotifyWatch`
// was never wired to the token effect (dead prod code), so the previous
// account's watch list + presence dots + toasts leaked across a same-browser
// account switch. Drive rotation via `auth.setToken(...)` like the sibling
// awayStatus.test.ts; dynamic imports + resetModules so each test gets a
// fresh store instance bound to a fresh token signal.
describe("notifyWatch store — identity-rotation cleanup (#364 S3)", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  it("clears watch list, presence dots, and toasts on rotation (tokA → tokB)", async () => {
    localStorage.setItem("grappa-token", "tokA");
    const auth = await import("../lib/auth");
    const nw = await import("../lib/notifyWatch");
    nw._setScheduleExpiryForTest(() => {});

    nw.setNotifyList({ "42": [{ network_id: 42, nick: "Foo", added_at: "2026-07-18T00:00:00Z" }] });
    nw.applyPresenceSnapshot(42, { foo: "online" });
    nw.applyPresenceError({ network_id: 42, detail: "Monitor list is full" });

    expect(nw.watchByNetwork()[42]).toBeDefined();
    expect(nw.presenceByNetwork()[42]).toBeDefined();
    expect(nw.presenceToasts().length).toBe(1);

    auth.setToken("tokB");

    await vi.waitFor(() => {
      expect(nw.watchByNetwork()).toEqual({});
      expect(nw.presenceByNetwork()).toEqual({});
      expect(nw.presenceToasts()).toEqual([]);
    });
  });

  it("clears the store on logout (token → null)", async () => {
    localStorage.setItem("grappa-token", "tokA");
    const auth = await import("../lib/auth");
    const nw = await import("../lib/notifyWatch");

    nw.setNotifyList({ "7": [{ network_id: 7, nick: "Bar", added_at: "2026-07-18T00:00:00Z" }] });
    expect(nw.watchByNetwork()[7]).toBeDefined();

    auth.setToken(null);

    await vi.waitFor(() => {
      expect(nw.watchByNetwork()).toEqual({});
    });
  });
});
