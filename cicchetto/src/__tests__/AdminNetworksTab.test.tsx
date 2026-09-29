import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import type { Channel } from "phoenix";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminNetwork, WireAdminEvent } from "../lib/api";
import { NETWORKS_NETWORK_SERVICES_FLAVOR } from "../lib/wireTypes";

vi.mock("../lib/auth", () => ({
  token: () => "test-bearer",
}));

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    adminListNetworks: vi.fn(),
    adminPatchNetworkSettings: vi.fn(),
    adminRunReaper: vi.fn(),
    adminResetCircuit: vi.fn(),
    adminCreateNetwork: vi.fn(),
    adminDeleteNetwork: vi.fn(),
    adminNetworkMessageCount: vi.fn(),
    adminListServers: vi.fn(),
    adminAddServer: vi.fn(),
    adminDeleteServer: vi.fn(),
    adminUpdateServer: vi.fn(),
    adminListFeaturedChannels: vi.fn(),
    adminAddFeaturedChannel: vi.fn(),
    adminDeleteFeaturedChannel: vi.fn(),
    adminUpdateFeaturedChannel: vi.fn(),
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
// + max_per_ip) + per-row Save (enabled only when dirty vs.
// server-echoed value) + per-row Reset Circuit (InlineConfirmButton,
// visible only when circuit_state !== null).
//
// Tab-level surface: Sweep visitors (InlineConfirmButton) in the header
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
  services_flavor: null,
  visitor_enabled: false,
  visitor_autoconnect: false,
  max_concurrent_visitor_sessions: 100,
  max_concurrent_user_sessions: 3,
  max_per_ip: 5,
  inserted_at: "2026-05-01T00:00:00Z",
  updated_at: "2026-05-15T00:00:00Z",
  circuit_state: null,
  live_counts: { visitors: 0, users: 0 },
};

const AZZURRA: AdminNetwork = {
  id: 2,
  slug: "azzurra",
  services_flavor: null,
  visitor_enabled: false,
  visitor_autoconnect: false,
  max_concurrent_visitor_sessions: 100,
  max_concurrent_user_sessions: 3,
  max_per_ip: 3,
  inserted_at: "2026-05-01T00:00:00Z",
  updated_at: "2026-05-15T00:00:00Z",
  circuit_state: null,
  live_counts: { visitors: 0, users: 0 },
};

const OPEN_CIRCUIT: AdminNetwork = {
  id: 3,
  slug: "tripped",
  services_flavor: null,
  visitor_enabled: false,
  visitor_autoconnect: false,
  max_concurrent_visitor_sessions: 100,
  max_concurrent_user_sessions: 3,
  max_per_ip: 3,
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
  services_flavor: null,
  visitor_enabled: false,
  visitor_autoconnect: false,
  max_concurrent_visitor_sessions: null,
  max_concurrent_user_sessions: null,
  max_per_ip: null,
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
    const perIpInput = screen.getByTestId(
      `admin-network-max-per-ip-${BAHAMUT.slug}`,
    ) as HTMLInputElement;
    expect(perIpInput.value).toBe("5");
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
    vi.mocked(api.adminPatchNetworkSettings).mockResolvedValue({
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
    // Partial-body contract: cic must NOT echo `max_per_ip` when
    // the operator didn't touch it (CRIT-1 of M-10 review — sending
    // the unchanged value would lose concurrent edits to that field).
    await waitFor(() => {
      expect(api.adminPatchNetworkSettings).toHaveBeenCalledWith("test-bearer", BAHAMUT.slug, {
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
      .mockResolvedValueOnce([{ ...BAHAMUT, max_concurrent_visitor_sessions: 200, max_per_ip: 9 }]);
    vi.mocked(api.adminPatchNetworkSettings).mockResolvedValue({
      ...BAHAMUT,
      max_concurrent_visitor_sessions: 200,
      max_per_ip: 9,
    });

    render(() => <AdminNetworksTab />);

    const sessionsInput = (await screen.findByTestId(
      `admin-network-max-visitor-sessions-${BAHAMUT.slug}`,
    )) as HTMLInputElement;
    const perIpInput = screen.getByTestId(
      `admin-network-max-per-ip-${BAHAMUT.slug}`,
    ) as HTMLInputElement;
    fireEvent.input(sessionsInput, { target: { value: "200" } });
    fireEvent.input(perIpInput, { target: { value: "9" } });
    fireEvent.click(screen.getByTestId(`admin-network-save-${BAHAMUT.slug}`));
    await waitFor(() => {
      expect(api.adminPatchNetworkSettings).toHaveBeenCalledWith("test-bearer", BAHAMUT.slug, {
        max_concurrent_visitor_sessions: 200,
        max_per_ip: 9,
      });
    });
  });

  it("clearing a cap input sends null on PATCH (operator clears the cap) for only the cleared key", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminListNetworks)
      .mockResolvedValueOnce([BAHAMUT])
      .mockResolvedValueOnce([{ ...BAHAMUT, max_concurrent_visitor_sessions: null }]);
    vi.mocked(api.adminPatchNetworkSettings).mockResolvedValue({
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
      expect(api.adminPatchNetworkSettings).toHaveBeenCalledWith("test-bearer", BAHAMUT.slug, {
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
    expect(api.adminPatchNetworkSettings).not.toHaveBeenCalled();
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
    vi.mocked(api.adminPatchNetworkSettings).mockRejectedValue(
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
    expect(btn.textContent?.trim()).toBe("Confirm reset circuit");
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

  it("Sweep visitors inline-confirm fires POST + renders swept count line", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminListNetworks).mockResolvedValue([BAHAMUT]);
    vi.mocked(api.adminRunReaper).mockResolvedValue({
      swept_count: 3,
      swept_at: "2026-05-16T10:00:00Z",
    });

    render(() => <AdminNetworksTab />);

    const btn = (await screen.findByTestId("admin-networks-force-reap")) as HTMLButtonElement;
    expect(btn.textContent?.trim()).toBe("Sweep visitors");
    fireEvent.click(btn);
    expect(btn.textContent?.trim()).toBe("Confirm sweep");
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

  // Admin-panel bucket 5 — network CRUD + servers disclosure
  describe("network create / delete (bucket 5)", () => {
    it("submits the create form to adminCreateNetwork", async () => {
      const api = await import("../lib/api");
      vi.mocked(api.adminListNetworks).mockResolvedValue([BAHAMUT]);
      vi.mocked(api.adminCreateNetwork).mockResolvedValue(AZZURRA);
      render(() => <AdminNetworksTab />);
      await screen.findByTestId(`admin-network-row-${BAHAMUT.slug}`);

      const slug = screen.getByTestId("admin-networks-create-slug") as HTMLInputElement;
      fireEvent.input(slug, { target: { value: "newchat" } });
      fireEvent.click(screen.getByTestId("admin-networks-create-submit"));

      await waitFor(() => {
        expect(api.adminCreateNetwork).toHaveBeenCalledWith(
          "test-bearer",
          expect.objectContaining({ slug: "newchat" }),
        );
      });
    });

    it("delete inline-confirm names the server's message count, then fires adminDeleteNetwork", async () => {
      const api = await import("../lib/api");
      vi.mocked(api.adminListNetworks).mockResolvedValue([BAHAMUT]);
      vi.mocked(api.adminNetworkMessageCount).mockResolvedValue(12345);
      vi.mocked(api.adminDeleteNetwork).mockResolvedValue(undefined);
      render(() => <AdminNetworksTab />);
      await screen.findByTestId(`admin-network-row-${BAHAMUT.slug}`);

      const btn = screen.getByTestId(`admin-network-delete-${BAHAMUT.slug}`);
      expect(btn.textContent).toBe("Delete");
      fireEvent.click(btn);
      await waitFor(() => {
        expect(btn.textContent).toBe("Delete network and 12,345 messages");
      });
      expect(api.adminNetworkMessageCount).toHaveBeenCalledWith("test-bearer", BAHAMUT.id);
      fireEvent.click(btn);
      await waitFor(() => {
        expect(api.adminDeleteNetwork).toHaveBeenCalledWith("test-bearer", BAHAMUT.id);
      });
    });

    // issue 2320 — nobody confirms a delete blind: until the count arrives
    // the armed button says so and cannot be clicked.
    it("keeps the armed delete disabled while the count is outstanding", async () => {
      const api = await import("../lib/api");
      vi.mocked(api.adminListNetworks).mockResolvedValue([BAHAMUT]);
      let resolveCount: (n: number) => void = () => {};
      vi.mocked(api.adminNetworkMessageCount).mockReturnValue(
        new Promise<number>((resolve) => {
          resolveCount = resolve;
        }),
      );
      vi.mocked(api.adminDeleteNetwork).mockResolvedValue(undefined);
      render(() => <AdminNetworksTab />);
      await screen.findByTestId(`admin-network-row-${BAHAMUT.slug}`);

      const btn = screen.getByTestId(`admin-network-delete-${BAHAMUT.slug}`) as HTMLButtonElement;
      fireEvent.click(btn);
      expect(btn.textContent).toBe("Counting messages…");
      expect(btn.disabled).toBe(true);
      fireEvent.click(btn);
      expect(api.adminDeleteNetwork).not.toHaveBeenCalled();

      resolveCount(1);
      await waitFor(() => {
        expect(btn.textContent).toBe("Delete network and 1 message");
      });
      expect(btn.disabled).toBe(false);
    });

    it("disarms and reports when the count cannot be read", async () => {
      const api = await import("../lib/api");
      vi.mocked(api.adminListNetworks).mockResolvedValue([BAHAMUT]);
      vi.mocked(api.adminNetworkMessageCount).mockRejectedValue(
        new api.ApiError(404, "not_found", {}),
      );
      render(() => <AdminNetworksTab />);
      await screen.findByTestId(`admin-network-row-${BAHAMUT.slug}`);

      const btn = screen.getByTestId(`admin-network-delete-${BAHAMUT.slug}`);
      fireEvent.click(btn);
      await waitFor(() => {
        expect(screen.getByTestId("admin-networks-error").textContent).toContain(
          "could not count messages — not_found",
        );
      });
      expect(btn.textContent).toBe("Delete");
      expect(api.adminDeleteNetwork).not.toHaveBeenCalled();
    });

    it("surfaces 409 credentials_present with the operator-facing message", async () => {
      const api = await import("../lib/api");
      vi.mocked(api.adminListNetworks).mockResolvedValue([BAHAMUT]);
      const err = new api.ApiError(409, "credentials_present", { credential_count: 3 });
      vi.mocked(api.adminNetworkMessageCount).mockResolvedValue(0);
      vi.mocked(api.adminDeleteNetwork).mockRejectedValue(err);
      render(() => <AdminNetworksTab />);
      await screen.findByTestId(`admin-network-row-${BAHAMUT.slug}`);

      const btn = screen.getByTestId(`admin-network-delete-${BAHAMUT.slug}`);
      fireEvent.click(btn);
      await waitFor(() => {
        expect(btn.textContent).toBe("Delete network and 0 messages");
      });
      fireEvent.click(btn);
      await waitFor(() => {
        const errBanner = screen.getByTestId("admin-networks-error");
        expect(errBanner.textContent).toContain("3 bound credential");
      });
    });
  });

  describe("servers disclosure (bucket 5)", () => {
    it("expands a network row, lists servers, and adds a new one", async () => {
      const api = await import("../lib/api");
      vi.mocked(api.adminListNetworks).mockResolvedValue([BAHAMUT]);
      vi.mocked(api.adminListServers).mockResolvedValue([
        {
          id: 1,
          network_id: BAHAMUT.id,
          host: "irc.example.test",
          port: 6697,
          tls: true,
          tls_verify: true,
          priority: 0,
          enabled: true,
          source_address: null,
          inserted_at: "2026-05-31T00:00:00Z",
          updated_at: "2026-05-31T00:00:00Z",
        },
      ]);
      vi.mocked(api.adminAddServer).mockResolvedValue({
        id: 2,
        network_id: BAHAMUT.id,
        host: "irc.example2.test",
        port: 6697,
        tls: true,
        tls_verify: true,
        priority: 0,
        enabled: true,
        source_address: null,
        inserted_at: "2026-05-31T00:00:00Z",
        updated_at: "2026-05-31T00:00:00Z",
      });
      render(() => <AdminNetworksTab />);
      await screen.findByTestId(`admin-network-row-${BAHAMUT.slug}`);

      fireEvent.click(screen.getByTestId(`admin-network-expand-${BAHAMUT.slug}`));
      await waitFor(() =>
        expect(screen.queryByTestId(`admin-network-servers-table-${BAHAMUT.slug}`)).not.toBeNull(),
      );
      await waitFor(() =>
        expect(api.adminListServers).toHaveBeenCalledWith("test-bearer", BAHAMUT.id),
      );

      fireEvent.input(screen.getByTestId(`admin-network-add-server-host-${BAHAMUT.slug}`), {
        target: { value: "irc.example2.test" },
      });
      fireEvent.click(screen.getByTestId(`admin-network-add-server-submit-${BAHAMUT.slug}`));

      await waitFor(() => {
        expect(api.adminAddServer).toHaveBeenCalledWith(
          "test-bearer",
          BAHAMUT.id,
          expect.objectContaining({ host: "irc.example2.test", port: 6697, tls: true }),
        );
      });
    });

    // #266 — an empty source field is omitted; a filled one is sent as
    // source_address; the inline per-row editor sets/clears it via PUT.
    it("adds a server WITH a source_address and clears an existing one", async () => {
      const api = await import("../lib/api");
      vi.mocked(api.adminListNetworks).mockResolvedValue([BAHAMUT]);
      vi.mocked(api.adminListServers).mockResolvedValue([
        {
          id: 1,
          network_id: BAHAMUT.id,
          host: "irc.example.test",
          port: 6697,
          tls: true,
          tls_verify: true,
          priority: 0,
          enabled: true,
          source_address: "203.0.113.5",
          inserted_at: "2026-05-31T00:00:00Z",
          updated_at: "2026-05-31T00:00:00Z",
        },
      ]);
      vi.mocked(api.adminAddServer).mockResolvedValue({
        id: 2,
        network_id: BAHAMUT.id,
        host: "irc.example2.test",
        port: 6697,
        tls: true,
        tls_verify: true,
        priority: 0,
        enabled: true,
        source_address: "203.0.113.9",
        inserted_at: "2026-05-31T00:00:00Z",
        updated_at: "2026-05-31T00:00:00Z",
      });
      vi.mocked(api.adminUpdateServer).mockResolvedValue({
        id: 1,
        network_id: BAHAMUT.id,
        host: "irc.example.test",
        port: 6697,
        tls: true,
        tls_verify: true,
        priority: 0,
        enabled: true,
        source_address: null,
        inserted_at: "2026-05-31T00:00:00Z",
        updated_at: "2026-05-31T00:00:00Z",
      });
      render(() => <AdminNetworksTab />);
      await screen.findByTestId(`admin-network-row-${BAHAMUT.slug}`);

      fireEvent.click(screen.getByTestId(`admin-network-expand-${BAHAMUT.slug}`));
      await waitFor(() =>
        expect(screen.queryByTestId(`admin-network-servers-table-${BAHAMUT.slug}`)).not.toBeNull(),
      );

      // Add a server with a source pinned.
      fireEvent.input(screen.getByTestId(`admin-network-add-server-host-${BAHAMUT.slug}`), {
        target: { value: "irc.example2.test" },
      });
      fireEvent.input(screen.getByTestId(`admin-network-add-server-source-${BAHAMUT.slug}`), {
        target: { value: "203.0.113.9" },
      });
      fireEvent.click(screen.getByTestId(`admin-network-add-server-submit-${BAHAMUT.slug}`));
      await waitFor(() => {
        expect(api.adminAddServer).toHaveBeenCalledWith(
          "test-bearer",
          BAHAMUT.id,
          expect.objectContaining({ host: "irc.example2.test", source_address: "203.0.113.9" }),
        );
      });

      // Clear the existing server's source via the inline editor (empty → null).
      fireEvent.input(screen.getByTestId(`admin-network-server-source-input-${BAHAMUT.slug}-1`), {
        target: { value: "" },
      });
      fireEvent.click(screen.getByTestId(`admin-network-server-source-save-${BAHAMUT.slug}-1`));
      await waitFor(() => {
        expect(api.adminUpdateServer).toHaveBeenCalledWith("test-bearer", BAHAMUT.id, 1, {
          source_address: null,
        });
      });
    });

    it("delete-server inline-confirm fires adminDeleteServer", async () => {
      const api = await import("../lib/api");
      vi.mocked(api.adminListNetworks).mockResolvedValue([BAHAMUT]);
      vi.mocked(api.adminListServers).mockResolvedValue([
        {
          id: 1,
          network_id: BAHAMUT.id,
          host: "irc.example.test",
          port: 6697,
          tls: true,
          tls_verify: true,
          priority: 0,
          enabled: true,
          source_address: null,
          inserted_at: "2026-05-31T00:00:00Z",
          updated_at: "2026-05-31T00:00:00Z",
        },
      ]);
      vi.mocked(api.adminDeleteServer).mockResolvedValue({ network_session_count: 0 });
      render(() => <AdminNetworksTab />);
      await screen.findByTestId(`admin-network-row-${BAHAMUT.slug}`);

      fireEvent.click(screen.getByTestId(`admin-network-expand-${BAHAMUT.slug}`));
      await waitFor(() =>
        expect(screen.queryByTestId(`admin-network-servers-table-${BAHAMUT.slug}`)).not.toBeNull(),
      );

      const delBtn = screen.getByTestId(`admin-network-server-delete-${BAHAMUT.slug}-1`);
      fireEvent.click(delBtn);
      fireEvent.click(delBtn);
      await waitFor(() => {
        expect(api.adminDeleteServer).toHaveBeenCalledWith("test-bearer", BAHAMUT.id, 1);
      });
    });
  });

  describe("featured channels disclosure (#85)", () => {
    const FC = {
      id: 1,
      network_id: BAHAMUT.id,
      name: "#sniffo",
      description: "il canale",
      position: 0,
      enabled: true,
      inserted_at: "2026-06-28T00:00:00Z",
      updated_at: "2026-06-28T00:00:00Z",
    };

    it("expands a network row, lists featured channels, and adds one", async () => {
      const api = await import("../lib/api");
      vi.mocked(api.adminListNetworks).mockResolvedValue([BAHAMUT]);
      vi.mocked(api.adminListServers).mockResolvedValue([]);
      vi.mocked(api.adminListFeaturedChannels).mockResolvedValue([FC]);
      vi.mocked(api.adminAddFeaturedChannel).mockResolvedValue({ ...FC, id: 2, name: "#new" });
      render(() => <AdminNetworksTab />);
      await screen.findByTestId(`admin-network-row-${BAHAMUT.slug}`);

      fireEvent.click(screen.getByTestId(`admin-network-expand-${BAHAMUT.slug}`));
      await waitFor(() =>
        expect(screen.queryByTestId(`admin-network-featured-table-${BAHAMUT.slug}`)).not.toBeNull(),
      );
      expect(api.adminListFeaturedChannels).toHaveBeenCalledWith("test-bearer", BAHAMUT.id);

      fireEvent.input(screen.getByTestId(`admin-network-add-featured-name-${BAHAMUT.slug}`), {
        target: { value: "#new" },
      });
      fireEvent.input(
        screen.getByTestId(`admin-network-add-featured-description-${BAHAMUT.slug}`),
        {
          target: { value: "blurb" },
        },
      );
      fireEvent.click(screen.getByTestId(`admin-network-add-featured-submit-${BAHAMUT.slug}`));

      await waitFor(() => {
        expect(api.adminAddFeaturedChannel).toHaveBeenCalledWith(
          "test-bearer",
          BAHAMUT.id,
          expect.objectContaining({ name: "#new", description: "blurb", position: 0 }),
        );
      });
    });

    it("delete-featured inline-confirm fires adminDeleteFeaturedChannel", async () => {
      const api = await import("../lib/api");
      vi.mocked(api.adminListNetworks).mockResolvedValue([BAHAMUT]);
      vi.mocked(api.adminListServers).mockResolvedValue([]);
      vi.mocked(api.adminListFeaturedChannels).mockResolvedValue([FC]);
      vi.mocked(api.adminDeleteFeaturedChannel).mockResolvedValue(undefined);
      render(() => <AdminNetworksTab />);
      await screen.findByTestId(`admin-network-row-${BAHAMUT.slug}`);

      fireEvent.click(screen.getByTestId(`admin-network-expand-${BAHAMUT.slug}`));
      await waitFor(() =>
        expect(screen.queryByTestId(`admin-network-featured-table-${BAHAMUT.slug}`)).not.toBeNull(),
      );

      const delBtn = screen.getByTestId(`admin-network-featured-delete-${BAHAMUT.slug}-1`);
      fireEvent.click(delBtn);
      fireEvent.click(delBtn);
      await waitFor(() => {
        expect(api.adminDeleteFeaturedChannel).toHaveBeenCalledWith("test-bearer", BAHAMUT.id, 1);
      });
    });
  });

  // #1760 — the three settings the backend has whitelisted since #211
  // phase 3 but the pane could not reach. They ride the SAME draft +
  // per-row Save as the caps (one dirty check, one PATCH, only the
  // changed keys), not the fire-immediately toggle the servers and
  // featured sub-tables use. That is not stylistic: `visitor_autoconnect`
  // has a documented ordering hazard against `visitor_enabled`, and only
  // a single PATCH carrying both can flip them without the incoherent
  // pair ever being written.
  describe("visitor allowlist + services flavor (#1760)", () => {
    const VISITOR_ON: AdminNetwork = {
      ...BAHAMUT,
      id: 9,
      slug: "visitor-on",
      services_flavor: "azzurra",
      visitor_enabled: true,
      visitor_autoconnect: true,
    };

    it("seeds the two toggles and the flavor select from the server row", async () => {
      const api = await import("../lib/api");
      vi.mocked(api.adminListNetworks).mockResolvedValue([VISITOR_ON, BAHAMUT]);

      render(() => <AdminNetworksTab />);

      const on = (await screen.findByTestId(
        `admin-network-visitor-enabled-${VISITOR_ON.slug}`,
      )) as HTMLInputElement;
      expect(on.checked).toBe(true);
      const auto = screen.getByTestId(
        `admin-network-visitor-autoconnect-${VISITOR_ON.slug}`,
      ) as HTMLInputElement;
      expect(auto.checked).toBe(true);
      const flavor = screen.getByTestId(
        `admin-network-services-flavor-${VISITOR_ON.slug}`,
      ) as HTMLSelectElement;
      expect(flavor.value).toBe("azzurra");

      // A default row: both false, flavor unclassified (null → "").
      const off = screen.getByTestId(
        `admin-network-visitor-enabled-${BAHAMUT.slug}`,
      ) as HTMLInputElement;
      expect(off.checked).toBe(false);
      const offFlavor = screen.getByTestId(
        `admin-network-services-flavor-${BAHAMUT.slug}`,
      ) as HTMLSelectElement;
      expect(offFlavor.value).toBe("");
    });

    it("offers every wire flavor plus the unclassified blank, from the generated SSOT", async () => {
      const api = await import("../lib/api");
      vi.mocked(api.adminListNetworks).mockResolvedValue([BAHAMUT]);

      render(() => <AdminNetworksTab />);

      const flavor = (await screen.findByTestId(
        `admin-network-services-flavor-${BAHAMUT.slug}`,
      )) as HTMLSelectElement;
      const values = Array.from(flavor.options).map((o) => o.value);
      // The blank is `services_flavor: null` — a real, distinct wire value
      // (`network.ex`: nullable, "never classified"), not a placeholder.
      expect(values).toEqual(["", ...NETWORKS_NETWORK_SERVICES_FLAVOR]);
    });

    it("ticking visitor_enabled enables Save and PATCHes ONLY that key", async () => {
      const api = await import("../lib/api");
      vi.mocked(api.adminListNetworks)
        .mockResolvedValueOnce([BAHAMUT])
        .mockResolvedValueOnce([{ ...BAHAMUT, visitor_enabled: true }]);
      vi.mocked(api.adminPatchNetworkSettings).mockResolvedValue({
        ...BAHAMUT,
        visitor_enabled: true,
      });

      render(() => <AdminNetworksTab />);

      const toggle = (await screen.findByTestId(
        `admin-network-visitor-enabled-${BAHAMUT.slug}`,
      )) as HTMLInputElement;
      const save = screen.getByTestId(`admin-network-save-${BAHAMUT.slug}`) as HTMLButtonElement;
      expect(save.disabled).toBe(true);

      fireEvent.click(toggle);
      expect(save.disabled).toBe(false);
      fireEvent.click(save);

      await waitFor(() => {
        expect(api.adminPatchNetworkSettings).toHaveBeenCalledWith("test-bearer", BAHAMUT.slug, {
          visitor_enabled: true,
        });
      });
      await waitFor(() => {
        const post = screen.getByTestId(`admin-network-save-${BAHAMUT.slug}`) as HTMLButtonElement;
        expect(post.disabled).toBe(true);
      });
    });

    it("choosing a flavor PATCHes it; choosing the blank PATCHes null", async () => {
      const api = await import("../lib/api");
      vi.mocked(api.adminListNetworks).mockResolvedValue([BAHAMUT]);
      vi.mocked(api.adminPatchNetworkSettings).mockResolvedValue({
        ...BAHAMUT,
        services_flavor: "atheme",
      });

      render(() => <AdminNetworksTab />);

      const flavor = (await screen.findByTestId(
        `admin-network-services-flavor-${BAHAMUT.slug}`,
      )) as HTMLSelectElement;
      fireEvent.change(flavor, { target: { value: "atheme" } });
      fireEvent.click(screen.getByTestId(`admin-network-save-${BAHAMUT.slug}`));

      await waitFor(() => {
        expect(api.adminPatchNetworkSettings).toHaveBeenCalledWith("test-bearer", BAHAMUT.slug, {
          services_flavor: "atheme",
        });
      });
    });

    it("clearing an existing flavor back to unclassified PATCHes services_flavor null", async () => {
      const api = await import("../lib/api");
      vi.mocked(api.adminListNetworks).mockResolvedValue([VISITOR_ON]);
      vi.mocked(api.adminPatchNetworkSettings).mockResolvedValue({
        ...VISITOR_ON,
        services_flavor: null,
      });

      render(() => <AdminNetworksTab />);

      const flavor = (await screen.findByTestId(
        `admin-network-services-flavor-${VISITOR_ON.slug}`,
      )) as HTMLSelectElement;
      fireEvent.change(flavor, { target: { value: "" } });
      fireEvent.click(screen.getByTestId(`admin-network-save-${VISITOR_ON.slug}`));

      await waitFor(() => {
        expect(api.adminPatchNetworkSettings).toHaveBeenCalledWith("test-bearer", VISITOR_ON.slug, {
          services_flavor: null,
        });
      });
    });

    // The invariant, half one: autoconnect is a SUBSET of enabled
    // (`networks.ex` `list_visitor_autoconnect/0` — the login filter ANDs
    // the two and drops the odd pair as a no-op). Arming the subset while
    // the superset is off is not an error the server reports, it is a
    // silent nothing — so the control must not be reachable.
    it("cannot arm autoconnect on a network that does not accept visitors", async () => {
      const api = await import("../lib/api");
      vi.mocked(api.adminListNetworks).mockResolvedValue([BAHAMUT]);

      render(() => <AdminNetworksTab />);

      const auto = (await screen.findByTestId(
        `admin-network-visitor-autoconnect-${BAHAMUT.slug}`,
      )) as HTMLInputElement;
      expect(auto.disabled).toBe(true);

      // Ticking visitor_enabled in the DRAFT — before any Save — is
      // enough to unlock it. Requiring a round-trip first would make
      // "enable a network and auto-connect it" a two-Save chore.
      fireEvent.click(screen.getByTestId(`admin-network-visitor-enabled-${BAHAMUT.slug}`));
      expect(auto.disabled).toBe(false);
    });

    // The invariant, half two: revoking the superset must take the subset
    // with it, in the SAME body. Sending `visitor_enabled: false` alone
    // would leave `visitor_autoconnect: true` behind in the row — exactly
    // the stranded pair, reachable by one careless click.
    it("revoking visitor access clears autoconnect in the same PATCH", async () => {
      const api = await import("../lib/api");
      vi.mocked(api.adminListNetworks).mockResolvedValue([VISITOR_ON]);
      vi.mocked(api.adminPatchNetworkSettings).mockResolvedValue({
        ...VISITOR_ON,
        visitor_enabled: false,
        visitor_autoconnect: false,
      });

      render(() => <AdminNetworksTab />);

      const enabled = (await screen.findByTestId(
        `admin-network-visitor-enabled-${VISITOR_ON.slug}`,
      )) as HTMLInputElement;
      const auto = screen.getByTestId(
        `admin-network-visitor-autoconnect-${VISITOR_ON.slug}`,
      ) as HTMLInputElement;
      expect(auto.checked).toBe(true);

      fireEvent.click(enabled);

      // Visibly cleared, not merely dropped from the body on the way out —
      // the operator has to SEE what their click did before they commit it.
      expect(auto.checked).toBe(false);
      expect(auto.disabled).toBe(true);

      fireEvent.click(screen.getByTestId(`admin-network-save-${VISITOR_ON.slug}`));
      await waitFor(() => {
        expect(api.adminPatchNetworkSettings).toHaveBeenCalledWith("test-bearer", VISITOR_ON.slug, {
          visitor_enabled: false,
          visitor_autoconnect: false,
        });
      });
    });

    it("carries a cap edit and a toggle in one body when both are dirty", async () => {
      const api = await import("../lib/api");
      vi.mocked(api.adminListNetworks).mockResolvedValue([BAHAMUT]);
      vi.mocked(api.adminPatchNetworkSettings).mockResolvedValue({
        ...BAHAMUT,
        visitor_enabled: true,
        max_per_ip: 9,
      });

      render(() => <AdminNetworksTab />);

      const perIp = (await screen.findByTestId(
        `admin-network-max-per-ip-${BAHAMUT.slug}`,
      )) as HTMLInputElement;
      fireEvent.input(perIp, { target: { value: "9" } });
      fireEvent.click(screen.getByTestId(`admin-network-visitor-enabled-${BAHAMUT.slug}`));
      fireEvent.click(screen.getByTestId(`admin-network-save-${BAHAMUT.slug}`));

      await waitFor(() => {
        expect(api.adminPatchNetworkSettings).toHaveBeenCalledWith("test-bearer", BAHAMUT.slug, {
          visitor_enabled: true,
          max_per_ip: 9,
        });
      });
    });

    it("refresh discards a toggle draft the operator never saved", async () => {
      const api = await import("../lib/api");
      vi.mocked(api.adminListNetworks).mockResolvedValue([BAHAMUT]);

      render(() => <AdminNetworksTab />);

      const toggle = (await screen.findByTestId(
        `admin-network-visitor-enabled-${BAHAMUT.slug}`,
      )) as HTMLInputElement;
      fireEvent.click(toggle);
      expect(toggle.checked).toBe(true);

      fireEvent.click(screen.getByTestId("admin-networks-refresh"));
      await waitFor(() => {
        expect(api.adminListNetworks).toHaveBeenCalledTimes(2);
      });
      await waitFor(() => {
        const post = screen.getByTestId(
          `admin-network-visitor-enabled-${BAHAMUT.slug}`,
        ) as HTMLInputElement;
        expect(post.checked).toBe(false);
      });
    });
  });
});
