import { beforeEach, describe, expect, it, vi } from "vitest";

// issue 2346 — the three ban rows both menus share (the nick menu and the
// join/part/quit row menu), and the toast that keeps a menu verb's failure
// visible once the menu has closed.

const mockBanHost = vi.fn();
const mockKickban = vi.fn();
const mockBan = vi.fn();

vi.mock("../lib/kickban", () => ({
  banHost: (...a: unknown[]) => mockBanHost(...a),
  kickban: (...a: unknown[]) => mockKickban(...a),
}));

vi.mock("../lib/socket", () => ({
  pushChannelBan: (...a: unknown[]) => mockBan(...a),
}));

vi.mock("../lib/networks", () => ({
  networkIdBySlug: () => undefined,
  networks: vi.fn(() => [{ id: 7, slug: "azzurra", inserted_at: "x", updated_at: "y" }]),
}));

import type { ContextMenuAction } from "../ContextMenu";
import { channelKey } from "../lib/channelKey";
import { seedFromTest } from "../lib/members";
import { banMenuItems, opsMenuToasts, runOpsVerb } from "../lib/opsMenu";

const flush = () => new Promise((r) => setTimeout(r, 0));

const target = {
  networkId: 7,
  networkSlug: "azzurra",
  channelName: "#grappa",
  nick: "Guest123",
  host: "flapper.example.net" as string | null,
  ownModes: ["@"],
};

const byLabel = (items: ContextMenuAction[], label: string): ContextMenuAction => {
  const item = items.find((i) => i.label === label);
  if (item === undefined) throw new Error(`no ${label} row`);
  return item;
};

beforeEach(() => {
  vi.clearAllMocks();
  mockBan.mockResolvedValue(undefined);
  mockBanHost.mockResolvedValue(null);
  mockKickban.mockResolvedValue(null);
  seedFromTest(channelKey("azzurra", "#grappa"), [{ nick: "guest123", modes: [] }]);
});

describe("banMenuItems", () => {
  it("offers Ban nick, Ban host and Kickban — and no ambiguous bare Ban", () => {
    const labels = banMenuItems(target).map((i) => i.label);
    expect(labels).toEqual(["Ban nick", "Ban host", "Kickban"]);
  });

  it("Ban nick bans nick!*@* — the mask that survives a host change", async () => {
    byLabel(banMenuItems(target), "Ban nick").action();
    await flush();
    expect(mockBan).toHaveBeenCalledWith(7, "#grappa", "Guest123!*@*");
  });

  it("Ban host hands the row's host to the shared verb", async () => {
    byLabel(banMenuItems(target), "Ban host").action();
    await flush();
    expect(mockBanHost).toHaveBeenCalledWith({
      networkId: 7,
      channel: "#grappa",
      nick: "Guest123",
      knownHost: "flapper.example.net",
      label: "Ban host",
    });
  });

  // issue 2346 review — a row's host names whoever held the nick when the row
  // was written; on a recycled Guest nick that is someone else. Kickban kicks
  // the CURRENT holder, so it must not ban the row's host.
  it("Kickban runs the shared ban-then-kick verb WITHOUT the row's host", async () => {
    byLabel(banMenuItems(target), "Kickban").action();
    await flush();
    expect(mockKickban).toHaveBeenCalledWith({
      networkId: 7,
      channel: "#grappa",
      nick: "Guest123",
      reason: "",
      label: "Kickban",
    });
  });

  it("Kickban finds the nick across a case difference (the fold, not ===)", () => {
    // Seeded `guest123` against target `Guest123`: enabled only via nickEquals.
    expect(byLabel(banMenuItems(target), "Kickban").enabled).toBe(true);
  });

  it("without @ every row is disabled but still there", () => {
    const items = banMenuItems({ ...target, ownModes: [] });
    expect(items.map((i) => i.enabled)).toEqual([false, false, false]);
  });

  it("Kickban needs the nick IN the channel (a quit row's nick is gone); the bans do not", () => {
    seedFromTest(channelKey("azzurra", "#grappa"), [{ nick: "someone-else", modes: [] }]);
    const items = banMenuItems(target);
    expect(byLabel(items, "Ban nick").enabled).toBe(true);
    expect(byLabel(items, "Ban host").enabled).toBe(true);
    expect(byLabel(items, "Kickban").enabled).toBe(false);
  });

  it("a fail-closed host miss reaches the operator as a toast", async () => {
    mockBanHost.mockResolvedValue("Ban host: host unknown for Guest123 — ban not set");
    byLabel(banMenuItems({ ...target, host: null }), "Ban host").action();
    await flush();
    expect(opsMenuToasts().map((t) => t.message)).toContain(
      "Ban host: host unknown for Guest123 — ban not set",
    );
  });
});

describe("runOpsVerb", () => {
  it("a rejected push becomes a toast naming the verb, not an unhandled rejection", async () => {
    runOpsVerb("Op", Promise.reject(new Error("not connected")));
    await flush();
    expect(opsMenuToasts().some((t) => t.message.startsWith("Op: "))).toBe(true);
  });
});
