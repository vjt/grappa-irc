import {
  type Component,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  type JSX,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js";
import ComposeBox from "./ComposeBox";
import {
  acceptAlarmKey,
  CHECK_LOOK,
  CHECK_REASON,
  checkLook,
  checkPlace,
  TRUST_LABEL,
  VerifyKeyButton,
} from "./EncryptedRail";
import InlineConfirmButton from "./InlineConfirmButton";
import type { ScrollbackMessage } from "./lib/api";
import { ApiError } from "./lib/apiError";
import { channelKey } from "./lib/channelKey";
import { requestConfirm } from "./lib/confirmDialog";
import { isCtcpAction, stripCtcpAction } from "./lib/ctcpAction";
import { formatDateTime } from "./lib/dateFormat";
import { isDocumentVisible } from "./lib/documentVisibility";
import { formatDurationSince } from "./lib/duration";
import {
  countsAsUnread,
  type IdentityCheck,
  isMessage,
  type Message,
  type OutFailure,
} from "./lib/e2e/chatStore";
import type { ElsewhereReason, HeldDevices } from "./lib/e2e/identity";
import type { SasStep, SasView } from "./lib/e2e/sas";
import { SAS_EMOJI } from "./lib/e2e/sasEmoji";
import { encryptedArriving } from "./lib/encryptedArriving";
import {
  deleteEncryptedChat,
  elsewhereReason,
  encryptedChat,
  encryptedRows,
  encryptedSas,
  encryptedSendSubmitted,
  encryptedTrust,
  encryptedWireView,
  identityDevices,
  identityElsewhere,
  lastEncryptedSend,
  loadEncryptedChat,
  openAlarm,
  readEncryptedChat,
  rekeyEncrypted,
  replaceEncryptedIdentity,
  trustOf,
  type UnreadableStep,
  unreadableStep,
  verifyEncrypted,
} from "./lib/encryptedChats";
import { friendlyApiError } from "./lib/friendlyApiError";
import { createOverlayLock } from "./lib/overlayScrollLock";
import type { ArrivingLine, ScrollbackSource } from "./lib/scrollbackSource";
import { formatTimestamp } from "./lib/timeFormat";
import { encryptedWindowName } from "./lib/windowKinds";
import NickText from "./NickText";
import ScrollbackPane from "./ScrollbackPane";

// issue 2430 — the encrypted query window (kind "encrypted"): the rows of the
// device's chat with one peer, and a compose line that sends only through Olm.
//
// issue 2512 (vjt: reuse, do not reimplement) — the body is ScrollbackPane +
// ComposeBox, the pair every chat window has, so the scroll, where the window
// opens, the unread marker, the floating buttons and the compose box's text
// area (it wraps, it keeps a history) are theirs and nothing here copies them.
// What is this window's own rides their seams. The pane draws the chat
// through a `ScrollbackSource` (lib/scrollbackSource.ts) built below: the
// messages numbered in the order this window first saw them, the read state
// from the chat's unread count, and no server history to page in, since the
// device holds every line. The compose box, in an encrypted window, sends what
// is said (text, and `/me` as an ACTION) through Olm as one message and runs
// any other command as the plain query would, in clear (issue 2536), never
// mirrors the draft to storage, and keeps its history in this tab's memory
// only, dropped with the chat (lib/compose.ts). Each line renders through the
// scrollback's renderer (issue 2498, vjt's ruling: one renderer), with the
// lock and the delivery state in its two slots.
//
// issue 2485 (vjt's rulings, DESIGN_NOTES #2485) split the window three ways:
//   * the TOP BAR is the peer's verification only: verified or not (or the
//     key changed), the last identity check a bot made, compact, and two
//     buttons for the chat itself, a magnifier (search) and a shredder
//     (delete this chat). Issue 2544 (vjt's ruling, replacing 2507's emoji
//     door): a tap on the badge shows the peer's whole key, with the verify
//     button and the emoji comparison beside it while it is not verified;
//   * the CHAT BODY holds messages, and while the key exchange is not done,
//     the one step still needed, as a card: an identity held on another
//     device (pair this browser, or start a new identity), a key alarm (take
//     the new key), or no key yet (send). The exchange is done once the nick
//     has a pinned key and no alarm is open, verified or not: verification is
//     the top bar's state. A message none of the peer's devices could read
//     leaves a card too (issue 2491): asking for their keys again is the
//     user's choice, never made for them, and the compose line stays usable
//     meanwhile. The emoji comparison runs here too, modal-like over the
//     body, and nothing can be sent until it ends; so does the badge's key.
//     Issue 2507 (vjt's ruling): no card holds a key to copy; they say in
//     words that ours, for a bot's operator, is the rail's;
//   * everything technical (keys, devices, pins, the check in full) is the
//     right rail's (`EncryptedRail`). The key events the chat used to list as
//     rows (pinned, taken, compared, alarmed) stay in the store, where the
//     badge reads them, and show only as the rail's state.
//
// A key is verified by comparing it out of band and pressing verify (issue
// 2544, which retired 2430's pasted pin): a bot prints its master key, a
// person reads theirs out, and our own master is copied for a bot's operator.
// People can also compare emoji (SAS, `lib/e2e/sas.ts`) while both are
// online; a key the alarm showed can be taken unverified, to be verified
// either way (fork 7, 2430 comment 6339695571). A key here is always a
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
//
// issue 2513 — the window can show what the server and the network see
// instead: each message as the payloads it crossed IRC as (`ciphertextOf`),
// on the line it holds in the plaintext view, so the unread marker and the
// delivery state stay on it (the lines are longer: the scroll may move). The
// doors are the window's row in the sidebar (`EncryptedChatMenu`) and, since
// issue 2583, the `ciphertext` entry of the right rail's actions menu
// (`RailActions`), never the top bar; the compose box stays, so a line typed
// there shows up as the ciphertext it went as, and the search looks in what is
// shown.

type Props = {
  networkSlug: string;
  nick: string;
  /**
   * Our nick on the network, as any query's lines name us (issue 2498): the
   * sender of every outgoing line. `null` while `/me` or the network is
   * unknown, and then no line is drawn: an outgoing one would name nobody.
   */
  ownNick: string | null;
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
   * Called each time a dialog over the body opens (the emoji comparison's,
   * the badge's key), or `null`. Mobile passes the drawer's close: the rail
   * is a drawer OVER the pane there, and the dialog opens behind it. Desktop
   * passes `null`: its rail is beside.
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
  "no-such-nick": "there is no such nick on the network",
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

/** What a message reads in the ciphertext view when this device kept none of it (issue 2513). */
export const NO_CIPHERTEXT = "(no ciphertext on this device)";
/** What one of ours not sent reads there: none anywhere, and the line's state says why. */
export const UNSENT = "(no ciphertext)";

// issue 2513 — a message as the ciphertext view writes it: each payload it
// crossed IRC as on a line of its own, the verb and msgid its `E2E` lines
// carried, then the compact JSON grappa cut into them. One line per payload
// and not one per IRC line: the cut is the sending grappa's, sized to its
// relay budget, and the peer's is unknown here, so the lines would be
// invented; the payload is what they carried, whole.
function ciphertextOf(row: Message): string {
  const wire = row.wire ?? [];
  if (wire.length > 0) {
    return wire.map((p) => `E2E ${p.verb.toUpperCase()} ${p.msgid} ${p.payload}`).join("\n");
  }
  return row.kind === "out" && row.state !== "sent" ? UNSENT : NO_CIPHERTEXT;
}

// issue 2498 — a message as the scrollback's line. Ours is named by our nick,
// the peer's by theirs, as in any query. A message that cannot be read here is
// the line the scrollback draws for a peer's messages that cannot be read
// (issue 2430's `e2e_undeliverable`), one of them: the same words, one place.
// issue 2512 — `id` is the line's number in the window (`seq`), not the row's
// own id, which is a string: the pane orders, marks and reads lines by id.
// issue 2513 — in the ciphertext view the body is the payloads instead, on the
// same line; a message that could not be read is then its sender's line too.
// issue 2536 — a `/me` rides inside the message as a CTCP ACTION
// (lib/compose.ts), so a body in that envelope is the scrollback's action
// line, which unwraps it, ours or the peer's. Not in the ciphertext view:
// there the line is the payloads it crossed IRC as, and they are no action.
function lineOf(
  row: Message,
  seq: number,
  slug: string,
  windowName: string,
  ownNick: string,
  ciphertext: boolean,
): ScrollbackMessage {
  const line = { id: seq, network: slug, channel: windowName, server_time: row.at, meta: {} };
  const body = (plaintext: string) => (ciphertext ? ciphertextOf(row) : plaintext);
  switch (row.kind) {
    case "in":
    case "out": {
      const kind = !ciphertext && isCtcpAction(row.body) ? "action" : "privmsg";
      const sender = row.kind === "in" ? row.nick : ownNick;
      return { ...line, kind, sender, body: body(row.body) };
    }
    case "undecryptable":
      if (ciphertext) {
        return { ...line, kind: "privmsg", sender: row.nick, body: ciphertextOf(row) };
      }
      return {
        ...line,
        kind: "server_event",
        sender: row.nick,
        body: null,
        meta: { e2e_undeliverable: 1 },
      };
  }
}

/** The line's mark beside the time: every message here went encrypted. */
const Lock: Component = () => (
  <>
    <span class="encrypted-marker" aria-hidden="true">
      🔒
    </span>{" "}
  </>
);

// What the line says after the body: where an outgoing message is, or that an
// incoming one was written with another key. `pinned` is the master the
// chat's nick is pinned to. An `in` row carries the master whose device wrote
// it, which is not always that one: a message can land in a nick's chat
// written under ANOTHER master (one kept from before the nick was pinned to a
// new one). Such a row is marked, the key in its title.
const Trailer: Component<{ row: Message | undefined; pinned: string | undefined }> = (props) => (
  <Switch>
    <Match when={props.row?.kind === "in" && props.row}>
      {(row) => (
        <Show when={props.pinned !== undefined && row().ed25519 !== props.pinned}>
          {" "}
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
      )}
    </Match>
    <Match when={props.row?.kind === "out" && props.row}>
      {(row) => (
        <>
          {" "}
          <span class="muted" data-testid="e2e-row-state" data-state={row().state}>
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
  </Switch>
);

const REPLACE_CONFIRM =
  "start a new identity anyway: every other device of this account loses this identity " +
  "for this network, every contact sees a key alarm and must verify it again, and nothing " +
  "encrypted to the old identity can be read here";

// issue 2547 — what the card says first: why this browser cannot speak for
// the identity grappa holds, one sentence per reason the sync found.
export const ELSEWHERE_WHY: Record<ElsewhereReason, string> = {
  "no-keys": "this browser holds no keys for this account's encryption identity on this network.",
  replaced:
    "this account's encryption identity on this network was replaced on another device: the " +
    "keys this browser holds belong to the old one.",
  "left-out":
    "this browser is no longer one of the devices of this account's encryption identity on " +
    "this network.",
  "no-list":
    "grappa no longer holds the list of this identity's devices, and only the device that made " +
    "the identity can list them again.",
};

/**
 * issue 2547 — the card's line on what grappa holds of the identity: how
 * many devices its list names, and how long ago one of them was last active
 * (read its inbox) as of `nowMs`. No activity clause when none says.
 */
export function heldDevicesLine(held: HeldDevices, nowMs: number): string {
  if (held.listed === 0) return "grappa lists none of your devices";
  const count = `grappa lists ${held.listed} of your devices`;
  const ago = formatDurationSince(held.lastActive, nowMs);
  if (ago === null) return count;
  return held.listed === 1 ? `${count}, active ${ago} ago` : `${count}, one active ${ago} ago`;
}

// grappa holds this account's identity for the network and this browser
// cannot speak for it: another device holds it, or the browser was wiped.
// The card says which (issue 2547), and what grappa holds: a device of the
// identity active minutes ago means the keys live on, somewhere this browser
// is not, and the way in is pairing. Pairing this browser with a device that
// holds it (X1) keeps every contact's trust: that device opens "add a
// device", and this browser is offered the pairing in a banner (issue 2537)
// — the only way in since issue 2549 took the link and its paste field away.
// A new identity is the other way out, folded away under "none of your
// devices can pair this browser" and behind a confirmation that says what it
// destroys, and only one at a time: a second would delete the first.
const IdentityElsewhere: Component<{ slug: string; reason: ElsewhereReason }> = (props) => {
  const [armed, setArmed] = createSignal(false);
  const [replacing, setReplacing] = createSignal(false);
  const [replaceError, setReplaceError] = createSignal<string | null>(null);
  // A failed read leaves the line out: the card's way out does not need it.
  const [held] = createResource(
    () => props.slug,
    (slug) =>
      identityDevices(slug).catch((err: unknown) => {
        console.warn(`[e2e] could not read the devices grappa holds on ${slug}`, err);
        return null;
      }),
  );

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
      <p class="e2e-error" data-testid="e2e-identity-elsewhere" data-reason={props.reason}>
        {ELSEWHERE_WHY[props.reason]}
      </p>
      <Show when={held()}>
        {(h) => (
          <p class="muted" data-testid="e2e-identity-devices">
            {heldDevicesLine(h(), Date.now())}
          </p>
        )}
      </Show>
      <p data-testid="e2e-identity-pair-how">
        to use it here, pair this browser with a device that holds it: on that device, open "add a
        device", and a banner then offers the pairing here; "Pair this browser" takes it.
      </p>
      <details class="e2e-other-way">
        <summary data-testid="e2e-identity-other-way">
          none of your devices can pair this browser
        </summary>
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
      </details>
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
// sends the user to verify a bot's key by hand), so it is no `aria-modal`
// dialog, which would tell assistive tech the rail is out of reach. It takes
// the focus when it opens, which the compose line it makes inert would drop.
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
              waiting for {props.peer} to accept the emoji comparison. A bot never answers: compare
              the key it prints with theirs here, and verify it instead.
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

// issue 2544 (vjt's ruling) — what a tap on the top bar's badge shows: the
// key the peer's nick is pinned to, whole, all 43 characters, to compare with
// the peer out of band. It is the full Ed25519 key, 256 bits, and needs no
// protocol around it. The emoji are a summary of about 42 bits, safe only
// inside the synchronous comparison, where the commitment leaves an attacker
// one try; shown on their own, a key of the attacker's that gives the same
// emoji could be searched for. So a verified key shows the key alone, and one
// not verified adds the rail's verify button and, second, the emoji
// comparison, for when both sides are online.
//
// Over the body like the comparison's dialog, and for the same reason no
// `aria-modal`: the top bar and the rail stay usable. "close" or Esc ends it:
// it covers the scrollback, so it is a covering overlay (`createOverlayLock`
// in the pane), and Esc reaches it through the shared stack.
const KeyDialog: Component<{
  networkSlug: string;
  nick: string;
  peer: string;
  peerKey: string;
  verified: boolean;
  onCompare: () => void;
  onClose: () => void;
  onOpen: (() => void) | null;
}> = (props) => {
  let dialog: HTMLDivElement | undefined;
  onMount(() => {
    dialog?.focus();
    props.onOpen?.();
  });
  // A verify closes the dialog it was asked from, and no other: its pin may
  // answer once this one is closed, and another opened since.
  let open = true;
  onCleanup(() => {
    open = false;
  });
  const verified = () => {
    if (open) props.onClose();
  };
  return (
    <div
      ref={dialog}
      class="e2e-sas-modal e2e-key-modal"
      role="dialog"
      tabindex="-1"
      aria-labelledby="e2e-key-title"
      data-testid="e2e-key-dialog"
    >
      <div class="e2e-sas">
        <h3 class="e2e-sas-title" id="e2e-key-title">
          {props.peer}'s key
        </h3>
        <code class="e2e-key" data-testid="e2e-key-dialog-key">
          {props.peerKey}
        </code>
        <Show
          when={!props.verified}
          fallback={<p>verified: this is the key {props.peer}'s messages are encrypted to.</p>}
        >
          <p>
            compare it with the key {props.peer} gives you out of band (in person, by voice, or what
            a bot prints): if it is the same, verify it. Or compare emoji, while {props.peer} is
            online too.
          </p>
        </Show>
        <div class="e2e-step-actions">
          <Show when={!props.verified}>
            <VerifyKeyButton
              networkSlug={props.networkSlug}
              nick={props.nick}
              peerKey={props.peerKey}
              testId="e2e-key-verify"
              onVerified={verified}
            />
            <button
              type="button"
              class="e2e-sas-button"
              data-testid="e2e-key-compare"
              onClick={props.onCompare}
            >
              compare emoji
            </button>
          </Show>
          <button
            type="button"
            class="e2e-sas-button"
            data-testid="e2e-key-close"
            onClick={props.onClose}
          >
            close
          </button>
        </div>
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
  const [searching, setSearching] = createSignal(false);
  const [query, setQuery] = createSignal("");
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
  const windowName = () => encryptedWindowName(props.nick);
  const windowKey = () => channelKey(props.networkSlug, windowName());
  // issue 2544 — the badge shows the pinned key (`KeyDialog`) while no alarm
  // is open (the card answers that), no comparison runs (its dialog holds the
  // body), and the identity is here. Once that stops holding, an open key
  // dialog closes with it: a comparison the peer asks for takes its place.
  const [showingKey, setShowingKey] = createSignal(false);
  let keyDoor: HTMLButtonElement | undefined;
  const canShowKey = () =>
    !elsewhere() && peerTrust() !== null && alarm() === null && sas() === null;
  createEffect(() => {
    if (!canShowKey()) setShowingKey(false);
  });
  const closeKey = () => {
    setShowingKey(false);
    keyDoor?.focus();
  };
  createOverlayLock(showingKey, ".e2e-key-modal", closeKey);

  // The step still needed, read once the chat is loaded (before, a pinned
  // peer would flash as one with no key).
  const step = (): Step | null => {
    if (elsewhere()) return "elsewhere";
    if (!loaded()) return null;
    if (alarm() !== null) return "alarm";
    if (peerTrust() === null) return "no-key";
    return unreadableStep(rows());
  };

  // issue 2512 — the window's lines, numbered in the order the window first
  // sees them. The rows only grow at their end (a deleted chat starts over,
  // past every number already given), so the numbers keep the chat's order.
  // Undefined until the chat is loaded and our nick is known: an outgoing
  // line would name nobody.
  const seqById = new Map<string, number>();
  const seqOf = (id: string): number => {
    let seq = seqById.get(id);
    if (seq === undefined) {
      seq = seqById.size + 1;
      seqById.set(id, seq);
    }
    return seq;
  };
  const lines = createMemo(() => {
    const own = props.ownNick;
    if (own === null || !loaded()) return undefined;
    const ciphertext = encryptedWireView(props.networkSlug, props.nick);
    return rows()
      .filter(isMessage)
      .map((row) => ({
        row,
        msg: lineOf(row, seqOf(row.id), props.networkSlug, windowName(), own, ciphertext),
      }));
  });
  const rowBySeq = createMemo(
    () => new Map((lines() ?? []).map((line) => [line.msg.id, line.row])),
  );

  // While searching, only the messages that hold what was typed, in any case.
  // issue 2513 — what they hold as shown: in the ciphertext view the payloads,
  // where a message that cannot be read is a message too, never the plaintext.
  // issue 2536 — and what a line says: an action is a message, and its
  // envelope is framing, not text.
  const needle = () => (searching() ? query().trim().toLowerCase() : "");
  const searchable = () =>
    (lines() ?? []).filter(({ msg }) => msg.kind === "privmsg" || msg.kind === "action");
  const shown = createMemo(() => {
    const all = lines();
    const n = needle();
    if (all === undefined || n === "") return all;
    return searchable().filter(({ msg }) => stripCtcpAction(msg.body).toLowerCase().includes(n));
  });
  const shownMessages = createMemo(() => shown()?.map((line) => line.msg));

  // The chat counts what is unread rather than keeping a cursor: the cursor
  // is the last line before the last `unread` rows that count. A key event
  // that counts (an alarm, the peer asking to compare emoji) is no line and
  // marks none. Every line unread is 0, before the first.
  const readCursor = (): number | null => {
    if (lines() === undefined) return null;
    const all = rows();
    const unread = encryptedChat(props.networkSlug, props.nick)?.unread ?? 0;
    let read = all.filter(countsAsUnread).length - unread;
    let cursor = 0;
    for (const row of all) {
      if (countsAsUnread(row)) {
        if (read <= 0) break;
        read -= 1;
      }
      if (isMessage(row)) cursor = seqOf(row.id);
    }
    return cursor;
  };

  // Seen up to line `id`: once that is the last line, the chat is read, as a
  // query is read at its tail.
  const read = (): void => {
    void readEncryptedChat(props.networkSlug, props.nick).catch((err: unknown) => {
      console.warn(`[e2e] could not mark the encrypted chat with ${props.nick} read`, err);
    });
  };
  const markRead = (id: number): void => {
    const last = lines()?.at(-1)?.msg.id;
    if (last === undefined || id < last) return;
    read();
  };

  // issue 2509 — a chat with no line has no last line to see, yet its unread
  // can count a key event (an alarm on its card, the peer asking to compare
  // emoji in its dialog). The window shown with the page visible is what the
  // user reads then: left unread, it would badge for good and be a
  // next-active stop no jump could clear. A chat with lines is read at its
  // tail, above.
  createEffect(() => {
    if (lines()?.length !== 0 || !isDocumentVisible()) return;
    if ((encryptedChat(props.networkSlug, props.nick)?.unread ?? 0) > 0) read();
  });

  // issue 2577 — the peer's messages grappa announced and that have not landed
  // yet (lib/encryptedArriving.ts): drawn after every line, each until its own
  // line takes its place.
  const arriving = createMemo((): ArrivingLine[] =>
    encryptedArriving(props.networkSlug, props.nick).map((a) => ({
      id: `${a.fromDid}-${a.msgid}`,
      nick: a.nick,
      at: a.at,
    })),
  );

  const ours = (slug: string, name: string): boolean => channelKey(slug, name) === windowKey();
  const source: ScrollbackSource = {
    messages: (key) => (key === windowKey() ? shownMessages() : undefined),
    getReadCursor: (slug, name) => (ours(slug, name) ? readCursor() : null),
    setCursorIfAdvances: (slug, name, id) => {
      if (ours(slug, name)) markRead(id);
    },
    ownSendSubmitted: encryptedSendSubmitted,
    lastOwnSend: lastEncryptedSend,
    history: null,
    slots: (msg) => ({
      marker: <Lock />,
      trailer: <Trailer row={rowBySeq().get(msg.id)} pinned={peerTrust()?.master} />,
    }),
    arriving: (key) => (key === windowKey() ? arriving() : []),
  };

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

  const badge = () => (
    <span
      class={`e2e-trust e2e-trust-${trust()}`}
      data-testid="e2e-peer-trust"
      data-trust={trust()}
    >
      {TRUST_LABEL[trust()]}
    </span>
  );
  const keyLabel = () => `${TRUST_LABEL[trust()]}: show ${display()}'s key`;

  const toggleSearch = () => {
    const open = !searching();
    setSearching(open);
    if (!open) setQuery("");
    else queueMicrotask(() => searchInput?.focus());
  };

  // The window goes with the chat: the close-watcher moves focus, as after a
  // close, and the compose store drops what was typed in it (issue 2512).
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
          {/* issue 2511 — two lines, so the bar's buttons keep one row: the
            nick, cut when it is long; under it the badge and the last
            identity check. */}
          <div class="e2e-title">
            <span class="e2e-title-line">
              <span class="encrypted-marker" aria-hidden="true">
                🔒
              </span>
              <NickText nick={display()} extraClass="e2e-heading" />
            </span>
            <span class="e2e-title-line">
              <Show when={canShowKey()} fallback={badge()}>
                <button
                  ref={keyDoor}
                  type="button"
                  class="e2e-trust-door"
                  aria-label={keyLabel()}
                  title={keyLabel()}
                  aria-haspopup="dialog"
                  aria-expanded={showingKey()}
                  onClick={() => setShowingKey(true)}
                >
                  {badge()}
                </button>
              </Show>
              <Show when={check()}>
                {(c) => <CheckChip check={c()} slug={props.networkSlug} />}
              </Show>
            </span>
          </div>
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
                viewBox="3 3 19 19"
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
                viewBox="2 2 20 20"
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
                {shown()?.length ?? 0} of {searchable().length} messages
              </span>
            </Show>
          </div>
        </Show>
      </header>
      <div class="e2e-body">
        <div class="e2e-body-content" inert={sas() !== null || showingKey()}>
          <ScrollbackPane
            networkSlug={props.networkSlug}
            channelName={windowName()}
            kind="encrypted"
            source={source}
          />
          <Show when={step()}>
            {(s) => (
              <section class="e2e-step" data-testid="e2e-step" data-step={s()}>
                <Switch>
                  <Match when={s() === "elsewhere" && elsewhereReason(props.networkSlug)}>
                    {(reason) => <IdentityElsewhere slug={props.networkSlug} reason={reason()} />}
                  </Match>
                  <Match when={s() === "alarm" && alarm()}>
                    {(key) => (
                      <>
                        <p class="e2e-error">
                          {display()} wrote with a key that is not the one pinned, and it was
                          ignored. If they changed it, take the new key and verify it. If they did
                          not, someone else may be writing in their name: delete this chat with the
                          shredder above, and the pinned key stays.
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
                      </>
                    )}
                  </Match>
                  <Match when={s() === "no-key"}>
                    <p>
                      no keys exchanged with {display()} yet. Send a message: their key is taken
                      when they answer. A bot answers only once your key is pinned there: the side
                      panel copies it for its operator. Then compare the key the bot prints with the
                      one its badge shows, and verify it.
                    </p>
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
          {/* Nothing goes while the identity is held elsewhere: the box stays,
              with what was typed in it, out of reach until it is back. */}
          <div class="e2e-compose" data-testid="e2e-compose" inert={elsewhere()}>
            <ComposeBox networkSlug={props.networkSlug} channelName={windowName()} />
          </div>
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
        <Show when={showingKey() ? peerTrust() : null}>
          {(peer) => (
            <KeyDialog
              networkSlug={props.networkSlug}
              nick={props.nick}
              peer={display()}
              peerKey={peer().master}
              verified={peer().verified}
              onCompare={() => {
                setShowingKey(false);
                sasStep("start");
              }}
              onClose={closeKey}
              onOpen={props.onDialogOpen}
            />
          )}
        </Show>
      </div>
    </div>
  );
};

export default EncryptedChatPane;
