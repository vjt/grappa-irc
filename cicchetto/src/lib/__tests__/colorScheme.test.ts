import { afterEach, describe, expect, test } from "vitest";
import { applyColorScheme, colorSchemeFor } from "../colorScheme";

// #963 — the `color-scheme` derivation. The UA paints what our CSS cannot
// reach (the open <option> list of a real <select>, scrollbars), and the only
// way to tell it which way is `color-scheme`. It is derived from the theme's
// background rather than from the day/night slot, so a light theme parked in
// the night slot still gets a light option list.
//
// The threshold under test is not arbitrary: it is the luminance at which
// black and white contrast EQUALLY against the colour, which is the same
// question the UA is being asked. #757575 is the last grey where white wins.

describe("colorSchemeFor", () => {
  test("the two shipped palettes resolve to their own mode", () => {
    // The literal --bg of :root[data-theme="irssi-dark"] / ["mirc-light"].
    expect(colorSchemeFor("#0a0a0a")).toBe("dark");
    expect(colorSchemeFor("#ffffff")).toBe("light");
  });

  test("the boundary is where white stops being the more legible text", () => {
    expect(colorSchemeFor("#757575")).toBe("dark");
    expect(colorSchemeFor("#767676")).toBe("light");
  });

  test("luminance is weighted per channel, not averaged", () => {
    // Same mean channel value, opposite verdicts: green carries 0.7152 of the
    // luminance, blue 0.0722. A naive (r+g+b)/3 would call both the same.
    expect(colorSchemeFor("#00a000")).toBe("light");
    expect(colorSchemeFor("#0000a0")).toBe("dark");
  });

  test("reads the shorthand hex and the rgb() forms an engine may hand back", () => {
    expect(colorSchemeFor("#000")).toBe("dark");
    expect(colorSchemeFor("#FFF")).toBe("light");
    expect(colorSchemeFor("rgb(10, 10, 10)")).toBe("dark");
    expect(colorSchemeFor("rgb(255 255 255)")).toBe("light");
    // A computed custom property arrives as a token stream, spaces included.
    expect(colorSchemeFor("  #0a0a0a ")).toBe("dark");
  });

  test("a value that is not a colour yields no verdict rather than a guess", () => {
    expect(colorSchemeFor("")).toBeNull();
    expect(colorSchemeFor("var(--nope)")).toBeNull();
    expect(colorSchemeFor("linear-gradient(#000, #fff)")).toBeNull();
    expect(colorSchemeFor("#12345")).toBeNull();
  });
});

describe("applyColorScheme", () => {
  afterEach(() => {
    document.documentElement.style.removeProperty("--bg");
    document.documentElement.style.removeProperty("color-scheme");
  });

  test("writes the mode the current --bg resolves to, and clears it when unreadable", () => {
    const root = document.documentElement;

    root.style.setProperty("--bg", "#0a0a0a");
    applyColorScheme();
    expect(root.style.getPropertyValue("color-scheme")).toBe("dark");

    root.style.setProperty("--bg", "#ffffff");
    applyColorScheme();
    expect(root.style.getPropertyValue("color-scheme")).toBe("light");

    root.style.removeProperty("--bg");
    applyColorScheme();
    expect(root.style.getPropertyValue("color-scheme")).toBe("");
  });
});
