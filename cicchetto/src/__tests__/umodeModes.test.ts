import { describe, expect, it } from "vitest";

// #229 — static umode description table + the `availableUmodes` derivation
// that folds the operator's currently-active set into a display list for
// the /mode <nick> modal.

import { availableUmodes, umodeDescription } from "../lib/umodeModes";

describe("umodeModes description table", () => {
  it("umodeDescription returns label + desc + settable for a known settable umode", () => {
    const d = umodeDescription("i");
    expect(d.label).toBe("invisible");
    expect(d.desc).toMatch(/hidden/i);
    expect(d.settable).toBe(true);
  });

  it("marks server/services-managed umodes as read-only (not settable)", () => {
    expect(umodeDescription("o").settable).toBe(false); // operator
    expect(umodeDescription("r").settable).toBe(false); // registered
    expect(umodeDescription("a").settable).toBe(false); // services admin
    expect(umodeDescription("S").settable).toBe(false); // client connected via SSL
  });

  // #301 — the table shipped generic-ircd (charybdis/Unreal) copy for three
  // letters that mean something else on Azzurra/bahamut. Authority: Azzurra's
  // own `helpserv umode` helpfile. +d/+g are IRCop snomask-style RECEIVE flags
  // (not user message filters) → NOT settable; +S is a connection property
  // (SSL), not a services role.
  it("uses Azzurra semantics for +d/+g/+S (not generic-ircd copy)", () => {
    expect(umodeDescription("d").desc).toMatch(/debug/i);
    expect(umodeDescription("g").desc).toMatch(/globops/i);
    expect(umodeDescription("S").desc).toMatch(/ssl/i);
  });

  it("marks the IRCop receive flags +d/+g as read-only (not settable)", () => {
    expect(umodeDescription("d").settable).toBe(false); // receive DEBUG
    expect(umodeDescription("g").settable).toBe(false); // receive GLOBOPS
  });

  // #301 secondary — the table only knew 13 letters, so active-but-unlisted
  // Azzurra umodes rendered "no description available". Representative fill
  // letters are now KNOWN.
  it("knows the previously-missing Azzurra umodes (no generic fallback)", () => {
    expect(umodeDescription("b").desc).not.toMatch(/no description available/i);
    expect(umodeDescription("z").desc).not.toMatch(/no description available/i);
  });

  it("umodeDescription falls back to a generic non-settable label for an unknown letter", () => {
    const d = umodeDescription("Z");
    expect(d.label).toContain("Z");
    expect(d.settable).toBe(false);
    expect(typeof d.desc).toBe("string");
  });
});

// #249 — with an empty serverSet, availableUmodes falls back to the static
// KNOWN table (unioned with active letters) — the pre-#249 behavior.
describe("availableUmodes — static-table fallback (empty serverSet)", () => {
  it("lists the KNOWN umode table with settable arity", () => {
    const modes = availableUmodes([], []);
    const find = (letter: string) => modes.find((m) => m.letter === letter);

    const i = find("i");
    expect(i).toBeDefined();
    expect(i?.settable).toBe(true);
    expect(i?.label).toBe("invisible");

    const r = find("r");
    expect(r).toBeDefined();
    expect(r?.settable).toBe(false);
  });

  it("surfaces an active-but-unknown letter (vendor umode) read-only, no crash", () => {
    const modes = availableUmodes(["Z"], []);
    const z = modes.find((m) => m.letter === "Z");
    expect(z).toBeDefined();
    expect(z?.settable).toBe(false);
  });

  it("is sorted by label for a stable modal layout", () => {
    const labels = availableUmodes([], []).map((m) => m.label);
    const sorted = [...labels].sort((a, b) => a.localeCompare(b));
    expect(labels).toEqual(sorted);
  });
});

// #249 — when the server advertised a supported set (004 RPL_MYINFO), the
// modal renders exactly that set (unioned with active letters), NOT the full
// static table. Known letters keep their description; advertised-but-unknown
// letters get the generic non-settable copy.
describe("availableUmodes — server-advertised set (#249)", () => {
  it("renders one entry per advertised letter (known letters keep their copy)", () => {
    const modes = availableUmodes([], ["i", "o", "x"]);
    expect(modes.map((m) => m.letter).sort()).toEqual(["i", "o", "x"]);

    const i = modes.find((m) => m.letter === "i");
    expect(i?.label).toBe("invisible");
    expect(i?.settable).toBe(true);

    const o = modes.find((m) => m.letter === "o");
    expect(o?.settable).toBe(false); // operator — server-managed
  });

  it("does NOT include static-table letters the server did not advertise", () => {
    // "w" (wallops) is in the static table but not in this advertised set.
    const modes = availableUmodes([], ["i", "x"]);
    expect(modes.find((m) => m.letter === "w")).toBeUndefined();
  });

  it("gives an advertised-but-unknown vendor letter the generic non-settable copy", () => {
    const modes = availableUmodes([], ["Q"]);
    const q = modes.find((m) => m.letter === "Q");
    expect(q).toBeDefined();
    expect(q?.settable).toBe(false);
    expect(q?.desc).toMatch(/no description available/i);
  });

  it("still surfaces an active letter the server omitted (union with active)", () => {
    // The operator holds +Z but the server's 004 didn't list it — it must
    // still render (read-only) so the active state is never hidden.
    const modes = availableUmodes(["Z"], ["i"]);
    expect(modes.map((m) => m.letter).sort()).toEqual(["Z", "i"]);
    expect(modes.find((m) => m.letter === "Z")?.settable).toBe(false);
  });

  it("is sorted by label for a stable modal layout", () => {
    const labels = availableUmodes([], ["i", "o", "x", "w"]).map((m) => m.label);
    const sorted = [...labels].sort((a, b) => a.localeCompare(b));
    expect(labels).toEqual(sorted);
  });
});
