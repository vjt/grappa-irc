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

  it("renders no button when the entry has no actionHint", () => {
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
});
