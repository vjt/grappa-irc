import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import ConfirmModal from "../ConfirmModal";
import { dismissConfirm, requestConfirm } from "../lib/confirmDialog";
import {
  __resetForTest,
  overlayEscapeDepth,
  runTopmostOverlayEscape,
} from "../lib/overlayScrollLock";

// #195 — the explicit confirm modal that replaces the removed #172
// hold-to-close gesture. Store-driven singleton: it renders whatever
// requestConfirm queued, fires the action ONLY on the affirmative button, and
// dismisses (without firing) on Cancel / backdrop / Esc.

describe("ConfirmModal (#195)", () => {
  afterEach(() => {
    dismissConfirm();
    __resetForTest();
  });

  it("renders nothing when no request is pending", () => {
    render(() => <ConfirmModal />);
    expect(screen.queryByTestId("confirm-modal")).toBeNull();
  });

  it("renders the title + interpolated body when a request is pending", () => {
    render(() => <ConfirmModal />);
    requestConfirm({
      title: "Leave channel",
      body: "Do you want to leave #italia?",
      confirmLabel: "Yes",
      onConfirm: vi.fn(),
    });
    expect(screen.getByTestId("confirm-modal")).toBeInTheDocument();
    expect(screen.getByTestId("confirm-modal-body").textContent).toBe(
      "Do you want to leave #italia?",
    );
    // The affirmative button shows the caller's label.
    expect(screen.getByTestId("confirm-modal-confirm").textContent).toBe("Yes");
  });

  it("the affirmative button fires the action and closes", () => {
    const onConfirm = vi.fn();
    render(() => <ConfirmModal />);
    requestConfirm({ title: "t", body: "b", confirmLabel: "Yes", onConfirm });
    fireEvent.click(screen.getByTestId("confirm-modal-confirm"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("confirm-modal")).toBeNull();
  });

  it("Cancel dismisses WITHOUT firing the action", () => {
    const onConfirm = vi.fn();
    render(() => <ConfirmModal />);
    requestConfirm({ title: "t", body: "b", confirmLabel: "Yes", onConfirm });
    fireEvent.click(screen.getByTestId("confirm-modal-cancel"));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByTestId("confirm-modal")).toBeNull();
  });

  it("backdrop click dismisses WITHOUT firing the action", () => {
    const onConfirm = vi.fn();
    render(() => <ConfirmModal />);
    requestConfirm({ title: "t", body: "b", confirmLabel: "Yes", onConfirm });
    fireEvent.click(screen.getByTestId("confirm-modal-backdrop"));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByTestId("confirm-modal")).toBeNull();
  });

  // #232 — Esc dismisses via the shared overlay stack (dismissConfirm, the
  // safe close verb) and never fires the carried action. runTopmostOverlayEscape
  // is the exact verb the global keydown listener invokes (focus-independent).
  it("Escape dismisses WITHOUT firing the action (shared overlay stack)", async () => {
    const onConfirm = vi.fn();
    render(() => <ConfirmModal />);
    requestConfirm({ title: "t", body: "b", confirmLabel: "Yes", onConfirm });
    await waitFor(() => expect(overlayEscapeDepth()).toBe(1));
    expect(runTopmostOverlayEscape()).toBe(true);
    await waitFor(() => expect(screen.queryByTestId("confirm-modal")).toBeNull());
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
