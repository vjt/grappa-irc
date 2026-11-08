// Channel E2E (wire v3, CLIENT_PROTOCOL §4f) — the group session store:
// one outbound Megolm session per channel (this device's epoch), and one
// inbound session per (channel, sender, session id).
//
// PERSISTENCE. The state lives in `E2eState.groups` (`engine.ts`), so it
// is sealed with the Olm account in the same IndexedDB record, under the
// same wrapping key, and stored in the same write as the ratchet step that
// spent it — the exact pattern the Olm sessions follow (`accountStore.ts`:
// one record, because the pieces change together). A reload therefore
// keeps the epochs: without the stored pickles this device could decrypt
// nothing of an epoch it had already joined, and its own outbound session
// would fork a new epoch on every reload. A record sealed before this
// field existed opens with an empty store (`accountStore` spreads
// `newState()` underneath the stored state), so no migration is needed.
//
// WHAT A SESSION IS. An outbound session is stored by its pickle, the
// same string the adapter's `pickle()` returns; an inbound one the same.
// The pickle is written back after EVERY encrypt/decrypt: the ratchet
// advanced, and the pickle from before the step cannot read what comes
// after it. The store never holds a live wasm session between calls, so
// no `free()` discipline leaks out of this module.
//
// ROTATION, and why old keys die. One sender key per sender, one epoch
// per session. A sender rotates on two triggers (see `channelE2e.ts`):
// a member leaves, or the day passes. On rotation the old outbound
// pickle is deleted outright — encrypting with it again would hand the
// departed member new messages under a key they hold — and a sender's
// old inbound sessions are dropped the moment a newer session id of
// THEIRS arrives (supersede): their old epoch is dead, and keeping its
// key would only let a replayed old message read again. Inbound sessions
// of OTHER senders are untouched by a rotation: their epochs are theirs.
// A departed member's inbound sessions are dropped on the leave itself:
// nothing they send after leaving is read here. Rotation is only real if
// clients delete old keys (§4f); this module is where that happens.

import type { MegolmAdapter, MegolmInboundSession, MegolmOutboundSession } from "./megolm";
import { megolmBytes } from "./megolm";
import {
  type ChannelPayload,
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

const decoder = new TextDecoder("utf-8", { fatal: true });

/** This device's outbound session for a channel, as stored. */
export type StoredGroupOutbound = {
  /** The session id: the base64 of the session's signing key. */
  sid: string;
  /** The pickle AFTER the last encrypt (or the creation): the ratchet moved. */
  pickle: string;
  /** When the epoch was created (ms since epoch). */
  createdAt: number;
  /** How many messages this epoch encrypted: 0, it never spoke. */
  messages: number;
};

/** A sender's inbound session for a channel, as stored. */
export type StoredGroupInbound = {
  /** The session id it decrypts for. */
  sid: string;
  /** The pickle AFTER the last decrypt: the ratchet moved. */
  pickle: string;
  /** When the session key arrived (ms since epoch). */
  receivedAt: number;
};

/**
 * The group sessions, as `E2eState.groups` holds them. `outbound` is
 * keyed by folded channel name; `inbound` by folded channel, then the
 * sender's nick folded, then the session id. A channel name is folded
 * (`fold`) because §4f's `ch` is the folded name; a nick is folded the
 * way every E2E record folds one.
 */
export type GroupSessionsState = {
  v: 1;
  outbound: Record<string, StoredGroupOutbound>;
  inbound: Record<string, Record<string, Record<string, StoredGroupInbound>>>;
};

export function newGroupSessionsState(): GroupSessionsState {
  return { v: 1, outbound: {}, inbound: {} };
}

/** The outbound session held for `channel`, if any. */
export function outboundFor(
  state: GroupSessionsState,
  channel: string,
): StoredGroupOutbound | undefined {
  return state.outbound[fold(channel)];
}

/** The inbound session held for `sender`'s `sid` on `channel`, if any. */
export function inboundFor(
  state: GroupSessionsState,
  channel: string,
  sender: string,
  sid: string,
): StoredGroupInbound | undefined {
  return state.inbound[fold(channel)]?.[fold(sender)]?.[sid];
}

/** Whether a periodic rotation of `channel`'s epoch is due. */
export function rotationDue(state: GroupSessionsState, channel: string, now: number): boolean {
  const held = outboundFor(state, channel);
  if (held === undefined) return false;
  // An epoch that never spoke has nothing to protect: rotating it only
  // churns keys every member must then import.
  if (held.messages === 0) return false;
  return now - held.createdAt >= GROUP_ROTATION_INTERVAL_MS;
}

/**
 * A live outbound session on `stored`: the caller advances it and stores
 * its pickle again (`storeOutbound`), and frees it either way.
 */
function withOutbound<T>(
  adapter: MegolmAdapter,
  stored: StoredGroupOutbound,
  fn: (session: MegolmOutboundSession) => T,
): T {
  const session = adapter.restoreOutbound(stored.pickle);
  try {
    return fn(session);
  } finally {
    session.free();
  }
}

/** A live inbound session on `stored`: the same discipline as `withOutbound`. */
function withInbound<T>(
  adapter: MegolmAdapter,
  stored: StoredGroupInbound,
  fn: (session: MegolmInboundSession) => T,
): T {
  const session = adapter.restoreInbound(stored.pickle);
  try {
    return fn(session);
  } finally {
    session.free();
  }
}

/** Stores `session`'s pickle as `channel`'s outbound, counting one more message. */
function storeOutbound(
  state: GroupSessionsState,
  channel: string,
  session: MegolmOutboundSession,
  createdAt: number,
  messages: number,
): StoredGroupOutbound {
  const stored: StoredGroupOutbound = {
    sid: session.sessionId(),
    pickle: session.pickle(),
    createdAt,
    messages,
  };
  state.outbound[fold(channel)] = stored;
  return stored;
}

/** Stores `session`'s pickle as `sender`'s inbound for `sid` on `channel`. */
function storeInbound(
  state: GroupSessionsState,
  channel: string,
  sender: string,
  session: MegolmInboundSession,
  receivedAt: number,
): StoredGroupInbound {
  let bySender = state.inbound[fold(channel)];
  if (bySender === undefined) {
    bySender = {};
    state.inbound[fold(channel)] = bySender;
  }
  let bySid = bySender[fold(sender)];
  if (bySid === undefined) {
    bySid = {};
    bySender[fold(sender)] = bySid;
  }
  const stored: StoredGroupInbound = {
    sid: session.sessionId(),
    pickle: session.pickle(),
    receivedAt,
  };
  bySid[session.sessionId()] = stored;
  return stored;
}

/**
 * Creates `channel`'s outbound session: a new epoch, this device its
 * owner. The caller distributes its key (`exportOutboundKey`) before
 * anyone can read a message under it.
 */
export function createOutbound(
  state: GroupSessionsState,
  adapter: MegolmAdapter,
  channel: string,
  now: number,
): StoredGroupOutbound {
  const session = adapter.createOutbound();
  try {
    return storeOutbound(state, channel, session, now, 0);
  } finally {
    session.free();
  }
}

/** Deletes `channel`'s outbound session: its epoch is never spoken again. */
export function deleteOutbound(state: GroupSessionsState, channel: string): void {
  delete state.outbound[fold(channel)];
}

/**
 * The session key of `channel`'s outbound session, for distribution: the
 * `key` of a gkey, the `sid` it opens. Undefined when no epoch exists.
 * Exporting a key does not advance the session, so no pickle is stored.
 */
export function exportOutboundKey(
  state: GroupSessionsState,
  adapter: MegolmAdapter,
  channel: string,
): { sid: string; key: string } | undefined {
  const held = outboundFor(state, channel);
  if (held === undefined) return undefined;
  return withOutbound(adapter, held, (session) => ({
    sid: session.sessionId(),
    key: session.sessionKey(),
  }));
}

/**
 * Imports the inbound session `key` opens for `sender` on `channel`, as
 * a gkey or a grotate carried it. The session id it opens must be `sid`:
 * a key for another session is refused, never stored. An import of a
 * session id already held is a no-op (a re-sent gkey): the stored pickle
 * has the further-advanced ratchet, and re-importing would wind it back.
 * Otherwise the sender's older session ids on the channel are dropped:
 * the sender rotated, and their old epoch is dead (see the header).
 * Throws when `key` is not a session key.
 */
export function importInbound(
  state: GroupSessionsState,
  adapter: MegolmAdapter,
  channel: string,
  sender: string,
  sid: string,
  key: string,
  now: number,
): "imported" | "already-held" {
  if (inboundFor(state, channel, sender, sid) !== undefined) return "already-held";
  const session = adapter.importInbound(key);
  try {
    if (session.sessionId() !== sid) {
      throw new Error(`a gkey for ${sid} opened ${session.sessionId()}`);
    }
    let bySender = state.inbound[fold(channel)];
    if (bySender === undefined) {
      bySender = {};
      state.inbound[fold(channel)] = bySender;
    }
    bySender[fold(sender)] = {};
    storeInbound(state, channel, sender, session, now);
    return "imported";
  } finally {
    session.free();
  }
}

/** Drops every inbound session `sender` holds on `channel`: they left. */
export function dropInboundFrom(state: GroupSessionsState, channel: string, sender: string): void {
  const bySender = state.inbound[fold(channel)];
  if (bySender === undefined) return;
  delete bySender[fold(sender)];
  if (Object.keys(bySender).length === 0) delete state.inbound[fold(channel)];
}

/** Drops everything of `channel`: outbound and every inbound. We left. */
export function dropChannel(state: GroupSessionsState, channel: string): void {
  deleteOutbound(state, channel);
  delete state.inbound[fold(channel)];
}

/**
 * The gkey inner for `channel`'s current epoch, to send to `nick`'s DM:
 * `{"t":"gkey","ch":"#chan","sid":"...","key":"..."}` (§4f). Undefined
 * when no epoch exists: create one first (`createOutbound`).
 */
export function gkeyInner(
  state: GroupSessionsState,
  adapter: MegolmAdapter,
  channel: string,
): GkeyInner | undefined {
  const exported = exportOutboundKey(state, adapter, channel);
  if (exported === undefined) return undefined;
  return { t: "gkey", ch: fold(channel), sid: exported.sid, key: exported.key };
}

/**
 * Encrypts `body` for `channel` under this device's outbound session,
 * as the v3 payload of a channel `:msg`. Creates the epoch when none
 * exists (`created`): the caller distributes its key before the message
 * can be read. The chain index and the pickle are stored with the step.
 */
export function encryptChannel(
  state: GroupSessionsState,
  adapter: MegolmAdapter,
  channel: string,
  body: string,
  now: number,
): { payload: string; sid: string; index: number; created: boolean } {
  const created = outboundFor(state, channel) === undefined;
  const held = created ? createOutbound(state, adapter, channel, now) : outboundFor(state, channel);
  if (held === undefined) throw new Error(`no outbound session for ${channel}`);
  const inner = encodePayload({ t: "text", body });
  return withOutbound(adapter, held, (session) => {
    const index = session.messageIndex();
    const ciphertext = session.encrypt(megolmBytes(inner));
    const stored = storeOutbound(state, channel, session, held.createdAt, held.messages + 1);
    const payload: ChannelPayload = {
      v: GROUP_WIRE_VERSION,
      ch: fold(channel),
      sid: stored.sid,
      i: index,
      body: ciphertext,
    };
    return { payload: encodePayload(payload), sid: stored.sid, index, created };
  });
}

export type ChannelDecrypt =
  | { ok: true; kind: "text"; sid: string; index: number; body: string }
  | { ok: true; kind: "rotated"; sid: string; index: number; newSid: string }
  | {
      ok: false;
      reason: "bad-payload" | "channel-mismatch" | "no-session" | "decryption-failed" | "bad-inner";
      sid: string | null;
    };

/**
 * Decrypts a channel `:msg` payload from `sender` on `channel` with the
 * matching inbound session. A grotate inside is consumed, not shown: the
 * new epoch is imported (its key is inside, encrypted under the old one)
 * and the event says `rotated`, so the caller can note the new epoch.
 * Anything that cannot be read is `ok: false`, never a throw: an
 * undecryptable channel message surfaces as one, exactly as a DM's does.
 * The inbound pickle is stored after a decrypt: the ratchet advanced.
 */
export function decryptChannel(
  state: GroupSessionsState,
  adapter: MegolmAdapter,
  channel: string,
  sender: string,
  payloadText: string,
  now: number,
): ChannelDecrypt {
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
  const held = inboundFor(state, channel, sender, payload.sid);
  if (held === undefined) return { ok: false, reason: "no-session", sid: payload.sid };
  let plaintext: Uint8Array;
  let index: number;
  try {
    const out = withInbound(adapter, held, (session) => {
      const decrypted = session.decrypt(payload.body);
      // Stored before anything else can throw: the ratchet moved.
      const stored: StoredGroupInbound = {
        sid: session.sessionId(),
        pickle: session.pickle(),
        receivedAt: held.receivedAt,
      };
      const bySender = state.inbound[fold(channel)];
      const bySid = bySender?.[fold(sender)];
      if (bySid !== undefined) bySid[session.sessionId()] = stored;
      return decrypted;
    });
    plaintext = out.plaintext;
    index = out.messageIndex;
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
    try {
      importInbound(state, adapter, channel, sender, rotated.sid, rotated.key, now);
    } catch {
      return { ok: false, reason: "bad-inner", sid: payload.sid };
    }
    return { ok: true, kind: "rotated", sid: payload.sid, index, newSid: rotated.sid };
  }
  let text: { t: "text"; body: string };
  try {
    text = parseChannelTextInner(inner);
  } catch (err) {
    if (!(err instanceof PayloadError)) throw err;
    return { ok: false, reason: "bad-inner", sid: payload.sid };
  }
  return { ok: true, kind: "text", sid: payload.sid, index, body: text.body };
}

/**
 * Rotates `channel`'s epoch because a member left: the old outbound is
 * deleted (never spoken again), a new one created, and its key returned
 * for pairwise distribution to the members who remain. The old epoch's
 * key stays valid for what it already encrypted — a departed member can
 * re-read the past — and useless for the future: nothing new goes under
 * it. Callers also drop the departed member's inbound sessions
 * (`dropInboundFrom`); that half is not here, because the rotation and
 * the drop are judged together by the caller.
 */
export function rotateOutboundForLeave(
  state: GroupSessionsState,
  adapter: MegolmAdapter,
  channel: string,
  now: number,
): { oldSid: string | null; newSid: string; key: string } {
  const oldSid = outboundFor(state, channel)?.sid ?? null;
  deleteOutbound(state, channel);
  const created = createOutbound(state, adapter, channel, now);
  const exported = exportOutboundKey(state, adapter, channel);
  if (exported === undefined) throw new Error(`no outbound session for ${channel} after rotation`);
  return { oldSid, newSid: created.sid, key: exported.key };
}

/**
 * Rotates `channel`'s epoch because the day passed: the new key goes out
 * in ONE channel message, encrypted under the OLD epoch's key (the design
 * note's O(1) rotation: membership did not change, so the old key may
 * carry the new one). The returned payload is a v3 channel `:msg` whose
 * envelope names the OLD `sid`; the store already holds the NEW outbound
 * by the time it returns, and the old outbound pickle is gone. Null when
 * there is no epoch to rotate, or it never spoke.
 */
export function buildPeriodicRotation(
  state: GroupSessionsState,
  adapter: MegolmAdapter,
  channel: string,
  now: number,
): { payload: string; oldSid: string; newSid: string } | null {
  const held = outboundFor(state, channel);
  if (held === undefined || held.messages === 0) return null;
  const oldSid = held.sid;
  // The new epoch, created once: its key is what the rotation message
  // carries, and its pickle is what the store keeps. Minting a second
  // session here would store a key nobody holds.
  const created = adapter.createOutbound();
  let newSid: string;
  let newKey: string;
  try {
    newSid = created.sessionId();
    newKey = created.sessionKey();
    const rotate: GrotateInner = { t: "grotate", sid: newSid, key: newKey };
    const encrypted = withOutbound(adapter, held, (session) => {
      const index = session.messageIndex();
      return { index, body: session.encrypt(megolmBytes(encodePayload(rotate))) };
    });
    // Stored only once the rotation message exists: a failure above leaves
    // the old epoch in place, and the next tick tries again.
    deleteOutbound(state, channel);
    storeOutbound(state, channel, created, now, 0);
    const payload: ChannelPayload = {
      v: GROUP_WIRE_VERSION,
      ch: fold(channel),
      sid: oldSid,
      i: encrypted.index,
      body: encrypted.body,
    };
    return { payload: encodePayload(payload), oldSid, newSid };
  } finally {
    created.free();
  }
}
