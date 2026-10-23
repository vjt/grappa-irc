// issue 2430 S1 — one account's devices under one master, as `identity.ts`
// leaves them once paired: each device its own Olm account, its place in the
// identity and its engine state, every one of them on the one list the master
// signed. For the tests of the copies a device sends its siblings (the
// account's other devices); built from `e2eDevices.ts`, which speaks grappa's
// doors in one place.
import type { OwnIdentity } from "../../lib/e2e/accountStore";
import { type E2eState, Engine, newState } from "../../lib/e2e/engine";
import { idBlock } from "../../lib/e2e/keyBundle";
import type { Account } from "../../lib/e2e/vodozemac/vodozemac_binding";
import { certSigText, did, type SignedList } from "../../lib/e2e/wire";
import type { E2eKeysWireDevice } from "../../lib/wireTypes";
import { enlist, FRAME_BUDGET_BASE, signedList, uploadKeys } from "./e2eDevices";
import type { Grappa } from "./e2eGrappa";
import { olm } from "./olm";

/** One device of the account: its Olm account, its place in the identity, its engine's state. */
export type OwnDevice = { account: Account; own: OwnIdentity; state: E2eState };

/**
 * An account on one network: its nick, its master, the list the master
 * signed, its devices (all on that list, oldest first), and the clock (ms)
 * every engine of it reads.
 */
export type OwnAccount = {
  nick: string;
  master: Account;
  list: SignedList;
  devices: OwnDevice[];
  now: number;
};

/**
 * `count` devices of `nick` under one new master, every one on its list at
 * version 1 and certified at that version: each holds its own copy of the
 * list, as each device's record does.
 */
export function ownAccount(nick: string, count: number): OwnAccount {
  const master = new (olm().Account)();
  const accounts = Array.from({ length: count }, () => new (olm().Account)());
  const list = signedList(master, 1, accounts);
  return {
    nick,
    master,
    list,
    devices: accounts.map((account) => ({
      account,
      own: {
        master: master.ed25519_key(),
        cert: master.sign(certSigText(1, account.ed25519_key())),
        certVer: 1,
        list: { ...list, devices: [...list.devices] },
        did: did(olm(), account.ed25519_key()),
      },
      state: newState(),
    })),
    now: 1_700_000_000_000,
  };
}

/** The engine of `device` of `account`, on the account's clock. */
export function engineFor(account: OwnAccount, device: OwnDevice): Engine {
  return new Engine(
    olm(),
    device.account,
    device.own,
    device.state,
    account.nick,
    FRAME_BUDGET_BASE,
    () => account.now,
  );
}

/** What grappa lists of `device` registered under the master `master`: its did and its id block. */
export function deviceBlock(device: Account, master: string): E2eKeysWireDevice {
  return { did: did(olm(), device.ed25519_key()), ...idBlock(device, master) };
}

/** `account` on grappa: every device registered and listed, and each one's key bundle uploaded. */
export async function enrolledAccount(g: Grappa, account: OwnAccount): Promise<void> {
  const accounts = account.devices.map((device) => device.account);
  await enlist(g, account.nick, account.master, accounts, account.list);
  for (const device of accounts) await uploadKeys(g, account.nick, device);
}
