import { type Component, createResource, createSignal, Show } from "solid-js";
import AddDevicePanel from "./AddDevicePanel";
import E2eCopyButton from "./E2eCopyButton";
import { isChannelName } from "./lib/chantypes";
import { formatDateTime } from "./lib/dateFormat";
import type { ChatRow, CheckFailure, IdentityCheck } from "./lib/e2e/chatStore";
import type { PinOutcome } from "./lib/e2e/engine";
import { UNCONFIRMED } from "./lib/e2e/orders";
import { holdsMasterHere } from "./lib/e2e/pairingDeps";
import type { SasCancelReason } from "./lib/e2e/sas";
import {
  encryptedChat,
  encryptedRows,
  encryptedTrust,
  identityElsewhere,
  openAlarm,
  ownKey,
  pinEncryptedKey,
  type Trust,
  trustOf,
} from "./lib/encryptedChats";
import { errorMessage } from "./lib/friendlyApiError";
import { chantypesForNetwork } from "./lib/isupport";
import { networkBySlug } from "./lib/networks";

// issue 2485 — the technical half of an encrypted query, in the right rail:
// everything about keys that the chat window and its top bar no longer show
// (vjt: "right rail = everything technical"). Laid out like a settings page,
// one section per subject and a label over each value, the stacked `<dl>`
// every rail card uses (#857):
//   * the peer: the key their nick is pinned to, how far it is trusted, how
//     many of its devices, how the last emoji comparison ended, the last
//     identity check a bot made; and the key actions: verify the key shown,
//     take the key an alarm showed;
//   * this browser's identity: our own key, to copy for a bot's operator, and
//     the door to add a device (only from the browser that holds the master).
//
// What the rail does NOT hold, by vjt's rulings on this issue: the emoji
// comparison itself (it runs in the chat window, modal-like), search and
// "delete this chat" (the top bar's magnifier and shredder), and the two ways
// out of an identity held elsewhere (a card in the chat). While the identity
// is elsewhere, nothing here can act: no key could be pinned or verified.
//
// issue 2507 (vjt's rulings): the comparison starts from a tap on the top
// bar's trust badge, so the rail no longer offers it; and our own key, to
// copy for a bot's operator, lives HERE ONLY. The chat's step cards say what
// to do in words and hold no key to copy.
//
// issue 2544 (vjt's rulings): the key shown is verified with a button beside
// it, for when the user compared it with the peer out of band, a bot's
// printed key included; the form that pinned a pasted key is gone. Either the
// key shown is the peer's, or someone is in the middle and the chat must be
// closed: pasting the "right" key over a different one fixes neither.
//
// Mounted by RailContext, keyed on the window. Issue 2499: it mounts inside
// the query context, as an addition to the query rail and not a replacement
// for it: under the context's heading, which names the conversation (so none
// here), and above the peer's WHOIS card.

type Props = { networkSlug: string; nick: string };

export const TRUST_LABEL: Record<Trust, string> = {
  verified: "verified",
  unverified: "not verified",
  alarm: "key changed",
};

const PIN_REFUSED: Record<Exclude<PinOutcome, "pinned">, string> = {
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

/**
 * How the last emoji comparison of the key now pinned ended, from the rows
 * that record it; null when none did. A key chosen since (pinned, or taken
 * off an alarm) ends the search: what came before was about the old one.
 */
export function lastComparison(rows: readonly ChatRow[]): string | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row?.kind === "pinned" || row?.kind === "accepted") return null;
    if (row?.kind === "verified") return "matched";
    if (row?.kind === "sas_cancelled") {
      const who = row.by === "you" ? "stopped" : "stopped by them";
      return `${who}: ${reasonText(row.reason)}`;
    }
  }
  return null;
}

/** Why a check failed, as the rail says it: the console's words for the send log's verdicts. */
export const CHECK_REASON: Record<CheckFailure, string> = {
  ...UNCONFIRMED,
  unverified: "their key is not verified here",
};

/**
 * How a check reads: passed, failed, or not answered HERE. A bot encrypts its
 * challenge to every device of the account and the send log is the device's
 * (#2430w2c), so a line typed on a sibling device reads `not-sent` here, every
 * time, and this device cannot tell it from a line someone else put out in
 * the user's nick: no red alarm over it (DESIGN_NOTES #2485).
 */
export type CheckLook = "passed" | "unanswered" | "failed";

export const checkLook = (check: IdentityCheck): CheckLook =>
  check.passed ? "passed" : check.reason === "not-sent" ? "unanswered" : "failed";

export const CHECK_LOOK: Record<CheckLook, { glyph: string; label: string }> = {
  passed: { glyph: "✓", label: "passed" },
  unanswered: { glyph: "–", label: "not answered here" },
  failed: { glyph: "✗", label: "failed" },
};

const devicesText = (n: number): string => (n === 1 ? "1 device" : `${n} devices`);

/** Where a challenged line was said: a channel, or a private message to the bot. */
export function checkPlace(check: IdentityCheck, slug: string): string {
  const network = networkBySlug(slug);
  const chantypes = network === undefined ? ["#", "&"] : chantypesForNetwork(network.id);
  const where = isChannelName(check.channel, chantypes) ? check.channel : "a private message";
  return `${where} on ${check.network}`;
}

/**
 * issue 2544 — verifies `peerKey`, the key the peer's nick is pinned to and
 * the one shown beside the button: the user compared it with the peer out of
 * band. Pinning that very key again, verified, is the whole act
 * (`Engine.pin`): the pin stays where it is, the SAS under way on it too, and
 * the badge reads verified. The rail's and the badge's door are this one
 * button; a failure says so under it.
 */
export const VerifyKeyButton: Component<{
  networkSlug: string;
  nick: string;
  peerKey: string;
  testId: string;
  onVerified: (() => void) | null;
}> = (props) => {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const verify = async () => {
    setBusy(true);
    setError(null);
    let result: PinOutcome;
    try {
      result = await pinEncryptedKey(props.networkSlug, props.nick, props.peerKey, true);
    } catch (err) {
      console.warn(`[e2e] could not verify the key of ${props.nick}`, err);
      setError(`could not verify the key: ${errorMessage(err)}`);
      return;
    } finally {
      setBusy(false);
    }
    if (result === "pinned") props.onVerified?.();
    else setError(`could not verify the key: ${PIN_REFUSED[result]}`);
  };
  return (
    <>
      <button
        type="button"
        class="e2e-sas-button"
        data-testid={props.testId}
        disabled={busy()}
        onClick={() => void verify()}
      >
        verify
      </button>
      <Show when={error()}>
        {(message) => (
          <div class="e2e-error" data-testid={`${props.testId}-error`}>
            {message()}
          </div>
        )}
      </Show>
    </>
  );
};

/** Takes the key an alarm showed for the nick: written to now, not verified. */
export function acceptAlarmKey(slug: string, nick: string, key: string): void {
  void pinEncryptedKey(slug, nick, key, false).catch((err: unknown) => {
    console.warn(`[e2e] could not take the new key of ${nick}`, err);
  });
}

const EncryptedRail: Component<Props> = (props) => {
  const [adding, setAdding] = createSignal(false);
  // Whether this browser holds the master: only it may add a device. Asked
  // again when the key shown changes (a new identity, or a pairing, lands).
  // Unknown (still asking, or no key yet: the sync that makes it is what
  // settles whether this browser holds a master) offers neither the button
  // nor the hint, so a real master never sees the hint first.
  const [master] = createResource(
    () => {
      const key = ownKey(props.networkSlug);
      return key === undefined ? false : ([props.networkSlug, key] as const);
    },
    ([slug]) =>
      holdsMasterHere(slug).catch((err: unknown) => {
        console.warn(`[e2e] could not tell whether this browser holds the master of ${slug}`, err);
        return false;
      }),
  );
  const answered = () => (ownKey(props.networkSlug) === undefined ? undefined : master());

  const display = () => encryptedChat(props.networkSlug, props.nick)?.nick ?? props.nick;
  const rows = () => encryptedRows(props.networkSlug, props.nick) ?? [];
  const peerTrust = () => encryptedTrust(props.networkSlug, props.nick);
  const trust = () => trustOf(rows(), peerTrust());
  const alarm = () => openAlarm(rows());
  const comparison = () => lastComparison(rows());
  const check = () => encryptedChat(props.networkSlug, props.nick)?.check;
  const elsewhere = () => identityElsewhere(props.networkSlug);
  // The key to verify, where the badge reads `not verified`: a key pinned,
  // not verified, and no alarm open (that is answered first: take the new
  // key, or close the chat).
  const unverifiedKey = () => {
    const peer = peerTrust();
    return peer !== null && trust() === "unverified" ? peer.master : null;
  };

  return (
    <div class="rail-e2e selectable-text" data-testid="e2e-rail">
      <section class="rail-e2e-section" data-testid="e2e-rail-peer">
        <h4 class="rail-e2e-section-heading">{display()}</h4>
        <dl class="rail-e2e-fields">
          <dt>key</dt>
          <dd>
            <code class="e2e-key" data-testid="e2e-peer-key">
              {peerTrust()?.master ?? "none yet"}
            </code>
          </dd>
          <dt>status</dt>
          <dd>
            <span
              class={`e2e-trust e2e-trust-${trust()}`}
              data-testid="e2e-rail-trust"
              data-trust={trust()}
            >
              {TRUST_LABEL[trust()]}
            </span>
          </dd>
          <Show when={alarm()}>
            {(key) => (
              <>
                <dt>ignored key</dt>
                <dd>
                  <code class="e2e-key e2e-key-alarm" data-testid="e2e-rail-alarm-key">
                    {key()}
                  </code>
                </dd>
              </>
            )}
          </Show>
          <Show when={peerTrust()}>
            {(peer) => (
              <>
                <dt>devices</dt>
                <dd data-testid="e2e-peer-devices">{devicesText(peer().devices)}</dd>
              </>
            )}
          </Show>
          <Show when={comparison()}>
            {(text) => (
              <>
                <dt>last emoji comparison</dt>
                <dd data-testid="e2e-rail-comparison">{text()}</dd>
              </>
            )}
          </Show>
          <Show when={check()}>
            {(c) => (
              <>
                <dt>last identity check</dt>
                <dd
                  data-testid="e2e-identity-check"
                  data-passed={c().passed ? "true" : "false"}
                  data-reason={c().reason ?? ""}
                >
                  <span class={`e2e-check-${checkLook(c())}`}>
                    {CHECK_LOOK[checkLook(c())].label}
                  </span>
                  , {formatDateTime(c().at)}, {checkPlace(c(), props.networkSlug)}
                  <Show when={c().reason}>
                    {(reason) => <span class="muted">: {CHECK_REASON[reason()]}</span>}
                  </Show>
                </dd>
              </>
            )}
          </Show>
        </dl>
        <Show when={!elsewhere()}>
          <Show when={unverifiedKey()}>
            {(key) => (
              <VerifyKeyButton
                networkSlug={props.networkSlug}
                nick={props.nick}
                peerKey={key()}
                testId="e2e-peer-verify"
                onVerified={null}
              />
            )}
          </Show>
          <Show when={alarm()}>
            {(key) => (
              <button
                type="button"
                class="e2e-sas-button"
                data-testid="e2e-rail-alarm-accept"
                onClick={() => acceptAlarmKey(props.networkSlug, props.nick, key())}
              >
                take the ignored key (not verified)
              </button>
            )}
          </Show>
        </Show>
      </section>
      <section class="rail-e2e-section" data-testid="e2e-rail-own">
        <h4 class="rail-e2e-section-heading">your identity</h4>
        <Show
          when={!elsewhere()}
          fallback={
            <p class="muted rail-e2e-hint" data-testid="e2e-rail-elsewhere">
              held on another device, or lost: the chat says how to use it here
            </p>
          }
        >
          <dl class="rail-e2e-fields">
            <dt>your key</dt>
            <dd>
              <code class="e2e-key" data-testid="e2e-own-identity">
                {ownKey(props.networkSlug) ?? "…"}
              </code>
            </dd>
          </dl>
          <E2eCopyButton
            text={ownKey(props.networkSlug)}
            label="copy your key"
            testId="e2e-own-identity-copy"
          />
          <Show when={answered() === true}>
            <Show when={!adding()} fallback={<AddDevicePanel onClose={() => setAdding(false)} />}>
              <button
                type="button"
                class="e2e-copy"
                data-testid="e2e-add-device"
                onClick={() => setAdding(true)}
              >
                add a device
              </button>
            </Show>
          </Show>
          <Show when={answered() === false}>
            <p class="muted rail-e2e-hint" data-testid="e2e-add-device-hint">
              Devices are added from the browser that started this identity.
            </p>
          </Show>
        </Show>
      </section>
    </div>
  );
};

export default EncryptedRail;
