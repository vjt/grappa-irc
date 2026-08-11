import { fireEvent, render, screen } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminNetwork, AdminUser } from "../lib/api";

// #1223 item 1 — the admin console has its OWN breakpoint, and the JS has
// to use it.
//
// The console turns tables into cards, drops the secondary columns and
// swaps the desktop rail for a chip strip at 900px (`default.css`:
// `.adm-col-detail`, the `@media (max-width: 899px)` stacking block, the
// `.admin-pane` grid). `isMobile()` is the SHELL's breakpoint, 768px, and
// three admin gates were reading it — so between 769px and 899px the
// table was already a stack of cards while `AdminRowName` still rendered
// a plain `<span>`: the columns had left and the door to the panel they
// left through was not there (vjt, measured at `b0d5342d`).
//
// That band is the whole reason `isAdminNarrow()` exists. THE form factor
// under test here is the band, not the phone: jsdom has no matchMedia, so
// both signals are supplied explicitly and the two are set to DIFFERENT
// values — a fix that simply read the other signal would fail this file.
//
// The phone (both true) is covered by `adminMobileRowDetail.test.tsx`;
// what is on screen at each width is a CSS question and lives in
// `e2e/tests/issue1223-admin-card-affordances.spec.ts`.

const viewport = vi.hoisted(() => ({ mobile: false, adminNarrow: false }));

vi.mock("../lib/theme", () => ({
  isMobile: () => viewport.mobile,
  isAdminNarrow: () => viewport.adminNarrow,
  prefersDark: () => false,
  applyTheme: vi.fn(),
}));

vi.mock("../lib/auth", () => ({
  token: () => "test-bearer",
}));

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    adminListUsers: vi.fn(),
    adminCreateUser: vi.fn(),
    adminUpdateUserAdmin: vi.fn(),
    adminUpdateUserPassword: vi.fn(),
    adminDeleteUser: vi.fn(),
    adminListNetworks: vi.fn(),
    adminPatchNetworkCaps: vi.fn(),
    adminRunReaper: vi.fn(),
    adminResetCircuit: vi.fn(),
    adminCreateNetwork: vi.fn(),
    adminDeleteNetwork: vi.fn(),
    adminListServers: vi.fn(),
    adminListFeaturedChannels: vi.fn(),
  };
});

vi.mock("../lib/socket", () => ({
  joinAdminEvents: vi.fn(),
}));

import AdminNetworksTab from "../AdminNetworksTab";
import AdminUsersTab from "../AdminUsersTab";
import {
  adminListFeaturedChannels,
  adminListNetworks,
  adminListServers,
  adminListUsers,
} from "../lib/api";

const ALICE: AdminUser = {
  id: "00000000-0000-0000-0000-000000000001",
  name: "alice",
  is_admin: false,
  inserted_at: "2026-05-31T00:00:00Z",
  updated_at: "2026-05-31T00:00:00Z",
  live_session_count: 0,
};

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

beforeEach(() => {
  vi.clearAllMocks();
  viewport.mobile = false;
  viewport.adminNarrow = false;
});

describe("#1223 — the 769-899 band: the card regime without the shell's phone flag", () => {
  beforeEach(() => {
    viewport.mobile = false;
    viewport.adminNarrow = true;
  });

  it("gives a Users row the disclosure, because the columns have already left", async () => {
    vi.mocked(adminListUsers).mockResolvedValue([ALICE]);
    render(() => <AdminUsersTab />);

    await screen.findByTestId(`admin-user-row-${ALICE.id}`);

    // The door, and then that it opens: a button that renders but reveals
    // nothing would satisfy a mere presence check.
    const door = screen.getByTestId(`admin-user-details-${ALICE.id}`);
    expect(door.tagName).toBe("BUTTON");

    fireEvent.click(door);

    const panel = await screen.findByTestId(`admin-user-detail-${ALICE.id}`);
    expect(panel).toHaveTextContent("live sessions");
    expect(panel).toHaveTextContent("inserted");
  });

  it("moves the Networks cap editors into the detail here too", async () => {
    vi.mocked(adminListNetworks).mockResolvedValue([BAHAMUT]);
    vi.mocked(adminListServers).mockResolvedValue([]);
    vi.mocked(adminListFeaturedChannels).mockResolvedValue([]);
    render(() => <AdminNetworksTab />);

    const row = await screen.findByTestId(`admin-network-row-${BAHAMUT.slug}`);
    expect(row.querySelectorAll("td")).toHaveLength(2);
    expect(screen.queryByTestId(`admin-network-max-per-ip-${BAHAMUT.slug}`)).toBeNull();

    fireEvent.click(screen.getByTestId(`admin-network-expand-${BAHAMUT.slug}`));

    const panel = await screen.findByTestId(`admin-network-servers-${BAHAMUT.slug}`);
    expect(panel.contains(screen.getByTestId(`admin-network-max-per-ip-${BAHAMUT.slug}`))).toBe(
      true,
    );
  });
});

// The counter-claim, and it is why the fix is a second breakpoint rather
// than "always render the disclosure": above 900px every column is on
// screen, and a control that reveals what you can already see teaches the
// operator to distrust controls (`AdminRowName`'s own reasoning).
describe("#1223 — above the admin breakpoint nothing changes", () => {
  it("leaves a Users row's identity as plain text", async () => {
    vi.mocked(adminListUsers).mockResolvedValue([ALICE]);
    render(() => <AdminUsersTab />);

    const row = await screen.findByTestId(`admin-user-row-${ALICE.id}`);
    expect(screen.queryByTestId(`admin-user-details-${ALICE.id}`)).toBeNull();
    expect(row.querySelector(".adm-row-name")?.textContent).toBe(ALICE.name);
  });

  it("keeps the Networks cap editors on the row", async () => {
    vi.mocked(adminListNetworks).mockResolvedValue([BAHAMUT]);
    render(() => <AdminNetworksTab />);

    const row = await screen.findByTestId(`admin-network-row-${BAHAMUT.slug}`);
    expect(row.contains(screen.getByTestId(`admin-network-max-per-ip-${BAHAMUT.slug}`))).toBe(true);
  });
});
