import { beforeEach, describe, expect, it, vi } from "vitest";

// issue 2719 — a failed join's toast names a channel and a network the
// signed-in account asked for. `performJoin` already refuses to RAISE one
// once the identity moved during the await; this is the other half: a toast
// already on screen when the account switches (or logs out) goes with it,
// rather than living out its six seconds in front of the next account.
//
// The REAL `auth` token signal drives the transition here, because that is
// what `identityScopedStore` listens to; a mocked `token` would never change.

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    postJoin: () => Promise.reject(new actual.ApiError(404, "not_found")),
  };
});

// The stores the join verb reads, at their boundaries: no network is in the
// store (so no reconnect), focus is never reached on a failed join.
vi.mock("../lib/networks", () => ({ networkBySlug: () => undefined }));
vi.mock("../lib/selection", () => ({ setSelectedChannel: vi.fn() }));
vi.mock("../lib/windowState", () => ({ windowStateByChannel: () => ({}) }));

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
});

describe("join toasts are scoped to the account that asked (issue 2719)", () => {
  it("an account switch takes a failed join's toast with it", async () => {
    localStorage.setItem("grappa-token", "tokA");
    const auth = await import("../lib/auth");
    const { acceptInvite, joinToasts } = await import("../lib/channelJoin");

    acceptInvite("azzurra", "#secret");
    await vi.waitFor(() => expect(joinToasts()).toHaveLength(1));

    auth.setToken("tokB");
    await vi.waitFor(() => expect(joinToasts()).toHaveLength(0));
  });

  it("a logout takes it too", async () => {
    localStorage.setItem("grappa-token", "tokA");
    const auth = await import("../lib/auth");
    const { acceptInvite, joinToasts } = await import("../lib/channelJoin");

    acceptInvite("azzurra", "#secret");
    await vi.waitFor(() => expect(joinToasts()).toHaveLength(1));

    auth.setToken(null);
    await vi.waitFor(() => expect(joinToasts()).toHaveLength(0));
  });
});
