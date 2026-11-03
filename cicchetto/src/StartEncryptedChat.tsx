import { type Component, createSignal, Show } from "solid-js";
import { requestConfirm } from "./lib/confirmDialog";
import { askEncryptedChat, createRequestView } from "./lib/e2eRequests";
import { encryptedChat } from "./lib/encryptedChats";
import { openEncryptedWindow } from "./lib/encryptedWindow";
import { errorMessage } from "./lib/friendlyApiError";

// issue 2486 — the one button in a query's rail that asks the peer to start
// an encrypted chat. No settings and no probe first: CTCP VERSION can be off
// or lie, so the asking itself is the probe. The confirm says, before
// anything is sent, what the peer needs to answer and how long the asking
// waits. Our asking still waiting is the banner's to cancel, so the button
// says so rather than asking twice, and holds while the asking is on its way.
//
// issue 2508 — once an encrypted chat with the peer exists on this network
// (the device's chat index holds it, open or closed), there is nothing left
// to ask: the button becomes "chat securely" and opens that chat's 🔒 window,
// with no confirm and no request. Asking again would ask the peer to start a
// second chat.

/** How the confirm words the asking: what it needs from the peer, and the 24 h it waits. */
export function startEncryptedChatBody(nick: string): string {
  return (
    `Ask ${nick} to start an encrypted chat? ${nick} can answer only from cicchetto, ` +
    `or another client that speaks grappa's encrypted chats. Without an answer ` +
    `within 24 hours the request expires.`
  );
}

export type Props = {
  networkSlug: string;
  peer: string;
};

// One button per (network, peer): the rail stays mounted across window
// switches, and an asking still out for one peer, or its error, must not
// carry over to the next.
const StartEncryptedChat: Component<Props> = (props) => (
  <Show when={`${props.networkSlug} ${props.peer}`} keyed>
    <Button networkSlug={props.networkSlug} peer={props.peer} />
  </Show>
);

const Button: Component<Props> = (props) => {
  const [error, setError] = createSignal<string | null>(null);
  // Our asking on its way: until grappa answers, the banner has nothing to show.
  const [asking, setAsking] = createSignal(false);

  const view = createRequestView(
    () => props.networkSlug,
    () => props.peer,
  );
  const pending = () => view()?.kind === "pending";
  const existing = () => encryptedChat(props.networkSlug, props.peer);

  const ask = () => {
    setError(null);
    requestConfirm({
      title: "Start encrypted chat",
      body: startEncryptedChatBody(props.peer),
      confirmLabel: "Ask",
      onConfirm: () => {
        setAsking(true);
        void askEncryptedChat(props.networkSlug, props.peer)
          .catch((err: unknown) => setError(errorMessage(err)))
          .finally(() => setAsking(false));
      },
      alternative: null,
      attachments: null,
      choice: null,
      toggle: null,
      defaultButton: "cancel",
    });
  };

  // The window the chat index names, spelled as the index has it.
  const open = (nick: string) => {
    setError(null);
    void openEncryptedWindow(props.networkSlug, nick).catch((err: unknown) =>
      setError(errorMessage(err)),
    );
  };

  return (
    <div class="rail-encrypted-chat">
      <Show
        when={existing()}
        fallback={
          <button
            type="button"
            class="rail-encrypted-chat-button"
            data-testid="rail-start-encrypted-chat"
            disabled={pending() || asking()}
            onClick={ask}
          >
            {pending() ? "encrypted chat requested" : "start encrypted chat"}
          </button>
        }
      >
        {(chat) => (
          <button
            type="button"
            class="rail-encrypted-chat-button"
            data-testid="rail-chat-securely"
            onClick={() => open(chat().nick)}
          >
            chat securely
          </button>
        )}
      </Show>
      <Show when={error()}>
        {(message) => (
          <div class="e2e-error" data-testid="rail-start-encrypted-chat-error" role="alert">
            {message()}
          </div>
        )}
      </Show>
    </div>
  );
};

export default StartEncryptedChat;
