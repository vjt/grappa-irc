import { fireEvent, render, screen } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminCredential, AdminNetwork, AdminVisitor } from "../lib/api";

// #1157 — the dictated column 4: on a phone the row's verbs "collapse
// into ONE button with a dropdown" (vjt, 2026-08-09). Desktop keeps them
// side by side.
//
// The regime is supplied explicitly because jsdom has no matchMedia, and
// it is supplied as a MUTABLE object so this one file can assert both
// sides of the branch: a collapse that also happened on desktop would
// pass a narrow-only file.
//
// What the collapse must NOT do is skip the confirmation. Terminate is
// destructive and `InlineConfirmButton` is sticky by design (the parent
// owns `armed`), so the menu replaces the ARM step only — picking a verb
// arms it, and the cell then has to offer a way back out, because on a
// phone the sibling verb button that disarms it on desktop is not there.

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
    adminListVisitors: vi.fn(),
    adminListCredentials: vi.fn(),
    adminListSessions: vi.fn(),
    adminListNetworks: vi.fn(),
    adminListSessionLogSessions: vi.fn(),
    adminDisconnectSession: vi.fn(),
    adminReconnectSession: vi.fn(),
    adminTerminateSession: vi.fn(),
    adminDeleteVisitor: vi.fn(),
  };
});

import AdminSessionsTab from "../AdminSessionsTab";

const USER_ID = "11111111-1111-1111-1111-111111111111";
const VISITOR_ID = "22222222-2222-2222-2222-222222222222";
const USER_KEY = `user:${USER_ID}:1`;
const VISITOR_KEY = `visitor:${VISITOR_ID}:1`;

const NETWORK = {
  id: 1,
  slug: "azzurra",
  max_concurrent_visitor_sessions: null,
  max_concurrent_user_sessions: null,
  max_per_ip: null,
  live_counts: { visitors: 0, users: 0 },
} as unknown as AdminNetwork;

// A user row carries TWO verbs (`rowActions`) — the only shape the
// collapse has anything to collapse.
const userCredential = (): AdminCredential =>
  ({
    user_id: USER_ID,
    network_id: 1,
    network_slug: "azzurra",
    nick: "vjt",
    ident: null,
    realname: null,
    sasl_user: null,
    auth_method: "sasl",
    auth_command_template: null,
    autojoin_channels: [],
    last_joined_channels: [],
    connection_state: "connected",
    connection_state_reason: null,
    connection_state_changed_at: null,
    inserted_at: "2026-05-16T00:00:00Z",
    updated_at: "2026-05-16T00:00:00Z",
    last_seen_at: "2026-08-10T00:00:00Z",
    live_state: null,
    ...{},
  }) as AdminCredential;

// A parked visitor carries exactly ONE (`reconnect`).
const parkedVisitor = (): AdminVisitor =>
  ({
    id: VISITOR_ID,
    expires_at: "2099-01-01T00:00:00Z",
    identified: false,
    ip: "1.2.3.4",
    inserted_at: "2026-05-16T00:00:00Z",
    last_seen_at: null,
    networks: [
      {
        network_slug: "azzurra",
        network_id: 1,
        nick: "guest1",
        connection_state: "parked",
        live_state: null,
      },
    ],
  }) as AdminVisitor;

async function mountWith(over: {
  visitors?: AdminVisitor[];
  credentials?: AdminCredential[];
}): Promise<void> {
  const api = await import("../lib/api");
  vi.mocked(api.adminListVisitors).mockResolvedValue(over.visitors ?? []);
  vi.mocked(api.adminListCredentials).mockResolvedValue(over.credentials ?? []);
  vi.mocked(api.adminListSessions).mockResolvedValue([]);
  vi.mocked(api.adminListNetworks).mockResolvedValue([NETWORK]);
  vi.mocked(api.adminListSessionLogSessions).mockResolvedValue([]);
  render(() => <AdminSessionsTab />);
}

/** The row's actions cell — the box the dictation is about. */
function actionsCell(key: string): HTMLElement {
  const row = screen.getByTestId(`admin-session-row-${key}`);
  const cell = row.querySelector<HTMLElement>("td.admin-sessions-actions");
  if (cell === null) throw new Error(`no actions cell on row ${key}`);
  return cell;
}

beforeEach(() => {
  vi.clearAllMocks();
  viewport.mobile = false;
  viewport.adminNarrow = false;
});

describe("#1157 — column 4 collapses on a phone", () => {
  it("gives a two-verb row exactly one control, and it is the menu", async () => {
    viewport.mobile = true;
    viewport.adminNarrow = true;
    await mountWith({ credentials: [userCredential()] });
    await screen.findByTestId(`admin-session-row-${USER_KEY}`);

    // Exactly one: a cell that merely ADDED a menu beside the two verbs
    // would still satisfy "the menu is there".
    expect(actionsCell(USER_KEY).querySelectorAll("button")).toHaveLength(1);
    expect(screen.getByTestId(`admin-session-actions-menu-${USER_KEY}`)).toBeTruthy();
    // Absent from the DOM, not CSS-hidden: a hidden copy leaves two of
    // every verb once the menu renders its own.
    expect(screen.queryByTestId(`admin-session-disconnect-${USER_KEY}`)).toBeNull();
    expect(screen.queryByTestId(`admin-session-terminate-${USER_KEY}`)).toBeNull();
  });

  it("offers both verbs inside the dropdown", async () => {
    viewport.mobile = true;
    viewport.adminNarrow = true;
    await mountWith({ credentials: [userCredential()] });
    await screen.findByTestId(`admin-session-row-${USER_KEY}`);

    fireEvent.click(screen.getByTestId(`admin-session-actions-menu-${USER_KEY}`));

    const menu = screen.getByRole("menu");
    expect(menu.textContent).toContain("Disconnect");
    expect(menu.textContent).toContain("Terminate");
  });

  it("arms the picked verb rather than running it", async () => {
    viewport.mobile = true;
    viewport.adminNarrow = true;
    await mountWith({ credentials: [userCredential()] });
    await screen.findByTestId(`admin-session-row-${USER_KEY}`);

    fireEvent.click(screen.getByTestId(`admin-session-actions-menu-${USER_KEY}`));
    fireEvent.click(screen.getByText("Terminate"));

    const api = await import("../lib/api");
    // The destructive verb has NOT fired: the menu replaces the arm step,
    // not the confirmation.
    expect(vi.mocked(api.adminTerminateSession)).not.toHaveBeenCalled();
    const armed = screen.getByTestId(`admin-session-terminate-${USER_KEY}`);
    expect(armed.textContent).toBe("Confirm terminate");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("leaves a way out of the armed state, since no sibling verb can disarm it", async () => {
    viewport.mobile = true;
    viewport.adminNarrow = true;
    await mountWith({ credentials: [userCredential()] });
    await screen.findByTestId(`admin-session-row-${USER_KEY}`);

    fireEvent.click(screen.getByTestId(`admin-session-actions-menu-${USER_KEY}`));
    fireEvent.click(screen.getByText("Terminate"));
    fireEvent.click(screen.getByTestId(`admin-session-actions-cancel-${USER_KEY}`));

    expect(screen.queryByTestId(`admin-session-terminate-${USER_KEY}`)).toBeNull();
    expect(screen.getByTestId(`admin-session-actions-menu-${USER_KEY}`)).toBeTruthy();
  });

  it("does not put a one-item menu in front of a single-verb row", async () => {
    viewport.mobile = true;
    viewport.adminNarrow = true;
    await mountWith({ visitors: [parkedVisitor()] });
    await screen.findByTestId(`admin-session-row-${VISITOR_KEY}`);

    expect(screen.getByTestId(`admin-session-reconnect-${VISITOR_KEY}`)).toBeTruthy();
    expect(screen.queryByTestId(`admin-session-actions-menu-${VISITOR_KEY}`)).toBeNull();
    // Still one control — the rule is "one control in the cell", and a
    // lone verb already satisfies it without a tap to reach it.
    expect(actionsCell(VISITOR_KEY).querySelectorAll("button")).toHaveLength(1);
  });
});

describe("#1157 — desktop keeps the verbs side by side", () => {
  it("renders both verbs inline and grows no menu", async () => {
    await mountWith({ credentials: [userCredential()] });
    await screen.findByTestId(`admin-session-row-${USER_KEY}`);

    expect(screen.getByTestId(`admin-session-disconnect-${USER_KEY}`)).toBeTruthy();
    expect(screen.getByTestId(`admin-session-terminate-${USER_KEY}`)).toBeTruthy();
    expect(screen.queryByTestId(`admin-session-actions-menu-${USER_KEY}`)).toBeNull();
  });
});
