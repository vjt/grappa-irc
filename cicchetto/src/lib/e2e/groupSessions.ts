// Channel E2E (wire v4, CLIENT_PROTOCOL §4f) — the epoch store: one AEAD
// epoch per channel, shared by every member of the epoch.
//
// PERSISTENCE. The state lives in `E2eState.groups` (`engine.ts`), so it
// is sealed with the Olm account in the same IndexedDB record, under the
// same wrapping key, and stored in the same write as the step that spent
// it — the exact pattern the Olm sessions follow (`accountStore.ts`:
// one record, because the pieces change together). A reload therefore
// keeps the epochs: without the stored key this device could decrypt
// nothing of an epoch it had already joined, and its own epoch would fork
// a new one on every reload. A record sealed before this field existed
// opens with an empty store (`accountStore` spreads `newState()`
// underneath the stored state, and resets a groups object whose `v` is
// not 2), so no migration is needed.
//
// WHAT AN EPOCH IS. One record per channel: the epoch id (`sid`), the
// 32-byte AES-GCM key (base64), when it was created, how many messages
// went under it, this device's next counter, and the HOLDER SET — the
// folded nicks of every member who received this epoch key. The holder
// set is the audit input (§4f, F4): on cic open and before every send,
// the client compares it with the true roster, and anyone in the set who
// is no longer in the roster triggers rotation. There is no per-sender
// store: a sender is just a device whose counter the epoch tracks.
//
// ROTATION, and why old keys die. One key per epoch. A member leaves, or
// the day passes, and the epoch rotates: the old key is deleted outright
// — encrypting with it again would hand the departed member new messages
// under a key they hold — and the new key goes pairwise to the members
// who remain. A gkey supersedes by ARRIVAL: a valid gkey for a different
// epoch replaces the one held, whatever order the epochs were minted in.
// Rotation is only real if clients delete old keys (§4f); this module is
// where that happens. No keys are kept for channels left (`dropChannel`).
//
// REPLAY. The counter lives inside the signed, encrypted part, and the
// envelope carries no plaintext counter at all. A receiver keeps, per
// (channel, epoch, sender device), the highest counter accepted plus the
// counters accepted in the window below it (`REPLAY_WINDOW`); a counter
// at or below the high-water mark that was already seen, or below the
// window, is refused as `replay`. The state is indexed on the sender
// DEVICE (its did), never on the nick: a rename must not make a sender
// unreadable, and two devices of one subject must not evict each other.
// A re-delivery — the inbox is at-least-once — is refused by this state
// before any plaintext is shown. The window bounds the state: at most
// one entry per sender device, 128 counters each.

import { decryptEpoch, encryptEpoch, isEpochKey, newEpochId, newEpochKey } from "./channelCrypto";
import {
  type ChannelPayload,
  channelSigText,
  decodePayload,
  encodePayload,
  fold,
  type GkeyInner,
  GROUP_WIRE_VERSION,
  type GrotateInner,
  PayloadError,
  parseChannelPayload,
  parseChannelTextInner,
  parseGrotateInner,
} from "./wire";

/** A periodic rotation is due once an epoch is this old (ms): daily. */
export const GROUP_ROTATION_INTERVAL_MS = 86_400_000;
/** How many counters below the high-water mark a replay window keeps, per sender device. */
export const REPLAY_WINDOW = 128;
/** A member who asked for the key is answered at most this often (ms): duplicate answers are harmless, but not free. */
export const KEYREQ_ANSWER_THROTTLE_MS = 60_000;

const decoder = new TextDecoder("utf-8", { fatal: true });

/** Signs `text` with this device's Ed25519 key: the `sig` of a channel `:msg`. */
export type ChannelSigner = (text: string) => string;
/**
 * Whether `sig` is `nick`'s device `did`'s Ed25519 signature over `text`:
 * the pinned device key for that did, verified with the wasm binding.
 * False when the nick is not pinned, or the did is not one of its trusted
 * devices — a message from a sender this cic has no key for does not verify.
 */
export type ChannelVerifier = (
  nick: string,
  did: string,
  text: string,
  sig: string,
) => boolean;

/** The counters already accepted from one sender device under one epoch. */
export type ReplayState = {
  /** The highest counter accepted from this device. -1 before the first. */
  high: number;
  /** The counters accepted in (`high` - `REPLAY_WINDOW`, `high`]. */
  window: number[];
};

/** This channel's epoch, as stored: the one key every member shares. */
export type StoredEpoch = {
  /** The epoch id: 16 random bytes, base64 unpadded. */
  sid: string;
  /** The 32-byte AES-GCM key, base64 unpadded. */
  key: string;
  /** When the epoch was created (ms since epoch). */
  createdAt: number;
  /** How many messages went under this epoch: 0, it never spoke. */
  messages: number;
  /** This device's next counter under this epoch: 0, it never spoke. */
  counter: number;
  /** The folded nicks of every member who received this epoch key. */
  holders: string[];
  /** When the key arrived (ms since epoch): the creation, for our own epochs. */
  receivedAt: number;
  /** The did of the member whose gkey brought the key: null for our own epochs. */
  receivedFrom: string | null;
  /** The replay state per sender device did. */
  seen: Record<string, ReplayState>;
};

/**
 * The epochs, as `E2eState.groups` holds them. `epochs` is keyed by folded
 * channel name; `keyreqAnsweredAt` by `${folded channel}:${folded asker}`,
 * the last time this device answered that asker's key request on that
 * channel. A channel name is folded (`fold`) because §4f's `ch` is the
 * folded name.
 */
export type GroupSessionsState = {
  v: 2;
  epochs: Record<string, StoredEpoch>;
  keyreqAnsweredAt: Record<string, number>;
};

export function newGroupSessionsState(): GroupSessionsState {
  return { v: 2, epochs: {}, keyreqAnsweredAt: {} };
}

/** The epoch held for `channel`, if any. */
export function epochFor(state: GroupSessionsState, channel: string): StoredEpoch | undefined {
  return state.epochs[fold(channel)];
}

/** Whether a periodic rotation of `channel`'s epoch is due. */
export function rotationDue(state: GroupSessionsState, channel: string, now: number): boolean {
  const held = epochFor(state, channel);
  if (held === undefined) return false;
  // An epoch that never spoke has nothing to protect: rotating it only
  // churns keys every member must then import.
  if (held.messages === 0) return false;
  return now - held.createdAt >= GROUP_ROTATION_INTERVAL_MS;
}

/** Whether `channel`'s epoch holder set names someone no longer in `roster`: the audit input (§4f). */
export function epochHoldersStale(
  state: GroupSessionsState,
  channel: string,
  roster: string[],
): boolean {
  const held = epochFor(state, channel);
  if (held === undefined) return false;
  const present = new Set(roster.map((nick) => fold(nick)));
  return held.holders.some((holder) => !present.has(holder));
}

/** Whether this device answered `asker`'s key request on `channel` recently: the throttle. */
export function keyreqAnswerDue(
  state: GroupSessionsState,
  channel: string,
  asker: string,
  now: number,
): boolean {
  const at = state.keyreqAnsweredAt[`${fold(channel)}:${fold(asker)}`];
  return at === undefined || now - at >= KEYREQ_ANSWER_THROTTLE_MS;
}

/** Records that this device answered `asker`'s key request on `channel` now. */
export function markKeyreqAnswered(
  state: GroupSessionsState,
  channel: string,
  asker: string,
  now: number,
): void {
  state.keyreqAnsweredAt[`${fold(channel)}:${fold(asker)}`] = now;
}

/** Stores `epoch` as `channel`'s epoch, replacing whatever was held. */
function storeEpoch(state: GroupSessionsState, channel: string, epoch: StoredEpoch): StoredEpoch {
  state.epochs[fold(channel)] = epoch;
  return epoch;
}

/**
 * Creates `channel`'s epoch: a new key, this device its owner. `holders`
 * is the roster the key goes to, folded on store. The caller distributes
 * its key (`gkeyInner`) before anyone can read a message under it.
 */
export function createEpoch(
  state: GroupSessionsState,
  channel: string,
  holders: string[],
  now: number,
): StoredEpoch {
  return storeEpoch(state, channel, {
    sid: newEpochId(),
    key: newEpochKey(),
    createdAt: now,
    messages: 0,
    counter: 0,
    holders: holders.map((nick) => fold(nick)),
    receivedAt: now,
    receivedFrom: null,
    seen: {},
  });
}

/** Deletes `channel`'s epoch: its key is never spoken or read again. */
export function dropEpoch(state: GroupSessionsState, channel: string): void {
  delete state.epochs[fold(channel)];
}

/** Drops everything of `channel`: its epoch. We left. */
export function dropChannel(state: GroupSessionsState, channel: string): void {
  dropEpoch(state, channel);
}

/**
 * Imports the epoch `gkey` carries for `channel`: a gkey DM brought it,
 * or a grotate inside a channel message. The key must be a 32-byte epoch
 * key, or the import throws and nothing is stored. An import of the epoch
 * already held is a no-op (a re-sent gkey). Otherwise the held epoch is
 * replaced, whatever order the epochs were minted in: a gkey supersedes
 * by arrival, and the new epoch's counters start over. `fromDid` is the
 * did of the member whose gkey it was, for the record.
 */
export function importEpoch(
  state: GroupSessionsState,
  channel: string,
  gkey: GkeyInner,
  fromDid: string,
  now: number,
): "imported" | "already-held" {
  if (epochFor(state, channel)?.sid === gkey.sid) return "already-held";
  if (!isEpochKey(gkey.key)) throw new Error(`a gkey for ${gkey.sid} is not an epoch key`);
  storeEpoch(state, channel, {
    sid: gkey.sid,
    key: gkey.key,
    createdAt: now,
    messages: 0,
    counter: 0,
    holders: gkey.holders.map((nick) => fold(nick)),
    receivedAt: now,
    receivedFrom: fromDid,
    seen: {},
  });
  return "imported";
}

/**
 * The gkey inner for `channel`'s current epoch, to send to a member's DM:
 * `{"t":"gkey","ch":"#chan","sid":"...","key":"...","holders":["..."]}`
 * (§4f). Undefined when no epoch exists: create one first
 * (`createEpoch`).
 */
export function gkeyInner(state: GroupSessionsState, channel: string): GkeyInner | undefined {
  const held = epochFor(state, channel);
  if (held === undefined) return undefined;
  return { t: "gkey", ch: fold(channel), sid: held.sid, key: held.key, holders: [...held.holders] };
}

/** The key-request envelope for `channel`: `{"v":4,"t":"keyreq","ch":"#chan"}` (§4f). */
export function keyreqPayload(channel: string): string {
  return encodePayload({ v: GROUP_WIRE_VERSION, t: "keyreq", ch: fold(channel) });
}

/**
 * Encrypts `body` for `channel` under the epoch key, as the v4 payload of
 * a channel `:msg`. Creates the epoch when none exists (`created`): the
 * caller distributes its key before the message can be read. The
 * per-sender counter and the message count are stored with the step.
 */
export async function encryptChannel(
  state: GroupSessionsState,
  channel: string,
  body: string,
  holders: string[],
  sign: ChannelSigner,
  now: number,
): Promise<{ payload: string; sid: string; counter: number; created: boolean }> {
  const created = epochFor(state, channel) === undefined;
  const held = created
    ? createEpoch(state, channel, holders, now)
    : (epochFor(state, channel) as StoredEpoch);
  const inner = encodePayload({ t: "text", c: held.counter, body });
  const ciphertext = await encryptEpoch(held.key, new TextEncoder().encode(inner));
  const payload: ChannelPayload = {
    v: GROUP_WIRE_VERSION,
    t: "msg",
    ch: fold(channel),
    sid: held.sid,
    body: ciphertext,
    sig: sign(channelSigText(fold(channel), held.sid, ciphertext)),
  };
  held.counter += 1;
  held.messages += 1;
  return { payload: encodePayload(payload), sid: held.sid, counter: held.counter - 1, created };
}

/** Whether `counter` from `did` is a new message under the epoch, judging its replay state. */
function counterIsNew(replay: ReplayState | undefined, counter: number): boolean {
  if (replay === undefined) return true;
  if (counter > replay.high) return true;
  if (counter <= replay.high - REPLAY_WINDOW) return false;
  return !replay.window.includes(counter);
}

/** Records `counter` from `did` as read under the epoch. */
function noteCounter(epoch: StoredEpoch, did: string, counter: number): void {
  const replay = epoch.seen[did] ?? { high: -1, window: [] };
  if (counter > replay.high) {
    replay.high = counter;
    replay.window = [...replay.window, counter].filter((c) => c > counter - REPLAY_WINDOW);
  } else {
    replay.window.push(counter);
  }
  epoch.seen[did] = replay;
}

export type ChannelDecrypt =
  | { ok: true; kind: "text"; sid: string; counter: number; body: string }
  | { ok: true; kind: "rotated"; sid: string; counter: number; newSid: string }
  | {
      ok: false;
      reason:
        | "bad-payload"
        | "channel-mismatch"
        | "no-session"
        | "bad-signature"
        | "replay"
        | "decryption-failed"
        | "bad-inner";
      sid: string | null;
    };

/**
 * Decrypts a channel `:msg` payload from `sender`'s device `senderDid` on
 * `channel`, under the epoch the envelope names. The signature is checked
 * before the ciphertext is touched; the counter is checked after the
 * decrypt, on the counter inside the signed, encrypted part — never on a
 * plaintext field, of which the envelope has none. A grotate inside is
 * consumed, not shown: the new epoch is imported (its key is inside,
 * encrypted under the old one) and the event says `rotated`, so the caller
 * can note the new epoch. Anything that cannot be read is `ok: false`,
 * never a throw: an undecryptable channel message surfaces as one,
 * exactly as a DM's does.
 */
export async function decryptChannel(
  state: GroupSessionsState,
  channel: string,
  sender: string,
  senderDid: string,
  payloadText: string,
  verify: ChannelVerifier,
  now: number,
): Promise<ChannelDecrypt> {
  let payload: ChannelPayload;
  try {
    payload = parseChannelPayload(decodePayload(payloadText));
  } catch (err) {
    if (!(err instanceof PayloadError)) throw err;
    return { ok: false, reason: "bad-payload", sid: null };
  }
  if (fold(payload.ch) !== fold(channel)) {
    return { ok: false, reason: "channel-mismatch", sid: payload.sid };
  }
  const held = epochFor(state, channel);
  if (held === undefined || held.sid !== payload.sid) {
    return { ok: false, reason: "no-session", sid: payload.sid };
  }
  if (!verify(sender, senderDid, channelSigText(payload.ch, payload.sid, payload.body), payload.sig)) {
    return { ok: false, reason: "bad-signature", sid: payload.sid };
  }
  let plaintext: Uint8Array;
  try {
    plaintext = await decryptEpoch(held.key, payload.body);
  } catch {
    return { ok: false, reason: "decryption-failed", sid: payload.sid };
  }
  let inner: Record<string, unknown>;
  try {
    inner = decodePayload(decoder.decode(plaintext));
  } catch (err) {
    if (!(err instanceof PayloadError)) throw err;
    return { ok: false, reason: "bad-inner", sid: payload.sid };
  }
  if (inner.t === "grotate") {
    let rotated: GrotateInner;
    try {
      rotated = parseGrotateInner(inner);
    } catch (err) {
      if (!(err instanceof PayloadError)) throw err;
      return { ok: false, reason: "bad-inner", sid: payload.sid };
    }
    if (!isEpochKey(rotated.key)) return { ok: false, reason: "bad-inner", sid: payload.sid };
    if (!counterIsNew(held.seen[senderDid], rotated.c)) {
      return { ok: false, reason: "replay", sid: payload.sid };
    }
    noteCounter(held, senderDid, rotated.c);
    // The new epoch, under the old one's holders: membership did not
    // change on a periodic rotation, so the holder set carries over.
    storeEpoch(state, channel, {
      sid: rotated.sid,
      key: rotated.key,
      createdAt: now,
      messages: 0,
      counter: 0,
      holders: [...held.holders],
      receivedAt: now,
      receivedFrom: senderDid,
      seen: {},
    });
    return { ok: true, kind: "rotated", sid: payload.sid, counter: rotated.c, newSid: rotated.sid };
  }
  let text: { t: "text"; c: number; body: string };
  try {
    text = parseChannelTextInner(inner);
  } catch (err) {
    if (!(err instanceof PayloadError)) throw err;
    return { ok: false, reason: "bad-inner", sid: payload.sid };
  }
  if (!counterIsNew(held.seen[senderDid], text.c)) {
    return { ok: false, reason: "replay", sid: payload.sid };
  }
  noteCounter(held, senderDid, text.c);
  return { ok: true, kind: "text", sid: payload.sid, counter: text.c, body: text.body };
}

/**
 * Rotates `channel`'s epoch because a member left: the old epoch is
 * deleted (never spoken again), a new one created for `holders` — the
 * roster that remains — and its key returned for pairwise distribution
 * to them. The old epoch's key stays valid for what it already encrypted
 * — a departed member can re-read the past — and useless for the future:
 * nothing new goes under it.
 */
export function rotateEpochForLeave(
  state: GroupSessionsState,
  channel: string,
  holders: string[],
  now: number,
): { oldSid: string | null; newSid: string; key: string } {
  const oldSid = epochFor(state, channel)?.sid ?? null;
  dropEpoch(state, channel);
  const created = createEpoch(state, channel, holders, now);
  return { oldSid, newSid: created.sid, key: created.key };
}

/**
 * Rotates `channel`'s epoch because the day passed: the new key goes out
 * in ONE channel message, encrypted under the OLD epoch's key (the O(1)
 * rotation: membership did not change, so the old key may carry the new
 * one). The returned payload is a v4 channel `:msg` whose envelope names
 * the OLD `sid`; the store already holds the NEW epoch by the time it
 * returns, and the old epoch is gone. Null when there is no epoch to
 * rotate, or it never spoke. `sign` signs the envelope, as for any
 * channel message.
 */
export async function buildPeriodicRotation(
  state: GroupSessionsState,
  channel: string,
  sign: ChannelSigner,
  now: number,
): Promise<{ payload: string; oldSid: string; newSid: string } | null> {
  const held = epochFor(state, channel);
  if (held === undefined || held.messages === 0) return null;
  const oldSid = held.sid;
  const newSid = newEpochId();
  const newKey = newEpochKey();
  const rotate: GrotateInner = { t: "grotate", c: held.counter, sid: newSid, key: newKey };
  const ciphertext = await encryptEpoch(held.key, new TextEncoder().encode(encodePayload(rotate)));
  const payload: ChannelPayload = {
    v: GROUP_WIRE_VERSION,
    t: "msg",
    ch: fold(channel),
    sid: oldSid,
    body: ciphertext,
    sig: sign(channelSigText(fold(channel), oldSid, ciphertext)),
  };
  // Stored only once the rotation message exists: a failure above leaves
  // the old epoch in place, and the next tick tries again.
  dropEpoch(state, channel);
  storeEpoch(state, channel, {
    sid: newSid,
    key: newKey,
    createdAt: now,
    messages: 0,
    counter: 0,
    holders: [...held.holders],
    receivedAt: now,
    receivedFrom: null,
    seen: {},
  });
  return { payload: encodePayload(payload), oldSid, newSid };
}
