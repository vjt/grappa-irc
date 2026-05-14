import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@solidjs/router", () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock("../lib/theme", () => ({
  getTheme: vi.fn(() => "auto"),
  setTheme: vi.fn(),
}));

vi.mock("../lib/auth", () => ({
  logout: vi.fn().mockResolvedValue(undefined),
  token: () => "test-bearer",
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

const wrap = (open: boolean, onClose = vi.fn()) =>
  render(() => <SettingsDrawer open={open} onClose={onClose} />);

beforeEach(() => {
  vi.clearAllMocks();
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
