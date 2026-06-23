import { beforeEach, describe, expect, it } from "vitest";
import { getKeyboardPref, ircKeyboardEnabled, setKeyboardPref } from "../lib/keyboardPref";

describe("keyboardPref", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to off", () => {
    expect(getKeyboardPref()).toBe(false);
    expect(ircKeyboardEnabled()).toBe(false);
  });

  it("persists and reflects in the signal", () => {
    setKeyboardPref(true);
    expect(getKeyboardPref()).toBe(true);
    expect(ircKeyboardEnabled()).toBe(true);
    setKeyboardPref(false);
    expect(ircKeyboardEnabled()).toBe(false);
  });
});
