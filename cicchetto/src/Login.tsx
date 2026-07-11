import { useNavigate } from "@solidjs/router";
import { type Component, createSignal, onCleanup, onMount, Show } from "solid-js";
import { ApiError } from "./lib/api";
import * as auth from "./lib/auth";
import { type CaptchaProvider, mountCaptchaWidget } from "./lib/captcha";
import { CONNECTING_MESSAGES } from "./lib/connectingMessages";
import { friendlyApiError } from "./lib/friendlyApiError";
import { classifyLoginIdentifier } from "./lib/loginIdentifier";

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
  // U-3 (UD3): delegate to the shared `friendlyApiError` map so every
  // ApiError surface in cic (Login, ComposeBox, future admin error
  // banners) renders the same human copy for the same wire token.
  // The local function name is preserved as a call-site indirection
  // in case future Login-specific copy overrides are needed.
  return friendlyApiError(err);
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
  // #152 — login-Advanced realname + ident (both optional, collapsed
  // under the Advanced toggle alongside password). Blank = use server
  // defaults (nick for ident, "Grappa Visitor" for realname).
  const [realname, setRealname] = createSignal("");
  const [ident, setIdent] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [advanced, setAdvanced] = createSignal(false);
  // `connecting` drives the whole-view swap: while an auth.login attempt is
  // in flight the form is replaced by the spinner + reassurance copy. It is
  // NOT the same as "submitting a field" — it's "the one blocking login
  // request is running" (see the honesty note on CONNECTING_MESSAGES).
  const [connecting, setConnecting] = createSignal(false);
  const [msgIndex, setMsgIndex] = createSignal(0);
  const [captcha, setCaptcha] = createSignal<CaptchaChallenge | null>(null);
  const navigate = useNavigate();

  // Cosmetic reassurance rotation. There is no server progress stream to
  // subscribe to — login is one blocking request — so this timer just walks
  // the copy forward so the user sees motion. Capped at the last line (no
  // wrap) so it settles rather than looping forever. Cleared on leave +
  // on unmount so no timer survives the connecting state.
  let rotationTimer: ReturnType<typeof setInterval> | undefined;
  const startRotation = (): void => {
    // Defensive: never leave a prior interval orphaned if start is called
    // twice without an intervening stop.
    stopRotation();
    setMsgIndex(0);
    rotationTimer = setInterval(() => {
      setMsgIndex((i) => Math.min(i + 1, CONNECTING_MESSAGES.length - 1));
    }, 1200);
  };
  const stopRotation = (): void => {
    if (rotationTimer !== undefined) {
      clearInterval(rotationTimer);
      rotationTimer = undefined;
    }
  };
  onCleanup(stopRotation);

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

  // Shared tail for both the plain submit and the captcha-solve retry: run
  // the one blocking login request under the connecting view, navigate on
  // success, revert to the form (with a friendly error) on failure.
  const attemptLogin = async (
    id: string,
    pwd: string | null,
    captchaToken?: string,
  ): Promise<void> => {
    setError(null);
    setConnecting(true);
    startRotation();
    try {
      // #152 — thread login-Advanced ident/realname through the same
      // boundary. Blank fields are omitted downstream (auth.login), so a
      // guest/plain login stays a minimal request. Named `advancedFields`
      // (not `advanced`) so it doesn't shadow the `advanced()` toggle
      // signal accessor in this scope.
      const advancedFields = { ident: ident(), realname: realname() };
      // Preserve the auth.login(id, pwd, captcha?) boundary shape: forward
      // the captcha token only when present, so the plain path stays a
      // 2-arg call (the captcha retry is the only 3-arg caller).
      if (captchaToken === undefined) {
        await auth.login(id, pwd, undefined, advancedFields);
      } else {
        await auth.login(id, pwd, captchaToken, advancedFields);
      }
      // Stop the cosmetic rotation before we leave — navigation unmounts
      // Login (onCleanup would catch it too), but being explicit means a
      // future route guard that bounces back to /login without unmounting
      // can't leave the interval running.
      stopRotation();
      navigate("/", { replace: true });
    } catch (err) {
      setConnecting(false);
      stopRotation();
      handleError(err);
    }
  };

  const handleCaptchaSolve = async (token: string): Promise<void> => {
    // By the time the captcha is solved the identifier has already been
    // sanitized by the first submit, so it's safe to pass through verbatim.
    const pwd = password();
    setCaptcha(null);
    await attemptLogin(identifier(), pwd === "" ? null : pwd, token);
  };

  const handleCaptchaMountFailure = (err: unknown): void => {
    // CDN blocked, network error, or provider script failed to load —
    // surface a user-actionable toast and revert to the form so the user
    // can retry once they unblock the CDN.
    console.warn("[captcha] mount failed:", err);
    setCaptcha(null);
    setConnecting(false);
    stopRotation();
    setError("Captcha unavailable. Disable ad-blocker or try again.");
  };

  const onSubmit = async (e: Event): Promise<void> => {
    e.preventDefault();
    setError(null);

    // #204 — validate ON SUBMIT (vjt override), never as-typed. The field
    // is dual-purpose: "@" present → email branch, else nick branch. An
    // invalid value surfaces foolproof inline copy instead of letting the
    // server 400 with a raw `malformed_nick`.
    const raw = identifier();
    const classified = classifyLoginIdentifier(raw);
    if (classified.kind === "invalid") {
      setError(
        raw.includes("@")
          ? "That doesn't look like a valid email address. Check for typos."
          : "Please pick a valid nickname — it must start with a letter and contain no spaces.",
      );
      return;
    }

    // Reflect the sanitized value back into the field so the user SEES the
    // correction before the request fires (`my nick` → `my_nick`).
    setIdentifier(classified.value);
    const pwd = password();
    await attemptLogin(classified.value, pwd === "" ? null : pwd);
  };

  let nickInput: HTMLInputElement | undefined;
  onMount(() => {
    // Nick-first: focus the one field the minimal view shows.
    nickInput?.focus();
  });

  const Brand = () => (
    <div class="login-brand">
      <span class="login-brand-irc">IRC</span>
      <span class="login-brand-cic">cicchetto</span>
    </div>
  );

  return (
    <main class="login">
      {/* Matrix-rain backdrop — pure CSS app chrome behind the card. Dim,
          reduced-motion-safe (freezes to a static grid). Not scrollback
          media, so the IRC-text-only invariant is untouched. */}
      <div class="login-matrix" aria-hidden="true" />

      <Show
        when={connecting()}
        fallback={
          <form class="login-form" onSubmit={onSubmit}>
            <Brand />
            <label for="login-identifier">Nick or email</label>
            <input
              ref={(el) => {
                nickInput = el;
              }}
              id="login-identifier"
              type="text"
              autocomplete="username"
              autocapitalize="none"
              autocorrect="off"
              spellcheck={false}
              value={identifier()}
              onInput={(e) => setIdentifier(e.currentTarget.value)}
              required
            />

            {/* Advanced toggle sits BETWEEN the nick input and Connect
                (vjt layout fix). Real button + aria-expanded + conditional
                render (not display:none) so a11y + tests see the truth. */}
            <button
              type="button"
              class="login-advanced-toggle"
              aria-expanded={advanced() ? "true" : "false"}
              aria-controls="login-advanced"
              onClick={() => setAdvanced((v) => !v)}
            >
              {advanced() ? "▾ Advanced" : "▸ Advanced"}
            </button>
            <Show when={advanced()}>
              <div id="login-advanced" class="login-advanced">
                <label for="login-password">Password</label>
                <input
                  id="login-password"
                  type="password"
                  autocomplete="current-password"
                  value={password()}
                  onInput={(e) => setPassword(e.currentTarget.value)}
                />
                <p class="login-advanced-hint">
                  Leave blank to join as a guest. Enter your account password to log into a
                  registered account.
                </p>

                {/* #152 — realname + ident, optional. Blank = server
                    defaults (nick for ident, "Grappa Visitor" for
                    realname). ident is the `user` slot of nick!user@host. */}
                <label for="login-realname">Real name</label>
                <input
                  id="login-realname"
                  type="text"
                  autocomplete="off"
                  autocapitalize="none"
                  autocorrect="off"
                  spellcheck={false}
                  value={realname()}
                  onInput={(e) => setRealname(e.currentTarget.value)}
                />

                <label for="login-ident">Ident</label>
                <input
                  id="login-ident"
                  type="text"
                  autocomplete="off"
                  autocapitalize="none"
                  autocorrect="off"
                  spellcheck={false}
                  value={ident()}
                  onInput={(e) => setIdent(e.currentTarget.value)}
                />
                <p class="login-advanced-hint">
                  Real name and ident are optional and shown to other users. Leave blank to use the
                  defaults.
                </p>
              </div>
            </Show>

            <button type="submit" class="login-connect" disabled={connecting()}>
              Connect
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
        }
      >
        {/* Connecting view — replaces the form in place. Spinner + rotating
            cosmetic reassurance copy (NOT real server phases). */}
        <div
          class="login-connecting"
          data-testid="login-connecting"
          role="status"
          aria-live="polite"
        >
          <Brand />
          <div class="login-spinner" aria-hidden="true" />
          <p class="login-connecting-msg">{CONNECTING_MESSAGES[msgIndex()]}</p>
        </div>
      </Show>
    </main>
  );
};

export default Login;
