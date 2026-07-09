import { beforeEach, describe, expect, it, vi } from "vitest";
import { acceptConfirm, confirmRequest, dismissConfirm, requestConfirm } from "../confirmDialog";

// #195 — the generic confirm-dialog store that gates destructive window
// closes (leave channel / disconnect network), replacing the removed #172
// hold-to-close gesture. The store is domain-agnostic: it carries an
// onConfirm closure and fires it ONLY on affirmative accept.

describe("confirmDialog store (#195)", () => {
  beforeEach(() => dismissConfirm());

  it("requestConfirm sets the pending request without firing the action", () => {
    const onConfirm = vi.fn();
    requestConfirm({ title: "t", body: "b", confirmLabel: "Yes", onConfirm });
    expect(confirmRequest()).toMatchObject({ title: "t", body: "b", confirmLabel: "Yes" });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("acceptConfirm fires the action once and clears the request", () => {
    const onConfirm = vi.fn();
    requestConfirm({ title: "t", body: "b", confirmLabel: "Yes", onConfirm });
    acceptConfirm();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(confirmRequest()).toBeNull();
  });

  it("dismissConfirm clears the request WITHOUT firing the action (safe default)", () => {
    const onConfirm = vi.fn();
    requestConfirm({ title: "t", body: "b", confirmLabel: "Yes", onConfirm });
    dismissConfirm();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(confirmRequest()).toBeNull();
  });

  it("acceptConfirm with no pending request is a safe no-op", () => {
    expect(() => acceptConfirm()).not.toThrow();
    expect(confirmRequest()).toBeNull();
  });

  it("a second requestConfirm replaces the first (one modal at a time)", () => {
    const first = vi.fn();
    const second = vi.fn();
    requestConfirm({ title: "1", body: "1", confirmLabel: "Yes", onConfirm: first });
    requestConfirm({ title: "2", body: "2", confirmLabel: "Yes", onConfirm: second });
    expect(confirmRequest()?.title).toBe("2");
    acceptConfirm();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
