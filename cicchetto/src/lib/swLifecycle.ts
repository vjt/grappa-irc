// SW update lifecycle (#1063, 2026-08-08).
//
// Extracted from `service-worker.ts` so vitest can pin it — the SW module
// declares the `ServiceWorkerGlobalScope` `self` and pulls in Workbox, so
// it cannot be imported under jsdom. Same reason `swNavigate.ts` and
// `pushPayload.ts` exist.
//
// WHY THE WORKER IS INVOLVED IN THIS AT ALL. Every other path that moves a
// client onto a new bundle runs in the PAGE and needs the server to tell it
// a deploy happened: the #674 auto-refresh and the manual refresh banner
// both key off `bundle_hash`, which rides the user-topic WS join. A client
// whose socket never delivers that push never learns, and no amount of
// page-side logic fixes it, because the page is the thing that was not
// told. `/service-worker.js` is served `no-cache`, so the browser re-fetches
// it and installs the new worker regardless — `activate` is new code
// running on behalf of an old client, and it is the only lever that does
// not depend on the page having been informed.
//
// THE OBJECTION, AND THE MEASUREMENT THAT ANSWERS IT. cic registers with
// `registerType: "autoUpdate"`, and the generated register code really does
// carry `addEventListener("controlling", e => e.isUpdate && location.reload())`
// — read out of the emitted bundle. On that reading the page already
// reloads itself on a new worker and everything here is a redundant second
// navigation racing the first. Measured in a real chromium instead: a
// byte-different worker installed, activated and took control of the page
// (`controllerchange` fired once, `navigator.serviceWorker.controller`
// changed) and the page did NOT reload. The claimed tab kept running the
// bundle it booted with, exactly as #1063 described.
//
// The limit of that measurement, so nobody has to re-derive it: the update
// was driven by an explicit `registration.update()` — the same call
// `performRefresh` makes — and NOT by the browser's own update check on a
// navigation. Whether workbox-window flags that path as `isUpdate` and
// reloads is unmeasured. If someone later finds that it does, the honest
// consequence is that this pass is redundant for browser-initiated updates
// and still load-bearing for the refresh path.

/**
 * Minimal shape of the `WindowClient`s `activate` navigates. Structural so
 * vitest can drive it with a plain object and the SW can pass the real
 * thing.
 */
export type ReloadableClient = {
  readonly url: string;
  readonly visibilityState: DocumentVisibilityState;
  navigate: (url: string) => Promise<unknown>;
};

/**
 * Reload every window client that nobody is currently looking at, so it
 * comes back on the bundle this worker just activated.
 *
 * THE GATE, and why it is visibility (#1063 asked for this decision to be
 * made explicitly rather than defaulted):
 *
 * Unconditional was rejected. `activate` is not a proxy for "the operator
 * just opened the app" — a push event triggers a worker update check too,
 * so an unconditional navigate can throw away a foreground window mid-use,
 * hours after boot. That is a worse defect than the one being fixed, and it
 * would be the kind that only shows up in the field.
 *
 * Not-visible is the same principle #674 already ships page-side: apply a
 * deploy when it cannot eat anything the operator was in the middle of.
 * `visibilityState` is the only signal a worker has to approximate it.
 *
 * What this deliberately does NOT cover: a client that boots stale and
 * stays visible. Opening the app is served the OLD `index.html` out of the
 * old worker's precache, so the window that most needs this is often the
 * one the gate spares. It keeps the refresh banner, which is the affordance
 * that already exists for a window the operator is watching — and whether
 * that banner's Refresh button actually lands is #1063's other three
 * defects, not this one.
 *
 * KNOWN, from the #182 note in `service-worker.ts`: `clients.matchAll`
 * visibility is unreliable on iOS PWAs, which often report a foregrounded
 * window as not visible. The accepted consequence is that iOS navigates
 * more eagerly than this gate describes. It is survivable rather than
 * merely tolerated: #772 persists the compose draft in sessionStorage, so
 * an in-place navigate keeps the text the operator was typing.
 *
 * Each client is navigated independently and failures are swallowed: a
 * client can be torn down between `matchAll` and `navigate`, and one
 * casualty must not strand the rest on the old bundle.
 */
export async function navigateStaleClients(clients: readonly ReloadableClient[]): Promise<void> {
  await Promise.all(
    clients
      .filter((c) => c.visibilityState !== "visible")
      // Its OWN url: this is a reload, not a reset to the root. The client
      // is somewhere in the app and must come back there.
      .map((c) =>
        c.navigate(c.url).catch((err: unknown) => {
          console.warn("sw.activate: navigate failed", err);
        }),
      ),
  );
}

/**
 * True for the `{type:"SKIP_WAITING"}` message `performRefresh` posts.
 *
 * `install` already calls `skipWaiting()` unconditionally, so on a healthy
 * browser this handshake is redundant — but `performRefresh`'s own comment
 * describes the post as belt-and-braces "so iOS Safari versions that
 * throttle install-time skipWaiting still flip", and with no listener on
 * this side that was fiction: the post was a no-op and the worker stayed
 * waiting. Handling it is what makes the documented behaviour true. The
 * alternative #1063 offers — delete the post and the comment — would
 * instead remove the only lever that exists when install-time skipWaiting
 * is throttled.
 */
export function isSkipWaitingMessage(data: unknown): boolean {
  if (typeof data !== "object" || data === null) return false;
  return (data as { type?: unknown }).type === "SKIP_WAITING";
}
