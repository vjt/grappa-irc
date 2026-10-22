import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  on,
  Show,
  Switch,
} from "solid-js";
import InlineConfirmButton from "./InlineConfirmButton";
import { copyText } from "./lib/clipboard";
import { isDocumentVisible } from "./lib/documentVisibility";
import type { ChatRow, OutFailure } from "./lib/e2e/chatStore";
import type { SasCancelReason, SasStep, SasView } from "./lib/e2e/sas";
import { SAS_EMOJI } from "./lib/e2e/sasEmoji";
import {
  deleteEncryptedChat,
  encryptedChat,
  encryptedRows,
  encryptedSas,
  encryptedTrust,
  loadEncryptedChat,
  ownKey,
  pinEncryptedKey,
  readEncryptedChat,
  sendEncrypted,
  type Trust,
  trustOf,
  verifyEncrypted,
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
// other direction. People verify each other by comparing emoji (SAS,
// `lib/e2e/sas.ts`); a key the alarm showed can be taken unverified, to be
// verified that way (fork 7, 2430 comment 6339695571).
//
// The chat lives only on this device, so its search does too (2430: "client
// side only, no server index"): a filter over the rows the window already
// holds decrypted, at most `CHAT_ROWS_MAX`. "Delete this chat" takes two
// taps, on the same button the archive deletes grappa's DM history with.

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
  // `too-late` and `late` only happen to a payload with a deadline, and only
  // an ACK carries one; an ACK has no row. Kept so the map stays total over
  // the reasons the door and the drop push can name.
  "too-late": "its deadline had passed",
  refused: "grappa refused it",
  late: "its deadline passed before it could go",
  "send-failed": "the connection failed while sending it",
  "session-ended": "the connection to the network ended before it went",
};

const PIN_ERROR: Record<"bad-key" | "own-key", string> = {
  "bad-key": "that is not an Ed25519 key (43 characters of base64)",
  "own-key": "that is your own key",
};

const SAS_REASON: Record<SasCancelReason, string> = {
  user: "cancelled",
  mismatch: "the emoji did not match",
  timeout: "no answer in 10 minutes",
  "unexpected-message": "a step came out of order",
  "commitment-mismatch": "a key was not the one promised",
  "mac-mismatch": "the confirmation did not match",
  "key-changed": "the nick was pinned to another key",
  "page-gone": "the page running it was closed or reloaded",
  "bad-key": "a key could not be used",
};

// A reason that is not one of ours is the peer's own words: quoted, so
// that it does not read as cic's.
const reasonText = (reason: string): string =>
  (SAS_REASON as Record<string, string | undefined>)[reason] ?? `"${reason}"`;

// `pinned` is the key the chat's nick is pinned to. An `in` row carries the
// key that wrote it, which is not always that one: a known peer writing from
// another nick is read as itself (the engine moves no pin), so a message can
// land in a nick's chat written with ANOTHER key. Such a row says so.
const EncryptedRow: Component<{
  row: ChatRow;
  peer: string;
  pinned: string | undefined;
  onAccept: (key: string) => void;
}> = (props) => (
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
            <code class="e2e-key">{row().presented}</code>. If it is theirs, take it and verify it
            by comparing emoji, or pin the key they give you above.{" "}
            <Show when={row().presented !== props.pinned}>
              <button
                type="button"
                class="e2e-sas-button"
                data-testid="e2e-alarm-accept"
                onClick={() => props.onAccept(row().presented)}
              >
                take this key (not verified)
              </button>
            </Show>
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
      <Match when={props.row.kind === "accepted" && props.row}>
        {(row) => (
          <span class="e2e-row-notice">
            you took <code class="e2e-key">{row().ed25519}</code> as {props.peer}'s key, not
            verified: compare emoji to verify it
          </span>
        )}
      </Match>
      <Match when={props.row.kind === "sas_asked" && props.row}>
        {(row) => (
          <span class="e2e-row-notice">
            {row().by === "you"
              ? `you asked ${props.peer} to compare emoji`
              : `${props.peer} asked to compare emoji with you`}
          </span>
        )}
      </Match>
      <Match when={props.row.kind === "sas_cancelled" && props.row}>
        {(row) => (
          <span class="e2e-row-notice">
            {row().by === "you"
              ? "the emoji comparison stopped"
              : `${props.peer} stopped the emoji comparison`}
            : {reasonText(row().reason)}
          </span>
        )}
      </Match>
      <Match when={props.row.kind === "verified" && props.row}>
        {(row) => (
          <span class="e2e-row-notice">
            you verified {props.peer}'s key <code class="e2e-key">{row().ed25519}</code> by
            comparing emoji
          </span>
        )}
      </Match>
    </Switch>
  </li>
);

// What the panel shows for a SAS, from the window's view of it.
type SasPanelPhase = "waiting" | "asked" | "exchanging" | "compare" | "elsewhere" | "confirmed";

function panelPhase(view: SasView): SasPanelPhase {
  switch (view.phase) {
    case "started":
    case "keyed":
      return "waiting";
    case "asked":
      return "asked";
    case "accepted":
      return "exchanging";
    case "compare":
      if (view.confirmed) return "confirmed";
      if (!view.here) return "elsewhere";
      return view.emoji === null ? "exchanging" : "compare";
  }
}

// The SAS with the peer: a button to start one, or where it stands with what
// the user can do about it. A bot never answers a request (irc-olm drops
// SAS), so the wait says what to do instead.
const SasPanel: Component<{
  view: SasView | null;
  peer: string;
  canStart: boolean;
  onStep: (step: SasStep) => void;
}> = (props) => {
  const button = (step: SasStep, label: string) => (
    <button
      type="button"
      class="e2e-sas-button"
      data-testid={`e2e-sas-${step}`}
      onClick={() => props.onStep(step)}
    >
      {label}
    </button>
  );
  return (
    <Show
      when={props.view}
      fallback={
        <Show when={props.canStart}>
          <div class="e2e-sas">{button("start", "verify by comparing emoji")}</div>
        </Show>
      }
    >
      {(view) => (
        <div class="e2e-sas" data-testid="e2e-sas" data-phase={panelPhase(view())}>
          <Switch>
            <Match when={panelPhase(view()) === "waiting"}>
              <span>
                waiting for {props.peer} to accept the emoji comparison. A bot never answers: pin
                the key it prints instead.
              </span>
              {button("cancel", "cancel")}
            </Match>
            <Match when={panelPhase(view()) === "asked"}>
              <span>{props.peer} asks to compare emoji with you.</span>
              {button("accept", "accept")}
              {button("cancel", "decline")}
            </Match>
            <Match when={panelPhase(view()) === "exchanging"}>
              <span>exchanging keys with {props.peer}…</span>
              {button("cancel", "cancel")}
            </Match>
            <Match when={panelPhase(view()) === "elsewhere"}>
              <span>the emoji comparison is open in another tab.</span>
              {button("cancel", "cancel")}
            </Match>
            <Match when={panelPhase(view()) === "confirmed"}>
              <span>waiting for {props.peer} to confirm the emoji…</span>
              {button("cancel", "cancel")}
            </Match>
            <Match when={panelPhase(view()) === "compare"}>
              <span>
                does {props.peer} see these emoji, in this order? Compare them out of band (voice,
                in person).
              </span>
              <ol class="e2e-sas-emoji-list">
                <For each={view().emoji ?? []}>
                  {(index) => (
                    <li class="e2e-sas-emoji" data-testid="e2e-sas-emoji" data-index={index}>
                      <span class="e2e-sas-glyph" aria-hidden="true">
                        {SAS_EMOJI[index]?.[0]}
                      </span>
                      <span>{SAS_EMOJI[index]?.[1]}</span>
                    </li>
                  )}
                </For>
              </ol>
              {button("match", "they match")}
              {button("mismatch", "they don't match")}
            </Match>
          </Switch>
        </div>
      )}
    </Show>
  );
};

// The messages, in and out: what a search looks through and counts.
const messageBody = (row: ChatRow): string | null =>
  row.kind === "in" || row.kind === "out" ? row.body : null;

const EncryptedChatPane: Component<Props> = (props) => {
  const [draft, setDraft] = createSignal("");
  const [pin, setPin] = createSignal("");
  const [pinError, setPinError] = createSignal<string | null>(null);
  const [copyError, setCopyError] = createSignal<string | null>(null);
  const [query, setQuery] = createSignal("");
  const [deleteArmed, setDeleteArmed] = createSignal(false);
  let list: HTMLOListElement | undefined;

  const display = () => encryptedChat(props.networkSlug, props.nick)?.nick ?? props.nick;
  const rows = () => encryptedRows(props.networkSlug, props.nick) ?? [];
  const peerTrust = () => encryptedTrust(props.networkSlug, props.nick);
  const trust = () => trustOf(rows(), peerTrust());

  // While searching, only the messages that hold what was typed, in any case.
  const needle = () => query().trim().toLowerCase();
  const messages = () => rows().filter((row) => messageBody(row) !== null);
  const shown = createMemo(() => {
    const n = needle();
    if (n === "") return rows();
    return messages().filter((row) => messageBody(row)?.toLowerCase().includes(n));
  });

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
    on(shown, () => {
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
    const result = await pinEncryptedKey(props.networkSlug, props.nick, key, true);
    if (result === "pinned") {
      setPin("");
      setPinError(null);
    } else {
      setPinError(PIN_ERROR[result]);
    }
  };

  const acceptKey = (key: string) => {
    void pinEncryptedKey(props.networkSlug, props.nick, key, false).catch((err: unknown) => {
      console.warn(`[e2e] could not take the new key of ${props.nick}`, err);
    });
  };

  const sasStep = (step: SasStep) => {
    void verifyEncrypted(props.networkSlug, props.nick, step).catch((err: unknown) => {
      console.warn(`[e2e] could not ${step} the emoji comparison with ${props.nick}`, err);
    });
  };

  // The window goes with the chat: the close-watcher moves focus, as after a close.
  const deleteChat = () => {
    setDeleteArmed(false);
    void deleteEncryptedChat(props.networkSlug, props.nick).catch((err: unknown) => {
      console.warn(`[e2e] could not delete the encrypted chat with ${props.nick}`, err);
    });
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
        <SasPanel
          view={encryptedSas(props.networkSlug, props.nick)}
          peer={display()}
          canStart={peerTrust()?.verified === false}
          onStep={sasStep}
        />
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
        <div class="e2e-tools">
          <input
            type="search"
            class="e2e-search-input"
            data-testid="e2e-search-input"
            aria-label={`search the chat with ${display()}`}
            placeholder="search this chat"
            autocomplete="off"
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              setQuery("");
            }}
          />
          <Show when={needle() !== ""}>
            <span class="e2e-search-count muted" data-testid="e2e-search-count" aria-live="polite">
              {shown().length} of {messages().length} messages
            </span>
          </Show>
          <InlineConfirmButton
            idleLabel="delete this chat"
            confirmLabel="really delete?"
            armed={deleteArmed()}
            onArm={() => setDeleteArmed(true)}
            onConfirm={deleteChat}
            testId="e2e-delete-chat"
            extraClass="e2e-delete-chat"
          />
        </div>
      </header>
      <ol class="e2e-rows" ref={list}>
        <For each={shown()}>
          {(row) => (
            <EncryptedRow
              row={row}
              peer={display()}
              pinned={peerTrust()?.ed25519}
              onAccept={acceptKey}
            />
          )}
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
