import { replaceDocument } from "./documentNavigation";

// issue 2531 — recovering an installed PWA whose authenticating proxy session
// expired: Cloudflare Access (Zero Trust), or another proxy in front of the
// whole hostname that answers an expired session with a redirect to its login.
//
// THE SYMPTOM. The shell still loads — the service worker serves it from the
// precache, no request leaves the device — so the user sees the app. Every
// REST call then gets a 302 to the proxy's login host, which `fetch` follows
// cross-origin and the browser rejects as a CORS failure ("Load failed" on iOS
// Safari). Nothing in the app ever makes a top-level navigation, so the proxy
// never gets to run its login.
//
// DETECTION is `bootFetch`'s: the boot GETs go out with `redirect: "manual"`,
// which turns any redirect into an `opaqueredirect` response instead of a
// cross-origin follow. Grappa never redirects those GETs itself, so the
// redirect can only come from something in front of it. A non-JSON answer is
// deliberately NOT read as the same signal: nginx's HTML 502 while the BEAM
// restarts is non-JSON too, and sending the user out of the app to an error
// page is worse than the boot-failure screen they would otherwise get.
//
// RECOVERY is a top-level navigation the proxy can intercept — and a plain
// `location.reload()` is NOT one. The service worker answers that reload
// itself: `/` from the precache, every other SPA route from the navigation
// fallback, so the request never reaches the proxy and the loop is closed.
// The navigation therefore carries `?reauth=1`, a marker the SW's navigation
// denylist lets through (`swNavigationRoute.ts`; the precache route ignores
// it because no precached URL carries a query). Once the proxy has logged the
// user in it sends the browser back to that URL, the page boots against the
// fresh cookie, and `stripReauthParam` takes the marker out of the address bar
// so a later reload is the SW's again.
//
// Recovery also needs the proxy's own login callback to reach the network,
// because the worker sees that navigation too. Cloudflare Access ends the
// login on `/cdn-cgi/access/authorized`, which is issue 2530's denylist entry.
// A proxy whose callback lives on this origin under another path
// (oauth2-proxy's `/oauth2/callback`, say) needs an entry of its own there, or
// the worker answers its callback with the shell and the cookie is never set.
// A callback on the proxy's own host never meets the worker.

/** A boot GET was redirected by something in front of the server. */
export class AuthProxyRedirectError extends Error {
  constructor(path: string) {
    super(
      `The sign-in gateway in front of this server redirected ${path} — it wants you to sign in again.`,
    );
    this.name = "AuthProxyRedirectError";
  }
}

/** The query parameter that lets a navigation past the service worker. */
export const REAUTH_PARAM = "reauth";

/**
 * How long an automatic re-auth blocks the next one.
 *
 * The loop this stops is the automatic one: an identity provider that signs
 * the user straight back in, while the cookie never sticks, cycles in seconds
 * with no human in it. A cycle that needs the user to type a code is not a
 * loop worth stopping, and a second expiry inside five minutes of a re-login
 * would mean a proxy session shorter than any Access offers.
 */
export const REAUTH_RETRY_WINDOW_MS = 5 * 60_000;

/** sessionStorage, so the window is per tab and dies with the app. */
export const REAUTH_MARKER_KEY = "grappa-reauth-at";

/** `href` with the re-auth marker set, everything else untouched. */
export function reauthUrl(href: string): string {
  const url = new URL(href);
  url.searchParams.set(REAUTH_PARAM, "1");
  return url.href;
}

/**
 * Who asked: the boot-failure screen on its own (`"auto"`), or a person
 * pressing its button (`"user"`). Only the automatic attempt is rate-limited —
 * a person pressing a button is not a loop.
 */
export type ReauthOrigin = "auto" | "user";

/**
 * Navigate to the re-auth URL so the proxy can run its login.
 *
 * Returns `false`, without navigating, when an automatic attempt finds
 * another one made less than `REAUTH_RETRY_WINDOW_MS` ago.
 */
export function requestReauth(origin: ReauthOrigin, now: number): boolean {
  if (origin === "auto" && attemptedWithinWindow(now)) return false;
  sessionStorage.setItem(REAUTH_MARKER_KEY, String(now));
  replaceDocument(reauthUrl(window.location.href));
  return true;
}

function attemptedWithinWindow(now: number): boolean {
  const at = Number(sessionStorage.getItem(REAUTH_MARKER_KEY));
  // `Number(null)` is 0 and a corrupt slot is NaN; both read as "no attempt".
  // So does a marker from the future (a clock stepped back after the attempt):
  // read as recent, it would block for the size of the step plus a window,
  // which can be hours. Letting one attempt through rewrites it with `now`.
  return Number.isFinite(at) && at > 0 && at <= now && now - at < REAUTH_RETRY_WINDOW_MS;
}

/** Boot-time: drop the marker from the address bar, so a later reload is the SW's. */
export function stripReauthParam(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has(REAUTH_PARAM)) return;
  url.searchParams.delete(REAUTH_PARAM);
  window.history.replaceState(window.history.state, "", url.href);
}
