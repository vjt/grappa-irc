import { useNavigate } from "@solidjs/router";
import { type Component, createSignal, Show } from "solid-js";
import { ApiError } from "./lib/api";
import * as auth from "./lib/auth";

// Bare credential form. The walking-skeleton login surface is one card,
// no branding, no "remember me" — the bouncer is single-tenant per
// operator and bearer tokens already persist via localStorage. The form
// reads/writes the auth signal store; route navigation happens here
// (post-resolve) because `useNavigate()` is a hook usable only from
// inside a `<Router>` route component, not from a free module.

const Login: Component = () => {
  const [name, setName] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [submitting, setSubmitting] = createSignal(false);
  const navigate = useNavigate();

  const onSubmit = async (e: Event) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await auth.login(name(), password());
      navigate("/", { replace: true });
    } catch (err) {
      // Match strictly on `ApiError.code === "invalid_credentials"` for
      // the common credential-failure path; fall through to the raw
      // message for any other (unexpected) failure so it's still
      // visible during development. Earlier shape used
      // `code.includes("invalid_credentials")` against the wire token,
      // which would silently map any unrelated error code that
      // happened to contain that substring (S47).
      if (err instanceof ApiError && err.code === "invalid_credentials") {
        setError("Invalid name or password.");
      } else {
        setError(err instanceof Error ? err.message : "login_failed");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main class="login">
      <form class="login-form" onSubmit={onSubmit}>
        <h1>cicchetto</h1>
        <label for="login-name">Name</label>
        <input
          id="login-name"
          type="text"
          autocomplete="username"
          value={name()}
          onInput={(e) => setName(e.currentTarget.value)}
          required
        />
        <label for="login-password">Password</label>
        <input
          id="login-password"
          type="password"
          autocomplete="current-password"
          value={password()}
          onInput={(e) => setPassword(e.currentTarget.value)}
          required
        />
        <button type="submit" disabled={submitting()}>
          Log in
        </button>
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
