import { describe, expect, it } from "vitest";
import { type GroupedWindows, orderWindows, type Window } from "../lib/windowKinds";

// TDD: C1.1 — window-kind type + ordering selector.
//
// orderWindows takes a flat list of Window objects and returns an
// array of GroupedWindows — one entry per network_id, containing
// windows sorted: server first, channels alpha, queries alpha,
// list, mentions. Ephemeral kinds (list, mentions) only appear
// when present.
//
// Network group order: stable by insertion order (first-seen
// network_id wins). This mirrors the order networks appear in the
// user's list (API-order — no secondary sort applied here).

const makeWindow = (
  overrides: Partial<Window> & { kind: Window["kind"]; networkId: number },
): Window => {
  const target = overrides.target ?? "";
  return {
    id: overrides.id ?? `${overrides.networkId}-${overrides.kind}-${target}`,
    networkId: overrides.networkId,
    kind: overrides.kind,
    target,
  };
};

describe("orderWindows", () => {
  it("returns empty array for empty input", () => {
    expect(orderWindows([])).toEqual([]);
  });

  it("single server window produces one group", () => {
    const w = makeWindow({ kind: "server", networkId: 1, target: "libera.chat" });
    const result = orderWindows([w]);
    expect(result).toHaveLength(1);
    const group = result[0] as GroupedWindows;
    expect(group.networkId).toBe(1);
    expect(group.windows).toEqual([w]);
  });

  it("within-network ordering: server first, then channels alpha, then queries alpha, then list, then mentions", () => {
    const server = makeWindow({ kind: "server", networkId: 1, target: "libera" });
    const chanB = makeWindow({ kind: "channel", networkId: 1, target: "#beta" });
    const chanA = makeWindow({ kind: "channel", networkId: 1, target: "#alpha" });
    const queryZ = makeWindow({ kind: "query", networkId: 1, target: "zara" });
    const queryA = makeWindow({ kind: "query", networkId: 1, target: "alice" });
    const list = makeWindow({ kind: "list", networkId: 1, target: "" });
    const mentions = makeWindow({ kind: "mentions", networkId: 1, target: "" });

    const result = orderWindows([mentions, queryZ, chanB, list, server, chanA, queryA]);
    expect(result).toHaveLength(1);
    const group = result[0] as GroupedWindows;
    expect(group.windows.map((w) => `${w.kind}:${w.target}`)).toEqual([
      "server:libera",
      "channel:#alpha",
      "channel:#beta",
      "query:alice",
      "query:zara",
      "list:",
      "mentions:",
    ]);
  });

  it("channels are sorted case-insensitively", () => {
    const chanC = makeWindow({ kind: "channel", networkId: 1, target: "#Cats" });
    const chanA = makeWindow({ kind: "channel", networkId: 1, target: "#animals" });
    const chanB = makeWindow({ kind: "channel", networkId: 1, target: "#Books" });
    const result = orderWindows([chanC, chanB, chanA]);
    const group = result[0] as GroupedWindows;
    expect(group.windows.map((w) => w.target)).toEqual(["#animals", "#Books", "#Cats"]);
  });

  it("queries are sorted case-insensitively", () => {
    const qC = makeWindow({ kind: "query", networkId: 1, target: "Charlie" });
    const qA = makeWindow({ kind: "query", networkId: 1, target: "alice" });
    const qB = makeWindow({ kind: "query", networkId: 1, target: "Bob" });
    const result = orderWindows([qC, qB, qA]);
    const group = result[0] as GroupedWindows;
    expect(group.windows.map((w) => w.target)).toEqual(["alice", "Bob", "Charlie"]);
  });

  it("ephemeral kinds (list, mentions) only present when in input", () => {
    const server = makeWindow({ kind: "server", networkId: 1, target: "libera" });
    const chan = makeWindow({ kind: "channel", networkId: 1, target: "#grappa" });
    const result = orderWindows([server, chan]);
    const group = result[0] as GroupedWindows;
    expect(group.windows.every((w) => w.kind !== "list" && w.kind !== "mentions")).toBe(true);
  });

  it("multi-network: groups by networkId, preserves insertion order", () => {
    const s1 = makeWindow({ kind: "server", networkId: 1, target: "libera" });
    const s2 = makeWindow({ kind: "server", networkId: 2, target: "efnet" });
    const c1 = makeWindow({ kind: "channel", networkId: 1, target: "#grappa" });
    const c2 = makeWindow({ kind: "channel", networkId: 2, target: "#efnet" });
    // network 1 seen first (s1 is first in array)
    const result = orderWindows([s1, s2, c2, c1]);
    expect(result).toHaveLength(2);
    expect((result[0] as GroupedWindows).networkId).toBe(1);
    expect((result[1] as GroupedWindows).networkId).toBe(2);
    expect((result[0] as GroupedWindows).windows.map((w) => w.target)).toEqual([
      "libera",
      "#grappa",
    ]);
    expect((result[1] as GroupedWindows).windows.map((w) => w.target)).toEqual(["efnet", "#efnet"]);
  });

  it("multi-network: each group sorted independently", () => {
    const q1B = makeWindow({ kind: "query", networkId: 1, target: "bob", id: "1-q-bob" });
    const q1A = makeWindow({ kind: "query", networkId: 1, target: "alice", id: "1-q-alice" });
    const q2B = makeWindow({ kind: "query", networkId: 2, target: "zara", id: "2-q-zara" });
    const q2A = makeWindow({ kind: "query", networkId: 2, target: "anna", id: "2-q-anna" });
    const result = orderWindows([q1B, q2B, q1A, q2A]);
    const g1 = result.find((g) => g.networkId === 1) as GroupedWindows;
    const g2 = result.find((g) => g.networkId === 2) as GroupedWindows;
    expect(g1.windows.map((w) => w.target)).toEqual(["alice", "bob"]);
    expect(g2.windows.map((w) => w.target)).toEqual(["anna", "zara"]);
  });
});
