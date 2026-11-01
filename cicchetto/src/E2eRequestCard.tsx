import { type Component, createSignal, Match, Show, Switch } from "solid-js";
import {
  askEncryptedChat,
  createRequestView,
  dismissEncryptedChatRequest,
  openAcceptedChat,
} from "./lib/e2eRequests";
import { errorMessage } from "./lib/friendlyApiError";
import NickText from "./NickText";

// issue 2486 — our asking to start an encrypted chat, as a card in the query
// with the peer (vjt's ruling R4: the outcomes are cards in the chat, not
// banners; the banner is for the peer's asking only). ONE card that changes
// state in place: waiting (Cancel), refused, unanswered for 24 h (Retry), and
// accepted, which is normally never seen because the chat opens by itself
// and the request is dismissed; if that failed, the card offers Open. The
// pane weaves it into the timeline at the request's `at`
// (`ScrollbackPane`'s `rows()`), like the other presentational rows: it never
// counts as unread and never moves the read cursor.
//
// What it shows is grappa's request, mirrored (`lib/e2eRequests.ts`), its
// deadline read here as well (`createRequestView`); every button is a door.

export type Props = {
  networkSlug: string;
  peer: string;
};

// One card per (network, peer), as the banner is: a door still out for one
// peer, or its error, must not carry over to the next.
const E2eRequestCard: Component<Props> = (props) => (
  <Show when={`${props.networkSlug} ${props.peer}`} keyed>
    <Card networkSlug={props.networkSlug} peer={props.peer} />
  </Show>
);

const Card: Component<Props> = (props) => {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const view = createRequestView(
    () => props.networkSlug,
    () => props.peer,
  );
  // The peer's asking is the banner's.
  const ours = () => {
    const v = view();
    return v === null || v.kind === "incoming" ? null : v;
  };

  // A failure is said in the card, never thrown at the click. While a door
  // runs every button is disabled, so a second click sends nothing.
  const act = (work: () => Promise<void>) => () => {
    setBusy(true);
    setError(null);
    void work()
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setBusy(false));
  };

  return (
    <Show when={ours()}>
      {(v) => (
        <section
          class="e2e-step e2e-request-card"
          data-testid="e2e-request-card"
          data-state={v().kind}
        >
          <div class="e2e-request-card-head">
            <p class="e2e-request-card-text">
              <Switch>
                <Match when={v().kind === "pending"}>
                  <span class="e2e-request-card-spinner" aria-hidden="true" />
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
            </p>
            <Show when={v().kind !== "pending"}>
              <button
                type="button"
                class="e2e-request-card-dismiss"
                data-testid="e2e-request-dismiss"
                aria-label="Dismiss the encrypted chat request"
                disabled={busy()}
                onClick={act(() => dismissEncryptedChatRequest(props.networkSlug, v().request))}
              >
                ×
              </button>
            </Show>
          </div>
          <Show when={v().kind !== "refused"}>
            <div class="e2e-step-actions">
              <Switch>
                <Match when={v().kind === "pending"}>
                  <button
                    type="button"
                    class="e2e-request-card-action"
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
                    class="e2e-request-card-action"
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
                    class="e2e-request-card-action"
                    data-testid="e2e-request-retry"
                    disabled={busy()}
                    onClick={act(() => askEncryptedChat(props.networkSlug, props.peer))}
                  >
                    Retry
                  </button>
                </Match>
              </Switch>
            </div>
          </Show>
          <Show when={error()}>
            {(message) => (
              <p class="e2e-error" data-testid="e2e-request-error" role="alert">
                {message()}
              </p>
            )}
          </Show>
        </section>
      )}
    </Show>
  );
};

export default E2eRequestCard;
