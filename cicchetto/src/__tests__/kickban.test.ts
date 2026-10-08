import { beforeEach, describe, expect, it, vi } from "vitest";

// issue 2346 — the host-mask ban and the kickban, lifted out of `/kb` (#386)
// so the menus run the SAME verb. `/kb`'s own wiring stays pinned in
// compose.test.ts; this file pins the shared verb, including the one thing
// the menus add: a host the caller already KNOWS (a join/part/quit row's
// prefix) is used as-is by `banHost`, and `kickban` refuses one: it kicks
// whoever holds the nick now, so it must ban THAT person's host.

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
  beforeEach(() => mockResolve.mockResolvedValue({ user: "ident", host: "h.example" }));

  it("resolves the CURRENT holder's host, bans *!*@host FIRST, then kicks", async () => {
    mockResolve.mockResolvedValue({ user: "ident", host: "flapper.example.net" });
    const err = await kickban({
      networkId: 7,
      channel: "#grappa",
      nick: "Guest123",
      reason: "",
      form: "host",
      label: "Kickban",
    });
    expect(err).toBeNull();
    expect(mockResolve).toHaveBeenCalledWith(7, "Guest123");
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
      form: "host",
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
      form: "host",
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
      form: "host",
      label: "Kickban",
    });
    expect(err).toMatch(/^Kickban: kick failed — /);
  });

  // issue 2347 — the subject's default ban type. The form is a PARAMETER, not
  // a read of the cached setting inside the verb: the callers own where the
  // value comes from, and this file can pin every form without a store.
  it("form nick bans nick!*@* without asking the server, then kicks", async () => {
    const err = await kickban({
      networkId: 7,
      channel: "#grappa",
      nick: "alice",
      reason: "",
      form: "nick",
      label: "Kickban",
    });
    expect(err).toBeNull();
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockBan).toHaveBeenCalledWith(7, "#grappa", "alice!*@*");
    expect(mockKick).toHaveBeenCalledWith(7, "#grappa", "alice", "");
  });

  it("form user_host bans *!user@host with the RESOLVED ident, then kicks", async () => {
    mockResolve.mockResolvedValue({ user: "~ident", host: "flapper.example.net" });
    const err = await kickban({
      networkId: 7,
      channel: "#grappa",
      nick: "alice",
      reason: "",
      form: "user_host",
      label: "/kb",
    });
    expect(err).toBeNull();
    expect(mockBan).toHaveBeenCalledWith(7, "#grappa", "*!~ident@flapper.example.net");
    expect(mockKick).toHaveBeenCalledWith(7, "#grappa", "alice", "");
  });

  it("form user_host on an unknown userhost is fail-closed: no ban, kick anyway", async () => {
    mockResolve.mockResolvedValue(null);
    const err = await kickban({
      networkId: 7,
      channel: "#grappa",
      nick: "alice",
      reason: "",
      form: "user_host",
      label: "/kb",
    });
    expect(mockBan).not.toHaveBeenCalled();
    expect(mockKick).toHaveBeenCalledWith(7, "#grappa", "alice", "");
    expect(err).toBe(
      "/kb: user@host unknown for alice — ban not set (run /whois alice first); kicking anyway",
    );
  });
});
