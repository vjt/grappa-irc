import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { Show } from "solid-js";
import { afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { warmGraph } from "./helpers/warmGraph";

// #717 — the recoverability half, tested through the REAL resource cascade.
//
// An earlier version of this file built its own resource inside the component
// and mocked `lib/networks` away. It passed against an implementation that did
// NOT fix #717, because the three things it changed are exactly the three that
// break in production:
//
//   * `networks` is `createResource(user, …)` and `channelsBySlug` is
//     `createResource(networks, …)`, so Solid compiles a `createMemo(user)`
//     that reads the failing resource;
//   * that memo lives in the module-level `createRoot` opened by
//     `identityScopedStore`, OUTSIDE the render tree;
//   * a throw from there has no error context, so `runUpdates` discards the
//     queued render effects — including the boundary's — and the DOM keeps the
//     splash forever.
//
// ORDER IS THE WHOLE TEST. An earlier rewrite still passed against the broken
// implementation because it let `me()` reject during the `await import(...)`
// calls, BEFORE `render()`. A resource that is already `errored` at first paint
// throws synchronously inside the boundary — no update cycle, nothing to abort,
// and the bug is invisible. Production is the opposite: `main.tsx` imports
// statically and renders in the same turn, so the rejection ALWAYS lands after
// the first paint, in an update cycle a context-less module root can abort.
//
// So the `me` mock hands back a promise this file settles by hand, AFTER
// `render()` has run. Falsified: reverting `identityScopedStore` to a bare
// `createRoot` turns the first case below red.
//
// Mocks ONLY `lib/api` (the network edge) — real `lib/networks`, real
// `identityScopedStore`, real cascade. `vi.resetModules` per test because these
// stores are module singletons.

// Only the three network calls are stubbed; everything else in `lib/api` stays
// REAL. `ApiError` in particular must be the genuine class — the fallback
// narrows with `instanceof` to route typed errors through `friendlyApiError`,
// and a stubbed stand-in would make that branch untestable (and quietly dead).
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    me: vi.fn(),
    listNetworks: vi.fn(),
    listChannels: vi.fn(),
  };
});

// The cache-purging reload verb. Stubbed so the reload branch can be asserted
// on WHICH verb ran — the whole point of the discriminator at the bottom of
// this file is that picking the wrong one destroys the app shell.
vi.mock("../lib/bundleHash", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/bundleHash")>();
  return { ...actual, performRefresh: vi.fn().mockResolvedValue(undefined) };
});

// issue 2531 — the document load the re-auth recovery makes. jsdom cannot
// navigate, so the seam is mocked and the URL it was handed is the assertion.
vi.mock("../lib/documentNavigation", () => ({ replaceDocument: vi.fn() }));

const HEALTHY_ME = {
  kind: "user",
  id: "u1",
  name: "vjt",
  read_cursors: {},
  badge_count: 0,
};

// #781 — see helpers/warmGraph.ts. The component pulls api, bundleHash,
// connectivity and networks, so warming it covers every graph these tests
// re-import.
beforeAll(() => warmGraph(() => import("../BootErrorBoundary")));

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  // issue 2531 — the auth-proxy loop guard lives here: a marker left by one
  // test would hold off the next test's navigation and mask its assertion.
  sessionStorage.clear();
  vi.clearAllMocks();
});

// Explicit: each test renders its own tree against a freshly re-imported
// module singleton, so a left-over tree would put two of everything in the
// document and the queries below would match the wrong one.
afterEach(() => {
  cleanup();
});

// The child mirrors CrtSplash: it reads the boot resource through a predicate.
async function renderBootTree(): Promise<void> {
  const { user } = await import("../lib/networks");
  const BootErrorBoundary = (await import("../BootErrorBoundary")).default;

  render(() => (
    <BootErrorBoundary>
      <Show when={!user()} fallback={<div data-testid="app">app</div>}>
        <div data-testid="crt-splash">LOADING</div>
      </Show>
    </BootErrorBoundary>
  ));
}

// The DOWNSTREAM child, mirroring Sidebar.tsx / BottomBar.tsx: it reads
// `networks()`, the second link of the chain. `user` is the only link the tree
// above covers, and it is the one link whose retry works by refetching the root
// alone — so a `networks` failure is a separate case, not a variation.
async function renderNetworksTree(): Promise<void> {
  const { networks } = await import("../lib/networks");
  const BootErrorBoundary = (await import("../BootErrorBoundary")).default;

  render(() => (
    <BootErrorBoundary>
      <Show when={networks() !== undefined} fallback={<div data-testid="crt-splash">LOADING</div>}>
        <div data-testid="app">app</div>
      </Show>
    </BootErrorBoundary>
  ));
}

// A `me()` whose promise this file settles on demand, so the rejection can be
// placed AFTER the first render exactly as production places it.
function deferredMe(api: { me: unknown }): {
  reject: (e: unknown) => void;
  resolve: (v: unknown) => void;
} {
  let reject!: (e: unknown) => void;
  let resolve!: (v: unknown) => void;
  (api.me as Mock).mockReturnValue(
    new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    }),
  );
  return { reject: (e) => reject(e), resolve: (v) => resolve(v) };
}

describe("BootErrorBoundary (#717 — a failed boot must not freeze on the splash)", () => {
  it("surfaces the failure when /me rejects after first paint, through the real cascade", async () => {
    localStorage.setItem("grappa-token", "tokA");
    const api = await import("../lib/api");
    const pending = deferredMe(api);

    await renderBootTree();

    // First paint with the boot still in flight — the splash, as production
    // shows it.
    expect(screen.getByTestId("crt-splash")).toBeInTheDocument();

    pending.reject(new Error("network down"));

    // The whole point of #717: the splash is REPLACED by something that admits
    // the boot failed, rather than staying up forever.
    expect(await screen.findByTestId("boot-failure")).toBeInTheDocument();
    expect(screen.queryByTestId("crt-splash")).toBeNull();
  });

  // #1877 — the two buttons ARE the recovery ladder, and "Retry"/"Reload" both
  // read as "try again" to anyone who has not read the source. The names must
  // say WHICH THING each one restarts: the load (three fetches, no navigation)
  // or the app (a bundle refresh or a page reload). Asserted as the ACCESSIBLE
  // name rather than the text node because that is what the reporter's iOS
  // VoiceOver reads out, and it is the property a hint paragraph parked under
  // the button would NOT have changed.
  it("names what each recovery button restarts, so the two are not both 'try again'", async () => {
    localStorage.setItem("grappa-token", "tokA");
    const api = await import("../lib/api");
    const pending = deferredMe(api);

    await renderBootTree();
    pending.reject(new Error("network down"));
    await screen.findByTestId("boot-failure");

    expect(screen.getByTestId("boot-failure-retry")).toHaveAccessibleName("Retry loading");
    expect(screen.getByTestId("boot-failure-reload")).toHaveAccessibleName("Restart app");
    // issue 2531 — only a proxy redirect navigates on its own. A dead network
    // that did would take the user out of the app onto the browser's offline
    // page instead of this screen.
    const { replaceDocument } = await import("../lib/documentNavigation");
    expect(replaceDocument).not.toHaveBeenCalled();
  });

  it("leaves a healthy boot untouched", async () => {
    localStorage.setItem("grappa-token", "tokA");
    const api = await import("../lib/api");
    (api.me as Mock).mockResolvedValue(HEALTHY_ME);
    (api.listNetworks as Mock).mockResolvedValue([]);

    await renderBootTree();

    expect(await screen.findByTestId("app")).toBeInTheDocument();
    expect(screen.queryByTestId("boot-failure")).toBeNull();
  });

  it("retries the boot chain when the user asks, and clears the failure once it succeeds", async () => {
    localStorage.setItem("grappa-token", "tokA");
    const api = await import("../lib/api");
    const me = api.me as Mock;
    const pending = deferredMe(api);

    await renderBootTree();
    pending.reject(new Error("network down"));
    await screen.findByTestId("boot-failure");
    expect(me).toHaveBeenCalledTimes(1);

    // The retry must reach the network again — a bare `reset()` would re-render
    // a child that reads a still-errored resource and bounce right back here
    // with nothing in flight.
    me.mockResolvedValue(HEALTHY_ME);
    (api.listNetworks as Mock).mockResolvedValue([]);

    fireEvent.click(screen.getByTestId("boot-failure-retry"));

    expect(await screen.findByTestId("app")).toBeInTheDocument();
    expect(screen.queryByTestId("boot-failure")).toBeNull();
    expect(me.mock.calls.length).toBeGreaterThan(1);
  });

  // The case the `/me` retry above cannot cover, and the one that made the
  // button read as dead. `reset()` is synchronous while the `user → networks`
  // cascade is not, so refetching only the root left `networks` errored at
  // re-render: the child rethrew and the boundary bounced straight back into
  // the fallback. Recovery took a SECOND press. ONE press is the assertion.
  //
  // `me` hands back a FRESH object per call on purpose — production parses a
  // new envelope each time, and a mock returning one shared reference would
  // leave the `createMemo(user)` unchanged, so `networks` would never cascade
  // and this test would measure an artefact of the mock instead of the fix.
  it("recovers from a downstream listNetworks failure on ONE retry press", async () => {
    localStorage.setItem("grappa-token", "tokA");
    const api = await import("../lib/api");
    const pending = deferredMe(api);
    const listNetworks = api.listNetworks as Mock;
    listNetworks.mockRejectedValue(new Error("networks down"));

    await renderNetworksTree();
    expect(screen.getByTestId("crt-splash")).toBeInTheDocument();

    pending.resolve({ ...HEALTHY_ME });

    expect(await screen.findByTestId("boot-failure")).toBeInTheDocument();

    (api.me as Mock).mockImplementation(async () => ({ ...HEALTHY_ME }));
    listNetworks.mockResolvedValue([]);
    listNetworks.mockClear();
    (api.listChannels as Mock).mockClear();

    fireEvent.click(screen.getByTestId("boot-failure-retry"));

    expect(await screen.findByTestId("app")).toBeInTheDocument();
    expect(screen.queryByTestId("boot-failure")).toBeNull();

    // Pins the cost the handler's comment claims, so a future "refetch
    // everything" edit cannot quietly turn one press into a request storm.
    // `listNetworks` twice — the explicit verb, then the cascade off the fresh
    // `user`. `listChannels` NOT at all: its source is still unresolved when the
    // verb runs, so that load takes solid's null-lookup path, which clears the
    // error without issuing a request.
    expect(listNetworks.mock.calls.length).toBe(2);
    expect((api.listChannels as Mock).mock.calls.length).toBe(0);
  });
});

// #717 review round 3 — the Reload button must not purge the cache without
// positive evidence the server answers.
//
// `performRefresh` deletes EVERY cache before reloading. Doing that with no
// network lands the installed PWA on the browser's offline error page with the
// app shell destroyed — strictly worse than the frozen splash it replaced.
//
// The first cut gated it on `isOffline()` alone. That is `!navigator.onLine`,
// which is trustworthy in one direction only: false means definitely no link,
// true means merely "an interface exists". Behind a captive portal, on dead
// mobile data with the radio attached, or on a Wi-Fi association with no route
// it reads TRUE — and those are precisely the conditions this screen comes up
// in, so the guard was weakest in its own motivating case. The error carries
// the honest signal instead: an ApiError exists only because a response came
// back with a status.
describe("BootErrorBoundary reload — purge needs proof the server answers", () => {
  const originalLocation = window.location;
  let reloadSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    reloadSpy = vi.fn();
    Object.defineProperty(window, "location", {
      writable: true,
      configurable: true,
      value: { ...originalLocation, reload: reloadSpy },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "location", {
      writable: true,
      configurable: true,
      value: originalLocation,
    });
  });

  async function renderFailed(error: unknown): Promise<{ performRefresh: Mock }> {
    localStorage.setItem("grappa-token", "tokA");
    const api = await import("../lib/api");
    const pending = deferredMe(api);
    const { performRefresh } = await import("../lib/bundleHash");

    await renderBootTree();
    pending.reject(error);
    await screen.findByTestId("boot-failure");

    return { performRefresh: performRefresh as unknown as Mock };
  }

  // THE REGRESSION. A transport failure means bootFetch spent three attempts
  // and the server never answered — no proof of a link, whatever
  // `navigator.onLine` claims. Pre-fix this purged.
  it("does NOT purge on a transport failure, even when navigator reports online", async () => {
    const { __setConnectivityForTests } = await import("../lib/connectivity");
    __setConnectivityForTests(true);

    const { performRefresh } = await renderFailed(new TypeError("Failed to fetch"));

    fireEvent.click(screen.getByTestId("boot-failure-reload"));

    expect(performRefresh).not.toHaveBeenCalled();
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it("purges on an ApiError while online — a status came back, so the link is real", async () => {
    const { ApiError } = await import("../lib/apiError");
    const { __setConnectivityForTests } = await import("../lib/connectivity");
    __setConnectivityForTests(true);

    const { performRefresh } = await renderFailed(new ApiError(500, "internal_error"));

    fireEvent.click(screen.getByTestId("boot-failure-reload"));

    expect(performRefresh).toHaveBeenCalledTimes(1);
    expect(reloadSpy).not.toHaveBeenCalled();

    // #1877 — the in-flight label is part of the same naming: this branch is
    // the one that can sit for ~2s waiting on `controllerchange`, so the button
    // must say it is restarting rather than keep offering the restart.
    expect(screen.getByTestId("boot-failure-reload")).toHaveAccessibleName("Restarting…");
  });

  // Both conditions are required: a status came back earlier, but the link has
  // since dropped. `navigator.onLine === false` is the one direction that IS
  // conclusive.
  it("does NOT purge on an ApiError once the device reports offline", async () => {
    const { ApiError } = await import("../lib/apiError");
    const { __setConnectivityForTests } = await import("../lib/connectivity");
    __setConnectivityForTests(false);

    const { performRefresh } = await renderFailed(new ApiError(503, "unavailable"));

    fireEvent.click(screen.getByTestId("boot-failure-reload"));

    expect(performRefresh).not.toHaveBeenCalled();
    expect(reloadSpy).toHaveBeenCalledTimes(1);

    __setConnectivityForTests(true);
  });
});

// issue 2531 — an authenticating proxy (Cloudflare Access) wants the user to
// sign in again. `bootFetch` reports it as AuthProxyRedirectError; the failure
// screen is where the app reacts, because a reload cannot help (the service
// worker answers it from the precache) and only a navigation the worker lets
// through reaches the proxy.
describe("BootErrorBoundary — an expired auth-proxy session (2531)", () => {
  async function renderRedirected(): Promise<{ replaceDocument: Mock }> {
    localStorage.setItem("grappa-token", "tokA");
    const api = await import("../lib/api");
    const { AuthProxyRedirectError } = await import("../lib/authProxy");
    const pending = deferredMe(api);

    await renderBootTree();
    pending.reject(new AuthProxyRedirectError("/me"));
    await screen.findByTestId("boot-failure");

    const { replaceDocument } = await import("../lib/documentNavigation");
    return { replaceDocument: replaceDocument as unknown as Mock };
  }

  it("sends the browser to sign in again on its own, through the URL the worker lets out", async () => {
    const { replaceDocument } = await renderRedirected();
    const { reauthUrl } = await import("../lib/authProxy");

    expect(replaceDocument).toHaveBeenCalledTimes(1);
    expect(replaceDocument).toHaveBeenCalledWith(reauthUrl(window.location.href));
    // In flight, the button says what is happening instead of offering it.
    expect(screen.getByTestId("boot-failure-reload")).toHaveAccessibleName("Signing in…");
  });

  it("does not go round again inside the window, and leaves the person a button that does", async () => {
    const { REAUTH_MARKER_KEY } = await import("../lib/authProxy");
    // An attempt one second ago: the redirect came back anyway.
    sessionStorage.setItem(REAUTH_MARKER_KEY, String(Date.now() - 1_000));

    const { replaceDocument } = await renderRedirected();

    expect(replaceDocument).not.toHaveBeenCalled();
    // Not "Restart app": a reload is answered by the worker and changes nothing.
    const button = screen.getByTestId("boot-failure-reload");
    expect(button).toHaveAccessibleName("Sign in again");

    fireEvent.click(button);

    expect(replaceDocument).toHaveBeenCalledTimes(1);
  });
});
