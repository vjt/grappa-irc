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
});
