import { fireEvent, render, screen } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";

// M-cluster M-8 / M-9b / M-10 / M-11 + UX-6-B2 — AdminPane mounts
// Visitors + Sessions + Networks + Events + Settings tabs inside
// their respective tabpanels. Mock all five so this suite stays
// focused on the OUTER PANE contract (header + close + tab nav +
// active-tab switching + admin-events subscription lifecycle).
vi.mock("../AdminVisitorsTab", () => ({
  default: () => <div data-testid="admin-visitors-tab-mock">visitors-tab</div>,
}));

vi.mock("../AdminSessionsTab", () => ({
  default: () => <div data-testid="admin-sessions-tab-mock">sessions-tab</div>,
}));

vi.mock("../AdminNetworksTab", () => ({
  default: () => <div data-testid="admin-networks-tab-mock">networks-tab</div>,
}));

vi.mock("../AdminEventsTab", () => ({
  default: () => <div data-testid="admin-events-tab-mock">events-tab</div>,
}));

vi.mock("../AdminSessionLogTab", () => ({
  default: () => <div data-testid="admin-session-log-tab-mock">session-log-tab</div>,
}));

vi.mock("../AdminSettingsTab", () => ({
  default: () => <div data-testid="admin-settings-tab-mock">settings-tab</div>,
}));

// Mock the adminEvents subscription lifecycle. AdminPane calls these
// at mount/unmount; the actual channel join is exercised by the
// Playwright e2e + AdminEventsTab unit suite, not here.
const startSub = vi.fn();
const uninstall = vi.fn();
vi.mock("../lib/adminEvents", () => ({
  startAdminEventsSubscription: () => startSub(),
  uninstallAdminEvents: () => uninstall(),
  adminEvents: () => [],
}));

import AdminPane from "../AdminPane";

// M-cluster M-7 / M-8 / M-9b / M-10 / M-11 — admin console pane.
// Per `feedback_e2e_user_class_parity_matrix`: AdminPane itself is
// subject-agnostic; the admin-only gate lives at SettingsDrawer +
// Shell.tsx (which only mount this when `me.is_admin === true`).

describe("AdminPane", () => {
  it("renders the 'admin console' header", () => {
    render(() => <AdminPane onClose={vi.fn()} />);
    expect(screen.getByRole("heading", { name: /admin console/i })).toBeInTheDocument();
  });

  it("renders all five tabs with Visitors as the default-active tab", () => {
    render(() => <AdminPane onClose={vi.fn()} />);
    const visitorsTab = screen.getByTestId("admin-tab-visitors");
    const sessionsTab = screen.getByTestId("admin-tab-sessions");
    const networksTab = screen.getByTestId("admin-tab-networks");
    const eventsTab = screen.getByTestId("admin-tab-events");
    const settingsTab = screen.getByTestId("admin-tab-settings");
    // textContent assertion per `feedback_css_block_button_wraps_inline_prefix`.
    expect(visitorsTab.textContent).toContain("Visitors");
    expect(sessionsTab.textContent).toContain("Sessions");
    expect(networksTab.textContent).toContain("Networks");
    expect(eventsTab.textContent).toContain("Events");
    expect(settingsTab.textContent).toContain("Settings");
    expect(visitorsTab.getAttribute("aria-selected")).toBe("true");
    expect(sessionsTab.getAttribute("aria-selected")).toBe("false");
    expect(networksTab.getAttribute("aria-selected")).toBe("false");
    expect(eventsTab.getAttribute("aria-selected")).toBe("false");
    expect(settingsTab.getAttribute("aria-selected")).toBe("false");
    expect(eventsTab.getAttribute("role")).toBe("tab");
    expect(settingsTab.getAttribute("role")).toBe("tab");
  });

  it("mounts AdminVisitorsTab inside the active tabpanel by default", () => {
    render(() => <AdminPane onClose={vi.fn()} />);
    expect(screen.getByTestId("admin-visitors-tab-mock")).toBeInTheDocument();
    expect(screen.queryByTestId("admin-sessions-tab-mock")).toBeNull();
    expect(screen.queryByTestId("admin-networks-tab-mock")).toBeNull();
    expect(screen.queryByTestId("admin-events-tab-mock")).toBeNull();
    expect(screen.queryByTestId("admin-settings-tab-mock")).toBeNull();
  });

  it("clicking the Sessions tab swaps the active panel + flips aria-selected", () => {
    render(() => <AdminPane onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId("admin-tab-sessions"));
    expect(screen.getByTestId("admin-sessions-tab-mock")).toBeInTheDocument();
    expect(screen.queryByTestId("admin-visitors-tab-mock")).toBeNull();
    expect(screen.queryByTestId("admin-networks-tab-mock")).toBeNull();
    expect(screen.queryByTestId("admin-events-tab-mock")).toBeNull();
    expect(screen.getByTestId("admin-tab-sessions").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("admin-tab-visitors").getAttribute("aria-selected")).toBe("false");
  });

  it("clicking the Networks tab swaps the active panel + flips aria-selected", () => {
    render(() => <AdminPane onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId("admin-tab-networks"));
    expect(screen.getByTestId("admin-networks-tab-mock")).toBeInTheDocument();
    expect(screen.queryByTestId("admin-events-tab-mock")).toBeNull();
    expect(screen.getByTestId("admin-tab-networks").getAttribute("aria-selected")).toBe("true");
  });

  it("clicking the Events tab swaps the active panel + flips aria-selected", () => {
    render(() => <AdminPane onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId("admin-tab-events"));
    expect(screen.getByTestId("admin-events-tab-mock")).toBeInTheDocument();
    expect(screen.queryByTestId("admin-visitors-tab-mock")).toBeNull();
    expect(screen.queryByTestId("admin-sessions-tab-mock")).toBeNull();
    expect(screen.queryByTestId("admin-networks-tab-mock")).toBeNull();
    expect(screen.queryByTestId("admin-settings-tab-mock")).toBeNull();
    expect(screen.getByTestId("admin-tab-events").getAttribute("aria-selected")).toBe("true");
  });

  it("clicking the Session Log tab swaps the active panel + flips aria-selected (#215)", () => {
    render(() => <AdminPane onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId("admin-tab-session_log"));
    expect(screen.getByTestId("admin-session-log-tab-mock")).toBeInTheDocument();
    expect(screen.queryByTestId("admin-visitors-tab-mock")).toBeNull();
    expect(screen.queryByTestId("admin-events-tab-mock")).toBeNull();
    expect(screen.queryByTestId("admin-settings-tab-mock")).toBeNull();
    expect(screen.getByTestId("admin-tab-session_log").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("admin-tab-events").getAttribute("aria-selected")).toBe("false");
  });

  it("clicking the Settings tab swaps the active panel + flips aria-selected (UX-6-B2)", () => {
    render(() => <AdminPane onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId("admin-tab-settings"));
    expect(screen.getByTestId("admin-settings-tab-mock")).toBeInTheDocument();
    expect(screen.queryByTestId("admin-visitors-tab-mock")).toBeNull();
    expect(screen.queryByTestId("admin-sessions-tab-mock")).toBeNull();
    expect(screen.queryByTestId("admin-networks-tab-mock")).toBeNull();
    expect(screen.queryByTestId("admin-events-tab-mock")).toBeNull();
    expect(screen.getByTestId("admin-tab-settings").getAttribute("aria-selected")).toBe("true");
  });

  it("clicking back to Visitors after Sessions returns the original panel", () => {
    render(() => <AdminPane onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId("admin-tab-sessions"));
    fireEvent.click(screen.getByTestId("admin-tab-visitors"));
    expect(screen.getByTestId("admin-visitors-tab-mock")).toBeInTheDocument();
    expect(screen.queryByTestId("admin-sessions-tab-mock")).toBeNull();
  });

  it("close button fires onClose", () => {
    const onClose = vi.fn();
    render(() => <AdminPane onClose={onClose} />);
    fireEvent.click(screen.getByTestId("admin-pane-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("close button carries an a11y label", () => {
    render(() => <AdminPane onClose={vi.fn()} />);
    expect(screen.getByLabelText(/close admin console/i)).toBeInTheDocument();
  });

  it("starts admin-events subscription on mount, tears down on unmount (M-11)", () => {
    startSub.mockClear();
    uninstall.mockClear();
    const { unmount } = render(() => <AdminPane onClose={vi.fn()} />);
    expect(startSub).toHaveBeenCalledTimes(1);
    expect(uninstall).toHaveBeenCalledTimes(0);
    unmount();
    expect(uninstall).toHaveBeenCalledTimes(1);
  });
});
