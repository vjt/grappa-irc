import { fireEvent, render, screen } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  audioShareToasts,
  dismissAudioShareToast,
  reportAudioShareFailure,
} from "../lib/audioPlayer";
import {
  BUNDLE_REFRESH_NOTICE_KEY,
  bundleRefreshToasts,
  dismissBundleRefreshToast,
  markBundleRefreshApplied,
} from "../lib/bundleRefreshNotice";
import { applyPresenceChange, applyPresenceError, resetNotifyWatch } from "../lib/notifyWatch";
import { _setScheduleExpiryForTest } from "../lib/toasts";
import Toasts from "../Toasts";

// #775 — the ONE toast surface. Two producers, two queues, one stack element:
// separate fixed overlays would render on top of each other.
//
// It is also where the cross-reload notice is CONSUMED, at mount, because an
// `aria-live` region only speaks mutations it is already in the tree for — an
// announcement made at boot in main.tsx would be inaudible. That makes the
// wiring testable here by rendering, rather than by grepping the composition
// root: these cases go red if the mount-time consume is dropped.
//
// jsdom renders no layout, so this covers the WIRING (a queued toast reaches
// the DOM, a click removes it) and not the appearance. Whether the stack is
// positioned and legible is a browser question, unverified here.

const OLD_BUNDLE = "Tsa4Tfom";
const NEW_BUNDLE = "CiYQNUz0";

// The boot bundle identity is read once from the page's script + meta tags at
// module init, which jsdom has neither of. `importOriginal` keeps `versionLabel`
// (which `bundleRefreshNotice` formats through) real.
vi.mock("../lib/bundleHash", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/bundleHash")>()),
  bootBundleHashAccessor: () => NEW_BUNDLE,
  bootBundleVersionAccessor: () => "0.10.1",
}));

beforeEach(() => {
  sessionStorage.clear();
  _setScheduleExpiryForTest(() => {});
  resetNotifyWatch();
  for (const t of bundleRefreshToasts()) dismissBundleRefreshToast(t.id);
  for (const t of audioShareToasts()) dismissAudioShareToast(t.id);
});

describe("Toasts", () => {
  it("renders a presence transition, migrated onto the shared chrome", () => {
    applyPresenceChange({
      network_id: 42,
      nick: "Foo",
      presence: "online",
      initial: false,
      ts: "2026-08-03T12:00:00Z",
    });

    const { container } = render(() => <Toasts />);

    expect(container.querySelectorAll(".toast-stack .toast-online")).toHaveLength(1);
    expect(screen.getByText("is online")).toBeInTheDocument();
    expect(screen.getByText("Foo")).toBeInTheDocument();
  });

  it("renders a watch-list rejection with the error tone", () => {
    applyPresenceError({ network_id: 42, detail: "aaa,bbb" });

    const { container } = render(() => <Toasts />);

    expect(container.querySelectorAll(".toast-error")).toHaveLength(1);
    expect(screen.getByText(/aaa,bbb/)).toBeInTheDocument();
  });

  it("dismisses a presence toast on click", () => {
    applyPresenceError({ network_id: 42, detail: "aaa,bbb" });

    const { container } = render(() => <Toasts />);
    fireEvent.click(container.querySelector(".toast-error")!);

    expect(container.querySelectorAll(".toast")).toHaveLength(0);
  });

  // issue 2501 — the mini player's share has no status line of its own, so a
  // failure reaching this stack is the whole of its feedback.
  it("renders a mini-player share failure with the error tone, and dismisses it", () => {
    reportAudioShareFailure("share refused");

    const { container } = render(() => <Toasts />);

    expect(container.querySelectorAll(".toast-error")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /share refused/ }));
    expect(container.querySelectorAll(".toast")).toHaveLength(0);
  });

  // The whole feature, end to end on the client side: the departing document
  // left a marker, this one boots on a different bundle and says so — and it
  // says so from INSIDE the mounted live region.
  it("announces an auto-refresh that landed, at mount", () => {
    markBundleRefreshApplied(Date.now(), OLD_BUNDLE, "auto");

    const { container } = render(() => <Toasts />);

    expect(container.querySelectorAll(".toast-stack[aria-live] .toast-update")).toHaveLength(1);
    expect(screen.getByText("Updated to 0.10.1 (CiYQNUz)")).toBeInTheDocument();
    expect(sessionStorage.getItem(BUNDLE_REFRESH_NOTICE_KEY)).toBeNull();
  });

  it("says nothing when the reload landed back on the same bundle", () => {
    markBundleRefreshApplied(Date.now(), NEW_BUNDLE, "auto");

    const { container } = render(() => <Toasts />);

    expect(container.querySelectorAll(".toast")).toHaveLength(0);
  });

  it("says nothing on an ordinary boot", () => {
    const { container } = render(() => <Toasts />);

    expect(container.querySelectorAll(".toast")).toHaveLength(0);
  });

  it("stacks both producers in the one container", () => {
    applyPresenceChange({
      network_id: 42,
      nick: "Foo",
      presence: "offline",
      initial: false,
      ts: "2026-08-03T12:00:00Z",
    });
    markBundleRefreshApplied(Date.now(), OLD_BUNDLE, "auto");

    const { container } = render(() => <Toasts />);

    expect(container.querySelectorAll(".toast-stack")).toHaveLength(1);
    expect(container.querySelectorAll(".toast-stack > .toast")).toHaveLength(2);
  });

  it("dismisses the update toast on click without touching the presence one", () => {
    applyPresenceChange({
      network_id: 42,
      nick: "Foo",
      presence: "online",
      initial: false,
      ts: "2026-08-03T12:00:00Z",
    });
    markBundleRefreshApplied(Date.now(), OLD_BUNDLE, "auto");

    const { container } = render(() => <Toasts />);
    fireEvent.click(container.querySelector(".toast-update")!);

    expect(container.querySelectorAll(".toast-update")).toHaveLength(0);
    expect(container.querySelectorAll(".toast-online")).toHaveLength(1);
  });
});
