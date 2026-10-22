// issue 2430 — cics on a fake grappa (`e2eGrappa.ts`), for the E2E client's
// tests. The engines, the account store and the chat store are the real ones
// over in-memory twins of IndexedDB and Web Locks (`e2eVault.ts`). A tab is a
// client of its own over the same stores, with a page of its own: what a
// second tab of the same cic is.
import { type AccountStore, accountStore } from "../../lib/e2e/accountStore";
import { type ChatRow, type ChatStore, chatStore } from "../../lib/e2e/chatStore";
import { type E2eContext, e2eClient } from "../../lib/e2e/client";
import type { SasHost } from "../../lib/e2e/sas";
import { Grappa, publishBundle } from "./e2eGrappa";
import { type MemoryVault, memoryLock, memoryVault } from "./e2eVault";
import { olm } from "./olm";

export const SLOT = "user:0b5e:1";

export type Side = {
  nick: string;
  ctx: E2eContext;
  vault: MemoryVault;
  chatVault: MemoryVault;
  accounts: AccountStore;
  chats: ChatStore;
  host: SasHost;
  client: ReturnType<typeof e2eClient>;
};

export class World {
  now = 1_700_000_000_000;
  grappa = new Grappa();
  /** The pages alive: each tab's, until it is closed. */
  pages = new Set<string>();
  private nextPage = 1;

  /** A cic on `nick`, with its key bundle on grappa. */
  async join(nick: string): Promise<Side> {
    const vault = memoryVault();
    const lock = memoryLock();
    const accounts = accountStore(olm(), vault, lock);
    const chatVault = memoryVault();
    const chats = chatStore(chatVault, lock);
    await publishBundle(this.grappa, nick, accounts, SLOT);
    return this.open({
      nick,
      ctx: { slot: SLOT, ownNick: nick, door: this.grappa.door(nick) },
      vault,
      chatVault,
      accounts,
      chats,
    });
  }

  /** Another tab of `side`'s cic: the same stores, another page. */
  tab(side: Side): Side {
    return this.open(side);
  }

  /** The tab goes away: its page, and the SAS secrets it held, with it. */
  close(side: Side): void {
    this.pages.delete(side.host.page);
  }

  private open(stores: Omit<Side, "host" | "client">): Side {
    const page = `page-${this.nextPage++}`;
    this.pages.add(page);
    const host: SasHost = {
      page,
      secrets: new Map(),
      alive: async () => new Set(this.pages),
    };
    return {
      ...stores,
      host,
      client: e2eClient(olm(), stores.accounts, stores.chats, () => this.now, host),
    };
  }
}

export const rowsOf = (side: Side, nick: string): Promise<ChatRow[]> => side.chats.rows(SLOT, nick);

export async function pair(): Promise<{ w: World; a: Side; b: Side }> {
  const w = new World();
  return { w, a: await w.join("alice"), b: await w.join("Bob") };
}
