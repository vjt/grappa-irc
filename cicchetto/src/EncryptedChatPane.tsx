import { type Component, createEffect, createSignal, For, Match, on, Show, Switch } from "solid-js";
import { copyText } from "./lib/clipboard";
import { isDocumentVisible } from "./lib/documentVisibility";
import type { ChatRow, OutFailure } from "./lib/e2e/chatStore";
import {
  encryptedChat,
  encryptedRows,
  encryptedTrust,
  loadEncryptedChat,
  ownKey,
  pinEncryptedKey,
  readEncryptedChat,
  sendEncrypted,
  type Trust,
  trustOf,
} from "./lib/encryptedChats";
import { formatTimestamp } from "./lib/timeFormat";
import NickText from "./NickText";

// issue 2430 — the encrypted query window (kind "encrypted"): the rows of the
// device's chat with one peer, who the peer's nick is pinned to, our own key,
// and a compose line that sends only through Olm.
//
// Not ScrollbackPane + ComposeBox, on purpose. ScrollbackPane is coupled to
// grappa's scrollback (fetches, cursors, paging) and these rows never touch
// grappa. ComposeBox keeps drafts and history, and a plaintext draft kept at
// rest is exactly what an encrypted query must not leave behind: this
// compose line keeps nothing once the message is handed to the engine, and
// takes no slash commands (everything typed goes to the peer, encrypted).
//
// Bots are pinned by hand (2430 ruling 6253162964): the user reads the bot's
// key off the bot and pastes it here; our own key is shown, copyable, for the
// other direction. SAS between humans is a later slice.

type Props = { networkSlug: string; nick: string };

const TRUST_LABEL: Record<Trust, string> = {
  verified: "verified",
  unverified: "not verified",
  alarm: "key changed",
};

const FAILURE_LABEL: Record<OutFailure, string> = {
  "own-nick": "that is your own nick",
  unencodable: "it cannot be encoded",
  "queue-full": "too many messages are waiting for this peer",
  "keys-timeout": "no keys came from the peer",
  "too-long": "it is too long",
  "key-mismatch": "the peer answered with another key",
  "nack-from-another-nick": "another nick refused it",
  "unpinned-key": "the peer's key is not the pinned one",
  repinned: "the peer was pinned to another key",
  "resend-failed": "it could not be sent again",
  "rekey-throttled": "a new session was started too recently",
  "rate-limited": "grappa's queue for this peer is full",
  "too-large": "it is too large",
  refused: "grappa refused it",
};

const PIN_ERROR: Record<"bad-key" | "own-key", string> = {
  "bad-key": "that is not an Ed25519 key (43 characters of base64)",
  "own-key": "that is your own key",
};

// `pinned` is the key the chat's nick is pinned to. An `in` row carries the
// key that wrote it, which is not always that one: a known peer writing from
// another nick is read as itself (the engine moves no pin), so a message can
// land in a nick's chat written with ANOTHER key. Such a row says so.
const EncryptedRow: Component<{ row: ChatRow; peer: string; pinned: string | undefined }> = (
  props,
) => (
  <li class="e2e-row" data-testid="e2e-row" data-row-kind={props.row.kind}>
    <span class="e2e-row-time scrollback-time">{formatTimestamp(props.row.at)}</span>
    <span class="encrypted-marker" aria-hidden="true">
      🔒
    </span>
    <Switch>
      <Match when={props.row.kind === "in" && props.row}>
        {(row) => (
          <>
            <NickText nick={row().nick} extraClass="e2e-row-nick" />
            <span class="e2e-row-body">{row().body}</span>
            <Show when={props.pinned !== undefined && row().ed25519 !== props.pinned}>
              <span class="e2e-row-notice e2e-row-alarm" data-testid="e2e-row-other-key">
                written with another key: <code class="e2e-key">{row().ed25519}</code>
              </span>
            </Show>
          </>
        )}
      </Match>
      <Match when={props.row.kind === "out" && props.row}>
        {(row) => (
          <>
            <span class="e2e-row-nick e2e-row-own">you</span>
            <span class="e2e-row-body">{row().body}</span>
            <span class="e2e-row-state muted" data-testid="e2e-row-state" data-state={row().state}>
              <Switch>
                <Match when={row().state === "queued"}>waiting for keys</Match>
                <Match when={row().state === "sending"}>sending</Match>
                <Match when={row().state === "failed"}>
                  not sent: {FAILURE_LABEL[row().reason ?? "refused"]}
                </Match>
              </Switch>
            </span>
          </>
        )}
      </Match>
      <Match when={props.row.kind === "undecryptable" && props.row}>
        {(row) => (
          <span class="e2e-row-notice">
            {row().nick} sent you an encrypted message that cannot be read here
          </span>
        )}
      </Match>
      <Match when={props.row.kind === "key_alarm" && props.row}>
        {(row) => (
          <span class="e2e-row-notice e2e-row-alarm">
            {row().nick} spoke with a key that is not the pinned one, and was ignored:{" "}
            <code class="e2e-key">{row().presented}</code>. If it is theirs, pin it above.
          </span>
        )}
      </Match>
      <Match when={props.row.kind === "pinned" && props.row}>
        {(row) => (
          <span class="e2e-row-notice">
            you pinned {props.peer} to <code class="e2e-key">{row().ed25519}</code>
          </span>
        )}
      </Match>
    </Switch>
  </li>
);

const EncryptedChatPane: Component<Props> = (props) => {
  const [draft, setDraft] = createSignal("");
  const [pin, setPin] = createSignal("");
  const [pinError, setPinError] = createSignal<string | null>(null);
  const [copyError, setCopyError] = createSignal<string | null>(null);
  let list: HTMLOListElement | undefined;

  const display = () => encryptedChat(props.networkSlug, props.nick)?.nick ?? props.nick;
  const rows = () => encryptedRows(props.networkSlug, props.nick) ?? [];
  const peerTrust = () => encryptedTrust(props.networkSlug, props.nick);
  const trust = () => trustOf(rows(), peerTrust());

  createEffect(
    on(
      () => [props.networkSlug, props.nick] as const,
      ([slug, nick]) => {
        void loadEncryptedChat(slug, nick).catch((err: unknown) => {
          console.warn(`[e2e] could not load the encrypted chat with ${nick}`, err);
        });
      },
    ),
  );

  // Read while shown: what arrives in a window the user is looking at is read.
  createEffect(() => {
    const unread = encryptedChat(props.networkSlug, props.nick)?.unread ?? 0;
    if (unread === 0 || !isDocumentVisible()) return;
    void readEncryptedChat(props.networkSlug, props.nick).catch((err: unknown) => {
      console.warn(`[e2e] could not mark the encrypted chat with ${props.nick} read`, err);
    });
  });

  createEffect(
    on(rows, () => {
      if (list !== undefined) list.scrollTop = list.scrollHeight;
    }),
  );

  const send = (event: SubmitEvent) => {
    event.preventDefault();
    const body = draft();
    if (body.trim() === "") return;
    setDraft("");
    void sendEncrypted(props.networkSlug, props.nick, body).catch((err: unknown) => {
      console.warn(`[e2e] could not send to ${props.nick}`, err);
    });
  };

  const submitPin = async (event: SubmitEvent) => {
    event.preventDefault();
    const key = pin().trim();
    if (key === "") return;
    const result = await pinEncryptedKey(props.networkSlug, props.nick, key);
    if (result === "pinned") {
      setPin("");
      setPinError(null);
    } else {
      setPinError(PIN_ERROR[result]);
    }
  };

  const copyOwn = async () => {
    const own = ownKey(props.networkSlug);
    if (own === undefined) return;
    setCopyError(null);
    try {
      await copyText(own);
    } catch (err) {
      setCopyError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div class="e2e-pane" data-testid="e2e-pane">
      <header class="e2e-header">
        <div class="e2e-header-main">
          <span class="encrypted-marker" aria-hidden="true">
            🔒
          </span>
          <NickText nick={display()} extraClass="e2e-heading" />
          <span
            class={`e2e-trust e2e-trust-${trust()}`}
            data-testid="e2e-peer-trust"
            data-trust={trust()}
          >
            {TRUST_LABEL[trust()]}
          </span>
        </div>
        <div class="e2e-keys muted">
          <div class="e2e-key-line">
            your key:{" "}
            <code class="e2e-key" data-testid="e2e-own-identity">
              {ownKey(props.networkSlug) ?? "…"}
            </code>
            <button
              type="button"
              class="e2e-copy"
              data-testid="e2e-own-identity-copy"
              disabled={ownKey(props.networkSlug) === undefined}
              onClick={() => void copyOwn()}
            >
              copy
            </button>
          </div>
          <Show when={copyError()}>{(message) => <div class="e2e-error">{message()}</div>}</Show>
          <div class="e2e-key-line">
            {display()}'s key:{" "}
            <code class="e2e-key" data-testid="e2e-peer-key">
              {peerTrust()?.ed25519 ?? "none yet"}
            </code>
          </div>
          <form class="e2e-pin" onSubmit={(event) => void submitPin(event)}>
            <input
              type="text"
              class="e2e-pin-input"
              data-testid="e2e-pin-input"
              placeholder={`pin ${display()}'s key (paste it)`}
              autocomplete="off"
              spellcheck={false}
              value={pin()}
              onInput={(event) => setPin(event.currentTarget.value)}
            />
            <button type="submit" class="e2e-pin-submit" data-testid="e2e-pin-submit">
              pin
            </button>
          </form>
          <Show when={pinError()}>
            {(message) => (
              <div class="e2e-error" data-testid="e2e-pin-error">
                {message()}
              </div>
            )}
          </Show>
        </div>
      </header>
      <ol class="e2e-rows" ref={list}>
        <For each={rows()}>
          {(row) => <EncryptedRow row={row} peer={display()} pinned={peerTrust()?.ed25519} />}
        </For>
      </ol>
      <form class="e2e-compose" data-testid="e2e-compose" onSubmit={send}>
        <input
          type="text"
          class="e2e-compose-input"
          data-testid="e2e-compose-input"
          placeholder={`encrypted message to ${display()}`}
          autocomplete="off"
          value={draft()}
          onInput={(event) => setDraft(event.currentTarget.value)}
        />
        <button type="submit" class="e2e-compose-send" data-testid="e2e-compose-send">
          send
        </button>
      </form>
    </div>
  );
};

export default EncryptedChatPane;
