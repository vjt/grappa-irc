// Shared platform-faking stubs for iOS / standalone-PWA gated tests.
// One implementation (review fix 2026-06-11): platform.test.ts,
// MediaViewerModal.test.tsx and ScrollbackPane.test.tsx all need to
// fake the same three probes `lib/platform.ts` reads (userAgent,
// navigator.standalone, matchMedia) — divergent per-file copies would
// drift the platform fake away from what the detection code actually
// probes.
//
// jsdom ships none of these: userAgent is spied (restorable via
// vi.restoreAllMocks), the other two are define-then-DELETE — the
// reset must remove the property entirely, not set it to undefined,
// to restore the jsdom baseline the detection guards probe for.

import { vi } from "vitest";

export const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

export function stubIosUserAgent(): void {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(IPHONE_UA);
}

export function stubNavigatorStandalone(value: boolean): void {
  Object.defineProperty(navigator, "standalone", { value, configurable: true });
}

export function stubMatchMedia(matches: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    value: (query: string) => ({ matches, media: query }),
    configurable: true,
  });
}

// iOS-standalone in one call — the gate `escapePwaHref` checks.
export function stubIosStandalone(standalone: boolean): void {
  stubIosUserAgent();
  stubNavigatorStandalone(standalone);
}

export function resetPlatformStubs(): void {
  delete (navigator as Navigator & { standalone?: boolean }).standalone;
  delete (window as { matchMedia?: unknown }).matchMedia;
  vi.restoreAllMocks();
}
