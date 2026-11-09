// Channel E2E (wire v4, CLIENT_PROTOCOL §4f) — the orchestration over
// the epoch store: key distribution, rotation triggers, and the channel
// send/receive paths.
//
// This module is pure over its inputs: it never touches the network, the
// Olm engine, or the wasm binding directly. It takes the group state, the
// signing and verification callbacks, and `sendDm` (a gkey inside the
// pairwise Olm DM to a nick, through `Engine.send`), and answers the
// events and the outbound payloads for the caller (`e2e/client.ts`) to
// flush through grappa's send door and store. That keeps every rule here
// unit-testable with a fake DM sender and test keys, and keeps the store's
// sealed persistence (`E2eState.groups`) the only state it mutates.
//
// THE RULES, as §4f states them:
//
//   * Distribution: the epoch key NEVER travels in the clear and NEVER
//     through the server. It goes inside the pairwise Olm DM to each
//     member, as `{"t":"gkey","ch":"#chan","sid":"...","key":"...",
//     "holders":["..."]}`, with the nick mapping for those dids and the
//     sent-to nicks for the members whose device lists were unknown.
//     The DM goes out by nick even to a member whose list is unknown:
//     the engine resolves its keys lazily (KEYREQ), so the member still
//     gets the key — it just cannot be named in the holder set until its
//     dids land, and the reconcile moves it there. The mapping travels
//     in the inner, so every holder learns which nick each holder did
//     belongs to.
//   * Join: the newcomer ASKS. It broadcasts a key request on the
//     channel (`{"v":4,"t":"keyreq","ch":"#chan"}`), and the first member
//     with an open cic who holds the epoch answers with a gkey DM;
//     duplicate answers are harmless, the first valid import wins. If
//     nobody holds an epoch yet, only the member the channel topic names
//     as its key holder (`[e2e:1 key-from=<nick>]`) mints the first one,
//     and only to answer an explicit key request. If nobody has an open
//     cic, the newcomer waits: the request sits in every member's inbox
//     until one opens a cic and answers it. There is no server-side
//     fallback.
//   * Send: a row without a key waits in queue. It never mints an epoch
//     of its own, and never goes out in the clear: the key request goes
//     out on the channel, and the row goes out under the key once
//     someone with an open cic gives it. Cleartext only when the client
//     asks and the user confirms, per row or until the key arrives —
//     never automatically, never silently; the step has no such path.
//   * Leave / kick / quit: mandatory rotation. The rotator is
//     deterministic off the roster — the device whose did sorts first
//     among the REMAINING holder dids — so exactly one member mints the
//     new epoch and distributes it pairwise to ALL remaining members; the
//     old epoch is deleted. The new key is never encrypted under the old
//     one for this: the departed member holds the old one. The departed
//     member's dids come from the epoch's nick mapping (carried in the
//     gkey inner), so any holder can tell a holder left without ever
//     having DM'd them; a member the key was sent to whose dids never
//     landed counts as a holder too. A member whose audit finds a
//     departed holder rotates too — but only when it IS the designated
//     rotator (first remaining holder did): a closed designated
//     rotator's rotation waits, nobody else usurps it, there is no
//     timeout election.
//   * Periodic rotation: daily, one channel message carrying the new key
//     encrypted under the old key (membership unchanged, so the old key
//     may carry the new one). The rotator is the first holder did.
//     See `groupSessions.buildPeriodicRotation`.
//   * Own leave: everything of the channel is dropped. We hold no key
//     for a channel we are not in. Our own rejoin drops the epoch held
//     before the leave: it predates the rotation the others did without
//     us, so it is dead, and the newcomer asks for the key again.
//   * Audit: on cic open and before every send, the holder set is
//     compared with the true roster, in dids; anyone in the set who is no
//     longer in the roster triggers rotation (§4f, F4). A holder did
//     counts as still a member when a roster device list names it, or
//     when the nick mapping attributes it to a nick still on the roster —
//     the mapping is what settles a member this cic has not chatted
//     with. Otherwise the epoch rotates, fail closed: a missed departure
//     is a leak, a spurious rotation is one new epoch. A rename whose
//     new nick's list has not landed yet rotates once, until the list
//     lands and the did check settles it.
//
// A decrypted channel message is a `channel_received` event; one that
// cannot be read is `channel_undecryptable`, never a silent drop and never
// a crash — the DM path's rule for undecryptable messages, applied to a
// channel. Our own channel messages come back through the same inbox and
// are skipped: the sender's UI already shows the sent row from the send
// path.
//
// The decrypted text has nowhere to land yet: the channel window renders
// server rows (`scrollback.ts`), and a decrypted E2E line has no server
// id to order by. Events are therefore ALSO fanned out to the module
// listener registry (`onChannelE2eEvent`), so the channel UI can render
// them once it has a local-row design; `Report.channelE2e` (client.ts)
// carries the same events for the drain that produced them.

import { atNick, type ByNick, nickEntries, noNicks, setNick } from "./byNick";
import type { Outbound } from "./engine";
import {
  buildPeriodicRotation,
  type ChannelSigner,
  type ChannelVerifier,
  createEpoch,
  decryptChannel,
  dropChannel,
  dropEpoch,
  encryptChannel,
  epochFor,
  epochHoldersStale,
  epochRemainingHolders,
  type GroupSessionsState,
  gkeyInner,
  holderNicksOf,
  holdersStale,
  holdGkey,
  importEpoch,
  keyreqAnswerDue,
  keyreqPayload,
  keyreqSentAtFor,
  markKeyreqAnswered,
  markKeyreqSent,
  queuePendingSend,
  type RosterDids,
  rotateEpochForLeave,
  rotationDue,
  sentToOf,
  takeHeldGkeys,
  takePendingSends,
} from "./groupSessions";
import {
  decodePayload,
  fold,
  type GkeyInner,
  PayloadError,
  parseChannelKeyreqPayload,
  parseGkeyInner,
} from "./wire";

/** The tag of a gkey DM's `Engine.send`: its rows never exist (`chatStore` no-ops an `out` alone). */
export const GKEY_TAG = "gkey";

export type ChannelE2eEvent =
  | {
      kind: "channel_received";
      channel: string;
      from: string;
      sid: string;
      counter: number;
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
        | "bad-signature"
        | "replay"
        | "decryption-failed"
        | "bad-inner";
    }
  | { kind: "channel_key_received"; channel: string; from: string; sid: string }
  | { kind: "channel_key_sent"; channel: string; to: string; sid: string }
  | { kind: "channel_key_failed"; channel: string; to: string; sid: string; reason: string }
  | { kind: "channel_key_requested"; channel: string }
  | {
      kind: "channel_key_missing";
      channel: string;
    }
  | {
      kind: "channel_rotated";
      channel: string;
      oldSid: string | null;
      newSid: string;
      reason: "created" | "member-left" | "periodic";
    }
  | { kind: "channel_dropped"; channel: string; reason: string; detail?: string };

/**
 * What a step answered: its events, the payloads for the send door, and
 * `copies` — one per gkey DM sent, naming the peer it went to and the
 * exact gkey inner as JSON, so the caller can pass the same key to this
 * device's other devices. Always present, empty when no gkey went out.
 */
export type ChannelE2eResult = {
  events: ChannelE2eEvent[];
  outbound: Outbound[];
  copies: { peer: string; body: string }[];
};

export type ChannelE2eDeps = {
  /** Our nick on the network now. */
  ownNick: string;
  /** This device's did: the `from` of a channel `:msg`. */
  ownDid: string;
  /** The clock (ms since epoch). */
  now: () => number;
  /** Signs a channel message's text with this device's Ed25519 key. */
  sign: ChannelSigner;
  /** Whether a channel message's signature is its sender's device key's, pinned. */
  verify: ChannelVerifier;
  /**
   * The roster of `channel`, as the caller holds it, or undefined when the
   * caller has none: the gkey staleness check and the periodic-rotation
   * election skip when it is missing (the audit is what enforces them).
   */
  rosterFor?: (channel: string) => string[] | undefined;
  /**
   * The dids of `nick`'s devices as this cic knows them — its pinned
   * master's device list — or undefined when the list is unknown: the
   * holders and the roster are per did, never per nick, so every step
   * that names who holds the key resolves through here.
   */
  didsFor: (nick: string) => string[] | undefined;
  /**
   * The nick the topic of `channel` names as the holder of its epoch key
   * (`[e2e:1 key-from=<nick>]`), or undefined when the channel's topic
   * carries no such tag: the designee — the one member who mints the
   * first epoch, and only to answer an explicit key request. Absent when
   * the caller holds no topics: nobody bootstraps, and the newcomer
   * waits.
   */
  keyFromFor?: (channel: string) => string | undefined;
  /**
   * Sends `inner` to `nick`'s DM through the Olm engine, on the text
   * lane, and answers the outbound payloads. The engine queues for keys
   * and KEYREQs where the nick has none; a member with no E2E at all
   * waits out the queue like any DM would.
   */
  sendDm: (nick: string, inner: Record<string, unknown>) => Outbound[];
};

function emptyResult(): ChannelE2eResult {
  return { events: [], outbound: [], copies: [] };
}

const foldOf = (nick: string): string => fold(nick);

/** The roster without `except`, in display spelling. */
function others(members: string[], except: string): string[] {
  return members.filter((m) => foldOf(m) !== foldOf(except));
}

/**
 * The dids `nicks` resolve to, as this cic knows them: a nick whose
 * device list is unknown contributes none — it holds no key this device
 * can name, so it is not distributed to and not counted a holder until
 * its list lands and it asks. This device's own did is included when
 * the roster names us: the roster names us, and our list is not a
 * peer's — but only then, so a roster we are no longer on does not
 * count us as still a member of it.
 */
function didsOf(deps: ChannelE2eDeps, nicks: string[]): string[] {
  const dids = new Set<string>();
  for (const nick of nicks) {
    for (const did of deps.didsFor(nick) ?? []) dids.add(did);
  }
  if (nicks.some((nick) => foldOf(nick) === foldOf(deps.ownNick))) dids.add(deps.ownDid);
  return [...dids];
}

/**
 * `members` resolved for a distribution: the dids the key goes to, the
 * nick mapping for them (`byNick`), and the members whose device lists
 * are unknown (`unknown`, folded nicks) — the key is still DM'd to them
 * by nick, and they move into the holder set once their dids land.
 * Ourselves are never a DM recipient: our dids are in `dids`, our nick
 * in `byNick` when our list is known.
 */
function resolveMembers(
  deps: ChannelE2eDeps,
  members: string[],
): { dids: string[]; byNick: ByNick<string[]>; unknown: string[] } {
  const dids = didsOf(deps, members);
  const byNick = noNicks<string[]>();
  const unknown: string[] = [];
  for (const member of members) {
    const known = deps.didsFor(member);
    if (known !== undefined) {
      setNick(byNick, member, [...known]);
    } else if (foldOf(member) !== foldOf(deps.ownNick)) {
      unknown.push(foldOf(member));
    }
  }
  return { dids, byNick, unknown };
}

/** The roster `members` as the audit sees it: its nicks and the dids they resolve to. */
function resolveRoster(deps: ChannelE2eDeps, members: string[]): RosterDids {
  return { nicks: [...members], dids: didsOf(deps, members) };
}

/**
 * Moves `channel`'s sent-to nicks whose device lists have landed into
 * the holder set: a member the key was DM'd to while unknown is a holder
 * once its dids are known, and the nick mapping learns them. Runs
 * before any check that consults the holders, so the set is fresh.
 */
function reconcileSentTo(deps: ChannelE2eDeps, groups: GroupSessionsState, channel: string): void {
  const held = epochFor(groups, channel);
  if (held === undefined) return;
  const sentTo = sentToOf(held);
  if (sentTo.length > 0) {
    const byNick = holderNicksOf(held);
    const remaining: string[] = [];
    for (const nick of sentTo) {
      const dids = deps.didsFor(nick);
      if (dids === undefined) {
        remaining.push(nick);
        continue;
      }
      setNick(byNick, nick, [...dids]);
      for (const did of dids) {
        if (!held.holders.includes(did)) held.holders.push(did);
      }
    }
    held.holderNicks = byNick;
    held.sentTo = remaining;
  }
  // A gkey held while the roster was unknown is retried now: the audit
  // runs on roster seed, so this is the moment its checks can run for
  // real. A retry that still cannot run stays held; one that imports
  // updates the epoch in place, and the audit below then judges the
  // new epoch. The retry's events have nowhere to go here — the audit
  // has no event channel — so a drop in this path is silent; the
  // import, which is what heals the epoch, is not.
  retryHeldGkeys(deps, groups, channel);
}

/**
 * Whether `from`'s device `fromDid` is on `roster`: the did check, when
 * the sender's device list is known — the sending device must be one of
 * the roster's devices, not merely one of the sender's own — and the
 * nick check when it is not yet known, the strength available until the
 * list lands. The audit re-checks in dids once it does.
 */
function senderOnRoster(
  deps: ChannelE2eDeps,
  roster: string[],
  from: string,
  fromDid: string,
): boolean {
  if (deps.didsFor(from) === undefined) {
    return roster.some((m) => foldOf(m) === foldOf(from));
  }
  return didsOf(deps, roster).includes(fromDid);
}

/**
 * The one device that rotates an epoch: the first did, in sorted order,
 * of `holders` (already dids). Deterministic off a holder set every
 * member holds, so exactly one member rotates without coordinating.
 * Undefined when nobody holds the epoch.
 */
export function designatedRotator(holders: string[]): string | undefined {
  const sorted = [...holders].sort();
  return sorted[0];
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
 * the Olm engine, by nick: the engine resolves a member's keys lazily
 * (KEYREQ) where it has none, so a member whose device list is unknown
 * still gets the key — it just cannot be named in the holder set yet.
 * The epoch records the nick mapping for the dids known and the sent-to
 * nicks for the ones unknown, and the gkey inner carries both, so every
 * holder learns them. The caller flushes the outbound.
 */
export function distributeKey(
  deps: ChannelE2eDeps,
  groups: GroupSessionsState,
  channel: string,
  members: string[],
): ChannelE2eResult {
  const res = emptyResult();
  if (epochFor(groups, channel) === undefined) {
    const resolved = resolveMembers(deps, members);
    const created = createEpoch(groups, channel, resolved.dids, deps.now(), {
      holderNicks: resolved.byNick,
      sentTo: resolved.unknown,
      minter: deps.ownDid,
    });
    res.events.push({
      kind: "channel_rotated",
      channel,
      oldSid: null,
      newSid: created.sid,
      reason: "created",
    });
  }
  const inner = gkeyInner(groups, channel);
  if (inner === undefined) return res;
  for (const member of others(members, deps.ownNick)) {
    const sent = { ...inner };
    res.outbound.push(...deps.sendDm(member, sent));
    res.copies.push({ peer: member, body: JSON.stringify(sent) });
    res.events.push({ kind: "channel_key_sent", channel, to: member, sid: inner.sid });
  }
  return res;
}

/**
 * Broadcasts a key request for `channel` on the channel itself: the ask
 * a newcomer makes when it holds no epoch. The caller flushes the
 * outbound; every member with an open cic who holds the epoch answers
 * with a gkey DM (`onKeyreq`). Nothing when an epoch is already held:
 * there is nothing to ask for. The request is recorded, so a first
 * epoch is only imported after asking (`receiveGkey`).
 */
export function requestKey(
  deps: ChannelE2eDeps,
  groups: GroupSessionsState,
  channel: string,
): ChannelE2eResult {
  const res = emptyResult();
  if (epochFor(groups, channel) !== undefined) return res;
  markKeyreqSent(groups, channel, deps.now());
  res.events.push({ kind: "channel_key_requested", channel });
  res.outbound.push({
    target: channel,
    verb: "msg",
    from: deps.ownDid,
    to: "*",
    payload: keyreqPayload(channel),
    priority: "text",
  });
  return res;
}

/**
 * A key request on `channel` from `from`'s device `fromDid`, as the drain
 * delivered it: the first member with an open cic who holds the epoch
 * answers with a gkey DM. Duplicate answers are harmless (the first valid
 * import wins), so the answer is throttled per asker device, not elected:
 * every holder answers once per asker per minute. The asker is answered
 * only while their device is on the roster — an ask answered days later,
 * after the asker left, would hand the key to someone no longer in the
 * channel — and not at all when no roster is held: other members can
 * answer, and the asker can re-ask. The asker's did joins the stored
 * epoch's holder set before the gkey is built, so the key they receive
 * names their device and their later exit rotates the epoch. When the
 * answer enlarged the holder set, the updated key is re-distributed to
 * the holders this device knows, so their sets converge on the new
 * member too — the rotator learns them even though it did not answer.
 * Nothing when no epoch is held — except the bootstrap: the topic
 * designee (`keyFromFor`) mints the first epoch to answer an explicit
 * key request, and only then. Minting to answer an ask is the bootstrap,
 * not a send side effect: a send without a key queues, it never mints.
 */
export function onKeyreq(
  deps: ChannelE2eDeps,
  groups: GroupSessionsState,
  channel: string,
  from: string,
  fromDid: string,
): ChannelE2eResult {
  const res = emptyResult();
  if (foldOf(from) === foldOf(deps.ownNick)) return res;
  const roster = deps.rosterFor?.(channel);
  if (roster === undefined || !senderOnRoster(deps, roster, from, fromDid)) return res;
  if (!keyreqAnswerDue(groups, channel, fromDid, deps.now())) return res;
  const held = epochFor(groups, channel);
  if (held === undefined) {
    // The bootstrap: only the topic designee mints the first epoch, and
    // only to answer an explicit key request. Anyone else waits for the
    // designee (or a member who holds the epoch) to answer.
    const designee = deps.keyFromFor?.(channel);
    if (designee === undefined || foldOf(designee) !== foldOf(deps.ownNick)) return res;
    const minted = distributeKey(deps, groups, channel, roster);
    res.events.push(...minted.events);
    res.outbound.push(...minted.outbound);
    res.copies.push(...minted.copies);
    // The distribution already sent the asker the key: the ask is
    // answered, so a duplicate inside the minute does not mint again.
    markKeyreqAnswered(groups, channel, fromDid, deps.now());
    return res;
  }
  markKeyreqAnswered(groups, channel, fromDid, deps.now());
  let changed = false;
  if (!held.holders.includes(fromDid)) {
    held.holders.push(fromDid);
    changed = true;
  }
  const byNick = holderNicksOf(held);
  const known = atNick(byNick, from) ?? [];
  if (!known.includes(fromDid)) {
    setNick(byNick, from, [...new Set([...known, fromDid])]);
    changed = true;
  }
  held.holderNicks = byNick;
  const sentTo = sentToOf(held).filter((nick) => foldOf(nick) !== foldOf(from));
  if (sentTo.length !== sentToOf(held).length) changed = true;
  held.sentTo = sentTo;
  const inner = gkeyInner(groups, channel);
  if (inner === undefined) return res;
  const sent = { ...inner };
  res.outbound.push(...deps.sendDm(from, sent));
  res.copies.push({ peer: from, body: JSON.stringify(sent) });
  res.events.push({ kind: "channel_key_sent", channel, to: from, sid: inner.sid });
  if (changed) {
    // The answerer learned a member the other holders do not know yet:
    // re-distribute the updated key — same sid, same seq, enlarged
    // holder set — to the holders it knows, so their sets converge and
    // the rotator, whoever it is, rotates at that member's exit. The
    // asker already has this key; ourselves need no DM. A re-send of
    // the same epoch merges on arrival, so a duplicate is harmless.
    const recipients = new Set<string>();
    for (const [nick] of nickEntries(holderNicksOf(held))) recipients.add(nick);
    for (const nick of sentToOf(held)) recipients.add(nick);
    recipients.delete(foldOf(deps.ownNick));
    recipients.delete(foldOf(from));
    for (const nick of recipients) {
      const redistributed = { ...inner };
      res.outbound.push(...deps.sendDm(nick, redistributed));
      res.copies.push({ peer: nick, body: JSON.stringify(redistributed) });
      res.events.push({ kind: "channel_key_sent", channel, to: nick, sid: inner.sid });
    }
  }
  return res;
}

/**
 * A member joined `channel` (the roster `members` is after the join).
 * Our own join drops the epoch held before the leave: it predates the
 * rotation the others did without us, so it is dead, and the newcomer
 * asks for the key again through the channel UI (`requestKey`) — never
 * here, so a cleartext channel's joins stay silent. A join of anyone
 * else sends nothing: they ask with a key request, and the holders
 * answer it.
 */
export function onMemberJoined(
  deps: ChannelE2eDeps,
  groups: GroupSessionsState,
  channel: string,
  joined: string,
  members: string[],
): ChannelE2eResult {
  void members;
  const res = emptyResult();
  if (foldOf(joined) !== foldOf(deps.ownNick)) return res;
  if (epochFor(groups, channel) === undefined) return res;
  dropEpoch(groups, channel);
  res.events.push({
    kind: "channel_dropped",
    channel,
    reason: "rejoined",
    detail: "the epoch held before the leave is dead; ask for the key again",
  });
  return res;
}

/**
 * A member left `channel` (PART, KICK, or QUIT; the roster `members` is
 * after the leave). Our own leave drops the channel outright. Any other
 * leave rotates the epoch only when a device of the departed member held
 * the key AND this device is the designated rotator: the first holder
 * did in sorted order mints the new epoch and distributes it pairwise
 * to every remaining member. A leave of someone who never held the key
 * rotates nothing, and a channel with no epoch rotates nothing either —
 * the rotation is gated on the epoch, so a cleartext channel's joins and
 * parts never mint one.
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
  const held = epochFor(groups, channel);
  if (held === undefined) return res;
  // The departed member's dids come from the epoch's nick mapping —
  // carried in the gkey inner, so any holder can resolve them without
  // ever having DM'd the departed member — falling back to this cic's
  // own device list for them. A member the key was sent to whose dids
  // never landed counts as a holder too: the DM may still reach them.
  // Either way the rotation is gated on the epoch, so a cleartext
  // channel's joins and parts never mint one.
  const leftDids = atNick(holderNicksOf(held), left) ?? deps.didsFor(left) ?? [];
  if (
    !held.holders.some((holder) => leftDids.includes(holder)) &&
    !sentToOf(held).some((nick) => foldOf(nick) === foldOf(left))
  ) {
    return res;
  }
  const remaining = others(members, deps.ownNick);
  const resolved = resolveMembers(deps, members);
  const remainingDids = resolved.dids;
  const remainingHolders = held.holders.filter((holder) => remainingDids.includes(holder));
  if (designatedRotator(remainingHolders) !== deps.ownDid) return res;
  const rotated = rotateEpochForLeave(groups, channel, remainingDids, deps.now(), {
    holderNicks: resolved.byNick,
    sentTo: resolved.unknown,
  });
  res.events.push({
    kind: "channel_rotated",
    channel,
    oldSid: rotated.oldSid,
    newSid: rotated.newSid,
    reason: "member-left",
  });
  const inner = gkeyInner(groups, channel);
  if (inner === undefined) return res;
  for (const member of remaining) {
    const sent = { ...inner };
    res.outbound.push(...deps.sendDm(member, sent));
    res.copies.push({ peer: member, body: JSON.stringify(sent) });
    res.events.push({ kind: "channel_key_sent", channel, to: member, sid: rotated.newSid });
  }
  return res;
}

/**
 * The audit (§4f): `channel`'s epoch holder set against the true roster
 * `members`, in dids. Any holder did no longer in the roster triggers
 * rotation — the new epoch goes pairwise to the roster that remains —
 * which covers an exit that happened while every cic was closed. The
 * sent-to nicks are reconciled first, so a member whose list landed
 * counts as the holder it is. Exactly one rotates: the first remaining
 * holder did in sorted order. A device that is not the designated
 * rotator waits — the rotator's cic is the one that rotates, and if its
 * cic is closed the rotation waits with it: nobody else usurps it, and
 * there is no timeout election (two minters would bifurcate the epoch).
 * Nothing when the holders are all still members, or no epoch is held.
 */
export function auditEpochRotation(
  deps: ChannelE2eDeps,
  groups: GroupSessionsState,
  channel: string,
  members: string[],
): ChannelE2eResult {
  const res = emptyResult();
  reconcileSentTo(deps, groups, channel);
  const roster = resolveRoster(deps, members);
  if (!epochHoldersStale(groups, channel, roster)) return res;
  if (designatedRotator(epochRemainingHolders(groups, channel, roster)) !== deps.ownDid) {
    return res;
  }
  const resolved = resolveMembers(deps, members);
  const rotated = rotateEpochForLeave(groups, channel, resolved.dids, deps.now(), {
    holderNicks: resolved.byNick,
    sentTo: resolved.unknown,
  });
  res.events.push({
    kind: "channel_rotated",
    channel,
    oldSid: rotated.oldSid,
    newSid: rotated.newSid,
    reason: "member-left",
  });
  const inner = gkeyInner(groups, channel);
  if (inner === undefined) return res;
  for (const member of others(members, deps.ownNick)) {
    const sent = { ...inner };
    res.outbound.push(...deps.sendDm(member, sent));
    res.copies.push({ peer: member, body: JSON.stringify(sent) });
    res.events.push({ kind: "channel_key_sent", channel, to: member, sid: inner.sid });
  }
  return res;
}

/**
 * Sends the rows queued for `channel` now that an epoch exists, in the
 * order they were queued: the key arrived, so they go out under it.
 * Nothing when no epoch is held — the rows keep waiting — and no event:
 * a sent channel row has nowhere to render yet, so the flush is silent
 * in the report (the door still reconciles a refusal into a drop).
 */
export async function flushPendingSends(
  deps: ChannelE2eDeps,
  groups: GroupSessionsState,
  channel: string,
): Promise<ChannelE2eResult> {
  const res = emptyResult();
  if (epochFor(groups, channel) === undefined) return res;
  for (const pending of takePendingSends(groups, channel)) {
    const encrypted = await encryptChannel(groups, channel, pending.body, deps.sign);
    res.outbound.push({
      target: channel,
      verb: "msg",
      from: deps.ownDid,
      to: "*",
      payload: encrypted.payload,
      priority: "text",
    });
  }
  return res;
}

/**
 * Sends `body` to `channel`, encrypted under the channel's epoch. The
 * holder set is audited against the roster first: a departed holder
 * rotates the epoch before anything goes under it. When no epoch is
 * held the row waits in queue — it never mints one, and never goes out
 * in the clear: the key request goes out on the channel, and the row
 * goes out under the key once someone with an open cic gives it. What
 * waited before it goes first, in order. The channel `:msg` itself
 * carries no `ref` or `tag`: it has no DM row to move, and the caller
 * must not mistake it for one (`client.ts` flushes untagged payloads
 * without row changes). The caller flushes the outbound, gkey DMs first,
 * in order.
 */
export async function sendChannel(
  deps: ChannelE2eDeps,
  groups: GroupSessionsState,
  channel: string,
  body: string,
  members: string[],
): Promise<ChannelE2eResult> {
  const res = emptyResult();
  const audited = auditEpochRotation(deps, groups, channel, members);
  res.events.push(...audited.events);
  res.outbound.push(...audited.outbound);
  res.copies.push(...audited.copies);
  if (epochFor(groups, channel) === undefined) {
    for (const dropped of queuePendingSend(groups, channel, body, deps.now())) {
      res.events.push({
        kind: "channel_dropped",
        channel,
        reason: "send-queue-full",
        detail: dropped.body,
      });
    }
    const asked = requestKey(deps, groups, channel);
    res.events.push({ kind: "channel_key_missing", channel });
    res.events.push(...asked.events);
    res.outbound.push(...asked.outbound);
    res.copies.push(...asked.copies);
    return res;
  }
  const flushed = await flushPendingSends(deps, groups, channel);
  res.outbound.push(...flushed.outbound);
  res.copies.push(...flushed.copies);
  const encrypted = await encryptChannel(groups, channel, body, deps.sign);
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
 * A channel `:msg` from `from`'s device `fromDid` on `channel`, as grappa
 * delivered it: a key request is answered with the epoch key, a message
 * is decrypted, a rotation inside it is consumed, or it surfaces as
 * undecryptable. Our own messages are skipped (the send path showed
 * them). Never throws on wire input.
 */
export async function receiveChannel(
  deps: ChannelE2eDeps,
  groups: GroupSessionsState,
  channel: string,
  from: string,
  fromDid: string,
  payloadText: string,
): Promise<ChannelE2eResult> {
  if (foldOf(from) === foldOf(deps.ownNick)) return emptyResult();
  let decoded: Record<string, unknown>;
  try {
    decoded = decodePayload(payloadText);
  } catch {
    return {
      events: [
        {
          kind: "channel_undecryptable",
          channel,
          from,
          sid: null,
          reason: "bad-payload",
        },
      ],
      outbound: [],
      copies: [],
    };
  }
  if (decoded.t === "keyreq") {
    try {
      const keyreq = parseChannelKeyreqPayload(decoded);
      if (fold(keyreq.ch) !== fold(channel)) {
        return {
          events: [
            {
              kind: "channel_undecryptable",
              channel,
              from,
              sid: null,
              reason: "channel-mismatch",
            },
          ],
          outbound: [],
          copies: [],
        };
      }
    } catch (err) {
      if (!(err instanceof PayloadError)) throw err;
      return {
        events: [
          {
            kind: "channel_undecryptable",
            channel,
            from,
            sid: null,
            reason: "bad-payload",
          },
        ],
        outbound: [],
        copies: [],
      };
    }
    return onKeyreq(deps, groups, channel, from, fromDid);
  }
  const decrypted = await decryptChannel(
    groups,
    channel,
    from,
    fromDid,
    payloadText,
    deps.verify,
    deps.now(),
  );
  if (!decrypted.ok) {
    return {
      events: [
        {
          kind: "channel_undecryptable",
          channel,
          from,
          sid: decrypted.sid,
          reason: decrypted.reason,
        },
      ],
      outbound: [],
      copies: [],
    };
  }
  if (decrypted.kind === "rotated") {
    // The grotate carried the new epoch under the old one's key, and this
    // device decrypted it: it holds the new epoch too, so its did joins
    // the holder set, and the nick mapping learns it.
    const held = epochFor(groups, channel);
    if (held !== undefined && held.sid === decrypted.newSid) {
      if (!held.holders.includes(deps.ownDid)) held.holders.push(deps.ownDid);
      const byNick = holderNicksOf(held);
      const known = atNick(byNick, deps.ownNick) ?? [];
      setNick(byNick, deps.ownNick, [...new Set([...known, deps.ownDid])]);
      held.holderNicks = byNick;
    }
    return {
      events: [
        {
          kind: "channel_key_received",
          channel,
          from,
          sid: decrypted.newSid,
        },
      ],
      outbound: [],
      copies: [],
    };
  }
  return {
    events: [
      {
        kind: "channel_received",
        channel,
        from,
        sid: decrypted.sid,
        counter: decrypted.counter,
        body: decrypted.body,
      },
    ],
    outbound: [],
    copies: [],
  };
}

/**
 * The import of one gkey, with the checks `receiveGkey` runs: the
 * sender's device must be on the roster when one is held — its did must
 * be one of the sender's devices, falling back to the nick while the
 * sender's list is unknown — and a first epoch is imported only after
 * this device asked for the key — a key nobody asked for never arms the
 * channel. A re-sent key merges its holder set into the held epoch; a
 * key for an epoch whose holders name a did no longer in the roster is
 * stale and is dropped, never stored; a key whose seq is not a first
 * epoch at 0, a successor at exactly the held seq + 1, or a same-seq
 * rival that wins the minter tie-break is superseded and is dropped,
 * never stored; a key that is not an epoch key is dropped, never
 * stored. The importer's own did joins the holder set: it holds the
 * key now. `held: true` means the gkey was NOT judged: an epoch is held
 * but no roster is, so the sender and staleness checks would run
 * provisionally — the caller holds it for retry instead. Never throws
 * on wire input.
 */
function attemptGkey(
  deps: ChannelE2eDeps,
  groups: GroupSessionsState,
  gkey: GkeyInner,
  from: string,
  fromDid: string,
): { events: ChannelE2eEvent[]; held: boolean } {
  const roster = deps.rosterFor?.(gkey.ch);
  if (roster !== undefined && !senderOnRoster(deps, roster, from, fromDid)) {
    return {
      events: [
        {
          kind: "channel_dropped",
          channel: gkey.ch,
          reason: "sender-not-in-roster",
          detail: "the sender's device is not on the roster",
        },
      ],
      held: false,
    };
  }
  const held = epochFor(groups, gkey.ch);
  if (held === undefined && keyreqSentAtFor(groups, gkey.ch) === undefined) {
    // A first epoch is imported only after this device asked for the
    // key: a key nobody asked for never arms the channel, and the audit
    // — which returns early with no epoch held — never DMs a clear
    // channel's roster over it.
    return {
      events: [
        {
          kind: "channel_dropped",
          channel: gkey.ch,
          reason: "not-requested",
          detail: "no key request is outstanding for the channel",
        },
      ],
      held: false,
    };
  }
  if (held !== undefined && roster === undefined) {
    // No roster to check the sender or the holders against: the gkey
    // waits for the roster rather than replacing the held epoch on
    // provisional checks.
    return { events: [], held: true };
  }
  if (
    held !== undefined &&
    held.sid !== gkey.sid &&
    roster !== undefined &&
    holdersStale(
      gkey.holders,
      gkey.holderNicks ?? noNicks(),
      gkey.sentTo ?? [],
      resolveRoster(deps, roster),
    )
  ) {
    // Replacing an epoch: a gkey whose holders name a did no longer in
    // the roster is stale — the epoch it opens is already dead.
    return {
      events: [
        {
          kind: "channel_dropped",
          channel: gkey.ch,
          reason: "stale-gkey",
          detail: "its holders name a device no longer in the roster",
        },
      ],
      held: false,
    };
  }
  try {
    const imported = importEpoch(
      groups,
      gkey.ch,
      gkey,
      fromDid,
      deps.now(),
      roster !== undefined ? resolveRoster(deps, roster) : undefined,
    );
    if (imported === "imported") {
      const nowHeld = epochFor(groups, gkey.ch);
      if (nowHeld !== undefined && !nowHeld.holders.includes(deps.ownDid)) {
        nowHeld.holders.push(deps.ownDid);
      }
      return {
        events: [{ kind: "channel_key_received", channel: gkey.ch, from, sid: gkey.sid }],
        held: false,
      };
    }
    if (imported === "already-held") {
      const nowHeld = epochFor(groups, gkey.ch);
      if (nowHeld !== undefined && !nowHeld.holders.includes(deps.ownDid)) {
        nowHeld.holders.push(deps.ownDid);
      }
      return { events: [], held: false };
    }
    return {
      events: [
        {
          kind: "channel_dropped",
          channel: gkey.ch,
          reason: "superseded-gkey",
          detail: "a key is already held for this epoch sequence",
        },
      ],
      held: false,
    };
  } catch (err) {
    return {
      events: [
        {
          kind: "channel_dropped",
          channel: gkey.ch,
          reason: "bad-gkey",
          detail: err instanceof Error ? err.message : String(err),
        },
      ],
      held: false,
    };
  }
}

/**
 * Retries the gkeys held for `channel`: the roster seeded, or another
 * gkey arrived, so their checks can run now. One whose checks still
 * cannot run stays held; the rest import or drop with their reasons.
 * The events are the retry's own: the caller returns them where it can
 * (a gkey arrival), and drops them where it cannot (the audit, which
 * has no event channel — the import still updates the epoch in place).
 */
function retryHeldGkeys(
  deps: ChannelE2eDeps,
  groups: GroupSessionsState,
  channel: string,
): ChannelE2eEvent[] {
  const events: ChannelE2eEvent[] = [];
  for (const held of takeHeldGkeys(groups, channel)) {
    const attempt = attemptGkey(deps, groups, held.gkey, held.from, held.fromDid);
    if (attempt.held) {
      // Still no roster: back in the hold, with its arrival time kept.
      // The take shrank the list first, so this cannot evict anything.
      holdGkey(groups, held);
      continue;
    }
    events.push(...attempt.events);
  }
  return events;
}

/**
 * A gkey DM from `from`'s device `fromDid`, as the Olm engine delivered
 * its inner message: imports the epoch it carries. Gkeys held while the
 * roster was unknown are retried first — the roster may have seeded
 * since — then this one is judged. When an epoch is held and no roster
 * is, the gkey is held for retry instead of replacing the epoch on
 * provisional checks; the audit retries it once the roster seeds.
 * Never throws on wire input.
 */
export function receiveGkey(
  deps: ChannelE2eDeps,
  groups: GroupSessionsState,
  inner: Record<string, unknown>,
  from: string,
  fromDid: string,
): ChannelE2eEvent[] {
  let gkey: GkeyInner;
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
  const events: ChannelE2eEvent[] = [];
  events.push(...retryHeldGkeys(deps, groups, gkey.ch));
  const attempt = attemptGkey(deps, groups, gkey, from, fromDid);
  if (attempt.held) {
    for (const evicted of holdGkey(groups, {
      channel: gkey.ch,
      gkey,
      from,
      fromDid,
      receivedAt: deps.now(),
    })) {
      events.push({
        kind: "channel_dropped",
        channel: evicted.channel,
        reason: "held-gkey-evicted",
        detail: "a held key was evicted past the cap",
      });
    }
    return events;
  }
  events.push(...attempt.events);
  return events;
}

/**
 * The periodic rotations due now, across `channels`: one channel `:msg`
 * each, the new key encrypted under the old key. A channel whose epoch
 * never spoke, or is not due, is skipped — and so is one this device
 * does not rotate: the first holder did rotates, so exactly one member
 * sends the rotation. The caller flushes the outbound; each payload is
 * untagged (no DM row), as in `sendChannel`.
 */
export async function rotateDue(
  deps: ChannelE2eDeps,
  groups: GroupSessionsState,
  channels: string[],
): Promise<ChannelE2eResult> {
  const res = emptyResult();
  for (const channel of channels) {
    if (!rotationDue(groups, channel, deps.now())) continue;
    const held = epochFor(groups, channel);
    if (held === undefined) continue;
    const roster = deps.rosterFor?.(channel);
    if (roster === undefined) continue;
    if (designatedRotator(held.holders) !== deps.ownDid) continue;
    const rotated = await buildPeriodicRotation(groups, channel, deps.sign, deps.now());
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

/** The channels this device holds an epoch for. */
export function channelsWithEpoch(groups: GroupSessionsState): string[] {
  return Object.keys(groups.epochs);
}
