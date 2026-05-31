import { useNavigate, useParams } from "@solidjs/router";
import { type Component, createSignal, onMount, Show } from "solid-js";
import { consumeShareToken } from "./lib/api";
import { installSharedSession } from "./lib/auth";

// Visitor session-sharing — landing route for `/share/:token`.
// Mounted in `main.tsx` under the hash router. Auto-consumes on mount:
//   1. POST /auth/share/consume with the URL token.
//   2. On 200, installSharedSession({token, subject}) writes the bearer
//      + subject into localStorage and the existing RequireAuth
//      createEffect navigates the user into the Shell.
//   3. On error, render the wire-shape error string so the operator can
//      tell "expired" / "already used" / "not found" apart.
//
// Error wire-shape mapping (server → user):
//   share_token_expired   → link expired (TTL elapsed)
//   share_token_consumed  → already used on another device
//   not_found             → original session no longer exists
//   unauthorized          → tampered / unsigned token
//   bad_request           → malformed
//
// Auto-consume on mount because the link IS the auth credential — any
// additional "click here to log in" intermediary defeats the
// one-tap-to-second-device flow. The visitor already chose to open the
// link; we just complete the loop.

const ShareConsume: Component = () => {
  const params = useParams<{ token: string }>();
  const navigate = useNavigate();
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(true);

  onMount(() => {
    void consume();
  });

  const consume = async () => {
    setBusy(true);
    setError(null);
    try {
      const { token: bearer, subject } = await consumeShareToken(params.token);
      installSharedSession(bearer, subject);
      navigate("/", { replace: true });
    } catch (err) {
      const code = err instanceof Error ? err.message : "consume_failed";
      setError(code);
    } finally {
      setBusy(false);
    }
  };

  const goToLogin = () => navigate("/login", { replace: true });

  return (
    <main class="share-consume" data-testid="share-consume">
      <h1>opening shared session…</h1>

      <Show when={busy()}>
        <p data-testid="share-consume-busy">contacting the server…</p>
      </Show>

      <Show when={error() !== null}>
        <p class="share-consume-error" role="alert" data-testid="share-consume-error">
          {error()}
        </p>
        <button
          type="button"
          class="share-consume-go-login"
          data-testid="share-consume-go-login"
          onClick={goToLogin}
        >
          go to login
        </button>
      </Show>
    </main>
  );
};

export default ShareConsume;
