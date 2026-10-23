import type { Page } from "@playwright/test";

// Answering a page's fetch() from the spec, inside the page.
//
// A spec that must answer or count a fetch() the page makes does it here, not
// with `page.route`. `page.route` lives on Playwright's view of the network,
// and that view has lost requests twice, measured:
//
//   - #1702, WebKit (webkit-iphone-15): with the now-playing feed on
//     `page.route`, the spec reached the REAL api.somafm.com. That spec's
//     header puts it down to cic's service worker.
//   - #666, Chromium, in CI only (main 75fcd75bb, PR #2460): all eight send
//     POSTs reached grappa, 201, and not one reached the route or the page's
//     network trace, which stops showing the page's requests at one point and
//     never resumes. Locally the cause did not reproduce: on Chromium a probe
//     firing a fetch every 25 ms across the worker's `clients.claim` showed
//     `page.route` every one of them (220 of 220, three runs), and two
//     replays of CI's shard 2 kept #666 green. Why Chromium lost them in CI
//     is not established (#2461); the claim on its own does not do it.
//
// This wraps `window.fetch` before any page script runs, in the page's own
// realm, so no network layer sits between the stub and the call: whatever
// Playwright sees or misses below it, the answer is the same. A request whose
// absolute URL matches `match.url` (and `match.method`, when given) is handed
// to `answer`, which runs here in the spec: what it keeps survives a reload,
// and the spec reads it directly. `answer` returns the response to fake, or
// `undefined` to let the request through to the real fetch. Every other
// request goes straight to the real fetch, untouched.
//
// `serviceWorkers: "block"` is no alternative: cic then raises its "Service
// worker registration failed" banner, and the spec drives a degraded app
// (#1702). Media loads and navigations do not call fetch() and stay out of
// reach: an `<audio>` stream is still seen by `page.route` (#682).

export interface StubbedFetch {
  url: string;
  method: string;
  body: string | null;
}

export interface FetchAnswer {
  status: number;
  headers: Record<string, string>;
  body: string;
}

// One binding per call: a page can host more than one stub.
let bindings = 0;

export async function answerFetchInPage(
  page: Page,
  match: { url: RegExp; method: string | null },
  answer: (request: StubbedFetch) => FetchAnswer | undefined,
): Promise<void> {
  bindings += 1;
  const binding = `__answerFetch${bindings}`;
  await page.exposeFunction(binding, (request: StubbedFetch) => answer(request) ?? null);
  await page.addInitScript(
    (seed: { binding: string; source: string; flags: string; method: string | null }) => {
      const pattern = new RegExp(seed.source, seed.flags);
      const realFetch = window.fetch.bind(window);
      window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const raw =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const url = new URL(raw, window.location.href).href;
        const method = (
          init?.method ?? (input instanceof Request ? input.method : "GET")
        ).toUpperCase();
        if (!pattern.test(url) || (seed.method !== null && method !== seed.method)) {
          return realFetch(input, init);
        }
        const ask = (
          window as unknown as Record<string, (r: StubbedFetch) => Promise<FetchAnswer | null>>
        )[seed.binding];
        if (ask === undefined) throw new Error(`answerFetchInPage: ${seed.binding} missing`);
        const body = typeof init?.body === "string" ? init.body : null;
        const answered = await ask({ url, method, body });
        if (answered === null) return realFetch(input, init);
        return new Response(answered.body, { status: answered.status, headers: answered.headers });
      };
    },
    {
      binding,
      source: match.url.source,
      flags: match.url.flags,
      method: match.method === null ? null : match.method.toUpperCase(),
    },
  );
}
