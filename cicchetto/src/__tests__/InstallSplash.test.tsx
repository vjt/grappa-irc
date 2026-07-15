import { render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import InstallSplash, {
  INSTALL_CHOICE_BROWSER,
  INSTALL_CHOICE_KEY,
  shouldShowInstallSplash,
} from "../InstallSplash";
import { resetPlatformStubs, stubIosStandalone, stubIosUserAgent } from "./helpers/platformStubs";

// Push notifications cluster B0 — InstallSplash UX coverage.
//
// Component-level: render shape, primary CTA gating on
// `beforeinstallprompt` event availability, secondary CTA's
// localStorage write + dismiss callback. Pure-predicate
// `shouldShowInstallSplash` covers the parent-side mount gate so
// main.tsx can stay logic-light.

describe("shouldShowInstallSplash", () => {
  it("returns true when not standalone and no choice stored", () => {
    expect(shouldShowInstallSplash({ isStandalone: false, storedChoice: null })).toBe(true);
  });

  it("returns false when already standalone (PWA-installed)", () => {
    expect(shouldShowInstallSplash({ isStandalone: true, storedChoice: null })).toBe(false);
  });

  it("returns false when user chose 'Continue from browser' previously", () => {
    expect(
      shouldShowInstallSplash({ isStandalone: false, storedChoice: INSTALL_CHOICE_BROWSER }),
    ).toBe(false);
  });

  it("returns true on unrelated localStorage value (defensive)", () => {
    expect(shouldShowInstallSplash({ isStandalone: false, storedChoice: "garbage" })).toBe(true);
  });
});

describe("InstallSplash", () => {
  beforeEach(() => {
    localStorage.clear();
    window.__cicInstallPrompt = undefined;
  });

  afterEach(() => {
    localStorage.clear();
    window.__cicInstallPrompt = undefined;
    resetPlatformStubs();
  });

  it("renders title, blurb, and the secondary CTA", () => {
    render(() => <InstallSplash onDismiss={() => {}} />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Install Cicchetto/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Continue from browser/i })).toBeInTheDocument();
  });

  it("'Continue from browser' writes localStorage and calls onDismiss", () => {
    const onDismiss = vi.fn();
    render(() => <InstallSplash onDismiss={onDismiss} />);
    screen.getByRole("button", { name: /Continue from browser/i }).click();
    expect(localStorage.getItem(INSTALL_CHOICE_KEY)).toBe(INSTALL_CHOICE_BROWSER);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  // #259 — else branch = graceful hide. On a non-iOS browser that never
  // fired `beforeinstallprompt` (Firefox mobile, Samsung Internet, desktop
  // Firefox/Safari) there is no programmatic install AND no universal chrome
  // to aim an arrow at — so DROP the dead disabled "Install app" button
  // (pre-#259 it rendered one) and surface the manual-menu hint instead.
  it("gracefully hides the Install button on non-iOS with no prompt (shows hint)", () => {
    // jsdom UA is "Mozilla/5.0 (linux) ... jsdom" — non-iOS, no prompt.
    render(() => <InstallSplash onDismiss={() => {}} />);
    expect(screen.queryByRole("button", { name: /Install app/i })).toBeNull();
    expect(screen.getByText(/use your browser menu/i)).toBeInTheDocument();
  });

  it("'Install app' becomes enabled when window.__cicInstallPrompt is pre-set", () => {
    window.__cicInstallPrompt = {
      preventDefault: () => {},
      prompt: vi.fn().mockResolvedValue(undefined),
      userChoice: Promise.resolve({ outcome: "accepted", platform: "web" }),
      platforms: ["web"],
    } as unknown as Window["__cicInstallPrompt"];
    render(() => <InstallSplash onDismiss={() => {}} />);
    expect(screen.getByRole("button", { name: /Install app/i })).not.toBeDisabled();
  });

  it("'Install app' click invokes prompt() and dismisses on accept", async () => {
    const prompt = vi.fn().mockResolvedValue(undefined);
    window.__cicInstallPrompt = {
      preventDefault: () => {},
      prompt,
      userChoice: Promise.resolve({ outcome: "accepted", platform: "web" }),
      platforms: ["web"],
    } as unknown as Window["__cicInstallPrompt"];
    const onDismiss = vi.fn();
    render(() => <InstallSplash onDismiss={onDismiss} />);
    screen.getByRole("button", { name: /Install app/i }).click();
    // Yield to the microtask queue twice (prompt() then userChoice).
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("'Install app' click does NOT dismiss on user-dismissed outcome", async () => {
    window.__cicInstallPrompt = {
      preventDefault: () => {},
      prompt: vi.fn().mockResolvedValue(undefined),
      userChoice: Promise.resolve({ outcome: "dismissed", platform: "web" }),
      platforms: ["web"],
    } as unknown as Window["__cicInstallPrompt"];
    const onDismiss = vi.fn();
    render(() => <InstallSplash onDismiss={onDismiss} />);
    screen.getByRole("button", { name: /Install app/i }).click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("captures a late-firing beforeinstallprompt event after mount", () => {
    render(() => <InstallSplash onDismiss={() => {}} />);
    // #259 graceful hide: no dead button before the event fires (non-iOS,
    // no prompt yet).
    expect(screen.queryByRole("button", { name: /Install app/i })).toBeNull();
    // Simulate Chrome firing the event AFTER mount.
    const event = Object.assign(new Event("beforeinstallprompt"), {
      prompt: vi.fn().mockResolvedValue(undefined),
      userChoice: Promise.resolve({ outcome: "accepted", platform: "web" }),
      platforms: ["web"],
    });
    window.dispatchEvent(event);
    // Now the native Install button appears, enabled.
    expect(screen.getByRole("button", { name: /Install app/i })).not.toBeDisabled();
  });

  // #204/#259 — Add-to-Home-Screen hint. Lives ONLY on the install splash
  // (never the login screen), only for iOS Safari in browser-tab mode.
  // #259: the arrow + step text now target Safari's ⋯ (More) menu — the real
  // entry to Share → Add to Home Screen — NOT the in-page "Continue from
  // browser" button (issue #259, screenshot IMG_9559). Assert branch + TEXT
  // + element presence; the exact arrow-to-⋯ pixel geometry is DEVICE-VERIFY
  // (jsdom + Playwright reproduce neither Safari's chrome nor its position).
  it("does NOT render the A2HS arrow on non-iOS (jsdom default UA)", () => {
    render(() => <InstallSplash onDismiss={() => {}} />);
    expect(screen.queryByTestId("install-a2hs-arrow")).toBeNull();
  });

  it("renders the A2HS arrow on iOS Safari (browser-tab mode)", () => {
    stubIosUserAgent();
    render(() => <InstallSplash onDismiss={() => {}} />);
    expect(screen.getByTestId("install-a2hs-arrow")).toBeInTheDocument();
  });

  it("iOS arrow caption targets the ⋯ menu, not 'Share' (issue #259)", () => {
    stubIosUserAgent();
    render(() => <InstallSplash onDismiss={() => {}} />);
    const arrow = screen.getByTestId("install-a2hs-arrow");
    expect(arrow.textContent).toContain("⋯");
  });

  it("iOS step text guides ⋯ → Share → Add to Home Screen (issue #259)", () => {
    stubIosUserAgent();
    render(() => <InstallSplash onDismiss={() => {}} />);
    const steps = screen.getByTestId("install-ios-steps");
    expect(steps.textContent).toContain("⋯");
    expect(steps.textContent).toMatch(/Share/);
    expect(steps.textContent).toMatch(/Add to Home Screen/);
  });

  it("suppresses the A2HS arrow when already installed (standalone PWA)", () => {
    stubIosStandalone(true);
    render(() => <InstallSplash onDismiss={() => {}} />);
    expect(screen.queryByTestId("install-a2hs-arrow")).toBeNull();
  });

  it("shows the native Install button and NO arrow when the prompt fired (Android/Chromium)", () => {
    window.__cicInstallPrompt = {
      preventDefault: () => {},
      prompt: vi.fn().mockResolvedValue(undefined),
      userChoice: Promise.resolve({ outcome: "accepted", platform: "web" }),
      platforms: ["web"],
    } as unknown as Window["__cicInstallPrompt"];
    render(() => <InstallSplash onDismiss={() => {}} />);
    expect(screen.getByRole("button", { name: /Install app/i })).not.toBeDisabled();
    expect(screen.queryByTestId("install-a2hs-arrow")).toBeNull();
  });
});
