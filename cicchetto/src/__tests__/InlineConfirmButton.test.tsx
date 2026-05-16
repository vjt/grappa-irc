import { fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import InlineConfirmButton from "../InlineConfirmButton";

// M-cluster M-9b — extraction of M-8's per-row inline-confirm
// machine. The component is "dumb": parent owns the singleton
// `armed-key` signal (so a row armed for "Disconnect" disarms the
// sibling row's "Terminate", and vice-versa, with a single shared
// invariant). Tests pin:
//
//   * idle → armed transition on first click (no onConfirm fire)
//   * armed → confirm fire on second click (onArm NOT re-called)
//   * sibling Arm flips the local view through the `armed` prop
//     (parent re-routes mutex; child reacts)
//   * onCancel NOT exposed to UI (sticky inline-confirm per
//     M-8 design Q2); explicit external reset path is via the parent
//     setting `armed=false`
//
// Per `feedback_css_block_button_wraps_inline_prefix`: textContent
// is the load-bearing assertion (visible label, not aria).

describe("InlineConfirmButton", () => {
  it("renders idleLabel when armed=false", () => {
    render(() => (
      <InlineConfirmButton
        idleLabel="Delete"
        confirmLabel="Confirm delete?"
        armed={false}
        onArm={vi.fn()}
        onConfirm={vi.fn()}
        testId="btn"
      />
    ));
    const btn = screen.getByTestId("btn");
    expect(btn.textContent?.trim()).toBe("Delete");
    expect(btn.classList.contains("confirming")).toBe(false);
  });

  it("renders confirmLabel + .confirming class when armed=true", () => {
    render(() => (
      <InlineConfirmButton
        idleLabel="Delete"
        confirmLabel="Confirm delete?"
        armed={true}
        onArm={vi.fn()}
        onConfirm={vi.fn()}
        testId="btn"
      />
    ));
    const btn = screen.getByTestId("btn");
    expect(btn.textContent?.trim()).toBe("Confirm delete?");
    expect(btn.classList.contains("confirming")).toBe(true);
  });

  it("fires onArm on click when armed=false (NOT onConfirm)", () => {
    const onArm = vi.fn();
    const onConfirm = vi.fn();
    render(() => (
      <InlineConfirmButton
        idleLabel="Delete"
        confirmLabel="Confirm delete?"
        armed={false}
        onArm={onArm}
        onConfirm={onConfirm}
        testId="btn"
      />
    ));
    fireEvent.click(screen.getByTestId("btn"));
    expect(onArm).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("fires onConfirm on click when armed=true (NOT onArm)", () => {
    const onArm = vi.fn();
    const onConfirm = vi.fn();
    render(() => (
      <InlineConfirmButton
        idleLabel="Delete"
        confirmLabel="Confirm delete?"
        armed={true}
        onArm={onArm}
        onConfirm={onConfirm}
        testId="btn"
      />
    ));
    fireEvent.click(screen.getByTestId("btn"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onArm).not.toHaveBeenCalled();
  });

  it("reacts to parent-driven `armed` toggle (sibling re-arm path)", () => {
    const [armed, setArmed] = createSignal(false);
    render(() => (
      <InlineConfirmButton
        idleLabel="Delete"
        confirmLabel="Confirm delete?"
        armed={armed()}
        onArm={() => setArmed(true)}
        onConfirm={vi.fn()}
        testId="btn"
      />
    ));
    const btn = screen.getByTestId("btn");
    expect(btn.textContent?.trim()).toBe("Delete");
    fireEvent.click(btn);
    expect(btn.textContent?.trim()).toBe("Confirm delete?");
    // Parent simulates sibling arming a different row → disarm us.
    setArmed(false);
    expect(btn.textContent?.trim()).toBe("Delete");
  });

  it("threads extraClass onto the rendered button", () => {
    render(() => (
      <InlineConfirmButton
        idleLabel="Disconnect"
        confirmLabel="Confirm disconnect?"
        armed={false}
        onArm={vi.fn()}
        onConfirm={vi.fn()}
        testId="btn"
        extraClass="disconnect-btn"
      />
    ));
    const btn = screen.getByTestId("btn");
    expect(btn.classList.contains("disconnect-btn")).toBe(true);
  });
});
