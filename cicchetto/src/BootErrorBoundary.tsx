import { type Component, createSignal, ErrorBoundary, type JSX, onMount } from "solid-js";
import { ApiError } from "./lib/apiError";
import { AuthProxyRedirectError, requestReauth } from "./lib/authProxy";
import { requestBundleRefreshNow } from "./lib/bundleRefreshNotice";
import { isOffline } from "./lib/connectivity";
import { friendlyApiError } from "./lib/friendlyApiError";
import { refetchChannels, refetchNetworks, refetchUser } from "./lib/networks";

// #717 — keep a failed boot recoverable.
//
// The boot chain is three resources (`user` → `networks` → `channelsBySlug`,
// see lib/networks.ts) and every consumer reads them through a predicate:
// CrtSplash's is `!user() || channelsBySlug() === undefined`. When one of the
// underlying fetches REJECTS, the resource enters state `errored` and reading
// it RE-THROWS. That throw lands mid-render, and before this component
// cicchetto mounted no ErrorBoundary at all — so the throw was swallowed, the
// DOM kept the last painted frame (the splash), and the only way out was to
// force-kill the app. That is the reported #717 symptom on the installed
// Android/Firefox PWA.
//
// Why this is not solved by the timeout in `lib/api.ts`: a timeout REJECTS.
// Bounding the slow path converts a hang into a rejection, which is the exact
// state that freezes the UI. The bound and this boundary are two halves of one
// fix — retry absorbs the transient failure, the boundary catches the terminal
// one.
//
// DELIBERATELY BARE. This is a recovery affordance, not a loading screen:
// #687 owns the staged boot log the splash should show while it is healthy,
// and a second screen competing with it would be the layer that issue exists
// to avoid. Message + retry, nothing else.
//
// The error text IS shown. #717 is a diagnosis-starved bug reported by a
// self-hoster we cannot attach a debugger to; the failure string is the one
// thing they can read back to us. Same rationale as #120 capturing the
// service-worker registration error name+message.

// A typed server error goes through `friendlyApiError`, the SSOT for that copy
// (#411, "ogni cazzo di errore deve avere un copy"). Without it an ApiError
// renders its own `message`, which is the raw `"<status> <code>"` pair — the
// screen would greet a self-hoster with "500 internal_error". A transport
// failure is not an ApiError and has no token to localise, so its message
// (e.g. "Failed to fetch") is the honest text.
function failureText(error: unknown): string {
  if (error instanceof ApiError) return friendlyApiError(error);
  if (error instanceof Error && error.message !== "") return error.message;
  if (typeof error === "string" && error !== "") return error;
  return "unknown error";
}

// Rendered by the boundary below. Split out of the inline `fallback` because it
// owns a signal (the reload's in-flight state) and a component is where a signal
// belongs.
const BootFailure: Component<{ error: unknown; onRetry: () => void }> = (props) => {
  const [reloading, setReloading] = createSignal(false);

  // issue 2531 — an authenticating proxy in front of the server (Cloudflare
  // Access) wants the user to sign in again. Neither restart below can do that:
  // the service worker answers a reload from the device, so the proxy never
  // sees it. `requestReauth` makes the one navigation the worker lets through.
  // It goes on its own, once per window (`lib/authProxy.ts` argues the
  // window); after that the button below makes it, with a person behind it.
  // Read once: the boundary mounts a fresh BootFailure for every error.
  const proxyRedirect = props.error instanceof AuthProxyRedirectError;
  onMount(() => {
    if (proxyRedirect && requestReauth("auto", Date.now())) setReloading(true);
  });

  // The proxy case names its own object, as #1877 asks of both buttons:
  // restarting the app would not sign anybody in.
  const reloadLabel = (): string => {
    if (proxyRedirect) return reloading() ? "Signing in…" : "Sign in again";
    return reloading() ? "Restarting…" : "Restart app";
  };

  return (
    <div class="boot-failure" data-testid="boot-failure">
      {/* The live region is the message, not the container: putting
            role="alert" on a box that also holds the buttons announces the
            controls as part of the alert. */}
      <p class="boot-failure-title" role="alert">
        Could not load Grappa.
      </p>
      {/* The testid is on the DETAIL, not the container: issue 2199 is about
            what this paragraph says, and asserting the box cannot tell the
            fixed title apart from the failure text inside it. */}
      <p class="boot-failure-detail" data-testid="boot-failure-detail">
        {failureText(props.error)}
      </p>
      {/* #1877 — THE LABEL NAMES WHAT IT RESTARTS. "Retry" and "Reload" both
            read as "try again" to anyone who has not read this file, and a
            self-hoster who hit this screen on iOS reported not knowing which to
            press. The two are not interchangeable: this one is three fetches
            with the bundle untouched (press it when the network came back), the
            one below throws the running app away (press it when the app itself
            is suspect). So each label names its OBJECT — the load, or the app.

            The distinction goes in the LABEL and not in a line of copy under
            each button, which the issue offers as the alternative. Two reasons.
            The screen is deliberately bare (see the header) and the label costs
            no new element; and the accessible name is what the reporter's
            VoiceOver reads out when it lands on the control, whereas a sibling
            paragraph is announced separately or not at all unless it is wired
            through `aria-describedby` — machinery for a hint that would still
            leave the button itself saying "try again". The situational advice
            such a line would carry ("if the network just came back") is instead
            in the ORDER: primary first, the muted fallback second (the
            `.boot-failure-reload` rule in themes/default.css). */}
      <button
        type="button"
        class="boot-failure-retry"
        data-testid="boot-failure-retry"
        onClick={() => props.onRetry()}
      >
        Retry loading
      </button>
      {/* The escape hatch of last resort. The boundary wraps Shell for the
            whole session, so it also catches throws with nothing to do with the
            boot chain — and for those, Retry (which only refetches the boot
            resources) loops straight back here. Force-killing the app is what
            #717 exists to eliminate; this is what replaces it.

            IT MUST NOT PURGE WITHOUT PROOF THE SERVER ANSWERS. `performRefresh`
            is the right SW-aware verb when a stale bundle is the problem
            (#674's banner, #695's stale-resume) — but it deletes every cache
            before reloading, and #674 can only do that safely because a
            bundle-hash advertisement means the client is online by
            construction. This screen inverts that precondition: the likeliest
            reason it is up at all is that the network is gone. Purging the
            precache and reloading then lands the installed PWA on the browser's
            offline error page with the app shell destroyed — strictly worse
            than the frozen splash. Reusing the verb, not the noun: the shared
            part is "reload", the cache purge is the 20% that does not fit.

            `navigator.onLine` ALONE CANNOT GATE THAT, which is why the error is
            read too. It is trustworthy in one direction only: false means
            definitely no link, true means only "an interface exists". Behind a
            captive portal, on dead mobile data with the radio still attached,
            or on a Wi-Fi association with no route, it reads true — and those
            are exactly the conditions this screen comes up in. The guard was
            weakest in its own motivating case.

            So the purge needs POSITIVE evidence the server is reachable, and
            an `ApiError` is precisely that: it exists only because a response
            came back with a status. A transport failure is not one — `bootFetch`
            has already spent three attempts and the server never answered.
            Anything else (a mid-session render throw) is connectivity-unknown,
            and unknown takes the safe branch by the asymmetry of harm: purging
            offline destroys the app shell, while not purging costs one more
            reload and leaves #674's banner to offer the new bundle once the
            link is back. */}
      <button
        type="button"
        class="boot-failure-reload"
        data-testid="boot-failure-reload"
        onClick={() => {
          setReloading(true);
          if (proxyRedirect) {
            requestReauth("user", Date.now());
            return;
          }
          if (props.error instanceof ApiError && !isOffline()) {
            // #1063 — `"user"`, same as the refresh banner: a human pressed
            // Refresh, so the boot that follows owes them an answer. Here the
            // bundle very often has NOT moved (this button recovers a failed
            // boot, it is not an update prompt), which is exactly when the
            // "Still on X" toast is the only evidence the press did anything.
            void requestBundleRefreshNow("user");
            return;
          }
          window.location.reload();
        }}
      >
        {/* "Restart app", not "Reload" (#1877): the sibling above retries the
              LOAD, this one throws the running app away — either onto a fresh
              bundle or onto the same one. Both restart branches restart it, so
              the label is honest for both, and it shares no word with "Retry
              loading" for the reader who is scanning rather than reading. The
              auth-proxy branch (issue 2531) restarts nothing, so it names its
              own object: "Sign in again".

              `performRefresh` can take up to ~2s waiting on controllerchange.
              On a dead-boot screen a button that appears to do nothing is
              exactly what sends the user back to force-killing the app. */}
        {reloadLabel()}
      </button>
    </div>
  );
};

const BootErrorBoundary: Component<{ children: JSX.Element }> = (props) => (
  <ErrorBoundary
    fallback={(error, reset) => (
      <BootFailure
        error={error}
        onRetry={() => {
          // Refetch BEFORE reset: `reset()` re-renders the children
          // synchronously, and a child that reads a still-errored resource
          // rethrows immediately — the boundary would loop straight back into
          // this fallback without a single request going out.
          //
          // ALL THREE, ROOT FIRST, and both halves of that are load-bearing.
          //
          // Refetching only `user` is not enough even though the cascade is
          // real (`networks` is keyed on `user`, `channelsBySlug` on
          // `networks`): the cascade is ASYNCHRONOUS and `reset()` is not. A
          // `listNetworks` failure leaves `networks` errored with no refetch in
          // flight, so the re-render rethrows and the button reads as dead —
          // recovery needed a SECOND press, after the chain had settled. That
          // is the force-kill-the-app behaviour #717 exists to remove.
          //
          // What clears the throw is not the response, it is the in-flight
          // request: solid's resource `read()` is `if (err !== undefined &&
          // !pr) throw err`, so a resource with a load in flight reads as
          // pending instead of rethrowing. Each verb gives its own resource a
          // `pr`; then the children render the splash and the cascade lands.
          //
          // ROOT FIRST mirrors the cascade. It is not load-bearing — measured,
          // the reverse order also recovers, because each verb evaluates its
          // source memo and a memo that throws is handled, not propagated. It
          // is written this way because the reverse only works by routing a
          // throw through the error machinery on every press, which is a
          // coincidence to rely on, not a design.
          //
          // Downstream is nearly free: with its source not yet resolved, the
          // load takes solid's `lookup == null` path, which clears the error
          // without issuing a request. Measured for one press on a
          // `listNetworks` failure — `listNetworks` twice (the verb, then the
          // cascade off the fresh `user`), `listChannels` not at all. The spec
          // pins both numbers.
          refetchUser();
          refetchNetworks();
          refetchChannels();
          reset();
        }}
      />
    )}
  >
    {props.children}
  </ErrorBoundary>
);

export default BootErrorBoundary;
