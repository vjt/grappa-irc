import { describe, expect, it } from "vitest";

// #216 — per-network ISUPPORT capability store. Seeded by the
// `isupport_changed` user-topic event (server parses CHANMODES + PREFIX
// from 005 RPL_ISUPPORT). The `/mode` modal drives its available toggles
// from this table. Mirrors the shape of `channelTopic`'s modes store but
// keyed by network id (ISUPPORT is per-network, not per-channel).

import {
  DEFAULT_ISUPPORT,
  type IsupportEntry,
  isupportByNetwork,
  isupportForNetwork,
  seedIsupport,
} from "../lib/isupport";

describe("isupport store", () => {
  it("DEFAULT_ISUPPORT carries the bahamut/Azzurra seed", () => {
    expect(DEFAULT_ISUPPORT.prefix).toEqual({ o: "@", h: "%", v: "+" });
    expect(DEFAULT_ISUPPORT.chanmodes.a).toContain("b");
    expect(DEFAULT_ISUPPORT.chanmodes.b).toContain("k");
    expect(DEFAULT_ISUPPORT.chanmodes.c).toContain("l");
    expect(DEFAULT_ISUPPORT.chanmodes.d).toContain("n");
  });

  it("isupportForNetwork returns the default before any seed", () => {
    expect(isupportForNetwork(9999)).toEqual(DEFAULT_ISUPPORT);
  });

  it("seedIsupport stores the entry keyed by network id", () => {
    const entry: IsupportEntry = {
      chanmodes: { a: ["b", "e", "I"], b: ["k"], c: ["l"], d: ["i", "m", "n", "s", "t"] },
      prefix: { q: "~", a: "&", o: "@", h: "%", v: "+" },
    };
    seedIsupport(7, entry);
    expect(isupportByNetwork()[7]).toEqual(entry);
    expect(isupportForNetwork(7)).toEqual(entry);
  });

  it("isupportForNetwork falls back to default for an unseeded network", () => {
    seedIsupport(7, DEFAULT_ISUPPORT);
    expect(isupportForNetwork(12345)).toEqual(DEFAULT_ISUPPORT);
  });
});
