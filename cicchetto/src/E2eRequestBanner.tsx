import { type Component, createSignal, Match, Show, Switch } from "solid-js";
import {
  acceptEncryptedChat,
  askEncryptedChat,
  createRequestView,
  dismissEncryptedChatRequest,
  openAcceptedChat,
  refuseEncryptedChat,
} from "./lib/e2eRequests";
import { errorMessage } from "./lib/friendlyApiError";
import NickText from "./NickText";

// issue 2486 — the asking to start an encrypted chat, over the plaintext
// query with the peer (vjt's ruling: the banner need not be encrypted). Both
// sides read it here: the peer's asking with Accept / Reject, and our own
// asking while it waits (Cancel), once answered, or once it went 24 h
// unanswered (Retry). What it shows is grappa's request, mirrored
// (`lib/e2eRequests.ts`); every button is a door, and the banner changes
// when grappa says so, on every device.
//
// The deadline is read here as well as on grappa (`createRequestView`).

export type Props = {
  networkSlug: string;
  peer: string;
};

const E2eRequestBanner: Component<Props> = (props) => {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const view = createRequestView(
    () => props.networkSlug,
    () => props.peer,
  );

  // A failure is said in the banner, never thrown at the click. While a door
  // runs every button is disabled, so a second click sends nothing.
  const act = (work: () => Promise<void>) => () => {
    setBusy(true);
    setError(null);
    void work()
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setBusy(false));
  };

  return (
    <Show when={view()}>
      {(v) => (
        <div class="e2e-request-banner" data-testid="e2e-request-banner" data-state={v().kind}>
          <span class="e2e-request-banner-text">
            <Switch>
              <Match when={v().kind === "incoming"}>
                <NickText nick={props.peer} /> would like to start an encrypted chat with you.
              </Match>
              <Match when={v().kind === "pending"}>
                <span class="e2e-request-banner-spinner" aria-hidden="true" />
                Waiting for <NickText nick={props.peer} /> to accept the encrypted chat.
              </Match>
              <Match when={v().kind === "accepted"}>
                <NickText nick={props.peer} /> accepted the encrypted chat.
              </Match>
              <Match when={v().kind === "refused"}>
                <NickText nick={props.peer} /> refused the encrypted chat.
              </Match>
              <Match when={v().kind === "expired"}>
                <NickText nick={props.peer} /> did not answer the encrypted chat request within 24
                hours.
              </Match>
            </Switch>
          </span>
          <Switch>
            <Match when={v().kind === "incoming"}>
              <button
                type="button"
                class="e2e-request-banner-action"
                data-testid="e2e-request-accept"
                disabled={busy()}
                onClick={act(() => acceptEncryptedChat(props.networkSlug, v().request))}
              >
                Accept
              </button>
              <button
                type="button"
                class="e2e-request-banner-action"
                data-testid="e2e-request-reject"
                disabled={busy()}
                onClick={act(() => refuseEncryptedChat(props.networkSlug, v().request))}
              >
                Reject
              </button>
            </Match>
            <Match when={v().kind === "pending"}>
              <button
                type="button"
                class="e2e-request-banner-action"
                data-testid="e2e-request-cancel"
                disabled={busy()}
                onClick={act(() => dismissEncryptedChatRequest(props.networkSlug, v().request))}
              >
                Cancel
              </button>
            </Match>
            <Match when={v().kind === "accepted"}>
              <button
                type="button"
                class="e2e-request-banner-action"
                data-testid="e2e-request-open"
                disabled={busy()}
                onClick={act(() => openAcceptedChat(props.networkSlug, v().request))}
              >
                Open
              </button>
            </Match>
            <Match when={v().kind === "expired"}>
              <button
                type="button"
                class="e2e-request-banner-action"
                data-testid="e2e-request-retry"
                disabled={busy()}
                onClick={act(() => askEncryptedChat(props.networkSlug, props.peer))}
              >
                Retry
              </button>
            </Match>
          </Switch>
          <Show when={v().kind === "refused" || v().kind === "expired"}>
            <button
              type="button"
              class="e2e-request-banner-dismiss"
              data-testid="e2e-request-dismiss"
              aria-label="Dismiss the encrypted chat request"
              disabled={busy()}
              onClick={act(() => dismissEncryptedChatRequest(props.networkSlug, v().request))}
            >
              ×
            </button>
          </Show>
          <Show when={error()}>
            {(message) => (
              <span class="e2e-request-banner-error" data-testid="e2e-request-error" role="alert">
                {message()}
              </span>
            )}
          </Show>
        </div>
      )}
    </Show>
  );
};

export default E2eRequestBanner;
