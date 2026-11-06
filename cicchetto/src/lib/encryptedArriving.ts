// issue 2577 — an encrypted message on its way. A peer's PKMSG or MSG that
// spans several lines can take many seconds to come whole (the sender paces
// its lines), and grappa reassembles it: cic never sees a line, so grappa
// announces the first one (`e2e_incoming`, CLIENT_PROTOCOL §4l) and the
// encrypted window shows the message as arriving until it lands.
//
// Ephemeral, and this tab's: never stored, never a row of the chat, never a
// window opened nor an unread counted. A reload forgets it, and the message
// then simply lands (vjt's ruling on 2577: that is fine). Only a message to
// this device, or to every device (`*`), is shown, so nothing is until this
// device's id on the network is known.
//
// What ends it:
//   * the message landing: a row of the chat carrying its msgid in its
//     `wire` hides it in the same update that adds the row, so the row takes
//     its place (derived, not removed);
//   * grappa saying it will not reach this device (`e2e_incoming_lost`): its
//     lines stopped, or this device's queue did not take it;
//   * grappa queuing it for this device (`e2e_message`), once the drain that
//     follows has run, whether or not it wrote a row: an order challenge or
//     an emoji-comparison step writes none, and another tab of this browser
//     may have drained it first.
// cic keeps no clock: grappa's is the one that counts (vjt's ruling on 2577).

import { createSignal } from "solid-js";
import { isMessage } from "./e2e/chatStore";
import { fold } from "./e2e/wire";
import { drainE2e, encryptedRows, ownDevice } from "./encryptedChats";
import { identityScopedStore } from "./identityScopedStore";
import type {
  SessionWireE2eIncomingLostPayload,
  SessionWireE2eIncomingPayload,
  SessionWireE2eMessagePayload,
} from "./wireTypes";

/** A message on its way: who sends it (the RAW nick), and how its announcement names it. */
export type Arriving = { nick: string; fromDid: string; msgid: string; at: number };

const exports_ = identityScopedStore((onIdentityChange) => {
  const [bySlug, setBySlug] = createSignal<Record<string, Arriving[]>>({});
  onIdentityChange(() => setBySlug({}));

  /** Whether `to` is this device on the network, or every device. */
  const forHere = (slug: string, to: string): boolean => {
    const did = ownDevice(slug);
    return did !== undefined && (to === "*" || to === did);
  };

  function forget(slug: string, fromDid: string, msgid: string): void {
    setBySlug((prev) => {
      const list = prev[slug] ?? [];
      const left = list.filter((a) => a.fromDid !== fromDid || a.msgid !== msgid);
      return left.length === list.length ? prev : { ...prev, [slug]: left };
    });
  }

  function e2eIncoming(p: SessionWireE2eIncomingPayload): void {
    if (!forHere(p.network, p.to)) return;
    setBySlug((prev) => {
      const list = prev[p.network] ?? [];
      if (list.some((a) => a.fromDid === p.from_did && a.msgid === p.msgid)) return prev;
      const arriving = { nick: p.from, fromDid: p.from_did, msgid: p.msgid, at: Date.now() };
      return { ...prev, [p.network]: [...list, arriving] };
    });
  }

  function e2eIncomingLost(p: SessionWireE2eIncomingLostPayload): void {
    if (forHere(p.network, p.to)) forget(p.network, p.from_did, p.msgid);
  }

  /**
   * A message grappa queued for one of the user's devices: the drain takes
   * what is this device's (`drainE2e`). A copy for this device ends its
   * arrival once that drain has run, or failed: it then waits in the inbox
   * for the next drain, and the window shows it when that one lands it.
   */
  async function e2eMessageQueued(p: SessionWireE2eMessagePayload): Promise<void> {
    try {
      await drainE2e(p.network);
    } finally {
      if (p.to_did === ownDevice(p.network)) forget(p.network, p.from_did, p.msgid);
    }
  }

  /** The messages on their way in the chat with `nick`, in the order they began to arrive. */
  function encryptedArriving(slug: string, nick: string): Arriving[] {
    const landed = new Set(
      (encryptedRows(slug, nick) ?? []).flatMap((row) =>
        isMessage(row) ? (row.wire ?? []).map((w) => w.msgid) : [],
      ),
    );
    const key = fold(nick);
    return (bySlug()[slug] ?? []).filter((a) => fold(a.nick) === key && !landed.has(a.msgid));
  }

  return { e2eIncoming, e2eIncomingLost, e2eMessageQueued, encryptedArriving };
});

export const e2eIncoming = exports_.e2eIncoming;
export const e2eIncomingLost = exports_.e2eIncomingLost;
export const e2eMessageQueued = exports_.e2eMessageQueued;
export const encryptedArriving = exports_.encryptedArriving;
