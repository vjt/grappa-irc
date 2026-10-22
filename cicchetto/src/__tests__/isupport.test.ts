import { describe, expect, it } from "vitest";

// #216 — per-network ISUPPORT capability store. Seeded by the
// `isupport_changed` user-topic event (server parses CHANMODES + PREFIX
// from 005 RPL_ISUPPORT). The `/mode` modal drives its available toggles
// from this table. Mirrors the shape of `channelTopic`'s modes store but
// keyed by network id (ISUPPORT is per-network, not per-channel).

import {
  casemappingForNetwork,
  DEFAULT_ISUPPORT,
  frameBudgetBaseForNetwork,
  type IsupportEntry,
  isupportByNetwork,
  isupportEntryFromWire,
  isupportForNetwork,
  seedIsupport,
  sigilRank,
  sigilRankForNetwork,
} from "../lib/isupport";
import { nickEquals } from "../lib/nickEquals";
import { narrowIsupportChanged } from "../lib/wireNarrow";

// A full `isupport_changed` payload, as the server builds it. Tests override
// the one field they exercise so a new wire fact cannot be added here
// without every case seeing it.
const WIRE_PAYLOAD = {
  chanmodes_a: ["b", "e", "I"],
  chanmodes_b: ["k"],
  chanmodes_c: ["l"],
  chanmodes_d: ["i", "m", "n", "s", "t"],
  list_modes_queryable: ["b", "e", "I"],
  prefix: { o: "@", v: "+" },
  prefix_order: ["o", "v"],
  chantypes: ["#", "&"],
  casemapping: "ascii" as const,
  maxlist: { b: 100, e: 100, I: 100 },
  nicklen: 30,
  channellen: 200,
  topiclen: 307,
  frame_budget_base: 393,
  network: "AzzurraNet",
};

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

  // #1108 — the capability table has an honest default (bahamut's, which is
  // what every prod network advertises anyway); the frame BUDGET has none.
  // It is a projection of LINELEN plus the #246 worst-case relay reserve, so
  // a guess is a wrong number the compose box would warn from. Absent means
  // absent, and the affordances stay dark.
  it("DEFAULT_ISUPPORT carries NO frame budget — there is no honest default", () => {
    expect(DEFAULT_ISUPPORT.frameBudgetBase).toBeNull();
    expect(frameBudgetBaseForNetwork(9999)).toBeNull();
  });

  it("frameBudgetBaseForNetwork serves the seeded budget", () => {
    seedIsupport(11, { ...DEFAULT_ISUPPORT, frameBudgetBase: 393 });
    expect(frameBudgetBaseForNetwork(11)).toBe(393);
  });

  it("frameBudgetBaseForNetwork is null for an unknown network id", () => {
    expect(frameBudgetBaseForNetwork(null)).toBeNull();
  });

  it("seedIsupport stores the entry keyed by network id", () => {
    const entry: IsupportEntry = {
      chanmodes: { a: ["b", "e", "I"], b: ["k"], c: ["l"], d: ["i", "m", "n", "s", "t"] },
      prefix: { q: "~", a: "&", o: "@", h: "%", v: "+" },
      prefixOrder: ["q", "a", "o", "h", "v"],
      listModesQueryable: ["b", "e", "I"],
      chantypes: ["#", "&"],
      casemapping: "ascii",
      maxlist: { b: 100 },
      nicklen: 30,
      channellen: 200,
      topiclen: 307,
      frameBudgetBase: 393,
      network: "AzzurraNet",
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

// #1255 — the server parsed six 005 tokens and shipped two. These are the
// per-network facts cic used to open-code as constants: the channel sigil
// class (`[#&+!]` repeated across compose/slashCommands/inviteLink/
// ScrollbackPane), the identifier fold, the list caps #1251's mode switcher
// has to respect, and the length limits that today are only discovered by
// round-tripping an over-long nick or topic through the ircd.
describe("isupport widening (#1255)", () => {
  it("DEFAULT_ISUPPORT mirrors the server seed: RFC sigils, ascii fold, no caps", () => {
    // These defaults are what makes a network that omits the token behave
    // EXACTLY as cic behaved before the widening: the RFC 2812 sigil class
    // is the literal every open-coded copy carried, and `ascii` is the fold
    // `nickEquals.asciiFold` implements. The caps have no honest default —
    // inventing one would reject input the ircd accepts.
    expect(DEFAULT_ISUPPORT.chantypes).toEqual(["#", "&", "+", "!"]);
    expect(DEFAULT_ISUPPORT.casemapping).toBe("ascii");
    expect(DEFAULT_ISUPPORT.maxlist).toEqual({});
    expect(DEFAULT_ISUPPORT.nicklen).toBeNull();
    expect(DEFAULT_ISUPPORT.channellen).toBeNull();
    expect(DEFAULT_ISUPPORT.topiclen).toBeNull();
  });

  it("isupportEntryFromWire folds the widened payload into the store shape", () => {
    const entry = isupportEntryFromWire(WIRE_PAYLOAD);

    expect(entry.chantypes).toEqual(["#", "&"]);
    expect(entry.casemapping).toBe("ascii");
    expect(entry.maxlist).toEqual({ b: 100, e: 100, I: 100 });
    expect(entry.nicklen).toBe(30);
    expect(entry.channellen).toBe(200);
    expect(entry.topiclen).toBe(307);
  });

  it("carries a network whose fold is NOT ascii", () => {
    // solanum/Libera/Rizon advertise rfc1459, where `foo[1]` and `foo{1}` are
    // the SAME identity. Since #1861 cic ACTS on it: `casemappingForNetwork`
    // below feeds `normalizeNick`/`nickEquals`.
    const entry = isupportEntryFromWire({ ...WIRE_PAYLOAD, casemapping: "rfc1459" });
    expect(entry.casemapping).toBe("rfc1459");
  });

  // issue 2430 — what an order challenge is matched against, exactly.
  it("isupportEntryFromWire carries the network's own name, and its absence as null", () => {
    expect(isupportEntryFromWire(WIRE_PAYLOAD).network).toBe("AzzurraNet");
    expect(isupportEntryFromWire({ ...WIRE_PAYLOAD, network: null }).network).toBeNull();
    expect(DEFAULT_ISUPPORT.network).toBeNull();
  });

  it("carries an absent length limit as null, never as a guess", () => {
    const entry = isupportEntryFromWire({
      ...WIRE_PAYLOAD,
      nicklen: null,
      channellen: null,
      topiclen: null,
    });

    expect(entry.nicklen).toBeNull();
    expect(entry.channellen).toBeNull();
    expect(entry.topiclen).toBeNull();
  });

  // #1861 — the store-reading half of the nick fold. Sibling of
  // `chantypesForNetwork`, and the ONLY door the fold call sites use.
  it("casemappingForNetwork reports the seeded fold, per network", () => {
    seedIsupport(41, isupportEntryFromWire({ ...WIRE_PAYLOAD, casemapping: "rfc1459" }));
    seedIsupport(42, isupportEntryFromWire({ ...WIRE_PAYLOAD, casemapping: "rfc1459_strict" }));
    seedIsupport(43, isupportEntryFromWire({ ...WIRE_PAYLOAD, casemapping: "ascii" }));

    expect(casemappingForNetwork(41)).toBe("rfc1459");
    expect(casemappingForNetwork(42)).toBe("rfc1459_strict");
    expect(casemappingForNetwork(43)).toBe("ascii");
  });

  it("casemappingForNetwork defaults to ascii for an unseeded network and a null id", () => {
    // The narrower fold on both misses: pre-005, a parked session, or no
    // active network at all. Guessing `ascii` merges no identity the ircd
    // keeps apart, which is why it is the safe default in BOTH directions.
    expect(casemappingForNetwork(44)).toBe("ascii");
    expect(casemappingForNetwork(null)).toBe("ascii");
  });

  it("seeds the widened facts per network, keeping networks independent", () => {
    seedIsupport(31, isupportEntryFromWire({ ...WIRE_PAYLOAD, chantypes: ["#"] }));
    seedIsupport(32, isupportEntryFromWire({ ...WIRE_PAYLOAD, chantypes: ["#", "&", "!"] }));

    expect(isupportForNetwork(31).chantypes).toEqual(["#"]);
    expect(isupportForNetwork(32).chantypes).toEqual(["#", "&", "!"]);
    // An unseeded network still gets the RFC set, not a neighbour's.
    expect(isupportForNetwork(33).chantypes).toEqual(["#", "&", "+", "!"]);
  });
});

// #1861 — the COMPOSITION, driven from a raw wire payload rather than from
// the store shape. Every link in the chain has its own test; this is the one
// that fails if two of them stop composing:
//
//   005 CASEMAPPING=rfc1459  (measured live off the e2e solanum node,
//                             `azzurra2` — see DESIGN_NOTES 2026-08-29)
//     → Grappa.Session.ISupport.parse_casemapping/1   (isupport_test.exs)
//     → the isupport_changed wire payload              (wire_test.exs)
//     → narrowIsupportChanged                          (HERE, real narrower)
//     → isupportEntryFromWire → seedIsupport           (HERE)
//     → casemappingForNetwork                          (HERE)
//     → nickEquals                                     (HERE)
//
// It uses the REAL narrower on a raw `Record<string, unknown>`, so a wire
// rename or a narrowing regression reds here instead of surviving behind a
// hand-built store entry.
describe("isupport → nick fold composition (#1861)", () => {
  const rawWire = (networkId: number, casemapping: string): Record<string, unknown> => ({
    ...WIRE_PAYLOAD,
    network_id: networkId,
    casemapping,
  });

  // issue 2430 — a pre-47 server sends no `network`: the push still seeds
  // the table, and the name reads as absent (order challenges fail closed).
  it("narrows the network's name, and an absent or empty one to null", () => {
    expect(narrowIsupportChanged(rawWire(54, "ascii"))?.network).toBe("AzzurraNet");
    const { network: _, ...pre47 } = rawWire(55, "ascii");
    expect(narrowIsupportChanged(pre47)?.network).toBeNull();
    expect(narrowIsupportChanged({ ...rawWire(56, "ascii"), network: "" })?.network).toBeNull();
  });

  it("an rfc1459 005 makes the two spellings of one nick compare EQUAL", () => {
    const narrowed = narrowIsupportChanged(rawWire(51, "rfc1459"));
    // Positive control: the narrower accepted the payload at all. Without
    // this a future required-field addition would turn the whole case into a
    // vacuous pass via the `?? DEFAULT_ISUPPORT` fallback below.
    expect(narrowed).not.toBeNull();
    if (narrowed === null) return;
    expect(narrowed.casemapping).toBe("rfc1459");

    seedIsupport(51, isupportEntryFromWire(narrowed));

    const cm = casemappingForNetwork(51);
    expect(cm).toBe("rfc1459");
    // The reported pair, off a real Rizon session.
    expect(nickEquals("[EWG]-L0VE", "{ewg}-l0ve", cm)).toBe(true);
  });

  it("an ascii 005 keeps them DISTINCT — the #525 posture, all of production", () => {
    const narrowed = narrowIsupportChanged(rawWire(52, "ascii"));
    expect(narrowed).not.toBeNull();
    if (narrowed === null) return;

    seedIsupport(52, isupportEntryFromWire(narrowed));

    const cm = casemappingForNetwork(52);
    expect(cm).toBe("ascii");
    expect(nickEquals("[EWG]-L0VE", "{ewg}-l0ve", cm)).toBe(false);
    // …while the case fold still applies, so this is not "no fold at all".
    expect(nickEquals("[EWG]-L0VE", "[ewg]-l0ve", cm)).toBe(true);
  });

  it("a casemapping the server never models degrades to ascii, not to a throw", () => {
    // `narrowCasemapping` is the guard; the point here is that an unknown
    // token cannot silently widen the fold on a production network.
    const narrowed = narrowIsupportChanged(rawWire(53, "strict-rfc7700"));
    expect(narrowed).not.toBeNull();
    if (narrowed === null) return;

    seedIsupport(53, isupportEntryFromWire(narrowed));
    expect(casemappingForNetwork(53)).toBe("ascii");
  });
});

describe("isupport → membership sigil rank (issue 1999)", () => {
  it("DEFAULT_ISUPPORT's rank is the bahamut/Azzurra run, highest first", () => {
    expect(sigilRank(DEFAULT_ISUPPORT)).toEqual(["@", "%", "+"]);
  });

  it("a PREFIX-rich network ranks founder and admin ABOVE op", () => {
    // The client twin of `Grappa.Session.ISupport.sigils/1`. Every surface
    // that renders or orders a membership sigil reads this run instead of
    // the `@ % +` triple `memberSigil` and `tierRank` used to hardcode.
    const entry: IsupportEntry = {
      ...DEFAULT_ISUPPORT,
      prefix: { q: "~", a: "&", o: "@", h: "%", v: "+" },
      prefixOrder: ["q", "a", "o", "h", "v"],
    };

    expect(sigilRank(entry)).toEqual(["~", "&", "@", "%", "+"]);
  });

  it("the rank is NOT the map's value order", () => {
    // The guard `editorSigils` earned the hard way (#1302): the map crosses
    // the wire as a JSON object whose key order is the server runtime's —
    // alphabetical by mode letter — which on `(qaohv)` puts `o` in the
    // MIDDLE. Reading rank off the map is the defect, not the shortcut.
    const entry: IsupportEntry = {
      ...DEFAULT_ISUPPORT,
      prefix: { a: "&", h: "%", o: "@", q: "~", v: "+" },
      prefixOrder: ["q", "a", "o", "h", "v"],
    };

    expect(Object.values(entry.prefix)).not.toEqual(sigilRank(entry));
    expect(sigilRank(entry)).toEqual(["~", "&", "@", "%", "+"]);
  });

  it("an EMPTY prefixOrder falls back to the default run, never to []", () => {
    // A server predating #1302 publishes no order at all. `[]` would read as
    // "this network has no membership levels", which would silently disable
    // every sigil and flatten the pane — strictly worse than assuming the
    // bahamut run every production network advertises anyway. Same posture
    // `editorSigils` takes for an order it cannot resolve.
    const entry: IsupportEntry = { ...DEFAULT_ISUPPORT, prefixOrder: [] };

    expect(sigilRank(entry)).toEqual(["@", "%", "+"]);
  });

  it("a letter the map cannot resolve is skipped, not rendered as undefined", () => {
    const entry: IsupportEntry = {
      ...DEFAULT_ISUPPORT,
      prefix: { o: "@", v: "+" },
      prefixOrder: ["o", "q", "v"],
    };

    expect(sigilRank(entry)).toEqual(["@", "+"]);
  });

  it("sigilRankForNetwork resolves a seeded network, and defaults for an unseeded one", () => {
    seedIsupport(1999, {
      ...DEFAULT_ISUPPORT,
      prefix: { q: "~", o: "@", v: "+" },
      prefixOrder: ["q", "o", "v"],
    });

    expect(sigilRankForNetwork(1999)).toEqual(["~", "@", "+"]);
    expect(sigilRankForNetwork(19_991)).toEqual(["@", "%", "+"]);
    expect(sigilRankForNetwork(null)).toEqual(["@", "%", "+"]);
  });
});
