import { type Component, createSignal, onMount, Show } from "solid-js";
import { getOidcIdentity, type OidcIdentity, startOidcLink, unlinkOidc } from "./lib/api";
import { token } from "./lib/auth";
import { errorMessage } from "./lib/friendlyApiError";

// #1911 — the account's provider link, next to the passkey + TOTP sections
// in the security subpage, because that is what it is: a second credential
// for this account, not a profile decoration.
//
// Why the link lives HERE and nowhere else: grappa refuses to provision an
// account from a provider assertion, so a provider identity can only ever
// log in as an account that linked itself first, while holding a full
// session. The button hands back the provider URL (`POST /me/oidc/link`)
// and the browser is navigated at it — a navigation, not a fetch, because
// the first hop of the round trip is a 302 the browser has to follow
// (lib/oidc.ts). Coming home lands on /login, where the `linked` landing
// is read and the note rendered.
const OidcSettings: Component = () => {
  const [identity, setIdentity] = createSignal<OidcIdentity | null>(null);
  const [loaded, setLoaded] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const currentToken = (): string => {
    const value = token();
    if (value === null) throw new Error("missing auth token");
    return value;
  };

  onMount(() => {
    void getOidcIdentity(currentToken())
      .then((found) => {
        setIdentity(found);
        setLoaded(true);
      })
      .catch((value) => {
        setError(errorMessage(value));
        setLoaded(true);
      });
  });

  const startLink = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const { authorize_url } = await startOidcLink(currentToken());
      window.location.assign(authorize_url);
    } catch (value) {
      setError(errorMessage(value));
      setBusy(false);
    }
  };

  const removeLink = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      // A 404 is the "nothing was linked" answer (grappa refuses to nod
      // along); either way the section now shows the unlinked state.
      await unlinkOidc(currentToken());
      setIdentity(null);
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="settings-section settings-section-card" data-testid="oidc-settings">
      <h4 class="settings-section-heading">single sign-on</h4>
      <Show when={loaded()}>
        <Show
          when={identity()}
          keyed
          fallback={
            <>
              <p>No provider account is linked to this grappa account.</p>
              <button
                type="button"
                data-testid="oidc-link"
                disabled={busy()}
                onClick={() => void startLink()}
              >
                link a provider account
              </button>
            </>
          }
        >
          {(linked) => (
            <>
              <p>
                Linked provider account{linked.label === null ? "" : `: ${linked.label}`}. It can
                sign in as this grappa account, after its own second factor.
              </p>
              <button
                type="button"
                data-testid="oidc-unlink"
                disabled={busy()}
                onClick={() => void removeLink()}
              >
                unlink provider account
              </button>
            </>
          )}
        </Show>
      </Show>
      <Show when={error()}>
        {(message) => (
          <p role="alert" data-testid="oidc-settings-error">
            {message()}
          </p>
        )}
      </Show>
    </div>
  );
};

export default OidcSettings;
