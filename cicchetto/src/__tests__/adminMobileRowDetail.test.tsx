import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminNetwork, AdminUser } from "../lib/api";

// #1074 — a row's detail opens WHERE THE ROW IS, and no admin tab is
// wider than the viewport on a phone.
//
// The two are one knot. The detail panel used to be a sibling of the
// table card, rendered BEFORE it, with an `el.scrollIntoView()` on
// mount: tapping a row far down the list sent the viewport to the top.
// It sat out there because the tables were deliberately wider than a
// phone and anything inside a `<td colspan>` inherits the TABLE's
// width. Take the width away and the panel can go home.
//
// THE form factor under test. `isMobile()` is what `AdminRowName` and
// the Networks column split branch on; jsdom has no matchMedia, so
// without this mock the whole file would silently measure DESKTOP —
// where the disclosure does not even render.
vi.mock("../lib/theme", () => ({
  isMobile: () => true,
  // #1223 — a phone is below BOTH breakpoints. The admin components now
  // read the console's own 899px one; the shell's 768px flag stays for the
  // shell. `adminCardRegime.test.tsx` is the file that sets them apart.
  isAdminNarrow: () => true,
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

const BOB: AdminUser = {
  id: "00000000-0000-0000-0000-000000000002",
  name: "bob",
  is_admin: true,
  inserted_at: "2026-05-31T00:00:00Z",
  updated_at: "2026-05-31T00:00:00Z",
  live_session_count: 2,
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

const AZZURRA: AdminNetwork = {
  ...BAHAMUT,
  id: 2,
  slug: "azzurra",
  max_per_ip: 3,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("#1074 — the row detail opens in the row's own position", () => {
  // Every position assertion opens the FIRST of two rows. Opening the
  // last one would let `nextElementSibling` be null and `closest("tr")`
  // be null for a panel still parked outside the table — null === null
  // is a green that proves nothing.
  it("renders the Users detail as the row's next sibling, inside the same table body", async () => {
    vi.mocked(adminListUsers).mockResolvedValue([ALICE, BOB]);
    render(() => <AdminUsersTab />);

    const aliceRow = await screen.findByTestId(`admin-user-row-${ALICE.id}`);
    const bobRow = screen.getByTestId(`admin-user-row-${BOB.id}`);
    expect(aliceRow.nextElementSibling).toBe(bobRow);

    fireEvent.click(screen.getByTestId(`admin-user-details-${ALICE.id}`));

    const panel = await screen.findByTestId(`admin-user-detail-${ALICE.id}`);
    const panelRow = panel.closest("tr");
    expect(panelRow).not.toBeNull();
    expect(aliceRow.nextElementSibling).toBe(panelRow);
    expect(panelRow?.parentElement).toBe(aliceRow.parentElement);
  });

  it("renders the Users password rotation form in the row's position too", async () => {
    vi.mocked(adminListUsers).mockResolvedValue([ALICE, BOB]);
    render(() => <AdminUsersTab />);

    const aliceRow = await screen.findByTestId(`admin-user-row-${ALICE.id}`);
    fireEvent.click(screen.getByTestId(`admin-user-rotate-password-${ALICE.id}`));

    const form = await screen.findByTestId(`admin-user-rotate-form-${ALICE.id}`);
    const formRow = form.closest("tr");
    expect(formRow).not.toBeNull();
    expect(aliceRow.nextElementSibling).toBe(formRow);
  });
});

describe("#1074 — Networks drops its secondary columns on a phone", () => {
  it("leaves the row with its slug and its actions, and nothing to pan to", async () => {
    vi.mocked(adminListNetworks).mockResolvedValue([BAHAMUT]);
    render(() => <AdminNetworksTab />);

    const row = await screen.findByTestId(`admin-network-row-${BAHAMUT.slug}`);
    expect(row.querySelectorAll("td")).toHaveLength(2);

    // The header must drop the SAME columns — a `<th>` left behind is a
    // column the browser still reserves width for.
    const table = screen.getByTestId("admin-networks-table");
    expect(table.querySelectorAll("thead th")).toHaveLength(2);
  });

  it("moves the cap editors and the circuit badge into the row's detail, not out of reach", async () => {
    vi.mocked(adminListNetworks).mockResolvedValue([BAHAMUT]);
    vi.mocked(adminListServers).mockResolvedValue([]);
    vi.mocked(adminListFeaturedChannels).mockResolvedValue([]);
    render(() => <AdminNetworksTab />);

    await screen.findByTestId(`admin-network-row-${BAHAMUT.slug}`);
    // Closed: the editors are nowhere — not hidden in a `display: none`
    // cell, which would leave two of every control in the DOM once the
    // detail renders its own copy.
    expect(screen.queryByTestId(`admin-network-max-per-ip-${BAHAMUT.slug}`)).toBeNull();
    expect(screen.queryByTestId(`admin-network-circuit-${BAHAMUT.slug}`)).toBeNull();

    fireEvent.click(screen.getByTestId(`admin-network-expand-${BAHAMUT.slug}`));

    const panel = await screen.findByTestId(`admin-network-servers-${BAHAMUT.slug}`);
    await waitFor(() =>
      expect(screen.queryByTestId(`admin-network-max-per-ip-${BAHAMUT.slug}`)).not.toBeNull(),
    );
    for (const testId of [
      `admin-network-max-visitor-sessions-${BAHAMUT.slug}`,
      `admin-network-max-user-sessions-${BAHAMUT.slug}`,
      `admin-network-max-per-ip-${BAHAMUT.slug}`,
      `admin-network-circuit-${BAHAMUT.slug}`,
      `admin-network-live-visitors-${BAHAMUT.slug}`,
      `admin-network-live-users-${BAHAMUT.slug}`,
    ]) {
      expect(panel.contains(screen.getByTestId(testId)), testId).toBe(true);
    }

    // Save stays on the row: the editors are in the panel, the verb that
    // commits them must not be a second scroll away.
    const row = screen.getByTestId(`admin-network-row-${BAHAMUT.slug}`);
    expect(row.contains(screen.getByTestId(`admin-network-save-${BAHAMUT.slug}`))).toBe(true);
  });

  it("opens that detail in the row's own position", async () => {
    vi.mocked(adminListNetworks).mockResolvedValue([BAHAMUT, AZZURRA]);
    vi.mocked(adminListServers).mockResolvedValue([]);
    vi.mocked(adminListFeaturedChannels).mockResolvedValue([]);
    render(() => <AdminNetworksTab />);

    const row = await screen.findByTestId(`admin-network-row-${BAHAMUT.slug}`);
    expect(row.nextElementSibling).toBe(screen.getByTestId(`admin-network-row-${AZZURRA.slug}`));

    fireEvent.click(screen.getByTestId(`admin-network-expand-${BAHAMUT.slug}`));

    const panel = await screen.findByTestId(`admin-network-servers-${BAHAMUT.slug}`);
    const panelRow = panel.closest("tr");
    expect(panelRow).not.toBeNull();
    expect(row.nextElementSibling).toBe(panelRow);
  });
});
