// SW → page navigate delivery (#146 recurrence, 2026-07-01).
//
// Extracted from `service-worker.ts`'s `focusOrOpen` so the delivery
// contract can be pinned by vitest (the SW module itself can't be
// imported under jsdom — it declares the `ServiceWorkerGlobalScope`
// `self` and pulls in Workbox).
//
// The recurrence: `notificationclick` → `focusOrOpen` had
//
//     await existing.focus();
//     existing.postMessage({ type: "navigate", url });
//
// `WindowClient.focus()` returns a Promise that REJECTS when the call
// lacks transient activation. A synthetic dispatch never grants it, and
// — the field bite — iOS / WebKit reject `focus()` even from a genuine
// notification tap. A rejected `focus()` throws out of the async
// function BEFORE `postMessage` runs, so the deep-link never reaches the
// page and the tap opens nothing. The original #146 fix corrected the
// cic-side ROUTING (open-then-select); this closes the SW→page DELIVERY
// half, which the routing fix never touched and the shipped e2e (which
// bypasses the real SW) could not catch.
//
// Contract: the navigate MUST be delivered whenever a client exists —
// `focus()` is a best-effort nicety, never a gate on the navigation.

/**
 * Minimal shape of the `WindowClient` `focusOrOpen` messages. Kept
 * structural so vitest can drive it with a plain mock and the SW can
 * pass a real `WindowClient`.
 */
export type NavigableClient = {
  postMessage: (message: unknown) => void;
  focus: () => Promise<unknown>;
};

/**
 * Post the `{type:"navigate", url}` deep-link to an existing client,
 * then best-effort focus it.
 *
 * Ordering is load-bearing: `postMessage` FIRST so a `focus()` rejection
 * (missing transient activation — iOS/WebKit) can never swallow the
 * navigate. `focus()` is awaited only to keep `event.waitUntil` alive
 * until the window is foregrounded when it CAN be; its rejection is
 * caught and dropped because the navigation has already been delivered.
 */
export async function deliverNavigate(client: NavigableClient, url: string): Promise<void> {
  client.postMessage({ type: "navigate", url });
  try {
    await client.focus();
  } catch {
    // Best-effort — the navigate already went out. A focus() rejection
    // (no transient activation) must NOT propagate and abort delivery.
  }
}
