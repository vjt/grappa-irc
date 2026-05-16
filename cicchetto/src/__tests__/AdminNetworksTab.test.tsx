import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import type { Channel } from "phoenix";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminNetwork, WireAdminEvent } from "../lib/api";

vi.mock("../lib/auth", () => ({
  token: () => "test-bearer",
}));

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    adminListNetworks: vi.fn(),
    adminPatchNetworkCaps: vi.fn(),
    adminRunReaper: vi.fn(),
    adminResetCircuit: vi.fn(),
  };
});

vi.mock("../lib/socket", () => ({
  joinAdminEvents: vi.fn(),
}));

import AdminNetworksTab from "../AdminNetworksTab";
import { installAdminEvents, uninstallAdminEvents } from "../lib/adminEvents";

// M-cluster M-10 — Networks tab unit suite. Mirror of
// AdminVisitorsTab.test.tsx / AdminSessionsTab.test.tsx structure.
//
// Per-row surface: three inline number editors
// (max_concurrent_visitor_sessions + max_concurrent_user_sessions
// + max_per_client) + per-row Save (enabled only when dirty vs.
// server-echoed value) + per-row Reset Circuit (InlineConfirmButton,
// visible only when circuit_state !== null).
//
// Tab-level surface: Force Reap (InlineConfirmButton) in the header
// + ↻ refresh + transient success line for the last reap count.
//
// Per `feedback_e2e_user_class_parity_matrix`: admin-gated EXEMPT.
// Per `feedback_css_block_button_wraps_inline_prefix`: textContent
// assertions on every transition.
// Per `feedback_no_localized_strings_server_side`: circuit_state is
// typed (state + counts); cic renders the human-readable label.

const BAHAMUT: AdminNetwork = {
  id: 1,
  slug: "bahamut-test",
  max_concurrent_visitor_sessions: 100,
  max_concurrent_user_sessions: 3,
  max_per_client: 5,
  inserted_at: "2026-05-01T00:00:00Z",
  updated_at: "2026-05-15T00:00:00Z",
  circuit_state: null,
  live_counts: { visitors: 0, users: 0 },
};

const AZZURRA: AdminNetwork = {
  id: 2,
  slug: "azzurra",
  max_concurrent_visitor_sessions: 100,
  max_concurrent_user_sessions: 3,
  max_per_client: 3,
  inserted_at: "2026-05-01T00:00:00Z",
  updated_at: "2026-05-15T00:00:00Z",
  circuit_state: null,
  live_counts: { visitors: 0, users: 0 },
};

const OPEN_CIRCUIT: AdminNetwork = {
  id: 3,
  slug: "tripped",
  max_concurrent_visitor_sessions: 100,
  max_concurrent_user_sessions: 3,
  max_per_client: 3,
  inserted_at: "2026-05-01T00:00:00Z",
  updated_at: "2026-05-15T00:00:00Z",
  circuit_state: {
    state: "open",
    failure_count: 7,
    window_start_ms: 0,
    cooled_at_ms: 0,
    retry_after_seconds: 12,
  },
  live_counts: { visitors: 0, users: 0 },
};

const UNLIMITED: AdminNetwork = {
  id: 4,
  slug: "unlimited",
  max_concurrent_visitor_sessions: null,
  max_concurrent_user_sessions: null,
  max_per_client: null,
  inserted_at: "2026-05-01T00:00:00Z",
  updated_at: "2026-05-15T00:00:00Z",
  circuit_state: null,
  live_counts: { visitors: 0, users: 0 },
};

beforeEach(() => {
  vi.clearAllMocks();
  uninstallAdminEvents();
});

// Fake channel that captures handlers; used to inject cap_counts_changed
// events into the adminEvents store from inside the unit test.
function makeFakeAdminChannel(): {
  channel: Channel;
  fireEvent: (event: WireAdminEvent) => void;
} {
  let eventCb: ((p: WireAdminEvent) => void) | null = null;
  const channel = {
    on: (name: string, cb: unknown) => {
      if (name === "event") eventCb = cb as (p: WireAdminEvent) => void;
      return 0;
    },
    leave: () => ({ receive: () => ({ receive: () => undefined }) }),
  } as unknown as Channel;
  return { channel, fireEvent: (e) => eventCb?.(e) };
}

describe("AdminNetworksTab", () => {
  it("renders one row per network after onMount fetch", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminListNetworks).mockResolvedValue([BAHAMUT, AZZURRA]);

    render(() => <AdminNetworksTab />);

    await waitFor(() => {
      expect(screen.getByTestId(`admin-network-row-${BAHAMUT.slug}`)).toBeInTheDocument();
    });
    expect(screen.getByTestId(`admin-network-row-${AZZURRA.slug}`)).toBeInTheDocument();
    expect(api.adminListNetworks).toHaveBeenCalledTimes(1);
  });

  it("renders the empty state when fetch resolves to []", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminListNetworks).mockResolvedValue([]);

    render(() => <AdminNetworksTab />);

    await waitFor(() => {
      expect(screen.getByTestId("admin-networks-empty")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("admin-networks-table")).toBeNull();
  });

  it("renders the error banner when initial fetch fails", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminListNetworks).mockRejectedValue(new api.ApiError(500, "internal_error"));

    render(() => <AdminNetworksTab />);

    await waitFor(() => {
      expect(screen.getByTestId("admin-networks-error")).toBeInTheDocument();
    });
    expect(screen.getByTestId("admin-networks-error").textContent).toContain("refresh to retry");
  });

  it("renders the integer cap value in the editable input field", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminListNetworks).mockResolvedValue([BAHAMUT]);

    render(() => <AdminNetworksTab />);

    const sessionsInput = (await screen.findByTestId(
      `admin-network-max-visitor-sessions-${BAHAMUT.slug}`,
    )) as HTMLInputElement;
    expect(sessionsInput.value).toBe("100");
    const perClientInput = screen.getByTestId(
      `admin-network-max-per-client-${BAHAMUT.slug}`,
    ) as HTMLInputElement;
    expect(perClientInput.value).toBe("5");
  });

  it("renders empty input for null caps (unlimited)", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminListNetworks).mockResolvedValue([UNLIMITED]);

    render(() => <AdminNetworksTab />);

    const sessionsInput = (await screen.findByTestId(
      `admin-network-max-visitor-sessions-${UNLIMITED.slug}`,
    )) as HTMLInputElement;
    expect(sessionsInput.value).toBe("");
    expect(sessionsInput.placeholder).toMatch(/unlimited/i);
  });

  it("Save button disabled when cap values are pristine vs server-echoed", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminListNetworks).mockResolvedValue([BAHAMUT]);

    render(() => <AdminNetworksTab />);

    const save = (await screen.findByTestId(
      `admin-network-save-${BAHAMUT.slug}`,
    )) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });

  it("editing a cap input enables Save and Save fires PATCH with only the changed key", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminListNetworks)
      .mockResolvedValueOnce([BAHAMUT])
      .mockResolvedValueOnce([{ ...BAHAMUT, max_concurrent_visitor_sessions: 200 }]);
    vi.mocked(api.adminPatchNetworkCaps).mockResolvedValue({
      ...BAHAMUT,
      max_concurrent_visitor_sessions: 200,
    });

    render(() => <AdminNetworksTab />);

    const sessionsInput = (await screen.findByTestId(
      `admin-network-max-visitor-sessions-${BAHAMUT.slug}`,
    )) as HTMLInputElement;
    const save = screen.getByTestId(`admin-network-save-${BAHAMUT.slug}`) as HTMLButtonElement;
    fireEvent.input(sessionsInput, { target: { value: "200" } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    // Partial-body contract: cic must NOT echo `max_per_client` when
    // the operator didn't touch it (CRIT-1 of M-10 review — sending
    // the unchanged value would lose concurrent edits to that field).
    await waitFor(() => {
      expect(api.adminPatchNetworkCaps).toHaveBeenCalledWith("test-bearer", BAHAMUT.slug, {
        max_concurrent_visitor_sessions: 200,
      });
    });
    // Server response is authoritative — refresh re-fetches; the next
    // list call returns the new value → Save returns to disabled.
    await waitFor(() => {
      const post = screen.getByTestId(`admin-network-save-${BAHAMUT.slug}`) as HTMLButtonElement;
      expect(post.disabled).toBe(true);
    });
  });

  it("editing BOTH caps in one go sends both keys in the PATCH body", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminListNetworks)
      .mockResolvedValueOnce([BAHAMUT])
      .mockResolvedValueOnce([
        { ...BAHAMUT, max_concurrent_visitor_sessions: 200, max_per_client: 9 },
      ]);
    vi.mocked(api.adminPatchNetworkCaps).mockResolvedValue({
      ...BAHAMUT,
      max_concurrent_visitor_sessions: 200,
      max_per_client: 9,
    });

    render(() => <AdminNetworksTab />);

    const sessionsInput = (await screen.findByTestId(
      `admin-network-max-visitor-sessions-${BAHAMUT.slug}`,
    )) as HTMLInputElement;
    const perClientInput = screen.getByTestId(
      `admin-network-max-per-client-${BAHAMUT.slug}`,
    ) as HTMLInputElement;
    fireEvent.input(sessionsInput, { target: { value: "200" } });
    fireEvent.input(perClientInput, { target: { value: "9" } });
    fireEvent.click(screen.getByTestId(`admin-network-save-${BAHAMUT.slug}`));
    await waitFor(() => {
      expect(api.adminPatchNetworkCaps).toHaveBeenCalledWith("test-bearer", BAHAMUT.slug, {
        max_concurrent_visitor_sessions: 200,
        max_per_client: 9,
      });
    });
  });

  it("clearing a cap input sends null on PATCH (operator clears the cap) for only the cleared key", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminListNetworks)
      .mockResolvedValueOnce([BAHAMUT])
      .mockResolvedValueOnce([{ ...BAHAMUT, max_concurrent_visitor_sessions: null }]);
    vi.mocked(api.adminPatchNetworkCaps).mockResolvedValue({
      ...BAHAMUT,
      max_concurrent_visitor_sessions: null,
    });

    render(() => <AdminNetworksTab />);

    const sessionsInput = (await screen.findByTestId(
      `admin-network-max-visitor-sessions-${BAHAMUT.slug}`,
    )) as HTMLInputElement;
    fireEvent.input(sessionsInput, { target: { value: "" } });
    fireEvent.click(screen.getByTestId(`admin-network-save-${BAHAMUT.slug}`));
    await waitFor(() => {
      expect(api.adminPatchNetworkCaps).toHaveBeenCalledWith("test-bearer", BAHAMUT.slug, {
        max_concurrent_visitor_sessions: null,
      });
    });
  });

  it("rejects negative input client-side without firing PATCH", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminListNetworks).mockResolvedValue([BAHAMUT]);

    render(() => <AdminNetworksTab />);

    const sessionsInput = (await screen.findByTestId(
      `admin-network-max-visitor-sessions-${BAHAMUT.slug}`,
    )) as HTMLInputElement;
    fireEvent.input(sessionsInput, { target: { value: "-3" } });
    const save = screen.getByTestId(`admin-network-save-${BAHAMUT.slug}`) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(sessionsInput.getAttribute("aria-invalid")).toBe("true");
    expect(api.adminPatchNetworkCaps).not.toHaveBeenCalled();
  });

  it("rejects out-of-range (> MAX_CAP) input client-side", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminListNetworks).mockResolvedValue([BAHAMUT]);

    render(() => <AdminNetworksTab />);

    const sessionsInput = (await screen.findByTestId(
      `admin-network-max-visitor-sessions-${BAHAMUT.slug}`,
    )) as HTMLInputElement;
    // 99999999999999999999 exceeds JS safe-integer; cic guards instead
    // of trusting Number.parseInt's silent truncation (HIGH-2).
    fireEvent.input(sessionsInput, { target: { value: "99999999999999999999" } });
    const save = screen.getByTestId(`admin-network-save-${BAHAMUT.slug}`) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(sessionsInput.getAttribute("aria-invalid")).toBe("true");
  });

  it("PATCH error surfaces with verb-only prefix and preserves the operator's typed value", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminListNetworks).mockResolvedValue([BAHAMUT]);
    vi.mocked(api.adminPatchNetworkCaps).mockRejectedValue(
      new api.ApiError(422, "validation_failed"),
    );

    render(() => <AdminNetworksTab />);

    const sessionsInput = (await screen.findByTestId(
      `admin-network-max-visitor-sessions-${BAHAMUT.slug}`,
    )) as HTMLInputElement;
    fireEvent.input(sessionsInput, { target: { value: "200" } });
    fireEvent.click(screen.getByTestId(`admin-network-save-${BAHAMUT.slug}`));
    await waitFor(() => {
      const err = screen.getByTestId("admin-networks-error");
      expect(err.textContent).toContain("save: validation_failed");
    });
    // Operator's typed value MUST survive a server rejection — don't
    // wipe their input on the error path (LOW-13 of M-10 review).
    expect(sessionsInput.value).toBe("200");
  });

  it("does NOT render Reset Circuit when circuit_state is null", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminListNetworks).mockResolvedValue([BAHAMUT]);

    render(() => <AdminNetworksTab />);

    await screen.findByTestId(`admin-network-row-${BAHAMUT.slug}`);
    expect(screen.queryByTestId(`admin-network-reset-circuit-${BAHAMUT.slug}`)).toBeNull();
  });

  it("renders Reset Circuit when circuit_state is non-null, inline-confirm fires POST", async () => {
    const api = await import("../lib/api");
    // Initial render shows the open-circuit row; post-reset refresh
    // returns the same row with circuit_state cleared (matches the
    // post-mutation refresh contract — MED-5).
    vi.mocked(api.adminListNetworks)
      .mockResolvedValueOnce([OPEN_CIRCUIT])
      .mockResolvedValueOnce([{ ...OPEN_CIRCUIT, circuit_state: null }]);
    vi.mocked(api.adminResetCircuit).mockResolvedValue({
      network_id: OPEN_CIRCUIT.id,
      circuit_state: null,
    });

    render(() => <AdminNetworksTab />);

    const btn = (await screen.findByTestId(
      `admin-network-reset-circuit-${OPEN_CIRCUIT.slug}`,
    )) as HTMLButtonElement;
    expect(btn.textContent?.trim()).toBe("Reset Circuit");
    fireEvent.click(btn);
    expect(btn.textContent?.trim()).toBe("Confirm reset?");
    expect(api.adminResetCircuit).not.toHaveBeenCalled();
    fireEvent.click(btn);
    await waitFor(() => {
      expect(api.adminResetCircuit).toHaveBeenCalledWith("test-bearer", OPEN_CIRCUIT.id);
    });
    // Post-mutation refresh: list re-fetched, circuit_state cleared,
    // Reset Circuit button disappears.
    await waitFor(() => {
      expect(screen.queryByTestId(`admin-network-reset-circuit-${OPEN_CIRCUIT.slug}`)).toBeNull();
    });
  });

  it("circuit_state badge renders state + retry_after seconds (operator-readable)", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminListNetworks).mockResolvedValue([OPEN_CIRCUIT]);

    render(() => <AdminNetworksTab />);

    const badge = await screen.findByTestId(`admin-network-circuit-${OPEN_CIRCUIT.slug}`);
    expect(badge.textContent).toMatch(/open/i);
    expect(badge.textContent).toContain("12");
  });

  it("Force Reap inline-confirm fires POST + renders swept count line", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminListNetworks).mockResolvedValue([BAHAMUT]);
    vi.mocked(api.adminRunReaper).mockResolvedValue({
      swept_count: 3,
      swept_at: "2026-05-16T10:00:00Z",
    });

    render(() => <AdminNetworksTab />);

    const btn = (await screen.findByTestId("admin-networks-force-reap")) as HTMLButtonElement;
    expect(btn.textContent?.trim()).toBe("Force Reap");
    fireEvent.click(btn);
    expect(btn.textContent?.trim()).toBe("Confirm reap?");
    fireEvent.click(btn);
    await waitFor(() => {
      expect(api.adminRunReaper).toHaveBeenCalledWith("test-bearer");
    });
    await waitFor(() => {
      const msg = screen.getByTestId("admin-networks-reap-result");
      expect(msg.textContent).toContain("3");
    });
  });

  it("refresh button re-calls adminListNetworks and clears in-flight edits", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminListNetworks).mockResolvedValue([BAHAMUT]);

    render(() => <AdminNetworksTab />);

    const sessionsInput = (await screen.findByTestId(
      `admin-network-max-visitor-sessions-${BAHAMUT.slug}`,
    )) as HTMLInputElement;
    fireEvent.input(sessionsInput, { target: { value: "200" } });
    fireEvent.click(screen.getByTestId("admin-networks-refresh"));
    await waitFor(() => {
      expect(api.adminListNetworks).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      const post = screen.getByTestId(
        `admin-network-max-visitor-sessions-${BAHAMUT.slug}`,
      ) as HTMLInputElement;
      expect(post.value).toBe("100");
    });
  });

  describe("live cap counters (U-5)", () => {
    it("renders cold-state live counts from net.live_counts (no broadcast yet)", async () => {
      const api = await import("../lib/api");
      vi.mocked(api.adminListNetworks).mockResolvedValue([
        { ...BAHAMUT, live_counts: { visitors: 2, users: 1 } },
      ]);

      render(() => <AdminNetworksTab />);

      const cell = await screen.findByTestId(`admin-network-live-visitors-${BAHAMUT.slug}`);
      expect(cell.textContent).toBe("2/100");
      const usersCell = screen.getByTestId(`admin-network-live-users-${BAHAMUT.slug}`);
      expect(usersCell.textContent).toBe("1/3");
    });

    it("renders ∞ when the cap is null (unlimited)", async () => {
      const api = await import("../lib/api");
      vi.mocked(api.adminListNetworks).mockResolvedValue([
        { ...UNLIMITED, live_counts: { visitors: 7, users: 4 } },
      ]);

      render(() => <AdminNetworksTab />);

      const cell = await screen.findByTestId(`admin-network-live-visitors-${UNLIMITED.slug}`);
      expect(cell.textContent).toBe("7/∞");
    });

    it("overlays live :cap_counts_changed broadcasts (server > cold state)", async () => {
      const api = await import("../lib/api");
      vi.mocked(api.adminListNetworks).mockResolvedValue([
        { ...BAHAMUT, live_counts: { visitors: 0, users: 0 } },
      ]);

      render(() => <AdminNetworksTab />);

      // Cold state first.
      let cell = await screen.findByTestId(`admin-network-live-visitors-${BAHAMUT.slug}`);
      expect(cell.textContent).toBe("0/100");

      // Install fake channel, fire broadcast.
      const fake = makeFakeAdminChannel();
      installAdminEvents(fake.channel);

      fake.fireEvent({
        kind: "cap_counts_changed",
        network_id: BAHAMUT.id,
        network_slug: BAHAMUT.slug,
        visitors: 3,
        users: 2,
        max_concurrent_visitor_sessions: 100,
        max_concurrent_user_sessions: 3,
        at: "2026-05-17T12:00:00Z",
      } as WireAdminEvent);

      await waitFor(() => {
        cell = screen.getByTestId(`admin-network-live-visitors-${BAHAMUT.slug}`);
        expect(cell.textContent).toBe("3/100");
      });
      const usersCell = screen.getByTestId(`admin-network-live-users-${BAHAMUT.slug}`);
      expect(usersCell.textContent).toBe("2/3");
    });
  });
});
