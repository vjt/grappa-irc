import { describe, expect, it } from "vitest";
import { createNavigationRoute } from "../lib/swNavigationRoute";

// The SW's navigation fallback, driven through Workbox's OWN matcher: the
// route `service-worker.ts` registers is built by the same function, so these
// are the answers the installed PWA's navigation route gives. `true` = the
// shell handler answers the navigation; `false` = it reaches the network.
// (`/` never gets this far in the real worker: the precache route, registered
// first, answers it. The outcome is the same shell.)
//
// Router-scope coverage is `GrappaWeb.RouterSwDenylistTest`'s job: it checks
// that every router scope has an entry, by parsing the entry tokens out of the
// source. What this file pins is the denylist's BEHAVIOUR, as Workbox evaluates
// it against path plus query string, on paths the router never defines.

// Workbox's dev build logs every match decision; the assertions say it better.
(globalThis as { __WB_DISABLE_DEV_LOGS?: boolean }).__WB_DISABLE_DEV_LOGS = true;

const route = createNavigationRoute(() => Promise.resolve(new Response("shell")));
type MatchOptions = Parameters<typeof route.match>[0];

function servesShell(pathAndSearch: string, mode: RequestMode = "navigate"): boolean {
  const url = new URL(pathAndSearch, "https://grappa.example");
  // `navigate` cannot be passed to the Request constructor, and the matcher
  // reads only `mode` off the request.
  const request = { mode } as Request;
  return Boolean(route.match({ url, request, sameOrigin: true } as MatchOptions));
}

describe("SW navigation route", () => {
  it("serves the shell for the SPA's own routes", () => {
    // The positive control: a matcher that never matched would make every
    // `false` below vacuous.
    for (const path of ["/", "/login", "/share", "/pair", "/theme/abc123", "/?network=azzurra"]) {
      expect(servesShell(path), path).toBe(true);
    }
  });

  it("lets a REST scope reach the network", () => {
    expect(servesShell("/me")).toBe(false);
    expect(servesShell("/uploads/abc.png")).toBe(false);
  });

  // issue 2530 — behind Cloudflare Access the login ends with a navigation to
  // `/cdn-cgi/access/authorized` on THIS origin, and that response is what
  // sets the Access session cookie. Handed to the shell handler, it never
  // reaches Cloudflare: the cookie is never set, the login cannot complete and
  // every REST call keeps being redirected to the Access login host.
  it("lets Cloudflare's reserved /cdn-cgi/ prefix reach the network", () => {
    expect(servesShell("/cdn-cgi/access/authorized?redirect_url=%2F")).toBe(false);
    expect(servesShell("/cdn-cgi/access/logout")).toBe(false);
  });

  it("never answers a request that is not a navigation", () => {
    expect(servesShell("/", "cors")).toBe(false);
  });
});
