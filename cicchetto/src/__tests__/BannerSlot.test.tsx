import { render, screen } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import BannerSlot from "../BannerSlot";
import type { BannerEntry } from "../lib/errorBanners";

// #119 — pure slot renderer. Injected entries prove the message/severity/
// actionHint rendering contract independent of which source produced them
// (the bundle-refresh source can't be driven in jsdom — bootBundleHash needs
// a DOM script tag — so injection is the honest way to test the actionHint).

describe("BannerSlot", () => {
  it("renders the message and tags the slot with data-source + data-severity", () => {
    const entry: BannerEntry = { source: "ws", severity: "error", message: "boom" };
    const { container } = render(() => <BannerSlot entry={entry} />);
    const slot = container.querySelector(".error-banner");
    expect(slot).not.toBeNull();
    expect(slot?.getAttribute("data-source")).toBe("ws");
    expect(slot?.getAttribute("data-severity")).toBe("error");
    expect(slot?.textContent).toContain("boom");
  });

  it("uses role=alert for error/warn severities and role=status for info", () => {
    const { container: err } = render(() => (
      <BannerSlot entry={{ source: "ws", severity: "error", message: "x" }} />
    ));
    expect(err.querySelector(".error-banner")?.getAttribute("role")).toBe("alert");

    const { container: info } = render(() => (
      <BannerSlot entry={{ source: "bundle-refresh", severity: "info", message: "y" }} />
    ));
    expect(info.querySelector(".error-banner")?.getAttribute("role")).toBe("status");
  });

  it("renders no button when the entry has no actionHint and no onDismiss", () => {
    const { container } = render(() => (
      <BannerSlot entry={{ source: "connectivity", severity: "error", message: "offline" }} />
    ));
    expect(container.querySelector("button")).toBeNull();
  });

  it("renders the actionHint as a labelled button whose click invokes onAction", () => {
    const onAction = vi.fn();
    const entry: BannerEntry = {
      source: "bundle-refresh",
      severity: "info",
      message: "New version available",
      actionHint: { label: "Refresh", onAction },
    };
    render(() => <BannerSlot entry={entry} />);
    const button = screen.getByRole("button", { name: "Refresh" });
    expect(button).toBeInTheDocument();
    button.click();
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  // #207 — every banner carries a × dismiss affordance. The owner passes an
  // onDismiss handler; the slot renders a labelled close button that invokes it
  // (the owner already knows which source this slot is, so no argument needed).
  it("renders a × dismiss button whose click invokes onDismiss", () => {
    const onDismiss = vi.fn();
    const entry: BannerEntry = { source: "ws", severity: "error", message: "boom" };
    render(() => <BannerSlot entry={entry} onDismiss={onDismiss} />);
    const close = screen.getByRole("button", { name: /dismiss/i });
    expect(close).toBeInTheDocument();
    close.click();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("renders the × dismiss button alongside the actionHint button", () => {
    const onDismiss = vi.fn();
    const entry: BannerEntry = {
      source: "bundle-refresh",
      severity: "info",
      message: "New version available",
      actionHint: { label: "Refresh", onAction: vi.fn() },
    };
    render(() => <BannerSlot entry={entry} onDismiss={onDismiss} />);
    // Action + dismiss coexist — an actionable banner is still dismissable
    // (client-local hide, re-arms on recovery).
    expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /dismiss/i })).toBeInTheDocument();
  });
});
