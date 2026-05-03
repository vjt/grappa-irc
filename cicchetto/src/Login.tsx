import { useNavigate } from "@solidjs/router";
import { type Component, createEffect, createSignal, onCleanup, Show } from "solid-js";
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
      return "Login service temporarily unavailable. Please try again.";
    case "captcha_failed":
      return "Captcha challenge failed. Please try again.";
    default:
      return err.message;
  }
}

const Login: Component = () => {
  const [identifier, setIdentifier] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [submitting, setSubmitting] = createSignal(false);
  const [captcha, setCaptcha] = createSignal<CaptchaChallenge | null>(null);
  const navigate = useNavigate();

  let widgetContainer: HTMLDivElement | undefined;
  let cleanup: (() => void) | undefined;

  const handleError = (err: unknown): void => {
    if (err instanceof ApiError) {
      if (err.code === "captcha_required") {
        const provider = err.info.provider as "turnstile" | "hcaptcha" | "disabled";
        const siteKey = err.info.site_key as string;
        if (provider === "turnstile" || provider === "hcaptcha") {
          setCaptcha({ provider, siteKey });
          return;
        }
      }
      setError(friendlyMessage(err));
    } else {
      setError(err instanceof Error ? err.message : "login_failed");
    }
  };

  createEffect(() => {
    const c = captcha();
    if (c === null || widgetContainer === undefined) return;
    void mountCaptchaWidget(c.provider, widgetContainer, c.siteKey, async (token) => {
      try {
        const pwd = password();
        await auth.login(identifier(), pwd === "" ? null : pwd, token);
        navigate("/", { replace: true });
      } catch (err) {
        setCaptcha(null);
        handleError(err);
      }
    }).then((c2) => {
      cleanup = c2;
    });

    onCleanup(() => cleanup?.());
  });

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
        <Show when={captcha()}>
          <div
            ref={(el) => {
              widgetContainer = el;
            }}
            class="captcha-container"
          />
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
