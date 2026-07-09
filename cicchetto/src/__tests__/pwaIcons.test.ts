import { describe, expect, it } from "vitest";
import { pushNotificationOptions } from "../lib/pushPayload";
import { NOTIFICATION_ICON, PWA_ICONS } from "../lib/pwaIcons";

// S18 (codebase review 2026-07-08) — the service-worker's Web Push
// notification pointed `icon`/`badge` at `/icons/icon-192.png`, but icons
// are served at the ROOT (`/icon-192.png`, per `public/` + the manifest).
// Every notification fetched a 404 and rendered the browser's blank glyph.
//
// These tests TIE the SW notification icon to the manifest icon set, which is
// the single source shared with the Vite manifest (`vite.config.ts` imports
// the same `PWA_ICONS`). So the SW and the manifest cannot drift: if a future
// change re-hardcodes a path in the SW that isn't a declared manifest icon,
// the tie test fails. (File existence in `public/` is enforced downstream by
// the Vite manifest build + `includeAssets`; asserting it here would need
// Node fs, which the browser-target cic tsconfig has no types for.)
describe("PWA icons — S18 notification icon ↔ manifest tie", () => {
  const opts = pushNotificationOptions({ title: "t", body: "b", tag: "x", url: "/foo" });

  it("the SW notification icon + badge are a declared manifest icon (no drift)", () => {
    const declared = PWA_ICONS.map((i) => i.src);
    expect(declared).toContain(opts.icon);
    expect(declared).toContain(opts.badge);
  });

  it("the SW notification icon + badge both resolve to the single NOTIFICATION_ICON source", () => {
    expect(opts.icon).toBe(NOTIFICATION_ICON);
    expect(opts.badge).toBe(NOTIFICATION_ICON);
  });

  it("NOTIFICATION_ICON is a manifest-declared icon (root-served path, not /icons/…)", () => {
    expect(PWA_ICONS.map((i) => i.src)).toContain(NOTIFICATION_ICON);
    // Guard the exact S18 regression: the notification icon must be a
    // root-served path, never the 404 `/icons/…` prefix the SW used to carry.
    expect(NOTIFICATION_ICON.startsWith("/icons/")).toBe(false);
  });
});
