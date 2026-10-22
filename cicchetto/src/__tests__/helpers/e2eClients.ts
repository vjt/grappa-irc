// issue 2430 — cics on a fake grappa (`e2eGrappa.ts`), for the E2E client's
// tests. The engines, the identity sync, the account store and the chat store
// are the real ones over in-memory twins of IndexedDB and Web Locks
// (`e2eVault.ts`); grappa's REST is the fake's, through the `vi.mock`ed api
// module the test file routes to it (`routeApi`), whose bearer is the nick.
// A side is one device of a subject. A tab is a client of its own over the
// same stores, with a page of its own: what a second tab of the same cic is.
// Another device of the same subject is what a pairing (X1) leaves behind,
// built by hand here (`pairDevice`).
import { type AccountStore, accountStore, type OwnIdentity } from "../../lib/e2e/accountStore";
import { type ChatRow, type ChatStore, chatStore } from "../../lib/e2e/chatStore";
import { type E2eContext, e2eClient } from "../../lib/e2e/client";
import { Engine } from "../../lib/e2e/engine";
import { replaceIdentity, syncIdentity } from "../../lib/e2e/identity";
import { idBlock } from "../../lib/e2e/keyBundle";
import { type OrderScope, SendLog } from "../../lib/e2e/orders";
import type { SasHost } from "../../lib/e2e/sas";
import { certSigText, listSigText } from "../../lib/e2e/wire";
import { FRAME_BUDGET_BASE, SLUG } from "./e2eDevices";
import { Grappa } from "./e2eGrappa";
import { type MemoryVault, memoryLock, memoryVault } from "./e2eVault";
import { olm } from "./olm";

export const SLOT = "user:0b5e:1";
/** The network every side is on, as an order challenge names it. */
export const SCOPE: OrderScope = {
  subject: "user:0b5e",
  slug: SLUG,
  network: "AzzurraNet",
  casemapping: "ascii",
  chantypes: ["#", "&"],
};

/** One browser's stores: its vault of accounts, its chats, and the lock both share. */
type Stores = {
  vault: MemoryVault;
  chatVault: MemoryVault;
  accounts: AccountStore;
  chats: ChatStore;
};

export type Side = Stores & {
  nick: string;
  ctx: E2eContext;
  host: SasHost;
  /** The PRIVMSGs this side's cic sent: what its order challenges are checked against. */
  sent: SendLog;
  client: ReturnType<typeof e2eClient>;
};

// The world made last: the grappa a test file's `routeApi` answers from.
let latest: World | undefined;

/** The fake grappa of the world made last, for `routeApi`. */
export function latestGrappa(): Grappa {
  if (latest === undefined) throw new Error("no world yet");
  return latest.grappa;
}

export class World {
  now = 1_700_000_000_000;
  grappa = new Grappa();
  /** The pages alive: each tab's, until it is closed. */
  pages = new Set<string>();
  private nextPage = 1;

  constructor() {
    latest = this;
  }

  /** A cic on `nick`, its identity made by the real sync. */
  async join(nick: string): Promise<Side> {
    const stores = browser();
    const state = await syncIdentity(stores.accounts, nick, SLOT, SLUG);
    if (state !== "ready") throw new Error(`${nick}'s identity is ${state}`);
    return this.side(nick, stores, new SendLog(null));
  }

  /**
   * A new browser on `nick`, whose user chose to start a new identity over
   * the one grappa holds (`replaceIdentity`): every peer sees a new master.
   */
  async rejoin(nick: string): Promise<Side> {
    const stores = browser();
    await replaceIdentity(stores.accounts, nick, SLOT, SLUG);
    return this.side(nick, stores, new SendLog(null));
  }

  /**
   * Another device of `side`'s subject, in a browser of its own, as a pairing
   * leaves it: registered under the subject's master, which certifies it for
   * the next list and puts that list, naming both; then its keys, by the real
   * sync. It holds no master: `side`'s device keeps it.
   */
  async pairDevice(side: Side): Promise<Side> {
    const stores = browser();
    const own = await ownOf(side);
    const { ed25519, id } = await stores.accounts.withAccount(SLOT, async ({ account }) => ({
      ed25519: account.ed25519_key(),
      id: idBlock(account, own.master),
    }));
    const { did } = await this.grappa.api.registerE2eDevice(side.nick, SLUG, id);
    const placed = await side.accounts.withAccount(SLOT, async (session) => {
      if (session.master === null || session.own === null) throw new Error("no master here");
      const ver = session.own.list.ver + 1;
      const devices = [...session.own.list.devices, ed25519].sort();
      const list = { ver, devices, sig: session.master.sign(listSigText(ver, devices)) };
      await this.grappa.api.putE2eList(side.nick, SLUG, { master: own.master, ...list });
      session.own = { ...session.own, list };
      const cert = session.master.sign(certSigText(ver, ed25519));
      return { master: own.master, cert, certVer: ver, list, did };
    });
    await stores.accounts.withAccount(SLOT, async (session) => {
      session.own = placed;
    });
    const state = await syncIdentity(stores.accounts, side.nick, SLOT, SLUG);
    if (state !== "ready") throw new Error(`the paired device's identity is ${state}`);
    return this.side(side.nick, stores, new SendLog(null));
  }

  /** Another tab of `side`'s cic: the same stores, another page. */
  tab(side: Side): Side {
    const { vault, chatVault, accounts, chats } = side;
    return this.side(side.nick, { vault, chatVault, accounts, chats }, side.sent);
  }

  /** The tab goes away: its page, and the SAS secrets it held, with it. */
  close(side: Side): void {
    this.pages.delete(side.host.page);
  }

  private side(nick: string, stores: Stores, sent: SendLog): Side {
    const page = `page-${this.nextPage++}`;
    this.pages.add(page);
    const host: SasHost = {
      page,
      secrets: new Map(),
      alive: async () => new Set(this.pages),
    };
    return {
      ...stores,
      nick,
      ctx: {
        slot: SLOT,
        ownNick: nick,
        frameBudgetBase: FRAME_BUDGET_BASE,
        door: (did) => this.grappa.door(nick, did),
        orders: (chal, challenger, at) => sent.confirms(chal, challenger, SCOPE, at),
      },
      host,
      sent,
      client: e2eClient(olm(), stores.accounts, stores.chats, () => this.now, host),
    };
  }
}

function browser(): Stores {
  const lock = memoryLock();
  const vault = memoryVault();
  const chatVault = memoryVault();
  return {
    vault,
    chatVault,
    accounts: accountStore(olm(), vault, lock),
    chats: chatStore(chatVault, lock),
  };
}

/** `side`'s place in its subject's identity, as its record holds it. */
export async function ownOf(side: Side): Promise<OwnIdentity> {
  const own = await side.accounts.withAccount(SLOT, async (session) => session.own);
  if (own === null) throw new Error(`${side.nick} holds no identity`);
  return own;
}

export const rowsOf = (side: Side, nick: string): Promise<ChatRow[]> => side.chats.rows(SLOT, nick);

/** What grappa still holds for `side`'s device. */
export async function inboxOf(w: World, side: Side): Promise<unknown[]> {
  const { did } = await ownOf(side);
  return (await w.grappa.api.listE2eDeviceInbox(side.nick, SLUG, did, 0)).messages;
}

export async function pair(): Promise<{ w: World; a: Side; b: Side }> {
  const w = new World();
  return { w, a: await w.join("alice"), b: await w.join("Bob") };
}

/**
 * A message each way, so each side holds a session and the other's master,
 * and each one's list: the list asks a first message brings go and are
 * answered, and nothing is left in either inbox.
 */
export async function chat(a: Side, b: Side): Promise<void> {
  await a.client.send(a.ctx, b.nick, "hello");
  await a.client.drain(a.ctx);
  await b.client.drain(b.ctx);
  await b.client.send(b.ctx, a.nick, "hi");
  await a.client.drain(a.ctx);
  await b.client.drain(b.ctx);
}

/** An engine on `side`'s record, outside its client, and what it sends through its door. */
function outside<T>(
  w: World,
  side: Side,
  fn: (engine: Engine, own: OwnIdentity) => Promise<T>,
): Promise<T> {
  return side.accounts.withAccount(SLOT, async ({ account, own, state }) => {
    if (own === null) throw new Error(`${side.nick} holds no identity`);
    const engine = new Engine(
      olm(),
      account,
      own,
      state,
      side.nick,
      FRAME_BUDGET_BASE,
      () => w.now,
    );
    return fn(engine, own);
  });
}

/**
 * `side` sends `inner` to every device of `nick` on its sessions, outside
 * anything its own client would send: a misbehaving peer, or a bot's order
 * challenge.
 */
export async function inject(
  w: World,
  side: Side,
  nick: string,
  inner: Record<string, unknown>,
): Promise<void> {
  await outside(w, side, async (engine, own) => {
    for (const out of engine.send(nick, inner, "injected", null, null).outbound) {
      const answer = await side.ctx.door(own.did).send(out);
      if ("msgid" in answer && out.ref !== undefined) engine.sent(out.ref, answer.msgid);
    }
  });
}

/** The inner messages waiting for `side`'s device, decrypted on its engine, and taken from its inbox. */
export async function inners(w: World, side: Side): Promise<Record<string, unknown>[]> {
  return outside(w, side, async (engine, own) => {
    const door = side.ctx.door(own.did);
    const page = await door.inbox(0);
    const got: Record<string, unknown>[] = [];
    for (const m of page) {
      for (const e of engine.receive(m.from, m.verb, m.msgid, m.fromDid, m.payload).events) {
        if (e.kind === "received") got.push(e.inner);
      }
    }
    if (page.length > 0) await door.ack(page.map((m) => m.id));
    return got;
  });
}
