import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminVisitor } from "../lib/api";

vi.mock("../lib/auth", () => ({
  token: () => "test-bearer",
}));

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    adminListVisitors: vi.fn(),
    adminDeleteVisitor: vi.fn(),
  };
});

import AdminVisitorsTab from "../AdminVisitorsTab";

// M-cluster M-8 — Visitors tab unit suite. Covers:
//   * row render from a successful list fetch
//   * U-0 honesty signal (live_state: null badge) per
//     `feedback_no_silent_drops_closed`
//   * alive badge + joined channel count
//   * inline-confirm state machine per MD4 + design Q2
//   * row splice after a 204 DELETE (NOT refetch — splice keeps
//     scroll position + avoids flash)
//   * switching rows mid-confirm re-arms the new row
//   * refresh button re-calls adminListVisitors
//
// Per `feedback_e2e_user_class_parity_matrix`: AdminVisitorsTab is
// admin-gated EXEMPT — only one class reaches it. The reachability
// gate lives in M-7 SettingsDrawer + Shell.tsx; this suite covers
// the behavior assuming the gate has already passed.
//
// Per `feedback_css_block_button_wraps_inline_prefix`: the inline-
// confirm button's text transition ("Delete" → "Confirm delete?") is
// the load-bearing UX signal. textContent is asserted directly.

const ALIVE: AdminVisitor = {
  id: "00000000-0000-0000-0000-000000000001",
  expires_at: "2099-01-01T00:00:00Z",
  identified: false,
  ip: "1.2.3.4",
  inserted_at: "2026-05-16T00:00:00Z",
  networks: [
    {
      network_slug: "azzurra",
      nick: "alice",
      connection_state: "connected",
      live_state: {
        alive: true,
        pid_inspect: "#PID<0.123.0>",
        mailbox_len: 0,
        memory_bytes: 100_000,
        joined_channels: ["#a", "#b"],
        introspection_degraded: [],
      },
    },
  ],
};

const ORPHANED: AdminVisitor = {
  id: "00000000-0000-0000-0000-000000000002",
  expires_at: "2099-01-01T00:00:00Z",
  identified: false,
  ip: "5.6.7.8",
  inserted_at: "2026-05-16T00:00:00Z",
  networks: [
    {
      network_slug: "azzurra",
      nick: "bob",
      connection_state: "connected",
      // U-0 honesty signal: DB intent says active, BEAM has no pid.
      live_state: null,
    },
  ],
};

const DEAD: AdminVisitor = {
  id: "00000000-0000-0000-0000-000000000003",
  expires_at: "2099-01-01T00:00:00Z",
  identified: false,
  ip: null,
  inserted_at: "2026-05-16T00:00:00Z",
  networks: [
    {
      network_slug: "azzurra",
      nick: "carol",
      connection_state: "connected",
      live_state: {
        alive: false,
        pid_inspect: "#PID<0.999.0>",
        mailbox_len: 0,
        memory_bytes: 100_000,
        joined_channels: null,
        introspection_degraded: ["joined_channels"],
      },
    },
  ],
};

// Bucket D — NickServ-identified visitor: `identified: true` (derived
// server-side from the credentials) + `expires_at: null` (legacy permanent
// shape). The row must surface the WHY of the indefinite expiration.
const NICKSERV_IDENTIFIED: AdminVisitor = {
  id: "00000000-0000-0000-0000-000000000004",
  expires_at: null,
  identified: true,
  ip: "9.10.11.12",
  inserted_at: "2026-05-16T00:00:00Z",
  networks: [
    {
      network_slug: "azzurra",
      nick: "M\\Grappa",
      connection_state: "connected",
      live_state: {
        alive: true,
        pid_inspect: "#PID<0.555.0>",
        mailbox_len: 0,
        memory_bytes: 100_000,
        joined_channels: ["#italia"],
        introspection_degraded: [],
      },
    },
  ],
};

// #211 phase 7 — a registered visitor under the NEW model: `identified:
// true` (derived from the credentials) BUT `expires_at` is a non-null
// sliding future value, because `commit_password/3` no longer clears
// `expires_at` (DESIGN_NOTES 2026-07-12). The row must STILL read as
// "indefinite (NickServ)" — the Reaper excludes registered visitors via
// the derived NOT-IN subquery, so showing a countdown here would be a
// lie. This is the regression-lock for the pre-cold-deploy fix: keying
// `renderExpires` off `expires_at === null` (the retired model) would
// wrongly render a countdown for this shape.
const REGISTERED_WITH_TTL: AdminVisitor = {
  id: "00000000-0000-0000-0000-000000000005",
  expires_at: "2099-01-01T00:00:00Z",
  identified: true,
  ip: "13.14.15.16",
  inserted_at: "2026-07-12T00:00:00Z",
  networks: [
    {
      network_slug: "azzurra",
      nick: "RegdGrappa",
      connection_state: "connected",
      live_state: {
        alive: true,
        pid_inspect: "#PID<0.777.0>",
        mailbox_len: 0,
        memory_bytes: 100_000,
        joined_channels: ["#italia"],
        introspection_degraded: [],
      },
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AdminVisitorsTab", () => {
  it("renders one row per visitor after the onMount fetch resolves", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminListVisitors).mockResolvedValue([ALIVE, ORPHANED, DEAD]);

    render(() => <AdminVisitorsTab />);

    await waitFor(() => {
      expect(screen.getByTestId(`admin-visitor-row-${ALIVE.id}`)).toBeInTheDocument();
    });
    expect(screen.getByTestId(`admin-visitor-row-${ORPHANED.id}`)).toBeInTheDocument();
    expect(screen.getByTestId(`admin-visitor-row-${DEAD.id}`)).toBeInTheDocument();
    expect(api.adminListVisitors).toHaveBeenCalledTimes(1);
  });

  it("renders the U-0 honesty badge when live_state is null", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminListVisitors).mockResolvedValue([ORPHANED]);

    render(() => <AdminVisitorsTab />);

    const badge = await screen.findByText(/BEAM has no pid/i);
    expect(badge).toBeInTheDocument();
    expect(badge.classList.contains("live-badge")).toBe(true);
    expect(badge.classList.contains("none")).toBe(true);
  });

  it("renders 'indefinite (NickServ)' when expires_at is null (Bucket D)", async () => {
    // Pre-fix the bare "indefinite" left the WHY invisible — the
    // operator couldn't distinguish "indefinite because identified"
    // from "indefinite because of a bug". The parenthetical pins it
    // to the V7 NickServ-identified semantic.
    const api = await import("../lib/api");
    vi.mocked(api.adminListVisitors).mockResolvedValue([NICKSERV_IDENTIFIED]);

    render(() => <AdminVisitorsTab />);

    const row = await screen.findByTestId(`admin-visitor-row-${NICKSERV_IDENTIFIED.id}`);
    expect(row.textContent).toContain("indefinite (NickServ)");
  });

  it("renders 'indefinite (NickServ)' for a phase-7 registered visitor with a non-null sliding expires_at", async () => {
    // #211 phase 7 — commit_password/3 stopped clearing expires_at, so a
    // registered visitor carries `identified: true` AND a future
    // expires_at. renderExpires MUST trust the derived `identified`, not
    // `expires_at === null`, or the operator sees a bogus countdown for a
    // visitor the Reaper will never touch. Regression-lock for the
    // pre-cold-deploy fix.
    const api = await import("../lib/api");
    vi.mocked(api.adminListVisitors).mockResolvedValue([REGISTERED_WITH_TTL]);

    render(() => <AdminVisitorsTab />);

    const row = await screen.findByTestId(`admin-visitor-row-${REGISTERED_WITH_TTL.id}`);
    expect(row.textContent).toContain("indefinite (NickServ)");
    // The bug this locks out: a countdown ("in 47h") for a registered
    // visitor. Assert NO relative-future string leaked into the row.
    expect(row.textContent).not.toMatch(/in \d+[smhd]/);
  });

  it("renders relative future time when expires_at is set (sanity vs bucket D)", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminListVisitors).mockResolvedValue([ALIVE]);

    render(() => <AdminVisitorsTab />);

    const row = await screen.findByTestId(`admin-visitor-row-${ALIVE.id}`);
    // ALIVE has expires_at: "2099-01-01" — far in the future, no
    // NickServ parenthetical.
    expect(row.textContent).not.toContain("(NickServ)");
    expect(row.textContent).toMatch(/in \d+[smhd]/);
  });

  it("renders the alive badge + joined channel count when live_state.alive is true", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminListVisitors).mockResolvedValue([ALIVE]);

    render(() => <AdminVisitorsTab />);

    const badge = await screen.findByLabelText(/alive on 2 channels/i);
    expect(badge).toBeInTheDocument();
    expect(badge.textContent).toContain("2 chan");
  });

  it("inline confirm: first click on Delete flips text without firing the DELETE call", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminListVisitors).mockResolvedValue([ALIVE]);
    vi.mocked(api.adminDeleteVisitor).mockResolvedValue(undefined);

    render(() => <AdminVisitorsTab />);

    const btn = await screen.findByTestId(`admin-visitor-delete-${ALIVE.id}`);
    expect(btn.textContent?.trim()).toBe("Delete");
    fireEvent.click(btn);
    expect(btn.textContent?.trim()).toBe("Confirm delete?");
    expect(api.adminDeleteVisitor).not.toHaveBeenCalled();
  });

  it("inline confirm: second click on the SAME row fires DELETE + splices the row out", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminListVisitors).mockResolvedValue([ALIVE, ORPHANED]);
    vi.mocked(api.adminDeleteVisitor).mockResolvedValue(undefined);

    render(() => <AdminVisitorsTab />);

    const btn = await screen.findByTestId(`admin-visitor-delete-${ALIVE.id}`);
    fireEvent.click(btn); // arm
    fireEvent.click(btn); // confirm

    await waitFor(() => {
      expect(api.adminDeleteVisitor).toHaveBeenCalledWith("test-bearer", ALIVE.id);
    });
    await waitFor(() => {
      expect(screen.queryByTestId(`admin-visitor-row-${ALIVE.id}`)).toBeNull();
    });
    // Sibling rows must NOT be touched by the splice.
    expect(screen.getByTestId(`admin-visitor-row-${ORPHANED.id}`)).toBeInTheDocument();
    // No refetch — the splice is the only re-render path per design Q3.
    expect(api.adminListVisitors).toHaveBeenCalledTimes(1);
  });

  it("switching rows mid-confirm re-arms the new row and disarms the prior", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminListVisitors).mockResolvedValue([ALIVE, ORPHANED]);

    render(() => <AdminVisitorsTab />);

    const aBtn = await screen.findByTestId(`admin-visitor-delete-${ALIVE.id}`);
    const bBtn = screen.getByTestId(`admin-visitor-delete-${ORPHANED.id}`);
    fireEvent.click(aBtn); // arm A
    expect(aBtn.textContent?.trim()).toBe("Confirm delete?");
    fireEvent.click(bBtn); // switch arm to B → disarm A
    expect(bBtn.textContent?.trim()).toBe("Confirm delete?");
    expect(aBtn.textContent?.trim()).toBe("Delete");
  });

  it("refresh button re-calls adminListVisitors", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminListVisitors).mockResolvedValue([]);

    render(() => <AdminVisitorsTab />);

    await waitFor(() => {
      expect(api.adminListVisitors).toHaveBeenCalledTimes(1);
    });
    fireEvent.click(screen.getByTestId("admin-visitors-refresh"));
    await waitFor(() => {
      expect(api.adminListVisitors).toHaveBeenCalledTimes(2);
    });
  });

  it("renders the empty state when the fetch resolves to an empty list", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminListVisitors).mockResolvedValue([]);

    render(() => <AdminVisitorsTab />);

    await waitFor(() => {
      expect(screen.getByTestId("admin-visitors-empty")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("admin-visitors-table")).toBeNull();
  });

  it("renders the error banner + drops the loading indicator when initial fetch fails", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminListVisitors).mockRejectedValue(new api.ApiError(500, "internal_error"));

    render(() => <AdminVisitorsTab />);

    await waitFor(() => {
      expect(screen.getByTestId("admin-visitors-error")).toBeInTheDocument();
    });
    expect(screen.queryByText(/loading…/i)).toBeNull();
    expect(screen.queryByTestId("admin-visitors-table")).toBeNull();
    // The refresh button is the recovery path; MED-3 fix surfaces
    // the hint inside the banner copy.
    expect(screen.getByTestId("admin-visitors-error").textContent).toContain("refresh to retry");
    expect(screen.getByTestId("admin-visitors-refresh")).toBeInTheDocument();
  });
});
