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
//
//   3. SW handler (`tapNotification`, Chromium only): found later by the
//      #146 recurrence spec — the real handler IS drivable when the event is
//      dispatched INTO the live service worker as a plain `Event` carrying
//      the `notification` shape the handler reads. No real
//      `NotificationEvent`, no transient activation, so `focus()` still
//      rejects; the navigate must survive that, which is what that spec
//      pins. The closest a headless run gets to a tap.

import type { BrowserContext, Page } from "@playwright/test";

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
 * The deep link of an end-to-end encrypted message (issue 2515).
 *
 * Mirrors `Grappa.Push.Payload.build_e2e/2`: the DM deep link for the peer
 * plus `e2e=1`, the marker that makes the tap open the encrypted query
 * rather than the plaintext one. Asserted server-side in
 * `test/grappa/push/payload_test.exs`, as `buildPushDeepLink` is.
 */
export function buildEncryptedPushDeepLink(networkSlug: string, nick: string): string {
  return `${buildPushDeepLink(networkSlug, nick)}&e2e=1`;
}

/**
 * Taps a notification: dispatches a `notificationclick` carrying `url` into
 * the context's LIVE service worker, so the real handler (`focusOrOpen` →
 * `deliverNavigate`) runs and posts the navigate to the page. The page must
 * be controlled by the SW first (`awaitServiceWorkerActive`), or the
 * handler's `clients.matchAll` finds no window to post to.
 *
 * Resolves to how the handler's `waitUntil` promise settled — diagnostic
 * only: a `rejected: …` is `focus()` refusing without transient activation,
 * which the navigate must survive (#146 recurrence).
 */
export async function tapNotification(context: BrowserContext, url: string): Promise<string> {
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  // The synthetic event carries the notification shape the handler reads
  // (`data.url`, `close()`); `waitUntil` collects the focusOrOpen promise.
  return sw.evaluate((targetUrl) => {
    const ev = new Event("notificationclick") as Event & {
      notification: { data: { url: string }; close: () => void };
      waitUntil: (p: Promise<unknown>) => void;
    };
    ev.notification = { data: { url: targetUrl }, close() {} };
    let collected: Promise<unknown> = Promise.resolve();
    ev.waitUntil = (p: Promise<unknown>) => {
      collected = p;
    };
    self.dispatchEvent(ev);
    return collected.then(
      () => "resolved",
      (e) => `rejected: ${e}`,
    );
  }, url);
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
