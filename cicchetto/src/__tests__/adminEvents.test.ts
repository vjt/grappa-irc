import type { Channel } from "phoenix";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WireAdminEvent } from "../lib/api";

// M-11 — adminEvents store ingestion + bounded ring + snapshot
// path. Mock the socket join so the unit suite stays insulated
// from a real WS connection (e2e covers that).

const joinAdminEventsMock = vi.fn();
vi.mock("../lib/socket", () => ({
  joinAdminEvents: () => joinAdminEventsMock(),
}));

import {
  adminEvents,
  installAdminEvents,
  startAdminEventsSubscription,
  uninstallAdminEvents,
} from "../lib/adminEvents";

// Fake Channel that captures the .on handlers so the test can fire
// snapshot / event payloads at will. Matches the slim slice of
// phoenix.js's Channel API the production module touches.
function makeFakeChannel(): {
  channel: Channel;
  fireSnapshot: (events: WireAdminEvent[]) => void;
  fireEvent: (event: WireAdminEvent) => void;
  leftCount: () => number;
} {
  let snapshotCb: ((p: { events: WireAdminEvent[] }) => void) | null = null;
  let eventCb: ((p: WireAdminEvent) => void) | null = null;
  let leftCount = 0;

  const channel = {
    on: (name: string, cb: unknown) => {
      if (name === "snapshot") snapshotCb = cb as (p: { events: WireAdminEvent[] }) => void;
      if (name === "event") eventCb = cb as (p: WireAdminEvent) => void;
      return 0;
    },
    leave: () => {
      leftCount += 1;
      return { receive: () => ({ receive: () => undefined }) };
    },
  } as unknown as Channel;

  return {
    channel,
    fireSnapshot: (events) => snapshotCb?.({ events }),
    fireEvent: (event) => eventCb?.(event),
    leftCount: () => leftCount,
  };
}

beforeEach(() => {
  uninstallAdminEvents();
  expect(adminEvents()).toEqual([]);
  joinAdminEventsMock.mockReset();
});

describe("adminEvents store — install + snapshot + ingest", () => {
  it("populates the store from a snapshot push", () => {
    const fake = makeFakeChannel();
    installAdminEvents(fake.channel);

    const seed: WireAdminEvent[] = [
      { kind: "reaper_swept", count: 7, at: "2026-05-16T12:00:00Z" },
      {
        kind: "circuit_open",
        network_id: 1,
        network_slug: "azzurra",
        threshold: 3,
        cooldown_ms: 60_000,
        at: "2026-05-16T12:00:01Z",
      },
    ];
    fake.fireSnapshot(seed);

    expect(adminEvents()).toEqual(seed);
  });

  it("prepends new events from event pushes (newest-first)", () => {
    const fake = makeFakeChannel();
    installAdminEvents(fake.channel);

    fake.fireEvent({ kind: "reaper_swept", count: 1, at: "t1" } as WireAdminEvent);
    fake.fireEvent({ kind: "reaper_swept", count: 2, at: "t2" } as WireAdminEvent);
    fake.fireEvent({ kind: "reaper_swept", count: 3, at: "t3" } as WireAdminEvent);

    const list = adminEvents();
    expect(list.length).toBe(3);
    expect((list[0] as { count: number }).count).toBe(3);
    expect((list[2] as { count: number }).count).toBe(1);
  });

  it("caps the ring buffer at 200 events", () => {
    const fake = makeFakeChannel();
    installAdminEvents(fake.channel);

    for (let i = 0; i < 205; i++) {
      fake.fireEvent({
        kind: "reaper_swept",
        count: i,
        at: `t${i}`,
      } as WireAdminEvent);
    }

    const list = adminEvents();
    expect(list.length).toBe(200);
    expect((list[0] as { count: number }).count).toBe(204);
    expect((list[199] as { count: number }).count).toBe(5);
  });

  it("snapshot also caps at 200 on first ingest", () => {
    const fake = makeFakeChannel();
    installAdminEvents(fake.channel);

    const big = Array.from({ length: 250 }, (_, i) => ({
      kind: "reaper_swept" as const,
      count: i,
      at: `t${i}`,
    }));
    fake.fireSnapshot(big);

    expect(adminEvents().length).toBe(200);
  });
});

describe("adminEvents store — lifecycle", () => {
  it("install is idempotent for the same channel reference", () => {
    const fake = makeFakeChannel();
    installAdminEvents(fake.channel);
    installAdminEvents(fake.channel);
    fake.fireEvent({ kind: "reaper_swept", count: 1, at: "t" } as WireAdminEvent);
    expect(adminEvents().length).toBe(1);
  });

  it("uninstall clears the store and calls channel.leave", () => {
    const fake = makeFakeChannel();
    installAdminEvents(fake.channel);
    fake.fireEvent({ kind: "reaper_swept", count: 1, at: "t" } as WireAdminEvent);
    expect(adminEvents().length).toBe(1);

    uninstallAdminEvents();
    expect(adminEvents()).toEqual([]);
    expect(fake.leftCount()).toBe(1);
  });

  it("uninstall is safe when nothing is installed", () => {
    expect(() => uninstallAdminEvents()).not.toThrow();
    expect(adminEvents()).toEqual([]);
  });
});

describe("startAdminEventsSubscription", () => {
  it("joins the channel and installs handlers in one call", () => {
    const fake = makeFakeChannel();
    joinAdminEventsMock.mockReturnValue(fake.channel);

    const ch = startAdminEventsSubscription();
    expect(joinAdminEventsMock).toHaveBeenCalledTimes(1);
    expect(ch).toBe(fake.channel);

    fake.fireEvent({ kind: "reaper_swept", count: 42, at: "t" } as WireAdminEvent);
    expect((adminEvents()[0] as { count: number }).count).toBe(42);
  });
});
