// Notification-tap → focus e2e helpers (issue #146).
//
// The pre-#146 push deep-link spec (`ux-6-j-push-deep-link.spec.ts`)
// dispatched a synthetic `MessageEvent` at the PAGE listener and only
// covered a channel deep-link — never a DM/query. A break in the DM
// branch (which is exactly the #146 regression) sailed straight past it
// (the same hollow-green trap as #78).
//
// ── Harness ceiling (proven empirically, 2026-06-29) ──────────────────
// The IDEAL drive is the real SW `notificationclick` handler. That is
// NOT achievable under headless Playwright:
//   * `self.registration.showNotification(...)` rejects with "No
//     notification permission has been granted for this origin" — the
//     headless SW reports the permission denied even after
//     `context.grantPermissions(["notifications"])`, so a real
//     `NotificationEvent` can't be constructed (its `notification` must
//     come from `getNotifications()` after a `showNotification`).
//   * Even past that, `WindowClient.focus()` / `clients.openWindow()`
//     inside `focusOrOpen` require transient activation, which a
//     synthetic event dispatch does not grant — both reject.
// So the real SW handler is undrivable here. The two faithful drives
// this module exposes, in order of fidelity:
//
//   1. COLD path (`buildPushDeepLink` + `page.goto`): a fresh document
//      booted straight at the deep-link — exactly what the SW's
//      `clients.openWindow(url)` branch produces. Drives the production
//      `applyPushTargetFromUrl` boot reader for real. NOT a MessageEvent
//      shortcut. This is the primary #146 gate.
//
//   2. WARM path (`dispatchNavigateMessage`): replays the SW→page
//      contract — the `{type:"navigate", url}` message the SW posts from
//      `focusOrOpen` after `client.focus()` — onto the page's REAL
//      `installPushTargetListener` (`navigator.serviceWorker` 'message').
//      Exercises the real `applyPushTarget` routing (the warm call site
//      of the fix). The SW→page hop itself is simulated because the real
//      SW handler is undrivable (see above).

import type { Page } from "@playwright/test";

/**
 * Builds the push deep-link URL the way the server does.
 *
 * Mirrors `Grappa.Push.Payload.build_url/2` (lib/grappa/push/payload.ex):
 *   "/?network=#{URI.encode_www_form(slug)}&channel=#{URI.encode_www_form(target)}"
 *
 * `URLSearchParams` emits `application/x-www-form-urlencoded`, which is
 * byte-identical to Elixir's `URI.encode_www_form/1` for these inputs
 * (space → `+`, `#` → `%23`, UTF-8 percent-encoded). The URL *shape*
 * contract is asserted server-side in `test/grappa/push/payload_test.exs`;
 * this helper exists so specs never hand-write the query string and stay
 * in lockstep with the server builder.
 *
 * `target` is the channel name WITH sigil for a highlight (`#bofh`) or
 * the bare peer nick for a DM — exactly what `build/3` puts in the URL.
 */
export function buildPushDeepLink(networkSlug: string, target: string): string {
  const params = new URLSearchParams({ network: networkSlug, channel: target });
  return `/?${params.toString()}`;
}

/**
 * Replays the SW→page navigate message onto the page's real
 * `installPushTargetListener`. The production SW posts exactly this
 * shape from `focusOrOpen` after focusing the client; dispatching it on
 * `navigator.serviceWorker` fires the registered listener and runs the
 * real `applyPushTarget` routing — the warm-path half of the tap chain.
 */
export async function dispatchNavigateMessage(page: Page, url: string): Promise<void> {
  await page.evaluate((targetUrl) => {
    navigator.serviceWorker.dispatchEvent(
      new MessageEvent("message", { data: { type: "navigate", url: targetUrl } }),
    );
  }, url);
}
