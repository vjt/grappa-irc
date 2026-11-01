import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  Match,
  on,
  onMount,
  Show,
  Switch,
} from "solid-js";
import {
  acceptAlarmKey,
  CHECK_LOOK,
  CHECK_REASON,
  CopyOwnKey,
  checkLook,
  checkPlace,
  PinForm,
  TRUST_LABEL,
} from "./EncryptedRail";
import InlineConfirmButton from "./InlineConfirmButton";
import { ApiError } from "./lib/api";
import { requestConfirm } from "./lib/confirmDialog";
import { formatDateTime } from "./lib/dateFormat";
import { loadDocument } from "./lib/documentNavigation";
import { isDocumentVisible } from "./lib/documentVisibility";
import { type IdentityCheck, isMessage, type Message, type OutFailure } from "./lib/e2e/chatStore";
import { pairingUrl, parsePairFragment } from "./lib/e2e/pairing";
import type { SasStep, SasView } from "./lib/e2e/sas";
import { SAS_EMOJI } from "./lib/e2e/sasEmoji";
import {
  deleteEncryptedChat,
  encryptedChat,
  encryptedRows,
  encryptedSas,
  encryptedTrust,
  identityElsewhere,
  loadEncryptedChat,
  openAlarm,
  readEncryptedChat,
  rekeyEncrypted,
  replaceEncryptedIdentity,
  sendEncrypted,
  trustOf,
  type UnreadableStep,
  unreadableStep,
  verifyEncrypted,
} from "./lib/encryptedChats";
import { friendlyApiError } from "./lib/friendlyApiError";
import { formatTimestamp } from "./lib/timeFormat";
import NickText from "./NickText";

// issue 2430 — the encrypted query window (kind "encrypted"): the rows of the
// device's chat with one peer, and a compose line that sends only through Olm.
//
// Not ScrollbackPane + ComposeBox, on purpose. ScrollbackPane is coupled to
// grappa's scrollback (fetches, cursors, paging) and these rows never touch
// grappa. ComposeBox keeps drafts and history, and a plaintext draft kept at
// rest is exactly what an encrypted query must not leave behind: this
// compose line keeps nothing once the message is handed to the engine, and
// takes no slash commands (everything typed goes to the peer, encrypted).
//
// issue 2485 (vjt's rulings, DESIGN_NOTES #2485) split the window three ways:
//   * the TOP BAR is the peer's verification only: verified or not (or the
//     key changed), the last identity check a bot made, compact, and two
//     buttons for the chat itself, a magnifier (search) and a shredder
//     (delete this chat);
//   * the CHAT BODY holds messages, and while the key exchange is not done,
//     the one step still needed, as a card: an identity held on another
//     device (pair this browser, or start a new identity), a key alarm (take
//     the new key), or no key yet (send, or paste the bot's key and give it
//     ours). The exchange is done once the nick has a pinned key and no alarm
//     is open, verified or not: verification is the top bar's state. A
//     message none of the peer's devices could read leaves a card too (issue
//     2491): asking for their keys again is the user's choice, never made
//     for them, and the compose line stays usable meanwhile. The
//     emoji comparison runs here too, modal-like over the body, and nothing
//     can be sent until it ends;
//   * everything technical (keys, devices, pins, the comparison's start, the
//     check in full) is the right rail's (`EncryptedRail`). The key events the
//     chat used to list as rows (pinned, taken, compared, alarmed) stay in the
//     store, where the badge reads them, and show only as the rail's state.
//
// Bots are pinned by hand (2430 ruling 6253162964): the user reads the bot's
// master key off the bot and pastes it; our own master is copied for the
// other direction. People verify each other by comparing emoji (SAS,
// `lib/e2e/sas.ts`); a key the alarm showed can be taken unverified, to be
// verified that way (fork 7, 2430 comment 6339695571). A key here is always a
// master: what a peer pins, whichever of its devices writes (wire v2).
//
// An identity grappa holds and this browser cannot speak for is never
// replaced silently (vjt 6344779758): the card says so, and offers pairing
// this browser first, then, behind a confirmation that names what it
// destroys, a new identity here. Nothing can be sent meanwhile.
//
// The chat lives only on this device, so its search does too (2430: "client
// side only, no server index"): a filter over the messages the window
// already holds decrypted, at most `CHAT_ROWS_MAX`. The shredder asks first,
// as the window's × does when the chat keeps messages.

type Props = {
  networkSlug: string;
  nick: string;
  /**
   * The rail's ☰ as the bar's LAST child, or `null`. Mobile passes it: the
   * floating `.shell-chrome` ☰ would land on the shredder, the bar's
   * top-right corner (#1050's collision), so the bar hosts the door itself,
   * as MentionsWindow does (issue 2333). Desktop passes `null`: its rail is
   * permanent. Required, by the argument `PaneTopBar`'s slots make.
   */
  railOpener: JSX.Element;
  /**
   * The left `#` door to the window list (#1766), or `null`: the bar's FIRST
   * child, for the same reason. Mobile passes Shell's `windowsRailOpener()`
   * (itself empty while the window bar is in flow); desktop passes `null`.
   */
  windowsOpener: JSX.Element;
  /**
   * Called each time the emoji comparison's dialog opens, or `null`. Mobile
   * passes the drawer's close: the rail is a drawer OVER the pane there, and
   * the dialog opens behind it. Desktop passes `null`: its rail is beside.
   */
  onDialogOpen: (() => void) | null;
};

const FAILURE_LABEL: Record<OutFailure, string> = {
  "own-nick": "that is your own nick",
  unencodable: "it cannot be encoded",
  "queue-full": "too many messages are waiting for this peer",
  "keys-timeout": "no keys came from the peer",
  "too-long": "it is too long",
  "no-budget": "the network is not connected yet, so it could not be sized",
  "key-mismatch": "the peer answered with another key",
  "nack-from-another-nick": "another nick refused it",
  "unpinned-key": "it was for a device the peer's key does not vouch for",
  repinned: "the peer was pinned to another key",
  "resend-failed": "it could not be sent again",
  "rekey-throttled": "a new session was started too recently",
  unreadable: "none of the peer's devices can read it",
  "rate-limited": "grappa's queue for this peer is full",
  "too-large": "it is too large",
  // `too-late` and `late` only happen to a payload with a deadline, and only
  // an ACK carries one; an ACK has no row. Kept so the map stays total over
  // the reasons the door and the drop push can name.
  "too-late": "its deadline had passed",
  "unknown-device": "this device is no longer part of your encryption identity",
  refused: "grappa refused it",
  late: "its deadline passed before it could go",
  "send-failed": "the connection failed while sending it",
  "session-ended": "the connection to the network ended before it went",
};

// `pinned` is the master the chat's nick is pinned to. An `in` row carries the
// master whose device wrote it, which is not always that one: a message can
// land in a nick's chat written under ANOTHER master (one kept from before the
// nick was pinned to a new one). Such a row is marked, the key in its title.
const EncryptedRow: Component<{ row: Message; pinned: string | undefined }> = (props) => (
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
              <span
                class="e2e-row-alarm"
                data-testid="e2e-row-other-key"
                role="img"
                aria-label={`written with another key: ${row().ed25519}`}
                title={`written with another key: ${row().ed25519}`}
              >
                ⚠
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
    </Switch>
  </li>
);

const REPLACE_CONFIRM =
  "start a new identity anyway: every other device of this account loses this identity " +
  "for this network, every contact sees a key alarm and must verify it again, and nothing " +
  "encrypted to the old identity can be read here";

// grappa holds this account's identity for the network and this browser
// cannot speak for it: another device holds it, or the browser was wiped.
// Pairing this browser with a device that holds it (X1) keeps every
// contact's trust: that device shows a code, which the camera scans into
// `/pair`, or whose link is pasted here and loaded there as a camera scan
// would load it (`loadDocument`: `/pair` reads its code when it mounts). A
// new identity is the other way out, behind a confirmation that says what it
// destroys, and only one at a time: a second would delete the first.
const IdentityElsewhere: Component<{ slug: string }> = (props) => {
  const [code, setCode] = createSignal("");
  const [pairError, setPairError] = createSignal<string | null>(null);
  const [armed, setArmed] = createSignal(false);
  const [replacing, setReplacing] = createSignal(false);
  const [replaceError, setReplaceError] = createSignal<string | null>(null);

  const pair = (event: SubmitEvent) => {
    event.preventDefault();
    const text = code().trim();
    // The whole link, or the fragment that carries the code.
    const found = parsePairFragment(text.includes("#") ? text.slice(text.indexOf("#")) : text);
    if (found === null) {
      setPairError("that is not a pairing link: paste the whole link the other device shows");
      return;
    }
    setPairError(null);
    loadDocument(pairingUrl(window.location.origin, found));
  };

  const replace = async () => {
    setArmed(false);
    setReplacing(true);
    setReplaceError(null);
    try {
      await replaceEncryptedIdentity(props.slug);
    } catch (err) {
      console.warn(`[e2e] could not start a new identity on ${props.slug}`, err);
      setReplaceError(
        err instanceof ApiError
          ? friendlyApiError(err)
          : `could not start a new identity: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setReplacing(false);
    }
  };

  return (
    <>
      <p class="e2e-error" data-testid="e2e-identity-elsewhere">
        this account's encryption identity for this network lives on another device, or was lost. To
        use it here, pair this browser with a device that holds it.
      </p>
      <p class="muted">
        on a device that holds it, open "add a device" and scan the code it shows with this device's
        camera, or paste its link here:
      </p>
      <form class="e2e-pin" onSubmit={pair}>
        <input
          type="text"
          class="e2e-pin-input"
          data-testid="e2e-identity-pair-code"
          placeholder="pairing link"
          autocomplete="off"
          spellcheck={false}
          value={code()}
          onInput={(event) => setCode(event.currentTarget.value)}
        />
        <button type="submit" class="e2e-pin-submit" data-testid="e2e-identity-pair-submit">
          pair
        </button>
      </form>
      <Show when={pairError()}>
        {(message) => (
          <div class="e2e-error" data-testid="e2e-identity-pair-error">
            {message()}
          </div>
        )}
      </Show>
      <div class="e2e-step-actions">
        <InlineConfirmButton
          idleLabel="start a new identity here"
          confirmLabel={REPLACE_CONFIRM}
          armed={armed()}
          onArm={() => setArmed(true)}
          onConfirm={replace}
          testId="e2e-identity-replace"
          disabled={replacing()}
        />
      </div>
      <Show when={replaceError()}>
        {(message) => (
          <div class="e2e-error" data-testid="e2e-identity-replace-error">
            {message()}
          </div>
        )}
      </Show>
    </>
  );
};

/**
 * The one step the key exchange still needs, or null once it is done: the
 * three above, or, once it is done, a message the peer could not read
 * (`unreadableStep`, issue 2491), which leaves the compose line usable.
 */
type Step = "elsewhere" | "alarm" | "no-key" | UnreadableStep;

// What the dialog shows for a SAS, from the window's view of it.
type SasPhase = "waiting" | "asked" | "exchanging" | "compare" | "elsewhere" | "confirmed";

function sasPhase(view: SasView): SasPhase {
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

// The emoji comparison with the peer, while one runs: where it stands and
// what the user can do about it, modal-like over the chat body (vjt: no
// message goes until it is over). A bot never answers a request (irc-olm
// drops SAS), so the wait says what to do instead.
//
// Modal over the BODY only: the top bar and the rail stay usable (the wait
// sends the user to the rail's pin form), so it is no `aria-modal` dialog,
// which would tell assistive tech the rail is out of reach. It takes the
// focus when it opens, which the compose line it makes inert would drop.
const SasDialog: Component<{
  view: SasView;
  peer: string;
  onStep: (step: SasStep) => void;
  onOpen: (() => void) | null;
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
  const phase = () => sasPhase(props.view);
  let dialog: HTMLDivElement | undefined;
  onMount(() => {
    dialog?.focus();
    props.onOpen?.();
  });
  return (
    <div
      ref={dialog}
      class="e2e-sas-modal"
      role="dialog"
      tabindex="-1"
      aria-labelledby="e2e-sas-title"
      data-testid="e2e-sas"
      data-phase={phase()}
    >
      <div class="e2e-sas">
        <h3 class="e2e-sas-title" id="e2e-sas-title">
          compare emoji with {props.peer}
        </h3>
        <Switch>
          <Match when={phase() === "waiting"}>
            <p>
              waiting for {props.peer} to accept the emoji comparison. A bot never answers: pin the
              key it prints instead.
            </p>
            <div class="e2e-step-actions">{button("cancel", "cancel")}</div>
          </Match>
          <Match when={phase() === "asked"}>
            <p>{props.peer} asks to compare emoji with you.</p>
            <div class="e2e-step-actions">
              {button("accept", "accept")}
              {button("cancel", "decline")}
            </div>
          </Match>
          <Match when={phase() === "exchanging"}>
            <p>exchanging keys with {props.peer}…</p>
            <div class="e2e-step-actions">{button("cancel", "cancel")}</div>
          </Match>
          <Match when={phase() === "elsewhere"}>
            <p>the emoji comparison is open in another tab.</p>
            <div class="e2e-step-actions">{button("cancel", "cancel")}</div>
          </Match>
          <Match when={phase() === "confirmed"}>
            <p>waiting for {props.peer} to confirm the emoji…</p>
            <div class="e2e-step-actions">{button("cancel", "cancel")}</div>
          </Match>
          <Match when={phase() === "compare"}>
            <p>
              does {props.peer} see these emoji, in this order? Compare them out of band (voice, in
              person).
            </p>
            <ol class="e2e-sas-emoji-list">
              <For each={props.view.emoji ?? []}>
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
            <div class="e2e-step-actions">
              {button("match", "they match")}
              {button("mismatch", "they don't match")}
            </div>
          </Match>
        </Switch>
      </div>
    </div>
  );
};

/** The check's moment, compact: the time today, the date and time before. */
function checkWhen(at: number): string {
  const day = new Date(at);
  return day.toDateString() === new Date().toDateString()
    ? formatTimestamp(at)
    : formatDateTime(at);
}

/** The last identity check, as the top bar's compact signal; the rail says it in full. */
const CheckChip: Component<{ check: IdentityCheck; slug: string }> = (props) => {
  const look = () => checkLook(props.check);
  const detail = () =>
    `last identity check: ${CHECK_LOOK[look()].label}, ` +
    `${formatDateTime(props.check.at)}, ${checkPlace(props.check, props.slug)}` +
    (props.check.reason === null ? "" : ` (${CHECK_REASON[props.check.reason]})`);
  return (
    <span
      class={`e2e-check-chip e2e-check-${look()}`}
      data-testid="e2e-check-chip"
      data-passed={props.check.passed ? "true" : "false"}
      title={detail()}
      aria-label={detail()}
      role="img"
    >
      {CHECK_LOOK[look()].glyph} id check {checkWhen(props.check.at)}
    </span>
  );
};

const EncryptedChatPane: Component<Props> = (props) => {
  const [draft, setDraft] = createSignal("");
  const [searching, setSearching] = createSignal(false);
  const [query, setQuery] = createSignal("");
  let list: HTMLOListElement | undefined;
  let searchInput: HTMLInputElement | undefined;

  const display = () => encryptedChat(props.networkSlug, props.nick)?.nick ?? props.nick;
  const loaded = () => encryptedRows(props.networkSlug, props.nick) !== undefined;
  const rows = () => encryptedRows(props.networkSlug, props.nick) ?? [];
  const peerTrust = () => encryptedTrust(props.networkSlug, props.nick);
  const trust = () => trustOf(rows(), peerTrust());
  const alarm = () => openAlarm(rows());
  const elsewhere = () => identityElsewhere(props.networkSlug);
  const sas = () => encryptedSas(props.networkSlug, props.nick);
  const check = () => encryptedChat(props.networkSlug, props.nick)?.check;

  // The step still needed, read once the chat is loaded (before, a pinned
  // peer would flash as one with no key).
  const step = (): Step | null => {
    if (elsewhere()) return "elsewhere";
    if (!loaded()) return null;
    if (alarm() !== null) return "alarm";
    if (peerTrust() === null) return "no-key";
    return unreadableStep(rows());
  };

  // While searching, only the messages that hold what was typed, in any case.
  const needle = () => (searching() ? query().trim().toLowerCase() : "");
  const messages = createMemo(() => rows().filter(isMessage));
  const shown = createMemo(() => {
    const n = needle();
    if (n === "") return messages();
    return messages().filter(
      (row) => row.kind !== "undecryptable" && row.body.toLowerCase().includes(n),
    );
  });
  const messageCount = () => messages().filter((row) => row.kind !== "undecryptable").length;

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
    if (body.trim() === "" || elsewhere() || sas() !== null) return;
    setDraft("");
    void sendEncrypted(props.networkSlug, props.nick, body).catch((err: unknown) => {
      console.warn(`[e2e] could not send to ${props.nick}`, err);
    });
  };

  // The user's choice, never the engine's (issue 2491): the nick may be
  // someone else's now, and their key then comes as the alarm.
  const rekey = () => {
    void rekeyEncrypted(props.networkSlug, props.nick).catch((err: unknown) => {
      console.warn(`[e2e] could not ask ${props.nick} for their keys again`, err);
    });
  };

  const sasStep = (s: SasStep) => {
    void verifyEncrypted(props.networkSlug, props.nick, s).catch((err: unknown) => {
      console.warn(`[e2e] could not ${s} the emoji comparison with ${props.nick}`, err);
    });
  };

  const toggleSearch = () => {
    const open = !searching();
    setSearching(open);
    if (!open) setQuery("");
    else queueMicrotask(() => searchInput?.focus());
  };

  // The window goes with the chat: the close-watcher moves focus, as after a close.
  const shred = () =>
    requestConfirm({
      title: "Delete encrypted chat",
      body:
        `Delete the messages with ${display()} on this device? ` +
        `Deleted messages cannot be brought back: grappa never had them. ` +
        `The key ${display()} is pinned to stays.`,
      confirmLabel: "Delete",
      onConfirm: () => {
        void deleteEncryptedChat(props.networkSlug, props.nick).catch((err: unknown) => {
          console.warn(`[e2e] could not delete the encrypted chat with ${props.nick}`, err);
        });
      },
      alternative: null,
      attachments: null,
      choice: null,
      toggle: null,
      defaultButton: "cancel",
    });

  return (
    <div class="e2e-pane" data-testid="e2e-pane">
      <header class="e2e-header">
        <div class="e2e-header-main">
          {props.windowsOpener}
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
          <Show when={check()}>{(c) => <CheckChip check={c()} slug={props.networkSlug} />}</Show>
          <span class="e2e-header-tools">
            <button
              type="button"
              class="shell-chrome-btn e2e-tool"
              classList={{ active: searching() }}
              data-testid="e2e-search-toggle"
              aria-label={`search the chat with ${display()}`}
              aria-pressed={searching()}
              title="search this chat"
              onClick={toggleSearch}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <circle cx="11" cy="11" r="7" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
            </button>
            <button
              type="button"
              class="shell-chrome-btn e2e-tool"
              data-testid="e2e-delete-chat"
              aria-label={`delete the chat with ${display()}`}
              title="delete this chat"
              disabled={elsewhere()}
              onClick={shred}
            >
              {/* A shredder: the sheet going in, the strips coming out. */}
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="M7 10V3h10v7" />
                <rect x="3" y="10" width="18" height="5" rx="1" />
                <line x1="7" y1="15" x2="7" y2="21" />
                <line x1="10.5" y1="15" x2="10.5" y2="21" />
                <line x1="13.5" y1="15" x2="13.5" y2="21" />
                <line x1="17" y1="15" x2="17" y2="21" />
              </svg>
            </button>
          </span>
          {props.railOpener}
        </div>
        <Show when={searching()}>
          <div class="e2e-search">
            <input
              ref={searchInput}
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
                toggleSearch();
              }}
            />
            <Show when={needle() !== ""}>
              <span
                class="e2e-search-count muted"
                data-testid="e2e-search-count"
                aria-live="polite"
              >
                {shown().length} of {messageCount()} messages
              </span>
            </Show>
          </div>
        </Show>
      </header>
      <div class="e2e-body">
        <div class="e2e-body-content" inert={sas() !== null}>
          <ol class="e2e-rows" ref={list}>
            <For each={shown()}>
              {(row) => <EncryptedRow row={row} pinned={peerTrust()?.master} />}
            </For>
          </ol>
          <Show when={step()}>
            {(s) => (
              <section class="e2e-step" data-testid="e2e-step" data-step={s()}>
                <Switch>
                  <Match when={s() === "elsewhere"}>
                    <IdentityElsewhere slug={props.networkSlug} />
                  </Match>
                  <Match when={s() === "alarm" && alarm()}>
                    {(key) => (
                      <>
                        <p class="e2e-error">
                          {display()} wrote with a key that is not the one pinned, and it was
                          ignored. If they changed it, take the new key and compare emoji to verify
                          it; otherwise pin the key they give you.
                        </p>
                        <div class="e2e-step-actions">
                          <button
                            type="button"
                            class="e2e-sas-button"
                            data-testid="e2e-alarm-accept"
                            onClick={() => acceptAlarmKey(props.networkSlug, props.nick, key())}
                          >
                            take the new key (not verified)
                          </button>
                        </div>
                        <PinForm
                          networkSlug={props.networkSlug}
                          nick={props.nick}
                          display={display()}
                          testId="e2e-alarm-pin"
                        />
                      </>
                    )}
                  </Match>
                  <Match when={s() === "no-key"}>
                    <p>
                      no keys exchanged with {display()} yet. Send a message: a person's key is
                      taken when they answer. A bot answers only once its key is pinned here, and
                      yours there: paste the key it prints, and give its operator yours.
                    </p>
                    <PinForm
                      networkSlug={props.networkSlug}
                      nick={props.nick}
                      display={display()}
                      testId="e2e-step-pin"
                    />
                    <div class="e2e-step-actions">
                      <CopyOwnKey networkSlug={props.networkSlug} testId="e2e-step-copy" />
                    </div>
                  </Match>
                  <Match when={s() === "unreadable"}>
                    <p class="e2e-error">
                      {display()} could not read your last message: none of the devices it was
                      encrypted to is theirs any more. They may have moved to another server or
                      started a new encryption identity, or someone else may be using the nick. Ask
                      for their keys again to start a new key exchange: if their key changed, you
                      will be asked to check it.
                    </p>
                    <div class="e2e-step-actions">
                      <button
                        type="button"
                        class="e2e-sas-button"
                        data-testid="e2e-rekey"
                        onClick={rekey}
                      >
                        ask for their keys again
                      </button>
                    </div>
                  </Match>
                  <Match when={s() === "rekey-asked"}>
                    <p>waiting for {display()}'s keys…</p>
                  </Match>
                  <Match when={s() === "rekey-unanswered"}>
                    <p>
                      {display()} sent no keys: they may have no encryption identity where they are
                      now, or they are not on IRC. You can ask again later.
                    </p>
                    <div class="e2e-step-actions">
                      <button
                        type="button"
                        class="e2e-sas-button"
                        data-testid="e2e-rekey"
                        onClick={rekey}
                      >
                        ask again
                      </button>
                    </div>
                  </Match>
                </Switch>
              </section>
            )}
          </Show>
          <form class="e2e-compose" data-testid="e2e-compose" onSubmit={send}>
            <input
              type="text"
              class="e2e-compose-input"
              data-testid="e2e-compose-input"
              placeholder={`encrypted message to ${display()}`}
              autocomplete="off"
              disabled={elsewhere()}
              value={draft()}
              onInput={(event) => setDraft(event.currentTarget.value)}
            />
            <button
              type="submit"
              class="e2e-compose-send"
              data-testid="e2e-compose-send"
              disabled={elsewhere()}
            >
              send
            </button>
          </form>
        </div>
        <Show when={sas()}>
          {(view) => (
            <SasDialog
              view={view()}
              peer={display()}
              onStep={sasStep}
              onOpen={props.onDialogOpen}
            />
          )}
        </Show>
      </div>
    </div>
  );
};

export default EncryptedChatPane;
