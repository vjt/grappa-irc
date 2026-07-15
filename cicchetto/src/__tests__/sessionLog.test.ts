import type { Channel } from "phoenix";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionLogWireT } from "../lib/wireTypes";

// #215 — sessionLog store: live `session_log_event` ingestion +
// bounded ring + narrower boundary. Rides the SAME admin channel as
// adminEvents (`grappa:admin:events`); the wiring is installed via
// `installSessionLog(channel)` (called from adminEvents.ts's
// installAdminEvents so both consumers share one channel). Mock the
// socket the same way adminEvents.test.ts does so this unit suite
// stays insulated from a real WS connection (e2e covers that).

import { installSessionLog, resetSessionLog, sessionLogEvents } from "../lib/sessionLog";

let counter = 0;
const entry = (overrides: Partial<SessionLogWireT>): SessionLogWireT => {
  counter += 1;
  return {
    id: counter,
    session_id: "sess-abc",
    event: "connected",
    subject_kind: "user",
    network_id: 1,
    network_slug: "azzurra",
    nick: "vjt",
    reason: null,
    clean: null,
    duration_ms: null,
    delay_ms: null,
    attempt: null,
    at: "2026-07-15T12:00:00Z",
    ...overrides,
  };
};

// Fake Channel that captures the `session_log_event` handler so the
// test can fire payloads at will. Matches the slim slice of phoenix.js's
// Channel API the production module touches (mirror of
// adminEvents.test.ts's makeFakeChannel).
function makeFakeChannel(): {
  channel: Channel;
  fire: (entry: SessionLogWireT) => void;
  fireRaw: (payload: unknown) => void;
} {
  let cb: ((p: unknown) => void) | null = null;
  const channel = {
    on: (name: string, handler: unknown) => {
      if (name === "session_log_event") cb = handler as (p: unknown) => void;
      return 0;
    },
    leave: () => ({ receive: () => ({ receive: () => undefined }) }),
  } as unknown as Channel;
  return {
    channel,
    fire: (e) => cb?.({ kind: "session_log_event", entry: e }),
    fireRaw: (payload) => cb?.(payload),
  };
}

beforeEach(() => {
  resetSessionLog();
  expect(sessionLogEvents()).toEqual([]);
});

describe("sessionLog store — install + ingest", () => {
  it("prepends new entries newest-first", () => {
    const fake = makeFakeChannel();
    installSessionLog(fake.channel);

    fake.fire(entry({ id: 1, event: "connected" }));
    fake.fire(entry({ id: 2, event: "registered" }));
    fake.fire(entry({ id: 3, event: "disconnected", clean: true, reason: "quit" }));

    const list = sessionLogEvents();
    expect(list.length).toBe(3);
    expect(list[0]?.id).toBe(3);
    expect(list[0]?.event).toBe("disconnected");
    expect(list[2]?.id).toBe(1);
  });

  it("caps the ring buffer at 200 entries", () => {
    const fake = makeFakeChannel();
    installSessionLog(fake.channel);

    for (let i = 1; i <= 205; i++) {
      fake.fire(entry({ id: i }));
    }

    const list = sessionLogEvents();
    expect(list.length).toBe(200);
    // Newest-first: the last-fired (id 205) is at the head, id 6 at the tail.
    expect(list[0]?.id).toBe(205);
    expect(list[199]?.id).toBe(6);
  });
});

describe("sessionLog store — lifecycle", () => {
  it("install is idempotent for the same channel reference", () => {
    const fake = makeFakeChannel();
    installSessionLog(fake.channel);
    installSessionLog(fake.channel);
    fake.fire(entry({ id: 1 }));
    expect(sessionLogEvents().length).toBe(1);
  });

  it("reset clears the store and allows a fresh install on a new channel", () => {
    const first = makeFakeChannel();
    installSessionLog(first.channel);
    first.fire(entry({ id: 1 }));
    expect(sessionLogEvents().length).toBe(1);

    resetSessionLog();
    expect(sessionLogEvents()).toEqual([]);

    const second = makeFakeChannel();
    installSessionLog(second.channel);
    second.fire(entry({ id: 2 }));
    expect(sessionLogEvents().length).toBe(1);
    expect(sessionLogEvents()[0]?.id).toBe(2);
  });
});

describe("sessionLog store — narrower boundary", () => {
  it("drops a malformed entry payload without crashing or polluting the ring", () => {
    const fake = makeFakeChannel();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    installSessionLog(fake.channel);

    // `id` wrong-typed — the narrower rejects the whole entry.
    expect(() =>
      fake.fireRaw({ kind: "session_log_event", entry: { ...entry({}), id: "nope" } }),
    ).not.toThrow();

    expect(sessionLogEvents()).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("drops a payload missing the entry envelope", () => {
    const fake = makeFakeChannel();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    installSessionLog(fake.channel);

    fake.fireRaw({ kind: "session_log_event" });
    fake.fireRaw(null);
    fake.fireRaw({ entry: { event: "not_a_real_event" } });

    expect(sessionLogEvents()).toEqual([]);
  });

  it("accepts a valid entry after dropping a malformed one (no state corruption)", () => {
    const fake = makeFakeChannel();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    installSessionLog(fake.channel);

    fake.fireRaw({ kind: "session_log_event", entry: { bogus: true } });
    fake.fire(entry({ id: 42, event: "backoff", delay_ms: 5000, attempt: 3 }));

    const list = sessionLogEvents();
    expect(list.length).toBe(1);
    expect(list[0]?.id).toBe(42);
    expect(list[0]?.event).toBe("backoff");
  });
});
