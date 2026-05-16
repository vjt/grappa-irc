import { fireEvent, render, screen } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";

import AdminPane from "../AdminPane";

// M-cluster M-7 — admin console pane skeleton. Per
// `feedback_e2e_user_class_parity_matrix`: AdminPane itself is
// subject-agnostic; the admin-only gate lives at SettingsDrawer +
// Shell.tsx (which only mount this when `me.is_admin === true`).
// Tests here cover the skeleton contract: header renders, close
// button fires, the M-8/9/10/11 stub is visible so an admin operator
// who clicks into the pane sees a coherent surface instead of a
// blank one. Tab markup ships in subsequent buckets.

describe("AdminPane", () => {
  it("renders the 'admin console' header", () => {
    render(() => <AdminPane onClose={vi.fn()} />);
    expect(screen.getByRole("heading", { name: /admin console/i })).toBeInTheDocument();
  });

  it("renders the M-8/9/10/11 placeholder so the pane is never blank", () => {
    render(() => <AdminPane onClose={vi.fn()} />);
    // textContent guard per
    // `feedback_css_block_button_wraps_inline_prefix` — assert the
    // visible-to-operator copy directly, not just the wrapper.
    expect(screen.getByText(/tabs land in M-8/i)).toBeInTheDocument();
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
