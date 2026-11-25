import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api";
import { attachNetwork } from "../lib/networkAttach";

// issue 2703 — the attach verb both doors share (HomePane's "Available to
// connect" row and the invite link). What it owes its callers: the POST, then
// the two reads that make the attach visible. A 409 `already_attached` means
// the network IS attached (another tab won the race), so it gets the same two
// reads and is still thrown, for each door to read. Any other refusal gets the
// server's error and NO reads, so a refused attach never refreshes the page
// into looking like it went through.

const calls: string[] = [];
const h = vi.hoisted(() => ({ addNetwork: vi.fn<(t: string, slug: string) => Promise<void>>() }));

vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  addNetwork: (t: string, slug: string) => {
    calls.push(`addNetwork ${t} ${slug}`);
    return h.addNetwork(t, slug);
  },
}));

vi.mock("../lib/networks", () => ({
  refetchUser: () => void calls.push("refetchUser"),
  refetchNetworks: () => void calls.push("refetchNetworks"),
}));

describe("attachNetwork", () => {
  beforeEach(() => {
    calls.length = 0;
    h.addNetwork.mockReset();
  });

  it("POSTs the attach, then re-reads /me and the networks list", async () => {
    h.addNetwork.mockResolvedValue(undefined);
    await attachNetwork("tok", "azzurra2");
    expect(calls).toEqual(["addNetwork tok azzurra2", "refetchUser", "refetchNetworks"]);
  });

  it("re-reads on a 409 already_attached as on a 204, then rethrows it", async () => {
    // The tab that asked must not wait on a socket it may not have yet: the
    // winning tab's `network_attached` broadcast is not replayed to a topic
    // joined after it.
    const conflict = new ApiError(409, "already_attached");
    h.addNetwork.mockRejectedValue(conflict);
    await expect(attachNetwork("tok", "azzurra2")).rejects.toBe(conflict);
    expect(calls).toEqual(["addNetwork tok azzurra2", "refetchUser", "refetchNetworks"]);
  });

  it("rethrows the server's refusal and re-reads nothing", async () => {
    const refusal = new ApiError(403, "network_not_visitor_enabled");
    h.addNetwork.mockRejectedValue(refusal);
    await expect(attachNetwork("tok", "ircnet")).rejects.toBe(refusal);
    expect(calls).toEqual(["addNetwork tok ircnet"]);
  });
});
