import { describe, expect, it } from "vitest";

// #229 — per-network umode (user-mode) store. Seeded by the `umode_changed`
// user-topic event (server parses 221 RPL_UMODEIS + self-MODE echoes). The
// /mode <nick> modal marks which umodes are active from this set. Mirrors
// the shape of the isupport store but holds a flat letter list per network.

import { seedUmodes, umodesByNetwork, umodesForNetwork } from "../lib/umodes";

describe("umodes store", () => {
  it("umodesForNetwork returns [] before any seed", () => {
    expect(umodesForNetwork(9999)).toEqual([]);
  });

  it("seedUmodes stores the letter list keyed by network id", () => {
    seedUmodes(7, ["S", "i", "w"]);
    expect(umodesByNetwork()[7]).toEqual(["S", "i", "w"]);
    expect(umodesForNetwork(7)).toEqual(["S", "i", "w"]);
  });

  it("seedUmodes is last-write-wins per network (idempotent re-seed)", () => {
    seedUmodes(7, ["i"]);
    seedUmodes(7, ["w"]);
    expect(umodesForNetwork(7)).toEqual(["w"]);
  });

  it("umodesForNetwork falls back to [] for an unseeded network", () => {
    seedUmodes(7, ["i"]);
    expect(umodesForNetwork(12345)).toEqual([]);
  });
});
