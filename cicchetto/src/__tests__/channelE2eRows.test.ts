// Channel E2E (wire v4) — the decrypted channel rows store: where a
// decrypted channel line lands now that the drain no longer throws it
// away. No rendering, no scrollback injection: the store only keeps the
// rows, in arrival order, for the channel UI to read once it has a
// local-row design.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/api", () => ({
  setOn401Handler: vi.fn(),
  isContentKind: (k: string) => k === "privmsg" || k === "notice" || k === "action",
  isPresenceKind: (k: string) => !(k === "privmsg" || k === "notice" || k === "action"),
}));

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
});

afterEach(() => {
  vi.clearAllMocks();
});

// The store is a module singleton: each test imports it fresh, so the
// rows of one test never leak into the next.
async function fresh() {
  const rows = await import("../lib/channelE2eRows");
  const events = await import("../lib/e2e/channelE2e");
  return { ...rows, emitChannelE2eEvents: events.emitChannelE2eEvents };
}

describe("channelE2eRows", () => {
  it("keeps received rows in arrival order with per-channel synthetic ids", async () => {
    const { channelE2eRows, subscribeChannelE2eRows, emitChannelE2eEvents } = await fresh();
    const unsubscribe = subscribeChannelE2eRows();
    try {
      emitChannelE2eEvents([
        {
          kind: "channel_received",
          channel: "#grappa",
          from: "alice",
          sid: "s1",
          counter: 0,
          body: "one",
        },
        {
          kind: "channel_received",
          channel: "#grappa",
          from: "bob",
          sid: "s1",
          counter: 1,
          body: "two",
        },
        {
          kind: "channel_received",
          channel: "#grappa",
          from: "alice",
          sid: "s1",
          counter: 2,
          body: "three",
        },
      ]);
      expect(channelE2eRows("#grappa")).toEqual([
        {
          id: 1,
          kind: "received",
          channel: "#grappa",
          from: "alice",
          sid: "s1",
          counter: 0,
          body: "one",
        },
        {
          id: 2,
          kind: "received",
          channel: "#grappa",
          from: "bob",
          sid: "s1",
          counter: 1,
          body: "two",
        },
        {
          id: 3,
          kind: "received",
          channel: "#grappa",
          from: "alice",
          sid: "s1",
          counter: 2,
          body: "three",
        },
      ]);
    } finally {
      unsubscribe();
    }
  });

  it("surfaces undecryptable rows with their reason, in order", async () => {
    const { channelE2eRows, subscribeChannelE2eRows, emitChannelE2eEvents } = await fresh();
    const unsubscribe = subscribeChannelE2eRows();
    try {
      emitChannelE2eEvents([
        {
          kind: "channel_received",
          channel: "#grappa",
          from: "alice",
          sid: "s1",
          counter: 0,
          body: "readable",
        },
        {
          kind: "channel_undecryptable",
          channel: "#grappa",
          from: "bob",
          sid: "s1",
          reason: "bad-signature",
        },
        {
          kind: "channel_undecryptable",
          channel: "#grappa",
          from: "carol",
          sid: null,
          reason: "no-session",
        },
      ]);
      expect(channelE2eRows("#grappa")).toEqual([
        {
          id: 1,
          kind: "received",
          channel: "#grappa",
          from: "alice",
          sid: "s1",
          counter: 0,
          body: "readable",
        },
        {
          id: 2,
          kind: "undecryptable",
          channel: "#grappa",
          from: "bob",
          sid: "s1",
          reason: "bad-signature",
        },
        {
          id: 3,
          kind: "undecryptable",
          channel: "#grappa",
          from: "carol",
          sid: null,
          reason: "no-session",
        },
      ]);
    } finally {
      unsubscribe();
    }
  });

  it("bounds each channel at 200 rows, dropping the oldest", async () => {
    const { channelE2eRows, subscribeChannelE2eRows, emitChannelE2eEvents, MAX_CHANNEL_E2E_ROWS } =
      await fresh();
    const unsubscribe = subscribeChannelE2eRows();
    try {
      const events = Array.from({ length: MAX_CHANNEL_E2E_ROWS + 5 }, (_unused, i) => ({
        kind: "channel_received" as const,
        channel: "#grappa",
        from: "alice",
        sid: "s1",
        counter: i,
        body: `row ${i}`,
      }));
      emitChannelE2eEvents(events);
      const rows = channelE2eRows("#grappa");
      expect(rows).toHaveLength(MAX_CHANNEL_E2E_ROWS);
      expect(rows[0]).toEqual(expect.objectContaining({ id: 6, counter: 5, body: "row 5" }));
      expect(rows.at(-1)).toEqual(
        expect.objectContaining({
          id: MAX_CHANNEL_E2E_ROWS + 5,
          counter: MAX_CHANNEL_E2E_ROWS + 4,
        }),
      );
    } finally {
      unsubscribe();
    }
  });

  it("keeps no row for key, rotation, or drop events", async () => {
    const { channelE2eRows, subscribeChannelE2eRows, emitChannelE2eEvents } = await fresh();
    const unsubscribe = subscribeChannelE2eRows();
    try {
      emitChannelE2eEvents([
        { kind: "channel_key_received", channel: "#grappa", from: "alice", sid: "s1" },
        { kind: "channel_key_sent", channel: "#grappa", to: "bob", sid: "s1" },
        {
          kind: "channel_rotated",
          channel: "#grappa",
          oldSid: null,
          newSid: "s1",
          reason: "created",
        },
        { kind: "channel_dropped", channel: "#grappa", reason: "send-refused" },
      ]);
      expect(channelE2eRows("#grappa")).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it("sequences each channel on its own", async () => {
    const { channelE2eRows, subscribeChannelE2eRows, emitChannelE2eEvents } = await fresh();
    const unsubscribe = subscribeChannelE2eRows();
    try {
      emitChannelE2eEvents([
        {
          kind: "channel_received",
          channel: "#grappa",
          from: "alice",
          sid: "s1",
          counter: 0,
          body: "g1",
        },
        {
          kind: "channel_received",
          channel: "#sbiffo",
          from: "bob",
          sid: "s2",
          counter: 0,
          body: "s1",
        },
        {
          kind: "channel_received",
          channel: "#grappa",
          from: "alice",
          sid: "s1",
          counter: 1,
          body: "g2",
        },
      ]);
      expect(channelE2eRows("#grappa").map((r) => r.id)).toEqual([1, 2]);
      expect(channelE2eRows("#sbiffo").map((r) => r.id)).toEqual([1]);
      expect(channelE2eRows("#grappa").map((r) => (r.kind === "received" ? r.body : ""))).toEqual([
        "g1",
        "g2",
      ]);
    } finally {
      unsubscribe();
    }
  });
});
