import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminSession } from "../lib/api";

vi.mock("../lib/auth", () => ({
  token: () => "test-bearer",
}));

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    adminListSessions: vi.fn(),
    adminDisconnectSession: vi.fn(),
    adminTerminateSession: vi.fn(),
  };
});

import AdminSessionsTab from "../AdminSessionsTab";

// M-cluster M-9b — Sessions tab unit suite. Mirror of
// AdminVisitorsTab.test.tsx structure with TWO action buttons per
// row (Disconnect + Terminate) sharing one mutex (per-row, per-
// button). The mutex shape "<id>:<verb>" keeps a row's Disconnect
// armed-state disjoint from its Terminate armed-state and disjoint
// from sibling rows entirely — second-button click anywhere clears
// the prior arm.
//
// Per `feedback_e2e_user_class_parity_matrix`: admin-gated EXEMPT.
// Per `feedback_css_block_button_wraps_inline_prefix`: textContent
// assertions on both buttons.

const USER_SESSION: AdminSession = {
  subject_kind: "user",
  subject_id: "11111111-1111-1111-1111-111111111111",
  network_id: 1,
  live_state: {
    alive: true,
    pid_inspect: "#PID<0.123.0>",
    mailbox_len: 3,
    memory_bytes: 250_000,
    joined_channels: ["#bofh", "#italia"],
    introspection_degraded: [],
  },
};

const VISITOR_SESSION: AdminSession = {
  subject_kind: "visitor",
  subject_id: "22222222-2222-2222-2222-222222222222",
  network_id: 1,
  live_state: {
    alive: true,
    pid_inspect: "#PID<0.456.0>",
    mailbox_len: 0,
    memory_bytes: 90_000,
    joined_channels: ["#guest"],
    introspection_degraded: [],
  },
};

const DEGRADED_SESSION: AdminSession = {
  subject_kind: "user",
  subject_id: "33333333-3333-3333-3333-333333333333",
  network_id: 2,
  live_state: {
    alive: true,
    pid_inspect: "#PID<0.789.0>",
    mailbox_len: 0,
    memory_bytes: 100_000,
    joined_channels: null,
    introspection_degraded: ["joined_channels"],
  },
};

const DEAD_SESSION: AdminSession = {
  subject_kind: "user",
  subject_id: "44444444-4444-4444-4444-444444444444",
  network_id: 1,
  live_state: {
    alive: false,
    pid_inspect: "#PID<0.999.0>",
    mailbox_len: 0,
    memory_bytes: 0,
    joined_channels: null,
    // `alive` NOT in degraded — the false value is trustworthy
    // (pid registered, Session.Server is genuinely dead between
    // BEAM crash + registry sweep). Distinct from
    // ALIVE_UNKNOWN_SESSION where introspection itself timed out.
    introspection_degraded: ["mailbox_len", "memory_bytes", "joined_channels"],
  },
};

const ALIVE_UNKNOWN_SESSION: AdminSession = {
  subject_kind: "user",
  subject_id: "55555555-5555-5555-5555-555555555555",
  network_id: 1,
  live_state: {
    alive: false,
    pid_inspect: "#PID<0.888.0>",
    mailbox_len: 0,
    memory_bytes: 0,
    joined_channels: null,
    // `alive` IS in degraded — boolean value unreliable; render
    // "alive unknown" rather than trusting the half-truth (M4).
    introspection_degraded: ["alive", "mailbox_len", "memory_bytes", "joined_channels"],
  },
};

function rowId(s: AdminSession): string {
  return `${s.subject_kind}:${s.subject_id}:${s.network_id}`;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AdminSessionsTab", () => {
  it("renders one row per session after the onMount fetch resolves", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminListSessions).mockResolvedValue([USER_SESSION, VISITOR_SESSION]);

    render(() => <AdminSessionsTab />);

    await waitFor(() => {
      expect(screen.getByTestId(`admin-session-row-${rowId(USER_SESSION)}`)).toBeInTheDocument();
    });
    expect(screen.getByTestId(`admin-session-row-${rowId(VISITOR_SESSION)}`)).toBeInTheDocument();
    expect(api.adminListSessions).toHaveBeenCalledTimes(1);
  });

  it("renders the alive badge with joined channel count for live sessions", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminListSessions).mockResolvedValue([USER_SESSION]);

    render(() => <AdminSessionsTab />);

    const badge = await screen.findByLabelText(/alive on 2 channels/i);
    expect(badge).toBeInTheDocument();
    expect(badge.textContent).toContain("2 chan");
  });

  it("renders '?' for joined_channels when the field is degraded", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminListSessions).mockResolvedValue([DEGRADED_SESSION]);

    render(() => <AdminSessionsTab />);

    const badge = await screen.findByLabelText(/alive on \? channels/i);
    expect(badge.textContent).toContain("? chan");
  });

  it("renders a dead badge when alive is false AND not in degraded", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminListSessions).mockResolvedValue([DEAD_SESSION]);

    render(() => <AdminSessionsTab />);

    const badge = await screen.findByLabelText(/pid registered but/i);
    expect(badge.classList.contains("dead")).toBe(true);
    expect(badge.textContent).toContain("pid registered but dead");
  });

  it("renders 'alive unknown' when 'alive' itself is in introspection_degraded (M4)", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminListSessions).mockResolvedValue([ALIVE_UNKNOWN_SESSION]);

    render(() => <AdminSessionsTab />);

    const badge = await screen.findByLabelText(/alive unknown/i);
    expect(badge.classList.contains("dead")).toBe(true);
    expect(badge.textContent).toContain("alive unknown");
  });

  it("renders an introspection_degraded warning chip when non-empty", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminListSessions).mockResolvedValue([DEGRADED_SESSION]);

    render(() => <AdminSessionsTab />);

    const chip = await screen.findByTestId(`admin-session-degraded-${rowId(DEGRADED_SESSION)}`);
    expect(chip.textContent).toContain("joined_channels");
  });

  it("disconnect inline-confirm: first click arms, second click fires POST", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminListSessions).mockResolvedValue([USER_SESSION]);
    vi.mocked(api.adminDisconnectSession).mockResolvedValue(undefined);

    render(() => <AdminSessionsTab />);

    const btn = await screen.findByTestId(`admin-session-disconnect-${rowId(USER_SESSION)}`);
    expect(btn.textContent?.trim()).toBe("Disconnect");
    fireEvent.click(btn);
    expect(btn.textContent?.trim()).toBe("Confirm disconnect?");
    expect(api.adminDisconnectSession).not.toHaveBeenCalled();
    fireEvent.click(btn);
    await waitFor(() => {
      expect(api.adminDisconnectSession).toHaveBeenCalledWith("test-bearer", rowId(USER_SESSION));
    });
  });

  it("terminate inline-confirm: first click arms, second click fires DELETE", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminListSessions).mockResolvedValue([USER_SESSION]);
    vi.mocked(api.adminTerminateSession).mockResolvedValue(undefined);

    render(() => <AdminSessionsTab />);

    const btn = await screen.findByTestId(`admin-session-terminate-${rowId(USER_SESSION)}`);
    fireEvent.click(btn);
    expect(btn.textContent?.trim()).toBe("Confirm terminate?");
    fireEvent.click(btn);
    await waitFor(() => {
      expect(api.adminTerminateSession).toHaveBeenCalledWith("test-bearer", rowId(USER_SESSION));
    });
  });

  it("arming Disconnect on row A disarms Terminate on row A (single mutex per surface)", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminListSessions).mockResolvedValue([USER_SESSION]);

    render(() => <AdminSessionsTab />);

    const disc = await screen.findByTestId(`admin-session-disconnect-${rowId(USER_SESSION)}`);
    const term = screen.getByTestId(`admin-session-terminate-${rowId(USER_SESSION)}`);
    fireEvent.click(term); // arm terminate
    expect(term.textContent?.trim()).toBe("Confirm terminate?");
    expect(disc.textContent?.trim()).toBe("Disconnect");
    fireEvent.click(disc); // arm disconnect → terminate disarms
    expect(disc.textContent?.trim()).toBe("Confirm disconnect?");
    expect(term.textContent?.trim()).toBe("Terminate");
  });

  it("arming on row B disarms a confirm on row A", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminListSessions).mockResolvedValue([USER_SESSION, VISITOR_SESSION]);

    render(() => <AdminSessionsTab />);

    const aDisc = await screen.findByTestId(`admin-session-disconnect-${rowId(USER_SESSION)}`);
    const bDisc = screen.getByTestId(`admin-session-disconnect-${rowId(VISITOR_SESSION)}`);
    fireEvent.click(aDisc);
    expect(aDisc.textContent?.trim()).toBe("Confirm disconnect?");
    fireEvent.click(bDisc);
    expect(bDisc.textContent?.trim()).toBe("Confirm disconnect?");
    expect(aDisc.textContent?.trim()).toBe("Disconnect");
  });

  it("refresh button re-calls adminListSessions and disarms any pending confirm", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminListSessions).mockResolvedValue([USER_SESSION]);

    render(() => <AdminSessionsTab />);

    const btn = await screen.findByTestId(`admin-session-disconnect-${rowId(USER_SESSION)}`);
    fireEvent.click(btn);
    expect(btn.textContent?.trim()).toBe("Confirm disconnect?");
    fireEvent.click(screen.getByTestId("admin-sessions-refresh"));
    await waitFor(() => {
      expect(api.adminListSessions).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      const post = screen.getByTestId(`admin-session-disconnect-${rowId(USER_SESSION)}`);
      expect(post.textContent?.trim()).toBe("Disconnect");
    });
  });

  it("renders the empty state when the fetch resolves to []", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminListSessions).mockResolvedValue([]);

    render(() => <AdminSessionsTab />);

    await waitFor(() => {
      expect(screen.getByTestId("admin-sessions-empty")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("admin-sessions-table")).toBeNull();
  });

  it("renders the error banner when initial fetch fails", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminListSessions).mockRejectedValue(new api.ApiError(500, "internal_error"));

    render(() => <AdminSessionsTab />);

    await waitFor(() => {
      expect(screen.getByTestId("admin-sessions-error")).toBeInTheDocument();
    });
    expect(screen.getByTestId("admin-sessions-error").textContent).toContain("refresh to retry");
  });

  it("surfaces a 422 cannot_disconnect_self error inline prefixed with the verb", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminListSessions).mockResolvedValue([USER_SESSION]);
    vi.mocked(api.adminDisconnectSession).mockRejectedValue(
      new api.ApiError(422, "cannot_disconnect_self"),
    );

    render(() => <AdminSessionsTab />);

    const btn = await screen.findByTestId(`admin-session-disconnect-${rowId(USER_SESSION)}`);
    fireEvent.click(btn); // arm
    fireEvent.click(btn); // confirm → 422
    await waitFor(() => {
      const err = screen.getByTestId("admin-sessions-error");
      expect(err.textContent).toContain("disconnect: cannot_disconnect_self");
    });
  });
});
