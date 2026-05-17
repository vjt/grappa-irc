import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@solidjs/router", () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock("../lib/theme", () => ({
  getTheme: vi.fn(() => "auto"),
  setTheme: vi.fn(),
}));

vi.mock("../lib/fontSize", () => ({
  getFontSize: vi.fn(() => "M"),
  setFontSize: vi.fn(),
}));

vi.mock("../lib/auth", () => ({
  logout: vi.fn().mockResolvedValue(undefined),
  token: () => "test-bearer",
}));

// M-cluster M-7 — admin gate. SettingsDrawer reads `user()` from
// `lib/networks` to gate the "admin console" entry off
// `me.kind === "user" && me.is_admin === true`. Mock returns a
// mutable holder so individual tests can flip subject + admin flag.
const meHolder = vi.hoisted(() => ({
  current: null as
    | { kind: "user"; id: string; name: string; is_admin: boolean; inserted_at: string }
    | { kind: "visitor"; id: string; nick: string; network_slug: string; expires_at: string }
    | null,
}));
vi.mock("../lib/networks", () => ({
  user: () => meHolder.current,
}));

vi.mock("../lib/push", () => ({
  enablePush: vi.fn().mockResolvedValue({ status: "enabled", subscriptionId: "sub-1" }),
  disablePush: vi.fn().mockResolvedValue(true),
  listPushDevices: vi.fn().mockResolvedValue([]),
  deletePushSubscription: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/userSettings", async () => {
  const actual = await vi.importActual<typeof import("../lib/userSettings")>("../lib/userSettings");
  return {
    ...actual,
    getNotificationPrefs: vi.fn().mockResolvedValue(actual.DEFAULT_NOTIFICATION_PREFS),
    putNotificationPrefs: vi
      .fn()
      .mockImplementation((_t: string, prefs: unknown) => Promise.resolve(prefs)),
  };
});

import SettingsDrawer from "../SettingsDrawer";

const wrap = (open: boolean, onClose = vi.fn(), onOpenAdmin = vi.fn()) =>
  render(() => <SettingsDrawer open={open} onClose={onClose} onOpenAdmin={onOpenAdmin} />);

beforeEach(() => {
  vi.clearAllMocks();
  // Default: no subject loaded yet — covers the pre-login / loading
  // state where me() returns null. Admin entry MUST be hidden.
  meHolder.current = null;
});

describe("SettingsDrawer", () => {
  it("renders theme radios", () => {
    wrap(true);
    expect(screen.getByLabelText(/auto/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/mirc light/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/irssi dark/i)).toBeInTheDocument();
  });

  it("changing radio fires setTheme", async () => {
    const theme = await import("../lib/theme");
    wrap(true);
    fireEvent.click(screen.getByLabelText(/mirc light/i));
    expect(theme.setTheme).toHaveBeenCalledWith("mirc-light");
  });

  it("logout button calls auth.logout", async () => {
    const auth = await import("../lib/auth");
    wrap(true);
    fireEvent.click(screen.getByText(/log out/i));
    expect(auth.logout).toHaveBeenCalled();
  });

  it("backdrop click fires onClose", () => {
    const onClose = vi.fn();
    wrap(true, onClose);
    const backdrop = screen.getByTestId("settings-drawer-backdrop");
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalled();
  });

  it("open=true gives the drawer the .open class", () => {
    wrap(true);
    const drawer = screen.getByRole("dialog", { name: /settings/i });
    expect(drawer.classList.contains("open")).toBe(true);
  });

  it("open=false withholds the .open class", () => {
    wrap(false);
    const drawer = screen.getByRole("dialog", { name: /settings/i });
    expect(drawer.classList.contains("open")).toBe(false);
  });
});

describe("SettingsDrawer notifications section", () => {
  it("renders the master toggle + 4 prefs checkboxes + 2 whitelist inputs", () => {
    wrap(true);
    expect(screen.getByTestId("push-master-toggle")).toBeInTheDocument();
    expect(screen.getByTestId("pref-channel-all")).toBeInTheDocument();
    expect(screen.getByTestId("pref-channel-mentions")).toBeInTheDocument();
    expect(screen.getByTestId("pref-private-all")).toBeInTheDocument();
    expect(screen.getByTestId("pref-channels-only")).toBeInTheDocument();
    expect(screen.getByTestId("pref-nicks-only")).toBeInTheDocument();
  });

  it("loads prefs on mount via getNotificationPrefs", async () => {
    const userSettings = await import("../lib/userSettings");
    wrap(true);
    await waitFor(() => {
      expect(userSettings.getNotificationPrefs).toHaveBeenCalledWith("test-bearer");
    });
  });

  it("clicking master toggle calls enablePush", async () => {
    const push = await import("../lib/push");
    wrap(true);
    const toggle = screen.getByTestId("push-master-toggle") as HTMLInputElement;
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(push.enablePush).toHaveBeenCalledWith("test-bearer");
    });
  });

  it("toggling a pref checkbox calls putNotificationPrefs", async () => {
    const userSettings = await import("../lib/userSettings");
    wrap(true);
    await waitFor(() => {
      expect(userSettings.getNotificationPrefs).toHaveBeenCalled();
    });
    fireEvent.click(screen.getByTestId("pref-channel-all"));
    await waitFor(() => {
      expect(userSettings.putNotificationPrefs).toHaveBeenCalled();
    });
    const lastCall = (userSettings.putNotificationPrefs as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, unknown];
    expect(lastCall[1]).toMatchObject({ channel_messages_all: true });
  });

  it("whitelist input is disabled when corresponding _all is true", async () => {
    const userSettings = await import("../lib/userSettings");
    (userSettings.getNotificationPrefs as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...userSettings.DEFAULT_NOTIFICATION_PREFS,
      channel_messages_all: true,
    });
    wrap(true);
    await waitFor(() => {
      const input = screen.getByTestId("pref-channels-only") as HTMLInputElement;
      expect(input.disabled).toBe(true);
    });
  });

  it("renders permission_denied banner when enablePush rejects", async () => {
    const push = await import("../lib/push");
    (push.enablePush as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: "permission_denied",
    });
    wrap(true);
    fireEvent.click(screen.getByTestId("push-master-toggle"));
    await waitFor(() => {
      expect(screen.getByTestId("push-banner")).toBeInTheDocument();
    });
  });
});

// V6 visitor-parity: the drawer does NOT read me()/getSubject() and is
// subject-agnostic by construction. This describe block pins that
// invariant — if a visitor-gated branch ever sneaks in (e.g. "hide push
// toggle for visitors") the assertions below break loudly. Mirrors the
// user-shape tests with a visitor subject seeded in localStorage to
// match the auth.ts contract; renders + asserts the same surface.
describe("SettingsDrawer (visitor subject)", () => {
  beforeEach(() => {
    localStorage.setItem(
      "grappa-subject",
      JSON.stringify({
        kind: "visitor",
        id: "v1",
        nick: "anon-vjt",
        network_slug: "azzurra",
      }),
    );
  });

  it("renders the same notifications surface for visitor as for user", () => {
    wrap(true);
    expect(screen.getByTestId("push-master-toggle")).toBeInTheDocument();
    expect(screen.getByTestId("pref-channel-all")).toBeInTheDocument();
    expect(screen.getByTestId("pref-channel-mentions")).toBeInTheDocument();
    expect(screen.getByTestId("pref-private-all")).toBeInTheDocument();
    expect(screen.getByTestId("pref-channels-only")).toBeInTheDocument();
    expect(screen.getByTestId("pref-nicks-only")).toBeInTheDocument();
  });

  it("loads notification prefs on mount for visitor (server returns 200, no 403 gate)", async () => {
    const userSettings = await import("../lib/userSettings");
    wrap(true);
    await waitFor(() => {
      expect(userSettings.getNotificationPrefs).toHaveBeenCalledWith("test-bearer");
    });
  });

  it("clicking master toggle calls enablePush for visitor (no client-side hide)", async () => {
    const push = await import("../lib/push");
    wrap(true);
    fireEvent.click(screen.getByTestId("push-master-toggle"));
    await waitFor(() => {
      expect(push.enablePush).toHaveBeenCalledWith("test-bearer");
    });
  });

  it("renders theme + logout for visitor (same chrome as user)", () => {
    wrap(true);
    expect(screen.getByLabelText(/auto/i)).toBeInTheDocument();
    expect(screen.getByText(/log out/i)).toBeInTheDocument();
  });
});

// M-cluster M-7 — admin console entry gate. Per
// `feedback_e2e_user_class_parity_matrix`: the admin entry is
// admin-gated EXEMPT (only one of the three subject classes sees it).
// The vitest covers visibility polarity; the Playwright e2e covers
// end-to-end login → drawer-open → entry-visibility per subject class.
describe("SettingsDrawer (M-7 admin console entry)", () => {
  it("hides admin entry when subject is non-admin user", () => {
    meHolder.current = {
      kind: "user",
      id: "u1",
      name: "alice",
      is_admin: false,
      inserted_at: "x",
    };
    wrap(true);
    expect(screen.queryByTestId("admin-console-entry")).toBeNull();
    expect(screen.queryByText(/admin console/i)).toBeNull();
  });

  it("hides admin entry when subject is a visitor", () => {
    meHolder.current = {
      kind: "visitor",
      id: "v1",
      nick: "anon-vjt",
      network_slug: "azzurra",
      expires_at: "2026-05-17T00:00:00Z",
    };
    wrap(true);
    expect(screen.queryByTestId("admin-console-entry")).toBeNull();
  });

  it("hides admin entry when subject is not yet loaded (me() === null)", () => {
    meHolder.current = null;
    wrap(true);
    expect(screen.queryByTestId("admin-console-entry")).toBeNull();
  });

  it("shows admin entry when user is admin", () => {
    meHolder.current = {
      kind: "user",
      id: "u1",
      name: "vjt",
      is_admin: true,
      inserted_at: "x",
    };
    wrap(true);
    const entry = screen.getByTestId("admin-console-entry");
    expect(entry).toBeInTheDocument();
    // textContent guard per
    // `feedback_css_block_button_wraps_inline_prefix` — pseudo-element
    // sigils / inline prefixes can clip the visible label even when
    // the button itself is present.
    expect(entry.textContent).toContain("admin console");
  });

  it("clicking admin entry fires onClose THEN onOpenAdmin (drawer dismiss → pane mount handoff)", () => {
    meHolder.current = {
      kind: "user",
      id: "u1",
      name: "vjt",
      is_admin: true,
      inserted_at: "x",
    };
    const onClose = vi.fn();
    const onOpenAdmin = vi.fn();
    wrap(true, onClose, onOpenAdmin);
    fireEvent.click(screen.getByTestId("admin-console-entry"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onOpenAdmin).toHaveBeenCalledTimes(1);
    // Order matters — drawer dismisses BEFORE pane mounts so the two
    // overlays don't briefly co-exist. Assert call-order via mock
    // invocation ordinals.
    const closeOrder = onClose.mock.invocationCallOrder[0];
    const openOrder = onOpenAdmin.mock.invocationCallOrder[0];
    expect(closeOrder !== undefined && openOrder !== undefined && closeOrder < openOrder).toBe(
      true,
    );
  });
});
