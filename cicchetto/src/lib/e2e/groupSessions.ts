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
// not 3), so no migration is needed. Version 3 is the holders-per-did
// store: a v2 record held folded nicks as holders, which read as dids
// under the new rule, so it is reset, not migrated — its channels re-ask
// for the key.
//
// WHAT AN EPOCH IS. One record per channel: the epoch id (`sid`), the
// 32-byte AES-GCM key (base64), when it was created, how many messages
// went under it, this device's next counter, and the HOLDER SET — the
// dids of every device that received this epoch key. The holder set is
// the audit input (§4f, F4): on cic open and before every send, the
// client compares it with the true roster, in dids, and anyone in the
// set who is no longer in the roster triggers rotation. A holder is a
// device, never a nick: a rename must not change who holds the key, and
// two devices of one subject hold it independently. There is no
// per-sender store: a sender is just a device whose counter the epoch
// tracks. Next to the holder set the epoch keeps the NICK MAPPING —
// which nick each holder did belongs to, as the distributor saw it —
// carried in the gkey inner, so any holder can tell a departed member's
// dids from a presence event naming only the nick; and the SENT-TO nicks
// — members the key was DM'd to whose device lists were unknown, who
// may still receive it (the engine resolves their keys lazily) and move
// into the holder set once their dids land. A rename must not change
// who holds the key; the mapping is only the lookup, the dids are the
// identity.
//
// ROTATION, and why old keys die. One key per epoch. A member leaves, or
// the day passes, and the epoch rotates: the old key is deleted outright
// — encrypting with it again would hand the departed member new messages
// under a key they hold — and the new key goes pairwise to the members
// who remain. Every epoch carries a SEQUENCE NUMBER — 0 for a first
// epoch, +1 per rotation — and the FIRST valid gkey wins: a gkey whose
// seq is not above the held epoch's is dropped, so a late duplicate, or
// a concurrent mint that lost the race, never replaces the key already
// taken; only a rotation successor (a higher seq) imports. Two devices
// that mint the same seq concurrently still fork — each keeps the first
// it saw — and the fork heals at the next rotation, when one epoch is
// minted and distributed to all. Rotation is only real if clients delete
// old keys (§4f); this module is where that happens. No keys are kept
// for channels left (`dropChannel`).
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
/** How many session-less channel rows are held for retry in total: the cap keeps the hold bounded. */
export const MAX_HELD_ROWS = 32;
/** How long a held row waits for its key (ms): an hour, then it expires and is reported, never silently lost. */
export const HELD_ROW_TTL_MS = 3_600_000;

const decoder = new TextDecoder("utf-8", { fatal: true });

/** Signs `text` with this device's Ed25519 key: the `sig` of a channel `:msg`. */
export type ChannelSigner = (text: string) => string;
/**
 * Whether `sig` is `nick`'s device `did`'s Ed25519 signature over `text`:
 * the pinned device key for that did, verified with the wasm binding.
 * False when the nick is not pinned, or the did is not one of its trusted
 * devices — a message from a sender this cic has no key for does not verify.
 */
export type ChannelVerifier = (nick: string, did: string, text: string, sig: string) => boolean;

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
  /**
   * The epoch's sequence number: 0 for a first epoch, +1 per rotation.
   * The first valid gkey wins: a gkey whose seq is not above the held
   * epoch's is dropped, so a late duplicate never replaces the key
   * already taken; a rotation successor (higher seq) still imports. A
   * record sealed before this field existed opens without it: read it
   * through `seqOf`.
   */
  seq: number;
  /** When the epoch was created (ms since epoch). */
  createdAt: number;
  /** How many messages went under this epoch: 0, it never spoke. */
  messages: number;
  /** This device's next counter under this epoch: 0, it never spoke. */
  counter: number;
  /** The dids of every device that received this epoch key. */
  holders: string[];
  /**
   * Which nick each holder did belongs to (`{folded nick: [did, ...]}`):
   * the distributor's snapshot at distribution time, carried in the gkey
   * inner, so any holder can tell a departed member's dids from a
   * presence event naming only the nick. A record sealed before this
   * field existed opens without it: read it through `holderNicksOf`.
   */
  holderNicks: Record<string, string[]>;
  /**
   * The folded nicks the key was DM'd to whose device lists were unknown
   * at distribution time: they may still receive it (the engine resolves
   * their keys lazily), so they count as holders-to-be until their dids
   * land and move them into `holders`. A record sealed before this field
   * existed opens without it: read it through `sentToOf`.
   */
  sentTo: string[];
  /** When the key arrived (ms since epoch): the creation, for our own epochs. */
  receivedAt: number;
  /** The did of the member whose gkey brought the key: null for our own epochs. */
  receivedFrom: string | null;
  /** The replay state per sender device did. */
  seen: Record<string, ReplayState>;
};

/** The roster as the audit sees it: its nicks, and the dids they resolve to. */
export type RosterDids = {
  /** The roster's nicks, in display spelling. */
  nicks: string[];
  /** The dids the roster resolves to, as this cic knows them. */
  dids: string[];
};

/**
 * A channel row that arrived before its epoch key: held for retry, not
 * dropped. `channel` is the folded channel name, `sid` the epoch the row
 * names, `from`/`fromDid` its sender, `payload` the wire payload as
 * delivered, `receivedAt` when it arrived (ms since epoch). The drain
 * retries held rows when the key arrives (`takeHeldRows`) and expires
 * the ones that waited too long (`expireHeldRows`).
 */
export type HeldRow = {
  channel: string;
  sid: string;
  from: string;
  fromDid: string;
  payload: string;
  receivedAt: number;
};

/**
 * A channel row this device queued while it held no epoch: it waits for
 * the key, never goes out in the clear, and never mints an epoch of its
 * own. `channel` is the folded channel name, `body` the row, `queuedAt`
 * when it was queued (ms since epoch). The drain flushes them when the
 * key arrives (`takePendingSends`); the user cancels them
 * (`dropPendingSends`); our own leave drops them with the channel.
 */
export type PendingSend = {
  channel: string;
  body: string;
  queuedAt: number;
};

/** How many rows may wait for a key per channel before the oldest drops. */
export const MAX_PENDING_SENDS = 32;

/**
 * The epochs, as `E2eState.groups` holds them. `epochs` is keyed by folded
 * channel name; `keyreqAnsweredAt` by `${folded channel}:${asker did}`,
 * the last time this device answered that asker's key request on that
 * channel; `keyreqSentAt` by folded channel, the last time this device
 * broadcast a key request for it; `held` is the session-less rows held
 * for retry; `pending` is the rows this device queued while it held no
 * epoch, waiting for the key. A channel name is folded (`fold`) because
 * §4f's `ch` is the folded name.
 */
export type GroupSessionsState = {
  v: 3;
  epochs: Record<string, StoredEpoch>;
  keyreqAnsweredAt: Record<string, number>;
  keyreqSentAt: Record<string, number>;
  held: HeldRow[];
  pending: PendingSend[];
};

export function newGroupSessionsState(): GroupSessionsState {
  return { v: 3, epochs: {}, keyreqAnsweredAt: {}, keyreqSentAt: {}, held: [], pending: [] };
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

/**
 * Whether `channel`'s epoch holder set names a did no longer in the
 * roster: the audit input (§4f). A holder did counts as still a member
 * when a roster device list names it, or when the epoch's nick mapping
 * attributes it to a nick still on the roster — the mapping is what
 * settles a member this cic has not chatted with, whose dids its engine
 * does not know yet. Otherwise the epoch is stale: the did belongs to
 * nobody in the channel, or to a member the key was sent to whose dids
 * never landed and who is no longer on the roster — either way the epoch
 * rotates (fail closed: a missed departure is a leak, a spurious
 * rotation is one new epoch). A rename whose new nick's list has not
 * landed yet rotates once, until the list lands and the did check
 * settles it; a rename whose list is known rotates nothing.
 */
export function holdersStale(
  holders: string[],
  holderNicks: Record<string, string[]>,
  sentTo: string[],
  roster: RosterDids,
): boolean {
  const rosterNicks = new Set(roster.nicks.map((n) => fold(n)));
  if (sentTo.some((nick) => !rosterNicks.has(fold(nick)))) return true;
  const present = new Set(roster.dids);
  for (const holder of holders) {
    if (present.has(holder)) continue;
    const attributed = roster.nicks.some((nick) =>
      (holderNicks[fold(nick)] ?? []).includes(holder),
    );
    if (!attributed) return true;
  }
  return false;
}

/** Whether `channel`'s stored epoch is stale against `roster` (`holdersStale`). */
export function epochHoldersStale(
  state: GroupSessionsState,
  channel: string,
  roster: RosterDids,
): boolean {
  const held = epochFor(state, channel);
  if (held === undefined) return false;
  return holdersStale(held.holders, holderNicksOf(held), sentToOf(held), roster);
}

/**
 * The holder dids still in the roster: the audit's rotator election
 * input (§4f, (d)). A holder did counts as still a member by the same
 * rule as `holdersStale` — a roster device list names it, or the epoch's
 * nick mapping attributes it to a nick still on the roster — so every
 * holder that holds the same epoch elects the same rotator. The first
 * of them in sorted order is the designated rotator; when none remain,
 * nobody rotates (the epoch is stale but there is no holder left to
 * mint its successor — the next joiner asks, and the designee answers
 * with a fresh epoch).
 */
export function remainingHolders(
  holders: string[],
  holderNicks: Record<string, string[]>,
  roster: RosterDids,
): string[] {
  const present = new Set(roster.dids);
  return holders.filter((holder) => {
    if (present.has(holder)) return true;
    return roster.nicks.some((nick) => (holderNicks[fold(nick)] ?? []).includes(holder));
  });
}

/** `channel`'s stored epoch's holder dids still in `roster` (`remainingHolders`). */
export function epochRemainingHolders(
  state: GroupSessionsState,
  channel: string,
  roster: RosterDids,
): string[] {
  const held = epochFor(state, channel);
  if (held === undefined) return [];
  return remainingHolders(held.holders, holderNicksOf(held), roster);
}

/** `epoch`'s sequence number, defaulting a record sealed before it existed to 0. */
export function seqOf(epoch: StoredEpoch): number {
  return epoch.seq ?? 0;
}

/** `epoch`'s nick mapping, defaulting a record sealed before it existed to empty. */
export function holderNicksOf(epoch: StoredEpoch): Record<string, string[]> {
  return epoch.holderNicks ?? {};
}

/** `epoch`'s sent-to nicks, defaulting a record sealed before it existed to empty. */
export function sentToOf(epoch: StoredEpoch): string[] {
  return epoch.sentTo ?? [];
}

/** Whether this device answered `askerDid`'s key request on `channel` recently: the throttle. */
export function keyreqAnswerDue(
  state: GroupSessionsState,
  channel: string,
  askerDid: string,
  now: number,
): boolean {
  const at = state.keyreqAnsweredAt[`${fold(channel)}:${askerDid}`];
  return at === undefined || now - at >= KEYREQ_ANSWER_THROTTLE_MS;
}

/** Records that this device answered `askerDid`'s key request on `channel` now. */
export function markKeyreqAnswered(
  state: GroupSessionsState,
  channel: string,
  askerDid: string,
  now: number,
): void {
  state.keyreqAnsweredAt[`${fold(channel)}:${askerDid}`] = now;
}

/**
 * Records that this device broadcast a key request for `channel` now: a
 * first epoch is imported only while such a request is outstanding, so a
 * key nobody asked for never arms the channel. A record sealed before
 * this field existed opens without it (`accountStore` spreads
 * `newState()` underneath, but a hand-built state may still lack it),
 * so the map is defaulted, never assumed.
 */
export function markKeyreqSent(state: GroupSessionsState, channel: string, now: number): void {
  const sent = state.keyreqSentAt ?? {};
  sent[fold(channel)] = now;
  state.keyreqSentAt = sent;
}

/** When this device last broadcast a key request for `channel`, if ever. */
export function keyreqSentAtFor(state: GroupSessionsState, channel: string): number | undefined {
  return state.keyreqSentAt?.[fold(channel)];
}

/** Forgets this device's outstanding key request for `channel`, if any. */
function clearKeyreqSent(state: GroupSessionsState, channel: string): void {
  const sent = state.keyreqSentAt ?? {};
  delete sent[fold(channel)];
  state.keyreqSentAt = sent;
}

/**
 * The rows queued for a key, defaulting a record sealed before the field
 * existed to an empty list.
 */
function pendingSends(state: GroupSessionsState): PendingSend[] {
  const rows = state.pending ?? [];
  state.pending = rows;
  return rows;
}

/**
 * Queues `body` for `channel`: the row waits for the key, never goes out
 * in the clear, and never mints an epoch of its own. Past the cap the
 * oldest rows are dropped, and returned — never silently — so the caller
 * can surface them.
 */
export function queuePendingSend(
  state: GroupSessionsState,
  channel: string,
  body: string,
  now: number,
): PendingSend[] {
  const rows = pendingSends(state);
  rows.push({ channel: fold(channel), body, queuedAt: now });
  const dropped: PendingSend[] = [];
  while (rows.filter((r) => fold(r.channel) === fold(channel)).length > MAX_PENDING_SENDS) {
    const idx = rows.findIndex((r) => fold(r.channel) === fold(channel));
    const oldest = rows.splice(idx, 1)[0];
    if (oldest !== undefined) dropped.push(oldest);
  }
  return dropped;
}

/**
 * Takes the rows queued for `channel`: the key arrived, so the caller
 * sends them now, under the new epoch, in the order they were queued.
 * They leave the queue.
 */
export function takePendingSends(state: GroupSessionsState, channel: string): PendingSend[] {
  const rows = pendingSends(state);
  const taken = rows.filter((r) => fold(r.channel) === fold(channel));
  state.pending = rows.filter((r) => fold(r.channel) !== fold(channel));
  return taken;
}

/**
 * Drops the rows queued for `channel`: the user cancelled them, or we
 * left the channel. The dropped rows are returned — never silently — so
 * the caller can surface them.
 */
export function dropPendingSends(state: GroupSessionsState, channel: string): PendingSend[] {
  return takePendingSends(state, channel);
}

/**
 * The rows held for retry, defaulting a record sealed before the field
 * existed to an empty list.
 */
function heldRows(state: GroupSessionsState): HeldRow[] {
  const rows = state.held ?? [];
  state.held = rows;
  return rows;
}

/**
 * Holds `row` for retry: a channel row that arrived before its key. The
 * row is stored under its folded channel name. Past the cap the oldest
 * rows are dropped, and returned — never silently — so the caller can
 * surface them.
 */
export function holdRow(state: GroupSessionsState, row: HeldRow): HeldRow[] {
  const rows = heldRows(state);
  rows.push({ ...row, channel: fold(row.channel) });
  const dropped: HeldRow[] = [];
  while (rows.length > MAX_HELD_ROWS) {
    const oldest = rows.shift();
    if (oldest !== undefined) dropped.push(oldest);
  }
  return dropped;
}

/**
 * Takes the rows held under `channel` and `sid`: the key just arrived,
 * so the drain retries them now. They leave the hold.
 */
export function takeHeldRows(state: GroupSessionsState, channel: string, sid: string): HeldRow[] {
  const rows = heldRows(state);
  const taken = rows.filter((r) => fold(r.channel) === fold(channel) && r.sid === sid);
  state.held = rows.filter((r) => !(fold(r.channel) === fold(channel) && r.sid === sid));
  return taken;
}

/**
 * Expires the held rows older than `HELD_ROW_TTL_MS` at `now`: they
 * waited too long for a key that never came. The expired rows are
 * returned — never silently — so the caller can surface them; the fresh
 * ones stay held.
 */
export function expireHeldRows(state: GroupSessionsState, now: number): HeldRow[] {
  const rows = heldRows(state);
  const expired = rows.filter((r) => now - r.receivedAt > HELD_ROW_TTL_MS);
  state.held = rows.filter((r) => now - r.receivedAt <= HELD_ROW_TTL_MS);
  return expired;
}

/** Stores `epoch` as `channel`'s epoch, replacing whatever was held. */
function storeEpoch(state: GroupSessionsState, channel: string, epoch: StoredEpoch): StoredEpoch {
  state.epochs[fold(channel)] = epoch;
  return epoch;
}

/**
 * Creates `channel`'s epoch: a new key, this device its owner. `holders`
 * is the dids the key goes to, stored as given — the caller resolves the
 * roster to dids and includes this device's did. `extra` carries the
 * nick mapping for those dids (`holderNicks`) and the nicks the key was
 * DM'd to whose dids were unknown (`sentTo`): both travel in the gkey
 * inner, so every holder learns them. The caller distributes its key
 * (`gkeyInner`) before anyone can read a message under it.
 */
export function createEpoch(
  state: GroupSessionsState,
  channel: string,
  holders: string[],
  now: number,
  extra?: { holderNicks?: Record<string, string[]>; sentTo?: string[]; seq?: number },
): StoredEpoch {
  return storeEpoch(state, channel, {
    sid: newEpochId(),
    key: newEpochKey(),
    seq: extra?.seq ?? 0,
    createdAt: now,
    messages: 0,
    counter: 0,
    holders: [...holders],
    holderNicks: { ...(extra?.holderNicks ?? {}) },
    sentTo: [...(extra?.sentTo ?? [])],
    receivedAt: now,
    receivedFrom: null,
    seen: {},
  });
}

/** Deletes `channel`'s epoch: its key is never spoken or read again. */
export function dropEpoch(state: GroupSessionsState, channel: string): void {
  delete state.epochs[fold(channel)];
  // An outstanding request for the channel is answered by nothing now:
  // the next key, if any, comes from a fresh ask.
  clearKeyreqSent(state, channel);
}

/** Drops everything of `channel`: its epoch, and the rows queued for its key. We left. */
export function dropChannel(state: GroupSessionsState, channel: string): void {
  dropEpoch(state, channel);
  dropPendingSends(state, channel);
}

/**
 * Imports the epoch `gkey` carries for `channel`: a gkey DM brought it,
 * or a grotate inside a channel message. The key must be a 32-byte epoch
 * key, or the import throws and nothing is stored. An import of the epoch
 * already held is a no-op (a re-sent gkey). Otherwise the FIRST valid
 * gkey wins: a gkey whose seq is not above the held epoch's is dropped
 * as superseded — a late duplicate, or a concurrent mint that lost the
 * race, never replaces the key already taken — and only a rotation
 * successor (a higher seq) imports. The new epoch's counters start over.
 * `fromDid` is the did of the member whose gkey it was, for the record.
 */
export function importEpoch(
  state: GroupSessionsState,
  channel: string,
  gkey: GkeyInner,
  fromDid: string,
  now: number,
): "imported" | "already-held" | "superseded" {
  if (epochFor(state, channel)?.sid === gkey.sid) return "already-held";
  if (!isEpochKey(gkey.key)) throw new Error(`a gkey for ${gkey.sid} is not an epoch key`);
  const held = epochFor(state, channel);
  if (held !== undefined && gkey.seq <= seqOf(held)) return "superseded";
  storeEpoch(state, channel, {
    sid: gkey.sid,
    key: gkey.key,
    seq: gkey.seq,
    createdAt: now,
    messages: 0,
    counter: 0,
    holders: [...gkey.holders],
    holderNicks: { ...(gkey.holderNicks ?? {}) },
    sentTo: [...(gkey.sentTo ?? [])],
    receivedAt: now,
    receivedFrom: fromDid,
    seen: {},
  });
  // The key arrived: the request that asked for it is answered.
  clearKeyreqSent(state, channel);
  return "imported";
}

/**
 * The gkey inner for `channel`'s current epoch, to send to a member's DM:
 * `{"t":"gkey","ch":"#chan","sid":"...","key":"...","holders":["..."]}`
 * (§4f), with the nick mapping and the sent-to nicks when either is
 * non-empty. Undefined when no epoch exists: create one first
 * (`createEpoch`).
 */
export function gkeyInner(state: GroupSessionsState, channel: string): GkeyInner | undefined {
  const held = epochFor(state, channel);
  if (held === undefined) return undefined;
  const inner: GkeyInner = {
    t: "gkey",
    ch: fold(channel),
    sid: held.sid,
    key: held.key,
    seq: seqOf(held),
    holders: [...held.holders],
  };
  const byNick = holderNicksOf(held);
  if (Object.keys(byNick).length > 0) inner.holderNicks = { ...byNick };
  const sentTo = sentToOf(held);
  if (sentTo.length > 0) inner.sentTo = [...sentTo];
  return inner;
}

/** The key-request envelope for `channel`: `{"v":4,"t":"keyreq","ch":"#chan"}` (§4f). */
export function keyreqPayload(channel: string): string {
  return encodePayload({ v: GROUP_WIRE_VERSION, t: "keyreq", ch: fold(channel) });
}

/**
 * Encrypts `body` for `channel` under the epoch key, as the v4 payload of
 * a channel `:msg`. Refuses — throws — when no epoch is held: a row
 * without a key waits in queue (`queuePendingSend`), it never mints an
 * epoch of its own. The per-sender counter and the message count are
 * stored with the step.
 */
export async function encryptChannel(
  state: GroupSessionsState,
  channel: string,
  body: string,
  sign: ChannelSigner,
): Promise<{ payload: string; sid: string; counter: number }> {
  const held = epochFor(state, channel);
  if (held === undefined) {
    throw new Error(`no epoch for ${channel}: ask for the key first`);
  }
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
  return { payload: encodePayload(payload), sid: held.sid, counter: held.counter - 1 };
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
  if (
    !verify(sender, senderDid, channelSigText(payload.ch, payload.sid, payload.body), payload.sig)
  ) {
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
    // change on a periodic rotation, so the holder set — and its nick
    // mapping and sent-to nicks — carry over. Its seq is the old one's
    // +1: the receiver computes the same number from the epoch it holds.
    storeEpoch(state, channel, {
      sid: rotated.sid,
      key: rotated.key,
      seq: seqOf(held) + 1,
      createdAt: now,
      messages: 0,
      counter: 0,
      holders: [...held.holders],
      holderNicks: { ...holderNicksOf(held) },
      sentTo: [...sentToOf(held)],
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
  extra?: { holderNicks?: Record<string, string[]>; sentTo?: string[] },
): { oldSid: string | null; newSid: string; key: string; seq: number } {
  const held = epochFor(state, channel);
  const oldSid = held?.sid ?? null;
  const seq = (held === undefined ? 0 : seqOf(held)) + 1;
  dropEpoch(state, channel);
  const created = createEpoch(state, channel, holders, now, { ...extra, seq });
  return { oldSid, newSid: created.sid, key: created.key, seq };
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
    seq: seqOf(held) + 1,
    createdAt: now,
    messages: 0,
    counter: 0,
    holders: [...held.holders],
    holderNicks: { ...holderNicksOf(held) },
    sentTo: [...sentToOf(held)],
    receivedAt: now,
    receivedFrom: null,
    seen: {},
  });
  return { payload: encodePayload(payload), oldSid, newSid };
}
