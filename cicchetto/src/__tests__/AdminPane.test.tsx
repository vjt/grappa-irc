import { fireEvent, render, screen } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";

// M-cluster M-8 / M-9b — AdminPane mounts AdminVisitorsTab +
// AdminSessionsTab inside their respective tabpanels. Mock both
// tab components so this suite stays focused on the OUTER PANE
// contract (header + close + tab nav + active-tab switching).
// Tab components have their own dedicated suites.
vi.mock("../AdminVisitorsTab", () => ({
  default: () => <div data-testid="admin-visitors-tab-mock">visitors-tab</div>,
}));

vi.mock("../AdminSessionsTab", () => ({
  default: () => <div data-testid="admin-sessions-tab-mock">sessions-tab</div>,
}));

import AdminPane from "../AdminPane";

// M-cluster M-7 / M-8 / M-9b — admin console pane. Per
// `feedback_e2e_user_class_parity_matrix`: AdminPane itself is
// subject-agnostic; the admin-only gate lives at SettingsDrawer +
// Shell.tsx (which only mount this when `me.is_admin === true`).
// Tests here cover the skeleton contract: header renders, close
// button fires, tab nav present, default Visitors tab mounts,
// switching to Sessions tab swaps panels.

describe("AdminPane", () => {
  it("renders the 'admin console' header", () => {
    render(() => <AdminPane onClose={vi.fn()} />);
    expect(screen.getByRole("heading", { name: /admin console/i })).toBeInTheDocument();
  });

  it("renders both tabs with Visitors as the default-active tab", () => {
    render(() => <AdminPane onClose={vi.fn()} />);
    const visitorsTab = screen.getByTestId("admin-tab-visitors");
    const sessionsTab = screen.getByTestId("admin-tab-sessions");
    // textContent assertion per `feedback_css_block_button_wraps_inline_prefix`.
    expect(visitorsTab.textContent).toContain("Visitors");
    expect(sessionsTab.textContent).toContain("Sessions");
    expect(visitorsTab.getAttribute("aria-selected")).toBe("true");
    expect(sessionsTab.getAttribute("aria-selected")).toBe("false");
    expect(visitorsTab.getAttribute("role")).toBe("tab");
    expect(sessionsTab.getAttribute("role")).toBe("tab");
  });

  it("mounts AdminVisitorsTab inside the active tabpanel by default", () => {
    render(() => <AdminPane onClose={vi.fn()} />);
    expect(screen.getByTestId("admin-visitors-tab-mock")).toBeInTheDocument();
    expect(screen.queryByTestId("admin-sessions-tab-mock")).toBeNull();
  });

  it("clicking the Sessions tab swaps the active panel + flips aria-selected", () => {
    render(() => <AdminPane onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId("admin-tab-sessions"));
    expect(screen.getByTestId("admin-sessions-tab-mock")).toBeInTheDocument();
    expect(screen.queryByTestId("admin-visitors-tab-mock")).toBeNull();
    expect(screen.getByTestId("admin-tab-sessions").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("admin-tab-visitors").getAttribute("aria-selected")).toBe("false");
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
});
