// issue 2430 — a fake grappa for the E2E tests: what the real one does with
// the E2E identities and messages of one network (protocol 49, CLIENT_PROTOCOL
// §4f), refusing what it refuses, so a client that gets the protocol wrong
// fails here rather than against a real server. A subject is a nick, and its
// bearer IS that nick: `api` takes what `api.ts`'s E2E functions take, so a
// test's `vi.mock` of the api module hands them over (`routeApi`); a bare
// client talks to it through `door`, the doors of one device.
//
// Per nick: its devices (oldest first), the list its master put, and each
// device's key bundle and offline queue. A send is routed by `to`: a did is
// that listed device of the target, `*` every listed one, and anything else
// is dropped without a word, as grappa drops it. A KEYREQ is answered as
// `Grappa.E2eKeys.answer/3` composes KEYS: the list, then each listed device
// in the list's order with its oldest one-time key, or its fallback key once
// none is left (a device with neither is left out), `from` `*` to the asking
// device. It goes unanswered when told to (the real one answers a nick at
// most so often, and drops the rest without a word), and with no list or no
// key to answer from.
import { vi } from "vitest";
import type * as Api from "../../lib/api";
import { ApiError } from "../../lib/api";
import type { DoorRefusal } from "../../lib/e2e/chatStore";
import type { SignedKey } from "../../lib/e2e/keyBundle";
import {
  base64Unpadded,
  base64Url,
  did,
  encodePayload,
  fold,
  type ReceiveVerb,
  unbase64,
  validMasterList,
} from "../../lib/e2e/wire";
import type {
  E2eKeysWireDevice,
  E2eKeysWireDeviceList,
  E2eKeysWireStatus,
  SessionWireE2eCopiedPayload,
  SessionWireE2eMessagePayload,
} from "../../lib/wireTypes";
import { olm } from "./olm";

/** The E2E functions of `api.ts`, which this grappa answers. */
export type E2eApi = Pick<
  typeof Api,
  | "registerE2eDevice"
  | "listE2eDevices"
  | "removeE2eDevice"
  | "getE2eList"
  | "putE2eList"
  | "getE2eDeviceKeys"
  | "uploadE2eDeviceKeys"
  | "listE2eDeviceInbox"
  | "ackE2eDeviceInbox"
  | "sendE2e"
  | "claimE2eDeviceKeys"
  | "copyE2e"
  | "clearE2eKeys"
>;

/**
 * A send as the door takes it: `sendE2e`'s body, the deadline as the engine
 * names it; `tag` when a client hands the engine's payload over whole (it
 * never reaches grappa, and says which message a send carried).
 */
export type DoorSend = {
  target: string;
  verb: string;
  from: string;
  to: string;
  payload: string;
  priority: string;
  expiresAt?: number | null;
  tag?: string;
};

/** One whole message, as one device's door hands it to the client. */
export type DeviceMessage = {
  id: number;
  from: string;
  fromDid: string;
  verb: ReceiveVerb;
  msgid: string;
  payload: string;
  own: boolean;
};

/** The doors of one device. */
export type DeviceDoor = {
  /** The oldest page of the device's queue past `after`. */
  inbox(after: number): Promise<DeviceMessage[]>;
  ack(ids: number[]): Promise<void>;
  /** A refusal `refuse` names is an answer; what grappa itself refuses throws. */
  send(out: DoorSend): Promise<{ msgid: string } | { refused: DoorRefusal }>;
  /** A refusal is an answer, as at the real door: the sibling's KEYS text, or why not. */
  claim(did: string): Promise<string | DoorRefusal>;
  /** A refusal is an answer, as at the real door: the copy's queue id, or why not. */
  copy(toDid: string, verb: "pkmsg" | "msg", payload: string): Promise<number | DoorRefusal>;
  /** A refusal is an answer, as at the real door: every device of the subject, or why not. */
  devices(): Promise<E2eKeysWireDevice[] | DoorRefusal>;
};

type Queued = Omit<SessionWireE2eMessagePayload, "kind" | "network">;
type Device = E2eKeysWireDevice & {
  otks: SignedKey[];
  fallback: SignedKey | null;
  inbox: Queued[];
};
type Subject = { devices: Device[]; list: E2eKeysWireDeviceList | null };

const VERBS = ["keyreq", "pkmsg", "msg", "nack"];
const PRIORITIES = ["control", "reactive", "text"];
// `Grappa.E2eKeys.max_one_time_keys/0`, `DeviceList.max_devices/0`,
// `Grappa.IRC.E2e.max_payload_bytes/0`, `E2eInbox.page_size/0`.
const MAX_ONE_TIME_KEYS = 50;
const MAX_DEVICES = 4;
const MAX_PAYLOAD_BYTES = 32 * 1024;
// `E2eInbox.max_sender_bytes/0` and `row_overhead_bytes/0`: a sender's share of one queue.
const MAX_SENDER_BYTES = 1_048_576;
const ROW_OVERHEAD_BYTES = 256;
const PAGE = 100;

/** How the send door answers each refusal: status, token. */
const REFUSED: Record<DoorRefusal, [number, string]> = {
  "rate-limited": [429, "rate_limited"],
  "too-large": [413, "too_large"],
  "too-late": [422, "too_late"],
  "unknown-device": [422, "unknown_device"],
  refused: [400, "bad_request"],
};

// What `encryptedChats.ts` makes of a door's refusal.
const refusalOf = (err: unknown): DoorRefusal => {
  if (!(err instanceof ApiError)) throw err;
  if (err.status === 413) return "too-large";
  return err.code === "unknown_device" ? "unknown-device" : "refused";
};

const badRequest = () => new ApiError(400, "bad_request");
const notFound = () => new ApiError(404, "not_found");

// `Device.key?/1` and `signature?/1`: standard base64, unpadded, the
// canonical spelling of exactly `size` bytes.
function canonical(value: unknown, size: number): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+$/.test(value)) return false;
  try {
    const bytes = unbase64(value);
    return bytes.length === size && base64Unpadded(bytes) === value;
  } catch {
    return false;
  }
}

// `Grappa.IRC.E2e.did?/1`: 11 characters of base64url, canonical.
function isDid(value: string): boolean {
  if (!/^[A-Za-z0-9_-]{11}$/.test(value)) return false;
  return base64Url(unbase64(value.replace(/-/g, "+").replace(/_/g, "/"))) === value;
}

// `Grappa.IRC.E2e.addressed?/3`: the addresses each verb may carry.
function addressed(verb: string, from: string, to: string): boolean {
  if (!isDid(from)) return false;
  if (verb === "keyreq") return to === "*";
  if (verb === "pkmsg" || verb === "msg") return to === "*" || isDid(to);
  return verb === "nack" && isDid(to);
}

// The send door's checks, in its order (`E2eController.create/2`,
// `Session.send_e2e/8`): closed sets, size, a deadline only on a control
// MSG/PKMSG, the addresses, compact JSON text.
function checkSend(o: DoorSend): void {
  if (!VERBS.includes(o.verb) || !PRIORITIES.includes(o.priority)) throw badRequest();
  if (new TextEncoder().encode(o.payload).length > MAX_PAYLOAD_BYTES) {
    throw new ApiError(413, "too_large");
  }
  const at = o.expiresAt ?? null;
  const deadlineOk =
    at === null ||
    (Number.isInteger(at) &&
      at > 0 &&
      o.priority === "control" &&
      (o.verb === "pkmsg" || o.verb === "msg"));
  if (!deadlineOk || !addressed(o.verb, o.from, o.to) || !/^[\x21-\x7e]+$/.test(o.payload)) {
    throw badRequest();
  }
}

const newMsgid = () => base64Unpadded(crypto.getRandomValues(new Uint8Array(8)));

const wireDevice = (d: Device): E2eKeysWireDevice => ({
  did: d.did,
  ed25519: d.ed25519,
  curve25519: d.curve25519,
  sig: d.sig,
});

const status = (device: Device): E2eKeysWireStatus => ({
  one_time_keys: device.otks.length,
  fallback: device.fallback !== null,
});

export class Grappa {
  private readonly subjects = new Map<string, Subject>();
  nextId = 1;
  pageSize = PAGE;
  /** Every send the door took, with who sent it and the msgid it named it. */
  sends: (DoorSend & { by: string; msgid: string })[] = [];
  refuse: (o: DoorSend) => DoorRefusal | undefined = () => undefined;
  /** A KEYREQ the door takes and nobody answers. */
  unanswered: (o: DoorSend) => boolean = () => false;
  failAck = false;

  /** `api.ts`'s E2E functions, for the subject the bearer names. */
  readonly api: E2eApi = {
    registerE2eDevice: async (nick, _slug, id) => wireDevice(this.register(nick, id)),
    listE2eDevices: async (nick) => this.subject(nick).devices.map(wireDevice),
    removeE2eDevice: async (nick, _slug, did) => this.remove(nick, did),
    // `api.ts` answers grappa's 404 for no list with null.
    getE2eList: async (nick) => {
      const list = this.subject(nick).list;
      return list === null ? null : { ...list, devices: [...list.devices] };
    },
    putE2eList: async (nick, _slug, list) => this.putList(nick, list),
    getE2eDeviceKeys: async (nick, _slug, did) => status(this.device(nick, did)),
    uploadE2eDeviceKeys: async (nick, _slug, did, upload) => this.upload(nick, did, upload),
    listE2eDeviceInbox: async (nick, slug, did, after) => ({
      messages: this.device(nick, did)
        .inbox.filter((m) => m.id > after)
        .slice(0, this.pageSize)
        .map((m) => ({ ...m, kind: "e2e_message" as const, network: slug })),
    }),
    claimE2eDeviceKeys: async (nick, _slug, did, fromDid) => ({
      keys: this.claim(nick, did, fromDid),
    }),
    copyE2e: async (nick, _slug, toDid, out) => this.copy(nick, toDid, out),
    ackE2eDeviceInbox: async (nick, _slug, did, ids) => this.ack(nick, did, ids),
    sendE2e: async (nick, _slug, out) => {
      const answer = this.send(nick, out);
      if ("refused" in answer) throw new ApiError(...REFUSED[answer.refused]);
      return answer;
    },
    clearE2eKeys: async (nick) => {
      this.subjects.delete(fold(nick));
    },
  };

  /** The doors of `nick`'s device `did`. */
  door(nick: string, did: string): DeviceDoor {
    return {
      inbox: async (after) =>
        (await this.api.listE2eDeviceInbox(nick, "", did, after)).messages.map((m) => ({
          id: m.id,
          from: m.from,
          fromDid: m.from_did,
          verb: m.verb,
          msgid: m.msgid,
          payload: m.payload,
          own: m.own,
        })),
      ack: async (ids) => {
        if (this.failAck) throw new Error("ack refused");
        await this.api.ackE2eDeviceInbox(nick, "", did, ids);
      },
      send: async (out) => this.send(nick, out),
      claim: (target) =>
        this.api.claimE2eDeviceKeys(nick, "", target, did).then((r) => r.keys, refusalOf),
      copy: (toDid, verb, payload) =>
        this.api
          .copyE2e(nick, "", toDid, { from_did: did, verb, payload })
          .then((r) => r.id, refusalOf),
      devices: () => this.api.listE2eDevices(nick, "").catch(refusalOf),
    };
  }

  private subject(nick: string): Subject {
    const key = fold(nick);
    const found = this.subjects.get(key) ?? { devices: [], list: null };
    this.subjects.set(key, found);
    return found;
  }

  private device(nick: string, did: string): Device {
    const found = this.subject(nick).devices.find((d) => d.did === did);
    if (found === undefined) throw notFound();
    return found;
  }

  /** The devices of `nick` its list names, in the list's order: the ones routed to. */
  private listed(nick: string): Device[] {
    const { devices, list } = this.subject(nick);
    return (list?.devices ?? []).flatMap((key) => devices.filter((d) => d.ed25519 === key));
  }

  // Registering a key again replaces its id block and stays one device.
  private register(nick: string, id: { ed25519: string; curve25519: string; sig: string }) {
    if (!canonical(id.ed25519, 32) || !canonical(id.curve25519, 32) || !canonical(id.sig, 64)) {
      throw badRequest();
    }
    const subject = this.subject(nick);
    const held = subject.devices.find((d) => d.ed25519 === id.ed25519);
    if (held !== undefined) {
      held.curve25519 = id.curve25519;
      held.sig = id.sig;
      return held;
    }
    if (subject.devices.length >= MAX_DEVICES) throw new ApiError(409, "too_many_devices");
    const device: Device = {
      did: did(olm(), id.ed25519),
      ed25519: id.ed25519,
      curve25519: id.curve25519,
      sig: id.sig,
      otks: [],
      fallback: null,
      inbox: [],
    };
    subject.devices.push(device);
    return device;
  }

  private remove(nick: string, did: string): void {
    const subject = this.subject(nick);
    const device = this.device(nick, did);
    if (subject.list?.devices.includes(device.ed25519)) throw new ApiError(409, "listed_device");
    subject.devices = subject.devices.filter((d) => d !== device);
  }

  // `E2eKeys.put_list/3`: the list rules and its signature, then the same
  // master, a rising `ver` (the very list again is answered as it is), keys
  // that are registered devices; a device the old list held and this one
  // does not goes, with its keys and its queue.
  private putList(nick: string, list: E2eKeysWireDeviceList): E2eKeysWireDeviceList {
    const signed = {
      ed25519: list.master,
      list: { ver: list.ver, devices: list.devices },
      sig: list.sig,
    };
    if (!validMasterList(olm(), signed)) throw badRequest();
    const subject = this.subject(nick);
    const held = subject.list;
    if (held !== null && held.master !== list.master) throw new ApiError(409, "master_mismatch");
    const same =
      held !== null &&
      held.ver === list.ver &&
      held.sig === list.sig &&
      held.devices.join(",") === list.devices.join(",");
    if (held !== null && same) return { ...held, devices: [...held.devices] };
    if (held !== null && list.ver <= held.ver) throw new ApiError(409, "stale_list");
    const registered = new Set(subject.devices.map((d) => d.ed25519));
    if (!list.devices.every((key) => registered.has(key))) {
      throw new ApiError(422, "unknown_device");
    }
    const revoked = new Set((held?.devices ?? []).filter((key) => !list.devices.includes(key)));
    subject.devices = subject.devices.filter((d) => !revoked.has(d.ed25519));
    subject.list = {
      master: list.master,
      ver: list.ver,
      devices: [...list.devices],
      sig: list.sig,
    };
    return { ...subject.list, devices: [...subject.list.devices] };
  }

  // `E2eKeys.upload/2` behind the controller's device lookup: one-time keys
  // added once each, a fallback key replacing the held one, all or nothing.
  private upload(
    nick: string,
    did: string,
    upload: { one_time_keys: SignedKey[]; fallback: SignedKey | null },
  ): E2eKeysWireStatus {
    const device = this.device(nick, did);
    const fresh = upload.one_time_keys.filter(
      (k, i, all) => all.findIndex((other) => other.key === k.key) === i,
    );
    if (fresh.length > MAX_ONE_TIME_KEYS) throw new ApiError(413, "too_large");
    const signed = [...fresh, ...(upload.fallback === null ? [] : [upload.fallback])];
    if (signed.length === 0 || !signed.every((k) => canonical(k.key, 32) && canonical(k.sig, 64))) {
      throw badRequest();
    }
    const held = new Set(device.otks.map((k) => k.key));
    const adding = fresh.filter((k) => !held.has(k.key));
    if (held.size + adding.length > MAX_ONE_TIME_KEYS) throw new ApiError(413, "too_large");
    device.otks.push(...adding);
    device.fallback = upload.fallback ?? device.fallback;
    return status(device);
  }

  private ack(nick: string, did: string, ids: number[]): void {
    if (
      ids.length === 0 ||
      ids.length > PAGE ||
      !ids.every((id) => Number.isInteger(id) && id > 0)
    ) {
      throw badRequest();
    }
    const device = this.device(nick, did);
    device.inbox = device.inbox.filter((m) => !ids.includes(m.id));
  }

  private send(by: string, o: DoorSend): { msgid: string } | { refused: DoorRefusal } {
    checkSend(o);
    if (!this.listed(by).some((d) => d.did === o.from)) throw new ApiError(422, "unknown_device");
    const refused = this.refuse(o);
    if (refused !== undefined) return { refused };
    const msgid = newMsgid();
    this.sends.push({ ...o, by, msgid });
    if (o.verb === "keyreq") {
      if (!this.unanswered(o)) this.answer(by, o);
      return { msgid };
    }
    for (const device of this.listed(o.target)) {
      if (o.to !== "*" && o.to !== device.did) continue;
      device.inbox.push({
        id: this.nextId++,
        from: by,
        from_did: o.from,
        to_did: device.did,
        verb: o.verb as ReceiveVerb,
        msgid,
        payload: o.payload,
        own: false,
      });
    }
    return { msgid };
  }

  // `E2eKeys.claim/4`: KEYS v2 restricted to the one sibling `did`, with its
  // oldest one-time key (consumed) or its fallback key (kept), refusing in
  // the order grappa does.
  private claim(nick: string, did: string, fromDid: string): string {
    if (did === fromDid) throw new ApiError(409, "same_device");
    const list = this.subject(nick).list;
    const listed = this.listed(nick);
    if (list === null || !listed.some((d) => d.did === fromDid)) {
      throw new ApiError(422, "unknown_device");
    }
    const device = listed.find((d) => d.did === did);
    if (device === undefined) throw notFound();
    const otk = device.otks.shift();
    const key = otk ?? device.fallback;
    if (key === null) throw new ApiError(409, "keyless_device");
    return encodePayload({
      v: 2,
      master: {
        ed25519: list.master,
        list: { ver: list.ver, devices: list.devices },
        sig: list.sig,
      },
      devices: [
        {
          id: { curve25519: device.curve25519, ed25519: device.ed25519, sig: device.sig },
          otk: { key: key.key, fallback: otk === undefined, sig: key.sig },
        },
      ],
    });
  }

  // `E2eController.copy/2` and `Session.copy_e2e/6`: a copy goes into the
  // sibling's queue flagged own, from the subject's own nick, and counts
  // against ONE own share of that queue (payload plus row overhead).
  private copy(
    nick: string,
    toDid: string,
    o: { from_did: string; verb: string; payload: string },
  ): SessionWireE2eCopiedPayload {
    if (o.verb !== "pkmsg" && o.verb !== "msg") throw badRequest();
    if (new TextEncoder().encode(o.payload).length > MAX_PAYLOAD_BYTES) {
      throw new ApiError(413, "too_large");
    }
    if (!/^[\x21-\x7e]+$/.test(o.payload)) throw badRequest();
    if (toDid === o.from_did) throw new ApiError(409, "same_device");
    const listed = this.listed(nick);
    if (!listed.some((d) => d.did === o.from_did)) throw new ApiError(422, "unknown_device");
    const sibling = listed.find((d) => d.did === toDid);
    if (sibling === undefined) throw notFound();
    const cost = (m: { payload: string }) =>
      new TextEncoder().encode(m.payload).length + ROW_OVERHEAD_BYTES;
    const held = sibling.inbox.filter((m) => m.own).reduce((sum, m) => sum + cost(m), 0);
    if (held + cost(o) > MAX_SENDER_BYTES) throw new ApiError(413, "inbox_full");
    const entry = { id: this.nextId++, msgid: newMsgid() };
    sibling.inbox.push({
      id: entry.id,
      from: nick,
      from_did: o.from_did,
      to_did: toDid,
      verb: o.verb,
      msgid: entry.msgid,
      payload: o.payload,
      own: true,
    });
    return entry;
  }

  // `E2eKeys.answer/3` with `consume/1`: each listed device that still has a
  // key, its oldest one-time key (handed out once) or its fallback key (kept).
  private answer(by: string, o: DoorSend): void {
    const list = this.subject(o.target).list;
    if (list === null) return;
    const devices = this.listed(o.target).flatMap((device) => {
      const otk = device.otks.shift();
      const key = otk ?? device.fallback;
      if (key === null) return [];
      return [
        {
          id: { curve25519: device.curve25519, ed25519: device.ed25519, sig: device.sig },
          otk: { key: key.key, fallback: otk === undefined, sig: key.sig },
        },
      ];
    });
    if (devices.length === 0) return;
    // grappa's own `v`, whatever cic's wire constant says.
    const payload = encodePayload({
      v: 2,
      master: {
        ed25519: list.master,
        list: { ver: list.ver, devices: list.devices },
        sig: list.sig,
      },
      devices,
    });
    this.device(by, o.from).inbox.push({
      id: this.nextId++,
      from: o.target,
      from_did: "*",
      to_did: o.from,
      verb: "keys",
      msgid: newMsgid(),
      payload,
      own: false,
    });
  }
}

/** Hands every E2E function of a `vi.mock`ed api module to the grappa of the network named. */
export function routeApi(api: E2eApi, grappaFor: (slug: string) => Grappa): void {
  vi.mocked(api.registerE2eDevice).mockImplementation((t, s, id) =>
    grappaFor(s).api.registerE2eDevice(t, s, id),
  );
  vi.mocked(api.listE2eDevices).mockImplementation((t, s) => grappaFor(s).api.listE2eDevices(t, s));
  vi.mocked(api.removeE2eDevice).mockImplementation((t, s, d) =>
    grappaFor(s).api.removeE2eDevice(t, s, d),
  );
  vi.mocked(api.getE2eList).mockImplementation((t, s) => grappaFor(s).api.getE2eList(t, s));
  vi.mocked(api.putE2eList).mockImplementation((t, s, l) => grappaFor(s).api.putE2eList(t, s, l));
  vi.mocked(api.getE2eDeviceKeys).mockImplementation((t, s, d) =>
    grappaFor(s).api.getE2eDeviceKeys(t, s, d),
  );
  vi.mocked(api.uploadE2eDeviceKeys).mockImplementation((t, s, d, u) =>
    grappaFor(s).api.uploadE2eDeviceKeys(t, s, d, u),
  );
  vi.mocked(api.listE2eDeviceInbox).mockImplementation((t, s, d, a) =>
    grappaFor(s).api.listE2eDeviceInbox(t, s, d, a),
  );
  vi.mocked(api.ackE2eDeviceInbox).mockImplementation((t, s, d, ids) =>
    grappaFor(s).api.ackE2eDeviceInbox(t, s, d, ids),
  );
  vi.mocked(api.sendE2e).mockImplementation((t, s, o) => grappaFor(s).api.sendE2e(t, s, o));
  vi.mocked(api.claimE2eDeviceKeys).mockImplementation((t, s, d, f) =>
    grappaFor(s).api.claimE2eDeviceKeys(t, s, d, f),
  );
  vi.mocked(api.copyE2e).mockImplementation((t, s, d, o) => grappaFor(s).api.copyE2e(t, s, d, o));
  vi.mocked(api.clearE2eKeys).mockImplementation((t, s) => grappaFor(s).api.clearE2eKeys(t, s));
}
