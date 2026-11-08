// Channel E2E (wire v3, CLIENT_PROTOCOL §4f) — the orchestration over
// the group session store: key distribution, rotation triggers, and the
// channel send/receive paths.
//
// This module is pure over its inputs: it never touches the network, the
// Olm engine, or the wasm binding directly. It takes the group state, a
// Megolm adapter, and two callbacks — `sendDm` (a gkey inside the pairwise
// Olm DM to a nick, through `Engine.send`) and the caller's own nick and
// did — and answers the events and the outbound payloads for the caller
// (`e2e/client.ts`) to flush through grappa's send door and store. That
// keeps every rule here unit-testable with a fake adapter and a fake DM
// sender, and keeps the store's sealed persistence (`E2eState.groups`)
// the only state it mutates.
//
// THE RULES, as §4f and the design note state them:
//
//   * Distribution: the epoch key NEVER travels in the clear and NEVER
//     through the server. It goes inside the pairwise Olm DM to each
//     member, as `{"t":"gkey","ch":"#chan","sid":"...","key":"..."}`.
//   * Join: the newcomer gets the current epoch key from ONE member, so
//     the key is sent once, not once per member. The sender is
//     deterministic off the roster — the member whose folded nick sorts
//     first among the members other than the newcomer — so every member
//     computes the same sender without coordinating. A member with no
//     epoch yet creates one when its turn to send comes: it becomes the
//     epoch owner. If the designated sender has no E2E (or is away), the
//     newcomer waits: nothing here re-asks, and a later rotation or
//     re-join distributes again. (A newcomer that never receives a key
//     reads nothing; it does NOT fork a new epoch on its own — the first
//     sender to speak creates the epoch, see `sendChannel`.)
//   * Leave / kick / quit: mandatory rotation. Every remaining member
//     rotates its OWN outbound session (one sender key per sender) and
//     distributes the new key pairwise to ALL remaining members; the old
//     outbound pickle is deleted, and the departed member's inbound
//     sessions are dropped. The new key is never encrypted under the old
//     one for this: the departed member holds the old one.
//   * Periodic rotation: daily, one channel message carrying the new key
//     encrypted under the old key (membership unchanged, so the old key
//     may carry the new one). See `groupSessions.buildPeriodicRotation`.
//   * Own leave: everything of the channel is dropped. We hold no key
//     for a channel we are not in.
//
// A decrypted channel message is a `channel_received` event; one that
// cannot be read is `channel_undecryptable`, never a silent drop and never
// a crash — the DM path's rule for undecryptable messages, applied to a
// channel. Our own channel messages come back through the same inbox and
// are skipped: the sender's UI already shows the sent row from the send
// path, and re-decrypting our own epoch would only burn the chain.
//
// The decrypted text has nowhere to land yet: the channel window renders
// server rows (`scrollback.ts`), and a decrypted E2E line has no server
// id to order by. Events are therefore ALSO fanned out to the module
// listener registry (`onChannelE2eEvent`), so the channel UI can render
// them once it has a local-row design; `Report.channelE2e` (client.ts)
// carries the same events for the drain that produced them.

import type { Outbound } from "./engine";
import {
  buildPeriodicRotation,
  createOutbound,
  decryptChannel,
  dropChannel,
  dropInboundFrom,
  encryptChannel,
  type GroupSessionsState,
  gkeyInner,
  importInbound,
  outboundFor,
  rotateOutboundForLeave,
  rotationDue,
} from "./groupSessions";
import type { MegolmAdapter } from "./megolm";
import { fold, PayloadError, parseGkeyInner } from "./wire";

/** The tag of a gkey DM's `Engine.send`: its rows never exist (`chatStore` no-ops an `out` alone). */
export const GKEY_TAG = "gkey";

export type ChannelE2eEvent =
  | {
      kind: "channel_received";
      channel: string;
      from: string;
      sid: string;
      index: number;
      body: string;
    }
  | {
      kind: "channel_undecryptable";
      channel: string;
      from: string;
      sid: string | null;
      reason:
        | "bad-payload"
        | "channel-mismatch"
        | "no-session"
        | "decryption-failed"
        | "bad-inner"
        | "megolm-unavailable";
    }
  | { kind: "channel_key_received"; channel: string; from: string; sid: string }
  | { kind: "channel_key_sent"; channel: string; to: string; sid: string }
  | {
      kind: "channel_rotated";
      channel: string;
      oldSid: string | null;
      newSid: string;
      reason: "created" | "member-left" | "periodic";
    }
  | { kind: "channel_dropped"; channel: string; reason: string; detail?: string };

/** What a step answered: its events, and the payloads for the send door. */
export type ChannelE2eResult = { events: ChannelE2eEvent[]; outbound: Outbound[] };

export type ChannelE2eDeps = {
  /** The Megolm adapter (real, or a fake in tests). Null before the wasm exports land. */
  adapter: MegolmAdapter | null;
  /** Our nick on the network now. */
  ownNick: string;
  /** This device's did: the `from` of a channel `:msg`. */
  ownDid: string;
  /** The clock (ms since epoch). */
  now: () => number;
  /**
   * Sends `inner` to `nick`'s DM through the Olm engine, on the text
   * lane, and answers the outbound payloads. The engine queues for keys
   * and KEYREQs where the nick has none; a member with no E2E at all
   * waits out the queue like any DM would.
   */
  sendDm: (nick: string, inner: Record<string, unknown>) => Outbound[];
};

function emptyResult(): ChannelE2eResult {
  return { events: [], outbound: [] };
}

const foldOf = (nick: string): string => fold(nick);

/** The roster without `except`, in display spelling, folded-nick order be damned. */
function others(members: string[], except: string): string[] {
  return members.filter((m) => foldOf(m) !== foldOf(except));
}

/**
 * The one member that sends the epoch key to a newcomer: the folded-nick
 * first of the roster other than the newcomer. Deterministic off a roster
 * every member holds, so exactly one member sends. Undefined when the
 * roster names nobody else (we are alone: nothing to send to).
 */
export function designatedSender(members: string[], joined: string): string | undefined {
  const rest = others(members, joined).map((m) => ({ folded: foldOf(m), display: m }));
  rest.sort((a, b) => (a.folded < b.folded ? -1 : a.folded > b.folded ? 1 : 0));
  return rest[0]?.display;
}

/** The listeners for live channel E2E events (the channel UI, once it renders them). */
const listeners = new Set<(event: ChannelE2eEvent) => void>();

/** Subscribes to live channel E2E events; answers the unsubscribe. */
export function onChannelE2eEvent(fn: (event: ChannelE2eEvent) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Fans `events` out to the live listeners. The caller also returns them. */
export function emitChannelE2eEvents(events: ChannelE2eEvent[]): void {
  for (const event of events) {
    for (const fn of listeners) fn(event);
  }
}

/**
 * Distributes `channel`'s current epoch key to `members` (each but us),
 * creating the epoch when none exists. One gkey DM per member, through
 * the Olm engine. The caller flushes the outbound.
 */
export function distributeKey(
  deps: ChannelE2eDeps,
  groups: GroupSessionsState,
  channel: string,
  members: string[],
): ChannelE2eResult {
  const res = emptyResult();
  if (deps.adapter === null) {
    res.events.push({
      kind: "channel_dropped",
      channel,
      reason: "megolm-unavailable",
      detail: "no Megolm adapter: the epoch key cannot be made or sent",
    });
    return res;
  }
  if (outboundFor(groups, channel) === undefined) {
    const created = createOutbound(groups, deps.adapter, channel, deps.now());
    res.events.push({
      kind: "channel_rotated",
      channel,
      oldSid: null,
      newSid: created.sid,
      reason: "created",
    });
  }
  const inner = gkeyInner(groups, deps.adapter, channel);
  if (inner === undefined) return res;
  for (const member of others(members, deps.ownNick)) {
    res.outbound.push(...deps.sendDm(member, { ...inner }));
    res.events.push({ kind: "channel_key_sent", channel, to: member, sid: inner.sid });
  }
  return res;
}

/**
 * A member joined `channel` (the roster `members` is after the join).
 * We send the epoch key only when we are the designated sender, and
 * only to the newcomer: the members who already hold the epoch need no
 * copy of it. A join of our own nick sends nothing (we wait for the
 * key). Nothing is sent when the roster names nobody else.
 */
export function onMemberJoined(
  deps: ChannelE2eDeps,
  groups: GroupSessionsState,
  channel: string,
  joined: string,
  members: string[],
): ChannelE2eResult {
  if (foldOf(joined) === foldOf(deps.ownNick)) return emptyResult();
  const sender = designatedSender(members, joined);
  if (sender === undefined || foldOf(sender) !== foldOf(deps.ownNick)) return emptyResult();
  return distributeKey(deps, groups, channel, [joined]);
}

/**
 * A member left `channel` (PART, KICK, or QUIT; the roster `members` is
 * after the leave). Our own leave drops the channel outright. Any other
 * leave rotates our epoch and distributes the new key pairwise to every
 * remaining member; the departed member's inbound sessions are dropped,
 * and our old outbound pickle is deleted by the rotation itself.
 */
export function onMemberLeft(
  deps: ChannelE2eDeps,
  groups: GroupSessionsState,
  channel: string,
  left: string,
  members: string[],
): ChannelE2eResult {
  const res = emptyResult();
  if (foldOf(left) === foldOf(deps.ownNick)) {
    dropChannel(groups, channel);
    res.events.push({ kind: "channel_dropped", channel, reason: "own-leave" });
    return res;
  }
  if (deps.adapter === null) {
    res.events.push({
      kind: "channel_dropped",
      channel,
      reason: "megolm-unavailable",
      detail: "no Megolm adapter: the epoch cannot rotate on a member leaving",
    });
    return res;
  }
  dropInboundFrom(groups, channel, left);
  const rotated = rotateOutboundForLeave(groups, deps.adapter, channel, deps.now());
  res.events.push({
    kind: "channel_rotated",
    channel,
    oldSid: rotated.oldSid,
    newSid: rotated.newSid,
    reason: "member-left",
  });
  for (const member of others(members, deps.ownNick)) {
    const inner = {
      t: "gkey",
      ch: fold(channel),
      sid: rotated.newSid,
      key: rotated.key,
    };
    res.outbound.push(...deps.sendDm(member, inner));
    res.events.push({ kind: "channel_key_sent", channel, to: member, sid: rotated.newSid });
  }
  return res;
}

/**
 * Sends `body` to `channel`, encrypted under this device's epoch. When
 * no epoch exists this device becomes its owner: the key is distributed
 * pairwise to the roster first, and the channel message follows, so the
 * members can read it. The channel `:msg` itself carries no `ref` or
 * `tag`: it has no DM row to move, and the caller must not mistake it
 * for one (`client.ts` flushes untagged payloads without row changes).
 * The caller flushes the outbound, gkey DMs first, in order.
 */
export function sendChannel(
  deps: ChannelE2eDeps,
  groups: GroupSessionsState,
  channel: string,
  body: string,
  members: string[],
): ChannelE2eResult {
  const res = emptyResult();
  if (deps.adapter === null) {
    res.events.push({
      kind: "channel_dropped",
      channel,
      reason: "megolm-unavailable",
      detail: "no Megolm adapter: the channel message cannot be encrypted",
    });
    return res;
  }
  const encrypted = encryptChannel(groups, deps.adapter, channel, body, deps.now());
  if (encrypted.created) {
    // The epoch is new: nobody holds its key yet. Distribute it first,
    // before the message that needs it.
    const distributed = distributeKey(deps, groups, channel, members);
    // `distributeKey` sees the epoch already exists, so it sends the key
    // without re-creating it; its `created` event is ours to report.
    res.events.push({
      kind: "channel_rotated",
      channel,
      oldSid: null,
      newSid: encrypted.sid,
      reason: "created",
    });
    res.events.push(...distributed.events);
    res.outbound.push(...distributed.outbound);
  }
  res.outbound.push({
    target: channel,
    verb: "msg",
    from: deps.ownDid,
    to: "*",
    payload: encrypted.payload,
    priority: "text",
  });
  return res;
}

/**
 * A channel `:msg` from `from` on `channel`, as grappa delivered it:
 * decrypts it, consumes a rotation inside it, or surfaces it as
 * undecryptable. Our own messages are skipped (the send path showed
 * them). Never throws on wire input.
 */
export function receiveChannel(
  deps: ChannelE2eDeps,
  groups: GroupSessionsState,
  channel: string,
  from: string,
  payloadText: string,
): ChannelE2eEvent[] {
  if (foldOf(from) === foldOf(deps.ownNick)) return [];
  if (deps.adapter === null) {
    return [
      {
        kind: "channel_undecryptable",
        channel,
        from,
        sid: null,
        reason: "megolm-unavailable",
      },
    ];
  }
  const decrypted = decryptChannel(groups, deps.adapter, channel, from, payloadText, deps.now());
  if (!decrypted.ok) {
    return [
      {
        kind: "channel_undecryptable",
        channel,
        from,
        sid: decrypted.sid,
        reason: decrypted.reason,
      },
    ];
  }
  if (decrypted.kind === "rotated") {
    return [
      {
        kind: "channel_key_received",
        channel,
        from,
        sid: decrypted.newSid,
      },
    ];
  }
  return [
    {
      kind: "channel_received",
      channel,
      from,
      sid: decrypted.sid,
      index: decrypted.index,
      body: decrypted.body,
    },
  ];
}

/**
 * A gkey DM from `from`, as the Olm engine delivered its inner message:
 * imports the inbound session it carries. A re-sent key is a no-op
 * (the stored ratchet is further along); a key for another session id,
 * or one Megolm refuses, is dropped, never stored. Never throws on wire
 * input.
 */
export function receiveGkey(
  deps: ChannelE2eDeps,
  groups: GroupSessionsState,
  inner: Record<string, unknown>,
  from: string,
): ChannelE2eEvent[] {
  let gkey: { t: "gkey"; ch: string; sid: string; key: string };
  try {
    gkey = parseGkeyInner(inner);
  } catch (err) {
    if (!(err instanceof PayloadError)) throw err;
    return [
      {
        kind: "channel_dropped",
        channel: typeof inner.ch === "string" ? inner.ch : "?",
        reason: "bad-gkey",
        detail: err.message,
      },
    ];
  }
  if (deps.adapter === null) {
    return [
      {
        kind: "channel_dropped",
        channel: gkey.ch,
        reason: "megolm-unavailable",
        detail: "no Megolm adapter: the gkey cannot be imported",
      },
    ];
  }
  try {
    const imported = importInbound(
      groups,
      deps.adapter,
      gkey.ch,
      from,
      gkey.sid,
      gkey.key,
      deps.now(),
    );
    return imported === "imported"
      ? [{ kind: "channel_key_received", channel: gkey.ch, from, sid: gkey.sid }]
      : [];
  } catch (err) {
    return [
      {
        kind: "channel_dropped",
        channel: gkey.ch,
        reason: "bad-gkey",
        detail: err instanceof Error ? err.message : String(err),
      },
    ];
  }
}

/**
 * The periodic rotations due now, across `channels`: one channel `:msg`
 * each, the new key encrypted under the old key. A channel whose epoch
 * never spoke, or is not due, is skipped. The caller flushes the
 * outbound; each payload is untagged (no DM row), as in `sendChannel`.
 */
export function rotateDue(
  deps: ChannelE2eDeps,
  groups: GroupSessionsState,
  channels: string[],
): ChannelE2eResult {
  const res = emptyResult();
  if (deps.adapter === null) return res;
  for (const channel of channels) {
    if (!rotationDue(groups, channel, deps.now())) continue;
    const rotated = buildPeriodicRotation(groups, deps.adapter, channel, deps.now());
    if (rotated === null) continue;
    res.events.push({
      kind: "channel_rotated",
      channel,
      oldSid: rotated.oldSid,
      newSid: rotated.newSid,
      reason: "periodic",
    });
    res.outbound.push({
      target: channel,
      verb: "msg",
      from: deps.ownDid,
      to: "*",
      payload: rotated.payload,
      priority: "text",
    });
  }
  return res;
}

/** The channels this device holds an outbound epoch for. */
export function channelsWithEpoch(groups: GroupSessionsState): string[] {
  return Object.keys(groups.outbound);
}
