import { useNavigate } from "@solidjs/router";
import { type Component, createSignal, onCleanup, onMount, Show } from "solid-js";
import { ApiError } from "./lib/api";
import * as auth from "./lib/auth";
import { type CaptchaProvider, mountCaptchaWidget } from "./lib/captcha";

// Bare credential form. The walking-skeleton login surface is one card,
// no branding, no "remember me" — the bouncer is single-tenant per
// operator and bearer tokens already persist via localStorage. The form
// reads/writes the auth signal store; route navigation happens here
// (post-resolve) because `useNavigate()` is a hook usable only from
// inside a `<Router>` route component, not from a free module.

type CaptchaChallenge = { provider: CaptchaProvider; siteKey: string };

// Codebase audit cic M6 — sub-component captures the challenge prop
// and runs mount inside `onMount` (after the ref-bound div is in the
// DOM, guaranteed by Solid's mount lifecycle). Eliminates the
// createEffect / `<Show>` / module-let `widgetContainer` race where
// the effect could fire before the `<Show>` rendered the captcha
// container, leaving `widgetContainer === undefined` and the captcha
// never mounted. The sub-component's lifetime is bound to its `<Show>`
// branch — when `captcha()` flips back to null the parent unmounts
// the component, triggering its `onCleanup` which tears down the
// widget. No module-let state, no per-effect-run cleanup-token race.
const CaptchaMount: Component<{
  challenge: CaptchaChallenge;
  onSolve: (token: string) => Promise<void>;
  onMountFailure: (err: unknown) => void;
}> = (props) => {
  let widgetContainer: HTMLDivElement | undefined;

  // `local` flags whether onCleanup already fired; if the mount
  // promise resolves AFTER teardown (rapid mount/unmount via captcha
  // signal flip-back) the resolved cleanup is invoked immediately.
  // Same pattern as the pre-fix createEffect-scoped state but now
  // tied to the sub-component's lifetime, which is shorter and more
  // predictable than an effect re-run scope.
  let local = false;
  let cleanup: (() => void) | undefined;

  onMount(() => {
    if (widgetContainer === undefined) {
      // Mount lifecycle guarantees ref is bound before onMount runs;
      // this branch is unreachable in production. Keep the guard so
      // a future refactor that breaks the invariant fails loud.
      props.onMountFailure(new Error("captcha container ref not bound"));
      return;
    }
    mountCaptchaWidget(
      props.challenge.provider,
      widgetContainer,
      props.challenge.siteKey,
      async (token) => {
        await props.onSolve(token);
      },
    )
      .then((c2) => {
        if (local) c2();
        else cleanup = c2;
      })
      .catch(props.onMountFailure);
  });

  onCleanup(() => {
    local = true;
    cleanup?.();
    cleanup = undefined;
  });

  return (
    <div
      ref={(el) => {
        widgetContainer = el;
      }}
      class="captcha-container"
    />
  );
};

function friendlyMessage(err: ApiError): string {
  switch (err.code) {
    case "invalid_credentials":
      return "Invalid name or password.";
    case "too_many_sessions":
      return "You're already connected to this network from another device or tab. Close one before opening a new session.";
    case "network_busy":
      return "This network is at capacity. Try again in a few minutes.";
    case "network_unreachable": {
      const retry = err.info.retry_after;
      return typeof retry === "number"
        ? `We can't reach the network right now. Retry in ${retry} seconds.`
        : "We can't reach the network right now.";
    }
    case "service_degraded":
      // Server-side captcha-verification outage (provider 4xx/5xx,
      // transport error, timeout — see
      // `Grappa.Admission.Captcha.SiteVerifyHttp` and
      // `FallbackController` clauses for `:captcha_provider_unavailable`,
      // which renders as 503 with wire body `{error: "service_degraded"}`)
      // OR any other server-side dependency-degradation 503 that may
      // surface here in the future. Bucket G H1: pre-bucket-G a stale
      // `captcha_provider_unavailable` arm shadowed this case at the
      // call sites that translated the server contract — but the server
      // never emits that literal wire token, so the dead arm gave silent
      // UX degradation (raw "503 service_degraded" Error.message
      // landed in the alert). One arm, one contract.
      return "Login service temporarily unavailable. Please try again.";
    case "captcha_failed":
      return "Captcha challenge failed. Please try again.";
    case "captcha_required":
      // Reached only via the disabled-provider routing in handleError
      // (operator demanded captcha but wired no provider) — every
      // other captcha_required path branches into the widget mount.
      return "Verification temporarily unavailable.";
    default:
      return err.message;
  }
}

// Type predicate for the captcha_required info envelope. The wire
// shape is `{site_key: String, provider: "turnstile" | "hcaptcha" |
// "disabled"}` (see `AdmissionError` in `lib/api.ts`); narrowing here
// rejects malformed payloads at the boundary instead of leaning on
// unsafe casts deeper in the form.
function isCaptchaInfo(info: unknown): info is { provider: string; site_key: string } {
  if (typeof info !== "object" || info === null) return false;
  const i = info as Record<string, unknown>;
  return typeof i.provider === "string" && typeof i.site_key === "string";
}

const Login: Component = () => {
  const [identifier, setIdentifier] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [submitting, setSubmitting] = createSignal(false);
  const [captcha, setCaptcha] = createSignal<CaptchaChallenge | null>(null);
  const navigate = useNavigate();

  const handleError = (err: unknown): void => {
    if (err instanceof ApiError) {
      if (err.code === "captcha_required" && isCaptchaInfo(err.info)) {
        const provider = err.info.provider;
        if (provider === "turnstile" || provider === "hcaptcha") {
          setCaptcha({ provider, siteKey: err.info.site_key });
          return;
        }
        // provider === "disabled" (operator demanded captcha but wired
        // no provider) — fall through to the friendlyMessage arm so
        // the user sees a generic "verification unavailable" copy
        // instead of the raw wire token.
      }
      setError(friendlyMessage(err));
    } else {
      setError(err instanceof Error ? err.message : "login_failed");
    }
  };

  const handleCaptchaSolve = async (token: string): Promise<void> => {
    setSubmitting(true);
    try {
      const pwd = password();
      await auth.login(identifier(), pwd === "" ? null : pwd, token);
      navigate("/", { replace: true });
    } catch (err) {
      setCaptcha(null);
      handleError(err);
    } finally {
      setSubmitting(false);
    }
  };

  const handleCaptchaMountFailure = (err: unknown): void => {
    // CDN blocked, network error, or provider script failed to load —
    // surface a user-actionable toast and re-enable submit so the user
    // can retry once they unblock the CDN.
    console.warn("[captcha] mount failed:", err);
    setCaptcha(null);
    setError("Captcha unavailable. Disable ad-blocker or try again.");
    setSubmitting(false);
  };

  const onSubmit = async (e: Event) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const pwd = password();
      await auth.login(identifier(), pwd === "" ? null : pwd);
      navigate("/", { replace: true });
    } catch (err) {
      handleError(err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main class="login">
      <form class="login-form" onSubmit={onSubmit}>
        <h1>cicchetto</h1>
        <label for="login-identifier">Nick or email</label>
        <input
          id="login-identifier"
          type="text"
          autocomplete="username"
          value={identifier()}
          onInput={(e) => setIdentifier(e.currentTarget.value)}
          required
        />
        <label for="login-password">Password (optional for visitors)</label>
        <input
          id="login-password"
          type="password"
          autocomplete="current-password"
          value={password()}
          onInput={(e) => setPassword(e.currentTarget.value)}
        />
        <button type="submit" disabled={submitting()}>
          Log in
        </button>
        <Show when={captcha()} keyed>
          {(c) => (
            <CaptchaMount
              challenge={c}
              onSolve={handleCaptchaSolve}
              onMountFailure={handleCaptchaMountFailure}
            />
          )}
        </Show>
        <Show when={error()}>
          {(msg) => (
            <p role="alert" class="login-error">
              {msg()}
            </p>
          )}
        </Show>
      </form>
    </main>
  );
};

export default Login;
