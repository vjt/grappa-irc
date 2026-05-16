import { fireEvent, render, screen } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";

// M-cluster M-8 — AdminPane mounts AdminVisitorsTab inside the
// admin-tab-visitors tabpanel. Mock the tab component so this
// suite stays focused on the OUTER PANE contract (header + close
// + tab nav). AdminVisitorsTab has its own dedicated suite.
vi.mock("../AdminVisitorsTab", () => ({
  default: () => <div data-testid="admin-visitors-tab-mock">visitors-tab</div>,
}));

import AdminPane from "../AdminPane";

// M-cluster M-7 / M-8 — admin console pane. Per
// `feedback_e2e_user_class_parity_matrix`: AdminPane itself is
// subject-agnostic; the admin-only gate lives at SettingsDrawer +
// Shell.tsx (which only mount this when `me.is_admin === true`).
// Tests here cover the skeleton contract: header renders, close
// button fires, tab nav present, default Visitors tab mounts.

describe("AdminPane", () => {
  it("renders the 'admin console' header", () => {
    render(() => <AdminPane onClose={vi.fn()} />);
    expect(screen.getByRole("heading", { name: /admin console/i })).toBeInTheDocument();
  });

  it("renders the tab nav with Visitors as the default-active tab", () => {
    render(() => <AdminPane onClose={vi.fn()} />);
    const tab = screen.getByTestId("admin-tab-visitors");
    // textContent assertion per
    // `feedback_css_block_button_wraps_inline_prefix` — pseudo-element
    // sigils / inline prefixes can clip the visible label even when
    // the button itself is present.
    expect(tab.textContent).toContain("Visitors");
    expect(tab.getAttribute("aria-selected")).toBe("true");
    expect(tab.getAttribute("role")).toBe("tab");
  });

  it("mounts AdminVisitorsTab inside the active tabpanel", () => {
    render(() => <AdminPane onClose={vi.fn()} />);
    expect(screen.getByTestId("admin-visitors-tab-mock")).toBeInTheDocument();
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
