import { fireEvent, render, screen } from "@solidjs/testing-library";
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
}));

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
