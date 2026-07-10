import { render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import InstallSplash, {
  INSTALL_CHOICE_BROWSER,
  INSTALL_CHOICE_KEY,
  shouldShowInstallSplash,
} from "../InstallSplash";

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
    vi.restoreAllMocks();
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

  it("renders 'Install app' button disabled when no beforeinstallprompt event captured", () => {
    // jsdom UA is "Mozilla/5.0 (linux) ... jsdom" — non-iOS path
    render(() => <InstallSplash onDismiss={() => {}} />);
    const btn = screen.getByRole("button", { name: /Install app/i });
    expect(btn).toBeDisabled();
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
    expect(screen.getByRole("button", { name: /Install app/i })).toBeDisabled();
    // Simulate Chrome firing the event AFTER mount.
    const event = Object.assign(new Event("beforeinstallprompt"), {
      prompt: vi.fn().mockResolvedValue(undefined),
      userChoice: Promise.resolve({ outcome: "accepted", platform: "web" }),
      platforms: ["web"],
    });
    window.dispatchEvent(event);
    expect(screen.getByRole("button", { name: /Install app/i })).not.toBeDisabled();
  });

  // #204 — Add-to-Home-Screen arrow. vjt Q2: it lives ONLY on the install
  // splash (never the login screen), and only for iOS Safari in browser-tab
  // mode (the platform whose Share → Add to Home Screen flow the arrow
  // points at). "Continue from browser" unmounts the whole splash, so the
  // arrow disappears with it — no separate suppression needed.
  it("does NOT render the A2HS arrow on non-iOS (jsdom default UA)", () => {
    render(() => <InstallSplash onDismiss={() => {}} />);
    expect(screen.queryByTestId("install-a2hs-arrow")).toBeNull();
  });

  it("renders the A2HS arrow on iOS Safari (browser-tab mode)", () => {
    vi.stubGlobal("navigator", {
      ...window.navigator,
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    });
    render(() => <InstallSplash onDismiss={() => {}} />);
    expect(screen.getByTestId("install-a2hs-arrow")).toBeInTheDocument();
  });
});
