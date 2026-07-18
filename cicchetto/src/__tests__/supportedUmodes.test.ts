import { describe, expect, it } from "vitest";

// #249 — per-network SUPPORTED umode store. Seeded by the
// `supported_umodes_changed` user-topic event (server parses 004 RPL_MYINFO).
// The /umode modal drives its AVAILABLE toggles from this set, falling back to
// a static table when a network hasn't advertised. Mirrors the umodes store
// shape but holds the server-ADVERTISED letter list per network.

import {
  seedSupportedUmodes,
  supportedUmodesByNetwork,
  supportedUmodesForNetwork,
} from "../lib/supportedUmodes";

describe("supportedUmodes store", () => {
  it("supportedUmodesForNetwork returns [] before any seed", () => {
    expect(supportedUmodesForNetwork(9999)).toEqual([]);
  });

  it("seedSupportedUmodes stores the letter list keyed by network id", () => {
    seedSupportedUmodes(7, ["i", "o", "w"]);
    expect(supportedUmodesByNetwork()[7]).toEqual(["i", "o", "w"]);
    expect(supportedUmodesForNetwork(7)).toEqual(["i", "o", "w"]);
  });

  it("seedSupportedUmodes is last-write-wins per network (idempotent re-seed)", () => {
    seedSupportedUmodes(7, ["i"]);
    seedSupportedUmodes(7, ["w"]);
    expect(supportedUmodesForNetwork(7)).toEqual(["w"]);
  });

  it("supportedUmodesForNetwork falls back to [] for an unseeded network", () => {
    seedSupportedUmodes(7, ["i"]);
    expect(supportedUmodesForNetwork(12345)).toEqual([]);
  });
});
