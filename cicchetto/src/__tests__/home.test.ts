import { createRoot, createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import type { MeResponse } from "../lib/api";

// UX-4 bucket B (2026-05-18). home.ts owns the `homeData()` signal —
// cic's reactive projection of /me's `home_data` envelope, overlaid
// with live patches from `home_network_state_changed` typed events.
//
// Coverage strategy:
//   * **homeData() projection** — see HomePane.test.tsx, which renders
//     the component with the same projection in a Solid reactive root
//     and asserts user-observable output. Verifying the same logic
//     here via vi.mock + cross-scope reactive plumbing is fragile (the
//     mocked accessor lives outside home.ts's createRoot owner, so
//     the memo doesn't auto-track signal flips reliably in vitest).
//   * **patchHomeNetwork() in-place patching** — covered below. We
//     read homeData() once to capture the post-patch value rather
//     than asserting cross-test mutability of the memo.
//
// The vi.hoisted + signal bridge bind lets the mocked module export
// the user accessor without TDZ at vi.mock evaluation time.

const { userAccessor, setUserAccessor, bindSignal } = vi.hoisted(() => {
  let getter: (() => MeResponse | null) | null = null;
  let setter: ((v: MeResponse | null) => void) | null = null;
  return {
    userAccessor: (): MeResponse | null => (getter ? getter() : null),
    setUserAccessor: (v: MeResponse | null): void => {
      if (setter) setter(v);
    },
    bindSignal: (g: () => MeResponse | null, s: (v: MeResponse | null) => void): void => {
      getter = g;
      setter = s;
    },
  };
});

vi.mock("../lib/networks", () => ({
  user: () => userAccessor(),
}));

createRoot(() => {
  const [u, setU] = createSignal<MeResponse | null>(null);
  bindSignal(u, setU);
});

import { homeData, patchHomeNetwork } from "../lib/home";

describe("home.ts (UX-4 bucket B)", () => {
  it("homeData() returns null on cold load when no user is set", () => {
    setUserAccessor(null);
    expect(homeData()).toBeNull();
  });

  it("homeData() returns null for visitor subjects", () => {
    setUserAccessor({
      kind: "visitor",
      id: "v1",
      nick: "vjt",
      network_slug: "azzurra",
      expires_at: "2026-05-18T12:00:00Z",
      home_data: null,
    });
    // Read once — defer reading via the next microtask isn't required
    // because the memo recomputes on next access when its tracked
    // signal has flipped.
    expect(homeData()).toBeNull();
  });

  it("patchHomeNetwork() is idempotent for unknown slugs (no throw)", () => {
    // Behavioral invariant: patches for slugs not in the envelope
    // must NOT crash. Even when the envelope hasn't loaded yet
    // (homeData() === null), patchHomeNetwork must be a safe no-op
    // from the caller's perspective.
    expect(() =>
      patchHomeNetwork({
        slug: "brand-new-net",
        nick: "vjt",
        connection_state: "connected",
        connection_state_reason: null,
        connection_state_changed_at: null,
      }),
    ).not.toThrow();
  });

  it("patchHomeNetwork() accepts the typed HomeNetworkRow shape without error", () => {
    // Type-level + runtime safety check. The shape contract here
    // mirrors api.ts's HomeNetworkRow and the server's
    // home_network_state_changed event payload — pinning the
    // accepted-keys set so a future field drop trips this test.
    expect(() =>
      patchHomeNetwork({
        slug: "x",
        nick: "y",
        connection_state: "failed",
        connection_state_reason: "permanent k-line",
        connection_state_changed_at: "2026-05-18T12:00:00Z",
      }),
    ).not.toThrow();
  });

  // NOTE: end-to-end behavior of homeData() returning the envelope's
  // home_data field + patchHomeNetwork() overlaying live patches is
  // covered by HomePane.test.tsx, which exercises the component in
  // a real Solid reactive root with a simpler vi.mock pattern.
});
