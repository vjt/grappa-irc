import { beforeEach, describe, expect, it, vi } from "vitest";

// issue 2584 — the `/` menu's two settings, on/off and how many entries it
// shows. PER-DEVICE (vjt's ruling, comment 6702171180 Q1): they live in this
// device's localStorage like the font size, never in the synced display
// prefs, because how many lines fit above the compose box is a question about
// the screen. On by default, five entries.

describe("commandMenu settings (issue 2584)", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  it("is on, with five entries, on a device that never set anything", async () => {
    const m = await import("../lib/commandMenu");
    expect(m.getCommandMenuEnabled()).toBe(true);
    expect(m.getCommandMenuEntries()).toBe(5);
  });

  it("reads back what a previous page load stored", async () => {
    localStorage.setItem("cicchetto.commandMenu", "false");
    localStorage.setItem("cicchetto.commandMenuEntries", "7");
    const m = await import("../lib/commandMenu");
    expect(m.getCommandMenuEnabled()).toBe(false);
    expect(m.getCommandMenuEntries()).toBe(7);
  });

  it("a stored value it cannot read falls back to the default, never to off", async () => {
    localStorage.setItem("cicchetto.commandMenu", "1");
    const m = await import("../lib/commandMenu");
    expect(m.getCommandMenuEnabled()).toBe(true);
  });

  it.each(["0", "11", "2.5", "five", ""])(
    "a stored entry count of %j is outside 1..10 and reads as the default",
    async (stored) => {
      localStorage.setItem("cicchetto.commandMenuEntries", stored);
      const m = await import("../lib/commandMenu");
      expect(m.getCommandMenuEntries()).toBe(5);
    },
  );

  it("the setters write through, so the next page load starts where this one left off", async () => {
    const first = await import("../lib/commandMenu");
    first.setCommandMenuEnabled(false);
    first.setCommandMenuEntries(3);
    expect(first.getCommandMenuEnabled()).toBe(false);
    expect(first.getCommandMenuEntries()).toBe(3);

    vi.resetModules();
    const reloaded = await import("../lib/commandMenu");
    expect(reloaded.getCommandMenuEnabled()).toBe(false);
    expect(reloaded.getCommandMenuEntries()).toBe(3);
  });

  it("refuses an entry count outside the choices instead of storing it", async () => {
    const m = await import("../lib/commandMenu");
    expect(() => m.setCommandMenuEntries(11)).toThrow(RangeError);
    expect(m.getCommandMenuEntries()).toBe(5);
    expect(localStorage.getItem("cicchetto.commandMenuEntries")).toBeNull();
  });

  it("offers exactly the counts 1..10 to choose from", async () => {
    const m = await import("../lib/commandMenu");
    expect(m.COMMAND_MENU_ENTRY_CHOICES).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});
