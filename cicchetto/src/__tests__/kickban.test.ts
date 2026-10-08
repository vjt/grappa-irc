import { beforeEach, describe, expect, it, vi } from "vitest";

// issue 2346 — the host-mask ban and the kickban, lifted out of `/kb` (#386)
// so the menus run the SAME verb. `/kb`'s own wiring stays pinned in
// compose.test.ts; this file pins the shared verb, including the one thing
// the menus add: a host the caller already KNOWS (a join/part/quit row's
// prefix) is used as-is and the USERHOST round-trip is skipped.

const mockBan = vi.fn();
const mockKick = vi.fn();
const mockResolve = vi.fn();

vi.mock("../lib/socket", () => ({
  pushChannelBan: (...a: unknown[]) => mockBan(...a),
  pushChannelKick: (...a: unknown[]) => mockKick(...a),
  resolveUserhost: (...a: unknown[]) => mockResolve(...a),
}));

import { banHost, kickban } from "../lib/kickban";

beforeEach(() => {
  vi.clearAllMocks();
  mockBan.mockResolvedValue(undefined);
  mockKick.mockResolvedValue(undefined);
});

describe("banHost", () => {
  it("a known host bans *!*@host verbatim and never asks the server", async () => {
    const err = await banHost({
      networkId: 7,
      channel: "#grappa",
      nick: "Guest123",
      knownHost: "flapper.example.net",
      label: "Ban host",
    });
    expect(err).toBeNull();
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockBan).toHaveBeenCalledWith(7, "#grappa", "*!*@flapper.example.net");
  });

  it("no known host resolves it from the server's userhost cache", async () => {
    mockResolve.mockResolvedValue({ user: "ident", host: "resolved.example.net" });
    const err = await banHost({
      networkId: 7,
      channel: "#grappa",
      nick: "alice",
      knownHost: null,
      label: "Ban host",
    });
    expect(err).toBeNull();
    expect(mockResolve).toHaveBeenCalledWith(7, "alice");
    expect(mockBan).toHaveBeenCalledWith(7, "#grappa", "*!*@resolved.example.net");
  });

  it("an unknown host is fail-closed: no ban, and an error naming the way out", async () => {
    mockResolve.mockResolvedValue(null);
    const err = await banHost({
      networkId: 7,
      channel: "#grappa",
      nick: "alice",
      knownHost: null,
      label: "Ban host",
    });
    expect(mockBan).not.toHaveBeenCalled();
    expect(err).toBe("Ban host: host unknown for alice — ban not set (run /whois alice first)");
  });

  it("a rejected ban push comes back as an error, never a throw", async () => {
    mockBan.mockRejectedValue(new Error("boom"));
    const err = await banHost({
      networkId: 7,
      channel: "#grappa",
      nick: "alice",
      knownHost: "h.example",
      label: "Ban host",
    });
    expect(err).toMatch(/^Ban host: ban failed — /);
  });
});

describe("kickban", () => {
  it("with a known host: bans *!*@host FIRST, then kicks, no lookup", async () => {
    const err = await kickban({
      networkId: 7,
      channel: "#grappa",
      nick: "Guest123",
      reason: "",
      knownHost: "flapper.example.net",
      label: "Kickban",
    });
    expect(err).toBeNull();
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockBan).toHaveBeenCalledWith(7, "#grappa", "*!*@flapper.example.net");
    expect(mockKick).toHaveBeenCalledWith(7, "#grappa", "Guest123", "");
    const [banOrder] = mockBan.mock.invocationCallOrder;
    const [kickOrder] = mockKick.mock.invocationCallOrder;
    if (banOrder === undefined || kickOrder === undefined) throw new Error("both must fire");
    expect(banOrder).toBeLessThan(kickOrder);
  });

  it("an unknown host still kicks, and surfaces the ban error under the caller's label", async () => {
    mockResolve.mockResolvedValue(null);
    const err = await kickban({
      networkId: 7,
      channel: "#grappa",
      nick: "alice",
      reason: "",
      knownHost: null,
      label: "Kickban",
    });
    expect(mockBan).not.toHaveBeenCalled();
    expect(mockKick).toHaveBeenCalledWith(7, "#grappa", "alice", "");
    expect(err).toBe(
      "Kickban: host unknown for alice — ban not set (run /whois alice first); kicking anyway",
    );
  });

  it("both failing surfaces the ban error, the primary one", async () => {
    mockBan.mockRejectedValue(new Error("boom"));
    mockKick.mockRejectedValue(new Error("bang"));
    const err = await kickban({
      networkId: 7,
      channel: "#grappa",
      nick: "alice",
      reason: "",
      knownHost: "h.example",
      label: "Kickban",
    });
    expect(err).toMatch(/^Kickban: ban failed — /);
  });

  it("only the kick failing surfaces the kick error", async () => {
    mockKick.mockRejectedValue(new Error("bang"));
    const err = await kickban({
      networkId: 7,
      channel: "#grappa",
      nick: "alice",
      reason: "",
      knownHost: "h.example",
      label: "Kickban",
    });
    expect(err).toMatch(/^Kickban: kick failed — /);
  });
});
