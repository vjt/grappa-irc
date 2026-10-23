// issue 2430 — a QR pairing from the QR to "done" (X1-crypto): the two roles,
// each a small state machine over the channel `pairing.ts` opens. The screens
// (AddDeviceQr, PairScan) open the channel and hand each role the channel and
// what arrives on it; they read `state()` and call the verbs.
//
// The holder (the browser holding the master) shows the QR, the ECIES inbound
// side; the joiner (the new browser) scans it and speaks first. The joiner's
// hello gives both the same two-digit code; the holder's user TYPES the code
// the joiner shows, once (wrong, it ends with nothing sent but the hello); the
// holder offers each network it is master of (with none to offer it sends no
// offer and closes, and the joiner takes an offer of none as nothing to
// pair); on the joiner's "Pair this browser", and only then, it registers a
// device on each; the holder signs each in, the joiner takes its place and
// says done, naming where it did; the holder closes.
//
// Each payload is read once and in the order it came (the channel delivers so,
// and the ECIES counter needs it). One the channel does not open, or that is
// not the message the step waits for, ends the pairing as "failed". A door of
// `identity.ts` that throws fails its network only. A device the joiner
// registered is dropped again whenever the pairing ends before `signed`. Once
// `signed` went out the holder's lists are put: it reads "done", with `ended`
// null only when the joiner said done, else why it never did. Once `signed`
// came, the joiner completes.

import { type Accessor, createSignal } from "solid-js";
import type { BrowserE2e } from "./browser";
import {
  abandonJoin,
  accountSlot,
  addDevice,
  completeJoin,
  offerable,
  prepareJoin,
} from "./identity";
import type { Olm } from "./olm";
import type { CloseReason, PairCode, PairingChannel } from "./pairing";
import {
  decodePairMessage,
  encodePairMessage,
  type Join,
  type Offer,
  PAIRING_INFO,
  type PairMessage,
  type PairRefusal,
  type Signed,
  unwrapInitial,
  wrapInitial,
} from "./pairingMessages";
import type { Ecies, EciesOutbound, EstablishedEcies } from "./vodozemac/vodozemac_binding";
import type { IdBlock } from "./wire";

export type HolderStage = "waiting" | "code" | "offered" | "signing" | "done" | "ended";
export type JoinerStage = "joining" | "code" | "confirm" | "joining-networks" | "done" | "ended";

/** What one network came to: "added" = signed into its list in this pairing. */
export type NetworkResult = { network: string; outcome: "added" | PairRefusal };

export type HolderState = {
  stage: HolderStage;
  offered: string[];
  full: string[];
  notMaster: string[];
  results: NetworkResult[];
  ended: CloseReason | "code-mismatch" | "nothing-to-offer" | "failed" | null;
};

export type JoinerState = {
  stage: JoinerStage;
  checkCode: string | null;
  offered: string[];
  full: string[];
  results: NetworkResult[];
  ended: CloseReason | "nothing-to-pair" | "failed" | null;
};

type Deps = {
  e2e: Pick<BrowserE2e, "olm" | "accounts">;
  bearer: string;
  subject: { kind: string; id: string };
  networks: () => { slug: string; id: number }[];
};
export type HolderDeps = Deps;
/** `paired`: a network is ready here (production: `encryptedChats.pairedHere`). */
export type JoinerDeps = Deps & { paired: (slug: string, slot: string) => void };

// What both states start from.
const blank = () => ({ offered: [], full: [], results: [], ended: null });

/** The check code as both screens show it: always two digits. */
const pad2 = (n: number): string => String(n).padStart(2, "0");

// A door of one network: a throw is that network's "failed", and says why.
async function guarded<T>(door: string, slug: string, go: () => Promise<T>): Promise<T | "failed"> {
  try {
    return await go();
  } catch (err) {
    console.warn(`[e2e] pairing: ${door} failed on ${slug}`, err);
    return "failed";
  }
}

async function send(ch: PairingChannel | null, link: EstablishedEcies | null, m: PairMessage) {
  if (ch === null || link === null) throw new Error("the pairing channel is not open");
  await ch.send(link.encrypt(encodePairMessage(m)));
}

// What the other side said; null when the channel does not open it or it is
// not one of the five messages, which is logged (what failed, never the payload).
function read(olm: Olm, role: string, link: EstablishedEcies | null, payload: string) {
  if (link === null) return null;
  let bytes: Uint8Array;
  try {
    bytes = link.decrypt(payload);
  } catch {
    console.warn(`[e2e] pairing (${role}): a payload that does not decrypt`);
    return null;
  }
  const m = decodePairMessage(olm, bytes);
  if (m === null) console.warn(`[e2e] pairing (${role}): a payload that is no pairing message`);
  return m;
}

// A step that is no network's door failed (a send, mostly): logged, then `failed`.
function running(task: Promise<void>, failed: () => void): void {
  task.catch((err: unknown) => {
    console.warn("[e2e] a pairing step failed", err);
    failed();
  });
}

/** The browser that holds the master: it shows the QR, checks the typed code and signs the new device in. */
export function holderPairing(deps: HolderDeps): {
  state: Accessor<HolderState>;
  curve: string;
  attach(channel: PairingChannel): void;
  onPayload(payload: string): void;
  onClosed(reason: CloseReason): void;
  submitCode(code: string): void;
  cancel(): void;
} {
  const { olm, accounts } = deps.e2e;
  // Used up by the first payload, whatever it holds; freed if never used.
  let ecies: Ecies | null = new olm.Ecies(PAIRING_INFO);
  const curve = ecies.public_key();
  const [state, setState] = createSignal<HolderState>({
    ...blank(),
    stage: "waiting",
    notMaster: [],
  });
  const set = (patch: Partial<HolderState>) => setState((s) => ({ ...s, ...patch }));
  // The stage, finer: "judging" shows as "code", "adding" as "signing".
  let step: "waiting" | "code" | "judging" | "offered" | "adding" | "signing" | "over" = "waiting";
  let channel: PairingChannel | null = null;
  let link: EstablishedEcies | null = null;
  // The networks offered, by slug: each one's account slot.
  const offered = new Map<string, string>();
  // The networks with a result (offered, or not judged), in order, once known.
  const shown: string[] = [];
  const outcomes = new Map<string, NetworkResult["outcome"]>();
  const results = (): NetworkResult[] =>
    shown.flatMap((network) => {
      const outcome = outcomes.get(network);
      return outcome === undefined ? [] : [{ network, outcome }];
    });

  const over = (patch: Partial<HolderState>): void => {
    if (step === "over") return;
    step = "over";
    set(patch);
    void channel?.close();
    ecies?.free();
    link?.free();
    ecies = null;
    link = null;
  };
  // Once adding began, what was put shows. Once `signed` went out every list
  // is put, so it is done, and `ended` says why the joiner never said so.
  const end = (ended: NonNullable<HolderState["ended"]>): void => {
    if (step === "signing") over({ stage: "done", ended });
    else over({ stage: "ended", ended, results: step === "adding" ? results() : [] });
  };

  function hello(payload: string): void {
    const initial = unwrapInitial(payload);
    if (initial !== null && ecies !== null) {
      const once = ecies;
      ecies = null; // used up by the attempt, whatever comes of it
      try {
        const inbound = once.establish_inbound_channel(initial);
        if (decodePairMessage(olm, inbound.plaintext)?.t === "hello") {
          link = inbound.take_channel() ?? null;
        }
        inbound.free();
      } catch {
        // Not a hello sealed to this QR's key: no channel.
      }
    }
    if (link !== null) {
      step = "code";
      set({ stage: "code" });
      return;
    }
    console.warn("[e2e] pairing (holder): a first payload that is no hello to this QR's key");
    end("failed");
  }

  // Each network judged on its synced list, then the offer of those it can.
  async function offer(): Promise<void> {
    const networks: Offer["networks"] = [];
    const full: string[] = [];
    const notMaster: string[] = [];
    for (const { slug, id } of deps.networks()) {
      const slot = accountSlot(deps.subject, id);
      const judged = await guarded("judging the network", slug, () =>
        offerable(accounts, deps.bearer, slot, slug),
      );
      if (step !== "judging") return;
      if (judged === null) notMaster.push(slug);
      else if (judged === "full") full.push(slug);
      else {
        shown.push(slug);
        if (judged === "failed") outcomes.set(slug, "failed");
        else {
          offered.set(slug, slot);
          networks.push({ network: slug, master: judged.master });
        }
      }
    }
    // Nothing to offer: no offer goes out, each network shows why, and the
    // rendezvous closes. Posting an empty offer and closing would race the
    // joiner's fetch of it, which the close can answer 404.
    if (networks.length === 0) {
      return over({
        stage: "ended",
        ended: "nothing-to-offer",
        full,
        notMaster,
        results: results(),
      });
    }
    step = "offered";
    set({ stage: "offered", offered: [...offered.keys()], full, notMaster });
    await send(channel, link, { v: 1, t: "offer", networks, full });
  }

  async function signIn(join: Join): Promise<void> {
    step = "adding";
    set({ stage: "signing" });
    const ids = new Map<string, IdBlock>();
    const refused: Signed["refused"] = [];
    for (const { network, id } of join.devices) {
      // Only a network this side offered, and one device on it: never two
      // keys on one network in one pairing.
      if (!offered.has(network) || ids.has(network)) refused.push({ network, reason: "failed" });
      else ids.set(network, id);
    }
    // An offered network the joiner sent no device for: its reason, or "failed".
    const skipped = new Map<string, PairRefusal>(join.skipped.map((s) => [s.network, s.reason]));
    for (const slug of offered.keys()) {
      if (!ids.has(slug)) outcomes.set(slug, skipped.get(slug) ?? "failed");
    }
    const devices: Signed["devices"] = [];
    for (const [slug, slot] of offered) {
      const id = ids.get(slug);
      if (id === undefined) continue;
      const added = await guarded("adding the device", slug, () =>
        addDevice(accounts, deps.bearer, slot, slug, id),
      );
      if (step !== "adding") return;
      if (typeof added === "string") {
        refused.push({ network: slug, reason: added });
        outcomes.set(slug, added);
      } else {
        devices.push({ network: slug, ...added });
        outcomes.set(slug, "added");
      }
    }
    step = "signing";
    set({ stage: "signing", results: results() });
    await send(channel, link, { v: 1, t: "signed", devices, refused });
  }

  return {
    state,
    curve,
    attach: (ch) => {
      channel = ch;
      // Ended before the screen had the channel: nothing will use it.
      if (step === "over") void ch.close();
    },
    onPayload: (payload) => {
      if (step === "over") return;
      if (step === "waiting") return hello(payload);
      const m = read(olm, "holder", link, payload);
      if (step === "offered" && m?.t === "join") {
        // A failed send of `signed` may have landed all the same (only its
        // answer lost): the joiner's done, or the rendezvous ending, settles it.
        return running(signIn(m), () => {
          if (step !== "signing") end("failed");
        });
      }
      if (step === "signing" && m?.t === "done") {
        // Listed here and not taken there: the new browser holds no place.
        for (const [network, outcome] of outcomes) {
          if (outcome !== "added" || m.paired.includes(network)) continue;
          console.warn(
            `[e2e] pairing (holder): the new browser did not take its place on ${network}`,
          );
          outcomes.set(network, "failed");
        }
        return over({ stage: "done", results: results() });
      }
      end("failed");
    },
    onClosed: (reason) => end(reason),
    submitCode: (code) => {
      if (step !== "code" || link === null) return;
      // One try: the hundred codes cannot be guessed through.
      if (code !== pad2(link.check_code())) return end("code-mismatch");
      step = "judging";
      running(offer(), () => end("failed"));
    },
    cancel: () => end("closed"),
  };
}

/** The new browser: it shows the code, and on the user's tap registers a device on each network offered. */
export function joinerPairing(
  deps: JoinerDeps,
  code: PairCode,
): {
  state: Accessor<JoinerState>;
  onPayload(payload: string): void;
  onClosed(reason: CloseReason): void;
  attach(channel: PairingChannel): void;
  confirm(): void;
  cancel(): void;
} {
  const { olm, accounts } = deps.e2e;
  const [state, setState] = createSignal<JoinerState>({
    ...blank(),
    stage: "joining",
    checkCode: null,
  });
  const set = (patch: Partial<JoinerState>) => setState((s) => ({ ...s, ...patch }));
  let step: "joining" | "code" | "confirm" | "registering" | "joined" | "completing" | "over" =
    "joining";
  let channel: PairingChannel | null = null;
  let link: EstablishedEcies | null = null;
  // The networks offered, by slug: the master each would list this device under.
  const offered = new Map<string, string>();
  // The devices registered here and not listed yet, by network.
  const registered = new Map<string, { slot: string; master: string; did: string }>();
  const outcomes = new Map<string, NetworkResult["outcome"]>();
  const results = (): NetworkResult[] =>
    [...offered.keys()].map((network) => ({ network, outcome: outcomes.get(network) ?? "failed" }));

  // Every device registered and not listed, dropped once.
  async function abandon(): Promise<void> {
    const left = [...registered];
    registered.clear();
    for (const [slug, { did }] of left) await abandonJoin(deps.bearer, slug, did);
  }

  const release = (): void => {
    link?.free();
    link = null;
  };
  // Before `signed` it can still end, and its unlisted devices go with it.
  const end = (ended: NonNullable<JoinerState["ended"]>): void => {
    if (step === "completing" || step === "over") return;
    step = "over";
    set({ stage: "ended", ended });
    void channel?.close();
    release();
    void abandon();
  };

  function open(ch: PairingChannel): void {
    let out: EciesOutbound | null = null;
    try {
      out = new olm.Ecies(PAIRING_INFO).establish_outbound_channel(
        code.curve,
        encodePairMessage({ v: 1, t: "hello" }),
      );
    } catch (err) {
      // The QR's key is not a key: nobody to talk to.
      console.warn("[e2e] pairing (joiner): no channel opens to this QR's key", err);
    }
    link = out?.take_channel() ?? null;
    const initial = out?.message;
    out?.free();
    if (initial === undefined || link === null) end("failed");
    else {
      step = "code";
      set({ stage: "code", checkCode: pad2(link.check_code()) });
      running(ch.send(wrapInitial(initial)), () => end("failed"));
    }
  }

  async function join(): Promise<void> {
    const devices: Join["devices"] = [];
    const skipped: Join["skipped"] = [];
    const skip = (network: string, reason: PairRefusal) => {
      skipped.push({ network, reason });
      outcomes.set(network, reason);
    };
    for (const [slug, master] of offered) {
      const network = deps.networks().find((n) => n.slug === slug);
      if (network === undefined) {
        console.warn(
          `[e2e] pairing (joiner): ${slug} was offered and is not among this browser's networks`,
        );
        skip(slug, "failed");
        continue;
      }
      const slot = accountSlot(deps.subject, network.id);
      const prepared = await guarded("registering the device", slug, () =>
        prepareJoin(accounts, deps.bearer, slot, slug, master),
      );
      if (typeof prepared !== "string") registered.set(slug, { slot, master, did: prepared.did });
      // Ended meanwhile: the device just registered goes too.
      if (step !== "registering") return abandon();
      if (typeof prepared === "string") skip(slug, prepared);
      else devices.push({ network: slug, id: prepared.id });
    }
    step = "joined";
    await send(channel, link, { v: 1, t: "join", devices, skipped });
  }

  async function complete(signed: Signed): Promise<void> {
    step = "completing";
    try {
      const paired: string[] = [];
      for (const [slug, { slot, master, did }] of registered) {
        // The first entry for a network this device joined; any other is ignored.
        const entry = signed.devices.find((d) => d.network === slug);
        const placed =
          entry !== undefined &&
          (await guarded("completing the join", slug, () =>
            completeJoin(accounts, deps.bearer, slot, slug, master, entry),
          )) === true;
        if (placed) {
          outcomes.set(slug, "added");
          paired.push(slug);
          try {
            deps.paired(slug, slot);
          } catch (err) {
            console.warn(`[e2e] pairing: telling the page that ${slug} is paired failed`, err);
          }
        } else {
          // Refused (its reason shows) or not signed for right ("failed"): it goes.
          const refusal = entry ? undefined : signed.refused.find((r) => r.network === slug);
          outcomes.set(slug, refusal?.reason ?? "failed");
          await abandonJoin(deps.bearer, slug, did);
        }
      }
      registered.clear();
      await send(channel, link, { v: 1, t: "done", paired });
    } finally {
      step = "over";
      set({ stage: "done", results: results() });
      release();
    }
  }

  return {
    state,
    onPayload: (payload) => {
      if (step === "completing" || step === "over") return;
      const m = read(olm, "joiner", link, payload);
      if (step === "code" && m?.t === "offer") {
        // One master per network: the first one named.
        for (const { network, master } of m.networks) {
          if (!offered.has(network)) offered.set(network, master);
        }
        // An offer of no network: nothing to pair, so no tap to ask for.
        if (offered.size === 0) {
          set({ full: m.full });
          return end("nothing-to-pair");
        }
        step = "confirm";
        set({ stage: "confirm", offered: [...offered.keys()], full: m.full });
        return;
      }
      if (step === "joined" && m?.t === "signed") return running(complete(m), () => end("failed"));
      end("failed");
    },
    onClosed: (reason) => end(reason),
    attach: (ch) => {
      channel = ch;
      if (step === "over") void ch.close();
      else if (step === "joining") open(ch);
    },
    confirm: () => {
      if (step !== "confirm") return;
      step = "registering";
      set({ stage: "joining-networks" });
      running(join(), () => end("failed"));
    },
    cancel: () => end("closed"),
  };
}
