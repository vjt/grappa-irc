// issue 2430 — a fake grappa for the E2E tests: it does what the real one
// does with encrypted messages. A per-recipient inbox with AUTOINCREMENT ids
// and paging, a msgid per accepted send, a KEYREQ answered from the target's
// uploaded bundle (a one-time key while any is left, then the fallback), a
// KEYREQ left unanswered when told to (the real one answers a nick at most
// so often, `E2eKeyAnswers`, and drops the rest without a word), and a
// refusal when told to.
import type { AccountStore } from "../../lib/e2e/accountStore";
import type { DoorRefusal } from "../../lib/e2e/chatStore";
import type { Door, InboxMessage } from "../../lib/e2e/client";
import type { Outbound } from "../../lib/e2e/engine";
import { topUp } from "../../lib/e2e/keyBundle";
import { base64Unpadded, fold } from "../../lib/e2e/wire";

export class Grappa {
  inboxes = new Map<string, InboxMessage[]>();
  bundles = new Map<string, { otks: string[]; fallback: string | null }>();
  nextId = 1;
  pageSize = 100;
  /** Every send the door took, with who sent it. */
  sends: (Outbound & { by: string })[] = [];
  refuse: (o: Outbound) => DoorRefusal | undefined = () => undefined;
  /** A KEYREQ the door takes and nobody answers. */
  unanswered: (o: Outbound) => boolean = () => false;
  failAck = false;

  private inbox(nick: string): InboxMessage[] {
    const key = fold(nick);
    const found = this.inboxes.get(key) ?? [];
    this.inboxes.set(key, found);
    return found;
  }

  deliver(to: string, m: Omit<InboxMessage, "id">): void {
    this.inbox(to).push({ ...m, id: this.nextId++ });
  }

  /** The key bundle door's upload: one-time keys add up, a fallback replaces the last. */
  upload(nick: string, upload: { one_time_keys: string[]; fallback: string | null }): void {
    const held = this.bundles.get(fold(nick)) ?? { otks: [], fallback: null };
    this.bundles.set(fold(nick), {
      otks: [...held.otks, ...upload.one_time_keys],
      fallback: upload.fallback ?? held.fallback,
    });
  }

  /** What the key bundle door reports holding. */
  held(nick: string): { one_time_keys: number; fallback: boolean } {
    const held = this.bundles.get(fold(nick));
    return { one_time_keys: held?.otks.length ?? 0, fallback: (held?.fallback ?? null) !== null };
  }

  door(nick: string): Door {
    return {
      inbox: async (after) =>
        this.inbox(nick)
          .filter((m) => m.id > after)
          .slice(0, this.pageSize),
      ack: async (ids) => {
        if (this.failAck) throw new Error("ack refused");
        this.inboxes.set(
          fold(nick),
          this.inbox(nick).filter((m) => !ids.includes(m.id)),
        );
      },
      send: async (o) => {
        const refused = this.refuse(o);
        if (refused !== undefined) return { refused };
        this.sends.push({ ...o, by: nick });
        const msgid = base64Unpadded(crypto.getRandomValues(new Uint8Array(8)));
        if (o.verb === "keyreq") {
          if (this.unanswered(o)) return { msgid };
          const bundle = this.bundles.get(fold(o.target));
          const payload = bundle?.otks.shift() ?? bundle?.fallback ?? null;
          if (payload !== null)
            this.deliver(nick, { from: o.target, verb: "keys", msgid, payload });
        } else {
          this.deliver(o.target, { from: nick, verb: o.verb, msgid, payload: o.payload });
        }
        return { msgid };
      },
    };
  }
}

/** Puts a full key bundle for the account in `slot` on grappa, under `nick`, as the bundle sync would. */
export async function publishBundle(
  grappa: Grappa,
  nick: string,
  accounts: AccountStore,
  slot: string,
): Promise<void> {
  await accounts.withAccount(slot, async ({ account }) => {
    const upload = topUp(account, { one_time_keys: 0, fallback: false });
    if (upload === null || upload.fallback === null) throw new Error("no bundle built");
    account.mark_keys_as_published();
    grappa.upload(nick, upload);
  });
}
