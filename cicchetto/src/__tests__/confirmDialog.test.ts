import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  acceptConfirm,
  chooseAlternative,
  confirmRequest,
  dismissConfirm,
  requestConfirm,
} from "../lib/confirmDialog";

// #195 — the generic confirm-dialog store that gates destructive window
// closes (leave channel / disconnect network), replacing the removed #172
// hold-to-close gesture. The store is domain-agnostic: it carries an
// onConfirm closure and fires it ONLY on affirmative accept.

describe("confirmDialog store (#195)", () => {
  beforeEach(() => dismissConfirm());

  it("requestConfirm sets the pending request without firing the action", () => {
    const onConfirm = vi.fn();
    requestConfirm({
      title: "t",
      body: "b",
      confirmLabel: "Yes",
      onConfirm,
      alternative: null,
      choice: null,
      attachments: null,
      defaultButton: "cancel",
    });
    expect(confirmRequest()).toMatchObject({ title: "t", body: "b", confirmLabel: "Yes" });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("acceptConfirm fires the action once and clears the request", () => {
    const onConfirm = vi.fn();
    requestConfirm({
      title: "t",
      body: "b",
      confirmLabel: "Yes",
      onConfirm,
      alternative: null,
      choice: null,
      attachments: null,
      defaultButton: "cancel",
    });
    acceptConfirm();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(confirmRequest()).toBeNull();
  });

  it("dismissConfirm clears the request WITHOUT firing the action (safe default)", () => {
    const onConfirm = vi.fn();
    requestConfirm({
      title: "t",
      body: "b",
      confirmLabel: "Yes",
      onConfirm,
      alternative: null,
      choice: null,
      attachments: null,
      defaultButton: "cancel",
    });
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
    requestConfirm({
      title: "1",
      body: "1",
      confirmLabel: "Yes",
      onConfirm: first,
      alternative: null,
      choice: null,
      attachments: null,
      defaultButton: "cancel",
    });
    requestConfirm({
      title: "2",
      body: "2",
      confirmLabel: "Yes",
      onConfirm: second,
      alternative: null,
      choice: null,
      attachments: null,
      defaultButton: "cancel",
    });
    expect(confirmRequest()?.title).toBe("2");
    acceptConfirm();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  // #816 (vjt's ruling, 2026-08-06) — a request may carry a THIRD door: an
  // alternative way to accomplish what the operator wanted, offered beside
  // Cancel and the affirmative rather than instead of them. The paste guard is
  // the first caller (send it as a .txt upload instead of N messages), but the
  // store stays domain-agnostic: it carries a second closure and fires ONLY
  // the one the operator picked.
  describe("#816 — the alternative door", () => {
    const alt = (onSelect: () => void) => ({ label: "Upload as .txt", onSelect });

    it("chooseAlternative fires the alternative, NOT the affirmative, and clears", () => {
      const onConfirm = vi.fn();
      const onSelect = vi.fn();
      requestConfirm({
        title: "t",
        body: "b",
        confirmLabel: "Yes",
        onConfirm,
        alternative: alt(onSelect),
        choice: null,
        attachments: null,
        defaultButton: "cancel",
      });
      chooseAlternative();
      expect(onSelect).toHaveBeenCalledTimes(1);
      // The two doors are exclusive — picking one must not fire the other.
      expect(onConfirm).not.toHaveBeenCalled();
      expect(confirmRequest()).toBeNull();
    });

    it("acceptConfirm still fires only the affirmative when an alternative is present", () => {
      const onConfirm = vi.fn();
      const onSelect = vi.fn();
      requestConfirm({
        title: "t",
        body: "b",
        confirmLabel: "Yes",
        onConfirm,
        alternative: alt(onSelect),
        choice: null,
        attachments: null,
        defaultButton: "cancel",
      });
      acceptConfirm();
      expect(onConfirm).toHaveBeenCalledTimes(1);
      expect(onSelect).not.toHaveBeenCalled();
    });

    it("dismissConfirm fires neither door", () => {
      const onConfirm = vi.fn();
      const onSelect = vi.fn();
      requestConfirm({
        title: "t",
        body: "b",
        confirmLabel: "Yes",
        onConfirm,
        alternative: alt(onSelect),
        choice: null,
        attachments: null,
        defaultButton: "cancel",
      });
      dismissConfirm();
      expect(onConfirm).not.toHaveBeenCalled();
      expect(onSelect).not.toHaveBeenCalled();
      expect(confirmRequest()).toBeNull();
    });

    it("chooseAlternative on a request that carries none is a safe no-op", () => {
      const onConfirm = vi.fn();
      requestConfirm({
        title: "t",
        body: "b",
        confirmLabel: "Yes",
        onConfirm,
        alternative: null,
        choice: null,
        attachments: null,
        defaultButton: "cancel",
      });
      expect(() => chooseAlternative()).not.toThrow();
      expect(onConfirm).not.toHaveBeenCalled();
      // The request survives: nothing was chosen, so nothing was resolved.
      expect(confirmRequest()).not.toBeNull();
    });
  });
});
