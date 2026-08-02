import { describe, expect, it } from "vitest";

// #216 — static channel-mode description table + the `availableModes`
// derivation that folds a network's ISUPPORT capability set into a
// display list for the /mode modal.

import {
  availableModes,
  editorSigils,
  modeDescription,
  sanitizeModeParam,
} from "../lib/channelModes";
import { DEFAULT_ISUPPORT, type IsupportEntry } from "../lib/isupport";

describe("channelModes description table", () => {
  it("modeDescription returns label + desc for a known flag mode", () => {
    const d = modeDescription("s");
    expect(d.label).toBe("secret");
    // #667 — desc is now the verbatim HelpServ CMODE text, not cic's own
    // paraphrase ("hidden from channel lists and WHOIS").
    expect(d.desc).toMatch(/does not show/i);
  });

  it("modeDescription returns label + desc for a param mode", () => {
    expect(modeDescription("k").label).toMatch(/key/i);
    expect(modeDescription("l").label).toMatch(/limit/i);
  });

  it("modeDescription falls back to a generic label for an unknown letter", () => {
    const d = modeDescription("Z");
    expect(d.label).toContain("Z");
    // no crash, non-empty desc
    expect(typeof d.desc).toBe("string");
  });
});

describe("availableModes", () => {
  it("lists the channel modes advertised by ISUPPORT with param arity", () => {
    const modes = availableModes(DEFAULT_ISUPPORT);
    const find = (letter: string) => modes.find((m) => m.letter === letter);

    // A flag mode (type D) — no param.
    const s = find("s");
    expect(s).toBeDefined();
    expect(s?.takesParam).toBe(false);
    expect(s?.label).toBe("secret");

    // A param mode (type C) — takes a param on set.
    const l = find("l");
    expect(l).toBeDefined();
    expect(l?.takesParam).toBe(true);

    // A key mode (type B) — takes a param.
    const k = find("k");
    expect(k).toBeDefined();
    expect(k?.takesParam).toBe(true);
  });

  it("EXCLUDES membership (PREFIX) modes — those are per-user, not channel toggles", () => {
    const modes = availableModes(DEFAULT_ISUPPORT);
    const letters = modes.map((m) => m.letter);
    expect(letters).not.toContain("o");
    expect(letters).not.toContain("v");
    expect(letters).not.toContain("h");
  });

  it("EXCLUDES list modes (type A: ban/except/invex) — not simple toggles", () => {
    // b/e/I are list modes managed via /ban, /banlist etc. — not a
    // boolean toggle the modal should render as a button.
    const modes = availableModes(DEFAULT_ISUPPORT);
    const letters = modes.map((m) => m.letter);
    expect(letters).not.toContain("b");
    expect(letters).not.toContain("e");
    expect(letters).not.toContain("I");
  });

  it("marks type-B modes as param-on-unset, type-C/D as not (#240)", () => {
    // Type B (key) takes a param on BOTH set and unset (bahamut `MODE -k
    // <key>`); type C (limit) takes a param on set only (`-l` bare). The
    // modal needs this distinction to send `-k <key>` vs a bare `-l`.
    const modes = availableModes(DEFAULT_ISUPPORT);
    const find = (letter: string) => modes.find((m) => m.letter === letter);

    expect(find("k")?.paramOnUnset).toBe(true); // type B
    expect(find("l")?.paramOnUnset).toBe(false); // type C
    expect(find("s")?.paramOnUnset).toBe(false); // type D (flag)
  });

  it("surfaces an advertised-but-unknown letter with a generic label (no crash)", () => {
    const isupport: IsupportEntry = {
      chanmodes: { a: [], b: [], c: [], d: ["n", "t", "Z"] },
      prefix: {},
    };
    const modes = availableModes(isupport);
    const z = modes.find((m) => m.letter === "Z");
    expect(z).toBeDefined();
    expect(z?.takesParam).toBe(false);
  });
});

describe("sanitizeModeParam (#240)", () => {
  it("trims surrounding whitespace and returns the value", () => {
    expect(sanitizeModeParam("  s3cr3t  ")).toBe("s3cr3t");
    expect(sanitizeModeParam("42")).toBe("42");
  });

  it("returns null for empty or whitespace-only input", () => {
    expect(sanitizeModeParam("")).toBeNull();
    expect(sanitizeModeParam("   ")).toBeNull();
  });

  it("returns null when the value contains internal whitespace (IRC params are single tokens)", () => {
    // A channel key / limit is one wire token — an embedded space would
    // split into two MODE args and set garbage. Reject at the boundary.
    expect(sanitizeModeParam("two words")).toBeNull();
    expect(sanitizeModeParam("a\tb")).toBeNull();
  });
});

describe("editorSigils", () => {
  it("bahamut default → op + halfop edit (not voice)", () => {
    const e = editorSigils(DEFAULT_ISUPPORT);
    expect(e.has("@")).toBe(true);
    expect(e.has("%")).toBe(true);
    expect(e.has("+")).toBe(false);
  });

  it("founder/admin prefixes rank above op → they edit too", () => {
    // PREFIX=(qaohv)~&@%+ — founder ~, admin &, op @, halfop %, voice +.
    const isupport: IsupportEntry = {
      chanmodes: { a: [], b: [], c: [], d: ["n", "t"] },
      prefix: { q: "~", a: "&", o: "@", h: "%", v: "+" },
    };
    const e = editorSigils(isupport);
    expect(e.has("~")).toBe(true); // founder
    expect(e.has("&")).toBe(true); // admin
    expect(e.has("@")).toBe(true); // op
    expect(e.has("%")).toBe(true); // halfop
    expect(e.has("+")).toBe(false); // voice cannot edit
  });

  it("falls back to op/halfop when no op sigil is advertised", () => {
    const isupport: IsupportEntry = {
      chanmodes: { a: [], b: [], c: [], d: [] },
      prefix: { v: "+" },
    };
    const e = editorSigils(isupport);
    expect(e.has("@")).toBe(true);
    expect(e.has("%")).toBe(true);
  });
});

// #667 — the description table must be reconciled with the letters the
// ircd (azzurra/bahamut) actually advertises, and the copy must be VERBATIM
// from the network's HelpServ CMODE helpfile (us), NOT paraphrased from the
// ircd C source. The paraphrase is exactly how +d ended up documented as
// its unrelated uppercase namesake and +u as a "spam filter".
describe("channelModes reconciled with the HelpServ CMODE helpfile (#667)", () => {
  // The ircd advertises, verbatim from its 005 (src/s_misc.c:1275):
  //   CHANMODES=bz,k,l,BcdijmMnOprRsStuU
  // ⇒ type A `b z` (list modes, excluded), type B `k`, type C `l`,
  //   type D `B c d i j m M n O p r R s S t u U`.
  const ADVERTISED_TYPE_B = ["k"];
  const ADVERTISED_TYPE_C = ["l"];
  const ADVERTISED_TYPE_D = "BcdijmMnOprRsStuU".split("");

  // Verbatim copy from `run/data/helpfiles/us/helpserv/cmode`, minus the
  // leading "  x  - " marker. THIS is the acceptance source of truth for the
  // verbatim entries. (No `B` here: it is absent from the helpfile, so it
  // carries authored copy instead — pinned separately in HIDEBANS_COPY and
  // asserted below, NOT verbatim.)
  const HELPFILE_US: Record<string, string> = {
    c: "Blocks all messages containing colors sent to the channel.",
    C: "Blocks all CTCPs sent to the channel.",
    d: "Only channel operators and voices can change nick while in channel.",
    i: "Sets the channel invite only.",
    j: "Only users identified to a registered nick can join the channel.",
    k: "Sets a key to the channel.",
    l: "Sets the maximum number of users allowed in the channel.",
    m: "Sets channel moderation; only operators, half-operators and voices can talk.",
    M: "Sets channel moderation; only users with a registered nick can talk.",
    n: "Blocks all outside messages to channel.",
    O: "(IRCop Only) Only IRC Operators can join the channel.",
    p: "Channel is private (does not show in /WHOIS, topic is hidden in /LIST ).",
    r: "(Services Only) Channel is registered with ChanServ.",
    R: "Only users with registered nicks can join the channel.",
    s: "Channel is secret (does not show in /WHOIS or /LIST ).",
    S: "Only SSL client can join the channel.",
    t: "Only channel operators can change the topic.",
    u: "Blocks PART/QUIT messages sent to the channel.",
    U: "Allow users without a registered nick on .US and .EU robins to join the channel.",
  };

  // #667 — the ONE authored (non-verbatim) entry: MODE_HIDEBANS (+B) is
  // advertised but absent from the helpfile, so its copy has no verbatim
  // source. vjt approved this exact wording in-channel (2026-08-02); it is
  // faithful to the ircd (ban list hidden from non-priv src/channel.c:1559;
  // MODE +b/-b chanop-routed src/channel.c:3609, 3634). Pinned here so a
  // drift from the approved string reds the suite.
  const HIDEBANS_COPY =
    "Hides the channel ban list and ban changes from users who are not channel operators.";

  // A letter resolves to the GENERIC fallback iff its label is the
  // synthesized `mode +<letter>` (the production fallback contract).
  const isFallback = (letter: string): boolean =>
    modeDescription(letter).label === `mode +${letter}`;

  it("every advertised type B/C/D letter resolves to non-fallback copy", () => {
    const advertised = [...ADVERTISED_TYPE_B, ...ADVERTISED_TYPE_C, ...ADVERTISED_TYPE_D];

    const stillFallback = advertised.filter(isFallback);
    expect(stillFallback).toEqual([]);
  });

  it("every reconciled letter's desc is the verbatim us helpfile text", () => {
    const mismatches = Object.entries(HELPFILE_US)
      .filter(([letter, desc]) => modeDescription(letter).desc !== desc)
      .map(([letter]) => letter);
    expect(mismatches).toEqual([]);
  });

  it("+d reads as a nick-change restriction, not 'delayed' (correction #1)", () => {
    const d = modeDescription("d");
    expect(d.desc).toBe(HELPFILE_US.d);
    expect(d.label).not.toMatch(/delay/i);
    expect(d.label).toMatch(/nick/i);
  });

  it("+u blocks PART/QUIT, not a spam filter (correction #2)", () => {
    const u = modeDescription("u");
    expect(u.desc).toBe(HELPFILE_US.u);
    expect(u.desc).not.toMatch(/spam/i);
    expect(u.label).not.toMatch(/spam/i);
  });

  it("+r (services 'registered' marker) and +R (join restriction) are split", () => {
    const r = modeDescription("r");
    const R = modeDescription("R");
    expect(r.desc).toBe(HELPFILE_US.r);
    expect(R.desc).toBe(HELPFILE_US.R);
    expect(r.desc).not.toBe(R.desc);
  });

  it("+D is deleted — the ircd has no such mode, so it falls through to the fallback", () => {
    // No `case 'D'` in the ircd and no `D` in CHANMODES. A description for a
    // phantom letter is what made a reader assume +d was its lowercase
    // sibling — delete it, don't rewrite it.
    expect(isFallback("D")).toBe(true);
  });

  it("+B (MODE_HIDEBANS) carries the approved authored copy — the sole non-verbatim entry", () => {
    // Advertised (type D) but ABSENT from the HelpServ helpfile, so it has no
    // verbatim source. vjt approved this exact wording in-channel; it is the
    // ONLY entry not drawn from the helpfile (every letter in HELPFILE_US is).
    const B = modeDescription("B");
    expect(isFallback("B")).toBe(false);
    expect(B.desc).toBe(HIDEBANS_COPY);
    // And it is NOT sourced from the verbatim helpfile dict — the marker that
    // keeps the "sole authored entry" invariant honest.
    expect(HELPFILE_US).not.toHaveProperty("B");
  });
});
