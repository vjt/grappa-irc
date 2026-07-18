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

describe("availableUmodes", () => {
  it("lists the KNOWN umode table with settable arity", () => {
    const modes = availableUmodes([]);
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
    const modes = availableUmodes(["Z"]);
    const z = modes.find((m) => m.letter === "Z");
    expect(z).toBeDefined();
    expect(z?.settable).toBe(false);
  });

  it("is sorted by label for a stable modal layout", () => {
    const labels = availableUmodes([]).map((m) => m.label);
    const sorted = [...labels].sort((a, b) => a.localeCompare(b));
    expect(labels).toEqual(sorted);
  });
});
