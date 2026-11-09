// Channel E2E (wire v4) — the decrypted channel rows store: where a
// decrypted channel line lands now that the drain no longer throws it
// away. No rendering, no scrollback injection: the store only keeps the
// rows, in arrival order, for the channel UI to read once it has a
// local-row design.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { channelKey } from "../lib/channelKey";

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
  const topics = await import("../lib/channelTopic");
  return {
    ...rows,
    emitChannelE2eEvents: events.emitChannelE2eEvents,
    seedTopic: topics.seedTopic,
  };
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
          network: "azzurra",
          from: "alice",
          sid: "s1",
          counter: 0,
          body: "one",
        },
        {
          kind: "channel_received",
          channel: "#grappa",
          network: "azzurra",
          from: "bob",
          sid: "s1",
          counter: 1,
          body: "two",
        },
        {
          kind: "channel_received",
          channel: "#grappa",
          network: "azzurra",
          from: "alice",
          sid: "s1",
          counter: 2,
          body: "three",
        },
      ]);
      expect(channelE2eRows(channelKey("azzurra", "#grappa"))).toEqual([
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
          network: "azzurra",
          from: "alice",
          sid: "s1",
          counter: 0,
          body: "readable",
        },
        {
          kind: "channel_undecryptable",
          channel: "#grappa",
          network: "azzurra",
          from: "bob",
          sid: "s1",
          reason: "bad-signature",
        },
        {
          kind: "channel_undecryptable",
          channel: "#grappa",
          network: "azzurra",
          from: "carol",
          sid: null,
          reason: "no-session",
        },
      ]);
      expect(channelE2eRows(channelKey("azzurra", "#grappa"))).toEqual([
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
        network: "azzurra",
        from: "alice",
        sid: "s1",
        counter: i,
        body: `row ${i}`,
      }));
      emitChannelE2eEvents(events);
      const rows = channelE2eRows(channelKey("azzurra", "#grappa"));
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
          network: "azzurra",
          oldSid: null,
          newSid: "s1",
          reason: "created",
        },
        { kind: "channel_dropped", channel: "#grappa", reason: "send-refused" },
      ]);
      expect(channelE2eRows(channelKey("azzurra", "#grappa"))).toEqual([]);
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
          network: "azzurra",
          from: "alice",
          sid: "s1",
          counter: 0,
          body: "g1",
        },
        {
          kind: "channel_received",
          channel: "#sbiffo",
          network: "azzurra",
          from: "bob",
          sid: "s2",
          counter: 0,
          body: "s1",
        },
        {
          kind: "channel_received",
          channel: "#grappa",
          network: "azzurra",
          from: "alice",
          sid: "s1",
          counter: 1,
          body: "g2",
        },
      ]);
      expect(channelE2eRows(channelKey("azzurra", "#grappa")).map((r) => r.id)).toEqual([1, 2]);
      expect(channelE2eRows(channelKey("azzurra", "#sbiffo")).map((r) => r.id)).toEqual([1]);
      expect(
        channelE2eRows(channelKey("azzurra", "#grappa")).map((r) =>
          r.kind === "received" ? r.body : "",
        ),
      ).toEqual(["g1", "g2"]);
    } finally {
      unsubscribe();
    }
  });

  it("scopes rows by network: two networks' same-named channels never share rows", async () => {
    const { channelE2eRows, subscribeChannelE2eRows, emitChannelE2eEvents } = await fresh();
    const unsubscribe = subscribeChannelE2eRows();
    try {
      emitChannelE2eEvents([
        {
          kind: "channel_received",
          channel: "#grappa",
          network: "azzurra",
          from: "alice",
          sid: "s1",
          counter: 0,
          body: "azzurra one",
        },
        {
          kind: "channel_received",
          channel: "#grappa",
          network: "freenode",
          from: "bob",
          sid: "s1",
          counter: 0,
          body: "freenode one",
        },
        {
          kind: "channel_received",
          channel: "#grappa",
          network: "azzurra",
          from: "alice",
          sid: "s1",
          counter: 1,
          body: "azzurra two",
        },
      ]);
      expect(
        channelE2eRows(channelKey("azzurra", "#grappa")).map((r) =>
          r.kind === "received" ? r.body : "",
        ),
      ).toEqual(["azzurra one", "azzurra two"]);
      expect(
        channelE2eRows(channelKey("freenode", "#grappa")).map((r) =>
          r.kind === "received" ? r.body : "",
        ),
      ).toEqual(["freenode one"]);
      // The ids never collide inside one channel's read, across networks.
      const azzurraIds = channelE2eRows(channelKey("azzurra", "#grappa")).map((r) => r.id);
      const freenodeIds = channelE2eRows(channelKey("freenode", "#grappa")).map((r) => r.id);
      expect(new Set(azzurraIds).size).toBe(azzurraIds.length);
      expect(azzurraIds.filter((id) => freenodeIds.includes(id))).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it("reads rows the drain raised without a network under the network bucket", async () => {
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
          body: "held before the key",
        },
        {
          kind: "channel_received",
          channel: "#grappa",
          network: "azzurra",
          from: "bob",
          sid: "s1",
          counter: 1,
          body: "live after the key",
        },
      ]);
      expect(
        channelE2eRows(channelKey("azzurra", "#grappa")).map((r) =>
          r.kind === "received" ? r.body : "",
        ),
      ).toEqual(["held before the key", "live after the key"]);
    } finally {
      unsubscribe();
    }
  });

  it("marks a cleartext row on a tagged channel with a held epoch", async () => {
    const {
      channelE2eRows,
      subscribeChannelE2eRows,
      emitChannelE2eEvents,
      noteCleartextChannelMessage,
      seedTopic,
    } = await fresh();
    const unsubscribe = subscribeChannelE2eRows();
    try {
      seedTopic(channelKey("azzurra", "#grappa"), {
        text: "welcome [e2e:1 key-from=alice]",
        set_by: "alice",
        set_at: null,
      });
      emitChannelE2eEvents([
        {
          kind: "channel_key_received",
          channel: "#grappa",
          network: "azzurra",
          from: "alice",
          sid: "s1",
        },
      ]);
      noteCleartextChannelMessage("azzurra", "#grappa", {
        kind: "privmsg",
        sender: "bob",
        body: "in the clear",
      });
      expect(channelE2eRows(channelKey("azzurra", "#grappa"))).toEqual([
        { id: 1, kind: "cleartext", channel: "#grappa", from: "bob", body: "in the clear" },
      ]);
    } finally {
      unsubscribe();
    }
  });

  it("keeps no cleartext row without a held epoch", async () => {
    const { channelE2eRows, subscribeChannelE2eRows, noteCleartextChannelMessage, seedTopic } =
      await fresh();
    const unsubscribe = subscribeChannelE2eRows();
    try {
      seedTopic(channelKey("azzurra", "#grappa"), {
        text: "welcome [e2e:1 key-from=alice]",
        set_by: "alice",
        set_at: null,
      });
      noteCleartextChannelMessage("azzurra", "#grappa", {
        kind: "privmsg",
        sender: "bob",
        body: "in the clear",
      });
      expect(channelE2eRows(channelKey("azzurra", "#grappa"))).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it("keeps no cleartext row on an untagged channel", async () => {
    const {
      channelE2eRows,
      subscribeChannelE2eRows,
      emitChannelE2eEvents,
      noteCleartextChannelMessage,
    } = await fresh();
    const unsubscribe = subscribeChannelE2eRows();
    try {
      emitChannelE2eEvents([
        {
          kind: "channel_key_received",
          channel: "#grappa",
          network: "azzurra",
          from: "alice",
          sid: "s1",
        },
      ]);
      noteCleartextChannelMessage("azzurra", "#grappa", {
        kind: "privmsg",
        sender: "bob",
        body: "in the clear",
      });
      expect(channelE2eRows(channelKey("azzurra", "#grappa"))).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it("keeps no cleartext row for a v4 envelope, a non-content line, or an empty body", async () => {
    const {
      channelE2eRows,
      subscribeChannelE2eRows,
      emitChannelE2eEvents,
      noteCleartextChannelMessage,
      seedTopic,
    } = await fresh();
    const unsubscribe = subscribeChannelE2eRows();
    try {
      seedTopic(channelKey("azzurra", "#grappa"), {
        text: "welcome [e2e:1 key-from=alice]",
        set_by: "alice",
        set_at: null,
      });
      emitChannelE2eEvents([
        {
          kind: "channel_key_received",
          channel: "#grappa",
          network: "azzurra",
          from: "alice",
          sid: "s1",
        },
      ]);
      noteCleartextChannelMessage("azzurra", "#grappa", {
        kind: "privmsg",
        sender: "bob",
        body: JSON.stringify({ v: 4, t: "msg", ch: "#grappa", sid: "s1", body: "x", sig: "y" }),
      });
      noteCleartextChannelMessage("azzurra", "#grappa", {
        kind: "join",
        sender: "bob",
        body: "bob joined",
      });
      noteCleartextChannelMessage("azzurra", "#grappa", {
        kind: "privmsg",
        sender: "bob",
        body: null,
      });
      expect(channelE2eRows(channelKey("azzurra", "#grappa"))).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it("keeps rows across a fresh import, and the next row continues the sequence", async () => {
    const first = await fresh();
    const unsubscribe = first.subscribeChannelE2eRows();
    try {
      first.emitChannelE2eEvents([
        {
          kind: "channel_received",
          channel: "#grappa",
          network: "azzurra",
          from: "alice",
          sid: "s1",
          counter: 0,
          body: "before reload",
        },
      ]);
      expect(first.channelE2eRows(channelKey("azzurra", "#grappa"))).toHaveLength(1);
    } finally {
      unsubscribe();
    }
    // The module reloads — its memory rows go with it — and reads the
    // durable copy back. localStorage is NOT cleared between the two
    // imports: that is the reload.
    vi.resetModules();
    const second = await fresh();
    expect(second.channelE2eRows(channelKey("azzurra", "#grappa"))).toEqual([
      expect.objectContaining({ id: 1, body: "before reload" }),
    ]);
    const unsubscribe2 = second.subscribeChannelE2eRows();
    try {
      second.emitChannelE2eEvents([
        {
          kind: "channel_received",
          channel: "#grappa",
          network: "azzurra",
          from: "bob",
          sid: "s1",
          counter: 1,
          body: "after reload",
        },
      ]);
      expect(second.channelE2eRows(channelKey("azzurra", "#grappa")).map((r) => r.id)).toEqual([
        1, 2,
      ]);
    } finally {
      unsubscribe2();
    }
  });
});
