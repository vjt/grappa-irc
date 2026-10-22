// issue 2430, X1 — the pairing relay's client half: the code a pairing QR
// carries, grappa's REST doors for a rendezvous, and an opaque channel over
// them. grappa relays the channel blind; what travels on it is encrypted by
// the two devices (vodozemac ECIES, the MSC4108 shape), and that layer
// lives above this module: here a payload is an opaque base64 string.
//
// The QR holds a URL whose FRAGMENT is `pair=<rendezvous id>.<ephemeral
// Curve25519 key>`. Both halves are public — nothing secret goes in a QR or
// in a URL — and the fragment is still where they go, because a browser
// does not send it with the request, so the link costs nothing in a server
// log.

import { ApiError, buildHeaders, readError } from "../api";
import {
  narrowPairingMessageResponse,
  narrowPairingMessagesResponse,
  narrowPairingRendezvousResponse,
} from "../wireNarrow";
import type {
  E2ePairingWireCloseReason,
  E2ePairingWireE2ePairingClosedPayload,
  E2ePairingWireE2ePairingMessagePayload,
  E2ePairingWireMessage,
  E2ePairingWireRendezvous,
} from "../wireTypes";

export type Rendezvous = E2ePairingWireRendezvous;
export type PairingMessage = E2ePairingWireMessage;

export type PairCode = { id: string; curve: string };

const ID = /^[A-Za-z0-9_-]{22}$/;
const CURVE = /^[A-Za-z0-9+/]{43}$/;
const FRAGMENT_KEY = "pair=";

/** The URL a pairing QR shows: the `/pair` route, with the code in its fragment. */
export function pairingUrl(origin: string, code: PairCode): string {
  if (!ID.test(code.id) || !CURVE.test(code.curve)) throw new Error("not a pairing code");
  return `${origin}/pair#${FRAGMENT_KEY}${code.id}.${code.curve}`;
}

/** The code in a URL fragment (with or without its `#`), or null. */
export function parsePairFragment(hash: string): PairCode | null {
  const raw = hash.replace(/^#/, "");
  if (!raw.startsWith(FRAGMENT_KEY)) return null;
  const [id, curve, ...rest] = raw.slice(FRAGMENT_KEY.length).split(".");
  if (rest.length > 0 || id === undefined || curve === undefined) return null;
  return ID.test(id) && CURVE.test(curve) ? { id, curve } : null;
}

// --- REST ------------------------------------------------------------------

export async function openPairing(token: string): Promise<Rendezvous> {
  const res = await fetch("/e2e/pairings", { method: "POST", headers: buildHeaders(token) });
  if (!res.ok) throw await readError(res);
  return narrowPairingRendezvousResponse(await res.json()).rendezvous;
}

export async function joinPairing(token: string, id: string): Promise<Rendezvous> {
  const res = await fetch(`/e2e/pairings/${encodeURIComponent(id)}/join`, {
    method: "POST",
    headers: buildHeaders(token),
  });
  if (!res.ok) throw await readError(res);
  return narrowPairingRendezvousResponse(await res.json()).rendezvous;
}

async function postPairingMessage(
  token: string,
  id: string,
  payload: string,
): Promise<PairingMessage> {
  const res = await fetch(`/e2e/pairings/${encodeURIComponent(id)}/messages`, {
    method: "POST",
    headers: buildHeaders(token),
    body: JSON.stringify({ payload }),
  });
  if (!res.ok) throw await readError(res);
  return narrowPairingMessageResponse(await res.json()).message;
}

async function listPairingMessages(
  token: string,
  id: string,
  after: number,
): Promise<PairingMessage[]> {
  const res = await fetch(
    `/e2e/pairings/${encodeURIComponent(id)}/messages?after=${encodeURIComponent(after)}`,
    { headers: buildHeaders(token) },
  );
  if (!res.ok) throw await readError(res);
  return narrowPairingMessagesResponse(await res.json()).messages;
}

async function closePairing(token: string, id: string): Promise<void> {
  const res = await fetch(`/e2e/pairings/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: buildHeaders(token),
  });
  if (!res.ok && res.status !== 404) throw await readError(res);
}

// --- the channel ---------------------------------------------------------

/**
 * Why a channel ended. `gone` is this client's own: a fetch answered 404, so
 * the rendezvous ended while this tab missed the push that would have said
 * how (a socket down at the time), and that is all it can know.
 */
export type CloseReason = E2ePairingWireCloseReason | "gone";

export type ChannelHandlers = {
  /** A payload the other side posted, in the order it posted them. */
  onMessage: (payload: string) => void;
  /** The rendezvous ended without this side closing it. */
  onClosed: (reason: CloseReason) => void;
};

export type PairingChannel = {
  readonly rendezvous: Rendezvous;
  send: (payload: string) => Promise<void>;
  /** Fetch what the other side posted that this channel has not delivered yet. */
  catchUp: () => Promise<void>;
  /**
   * Close it for both sides. The caller asked, so `onClosed` stays quiet. A
   * failed DELETE is logged, not thrown: the caller is a screen going away
   * with nothing to retry, and the other side's rendezvous still expires.
   */
  close: () => Promise<void>;
};

// The live channels of this tab, by rendezvous id: what a user-topic push
// is delivered to. A push is only a doorbell. The payload comes from the
// fetch, which grappa answers to the two sides only, while the push reaches
// every device of the account.
const channels = new Map<
  string,
  { role: Rendezvous["role"]; ring: () => void; ended: (r: CloseReason) => void }
>();

export function openChannel(
  token: string,
  rendezvous: Rendezvous,
  handlers: ChannelHandlers,
): PairingChannel {
  const id = rendezvous.id;
  let lastSeq = 0;
  let open = true;

  const forget = (): void => {
    open = false;
    channels.delete(id);
  };

  const end = (reason: CloseReason): void => {
    if (!open) return;
    forget();
    handlers.onClosed(reason);
  };

  // Fetches may overlap (a doorbell during a catch-up): each delivers only
  // what follows the last seq delivered, so none delivers a message twice.
  const catchUp = async (): Promise<void> => {
    if (!open) return;
    let page: PairingMessage[];
    try {
      page = await listPairingMessages(token, id, lastSeq);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return end("gone");
      throw err;
    }
    for (const m of page) {
      if (!open || m.seq <= lastSeq) continue;
      lastSeq = m.seq;
      handlers.onMessage(m.payload);
    }
  };

  const ring = (): void => {
    void catchUp().catch((err: unknown) => console.warn(`[pairing] fetch failed on ${id}`, err));
  };

  channels.set(id, { role: rendezvous.role, ring, ended: end });
  // A doorbell rung before this channel was registered (the other side
  // answering between our join and here) found nothing to ring.
  ring();

  return {
    rendezvous,
    send: async (payload) => {
      await postPairingMessage(token, id, payload);
    },
    catchUp,
    close: async () => {
      if (!open) return;
      forget();
      await closePairing(token, id).catch((err: unknown) =>
        console.warn(`[pairing] close failed on ${id}`, err),
      );
    },
  };
}

/** The user-topic dispatch for the two pairing events. */
export function deliverPairingEvent(
  event: E2ePairingWireE2ePairingMessagePayload | E2ePairingWireE2ePairingClosedPayload,
): void {
  const ch = channels.get(event.rendezvous_id);
  if (ch === undefined) return;
  if (event.kind === "e2e_pairing_closed") ch.ended(event.reason);
  else if (event.from !== ch.role) ch.ring();
}

/**
 * Catch every live channel up, on each user-topic (re)join: a push is not
 * replayed, and in a handshake each side waits for the other, so a doorbell
 * missed while the socket was down would otherwise leave both waiting until
 * the rendezvous expired. A rendezvous that ended meanwhile answers 404 and
 * ends as `gone`.
 */
export function catchUpPairings(): void {
  for (const ch of channels.values()) ch.ring();
}
