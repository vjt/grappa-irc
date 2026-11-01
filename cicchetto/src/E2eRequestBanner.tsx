import { type Component, createSignal, Show } from "solid-js";
import { acceptEncryptedChat, createRequestView, refuseEncryptedChat } from "./lib/e2eRequests";
import { errorMessage } from "./lib/friendlyApiError";
import NickText from "./NickText";

// issue 2486 — the peer's asking to start an encrypted chat, over the
// plaintext query with them (vjt's ruling: the banner need not be encrypted),
// with Accept / Reject. Only the peer's asking: ours, waiting or answered,
// is a card in the chat (`E2eRequestCard`, ruling R4). What it shows is
// grappa's request, mirrored (`lib/e2eRequests.ts`); both buttons are doors,
// and the banner goes when grappa says so, on every device.
//
// The deadline is read here as well as on grappa (`createRequestView`).

export type Props = {
  networkSlug: string;
  peer: string;
};

// One banner per (network, peer): the pane hosting it stays mounted across
// window switches, and a door still out for one peer, or its error, must not
// carry over to the next.
const E2eRequestBanner: Component<Props> = (props) => (
  <Show when={`${props.networkSlug} ${props.peer}`} keyed>
    <Banner networkSlug={props.networkSlug} peer={props.peer} />
  </Show>
);

const Banner: Component<Props> = (props) => {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const view = createRequestView(
    () => props.networkSlug,
    () => props.peer,
  );
  const incoming = () => {
    const v = view();
    return v?.kind === "incoming" ? v : null;
  };

  // A failure is said in the banner, never thrown at the click. While a door
  // runs both buttons are disabled, so a second click sends nothing.
  const act = (work: () => Promise<void>) => () => {
    setBusy(true);
    setError(null);
    void work()
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setBusy(false));
  };

  return (
    <Show when={incoming()}>
      {(v) => (
        <div class="e2e-request-banner" data-testid="e2e-request-banner" data-state="incoming">
          <span class="e2e-request-banner-text">
            <NickText nick={props.peer} /> would like to start an encrypted chat with you.
          </span>
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
