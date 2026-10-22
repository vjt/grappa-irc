// issue 2430 — devices on the fake grappa (`e2eGrappa.ts`) built by hand, for
// the tests that drive engines directly: what `identity.ts` does for a device
// (its id block registered under its master, the master's list put, its key
// bundle uploaded), and the send door as `client.ts` uses it (each payload
// sent, each msgid handed back). The engine's and the SAS's tests share it,
// so each of these steps speaks the protocol in one place.
import type { Outbound } from "../../lib/e2e/engine";
import { idBlock, MAX_HOSTED_ONE_TIME_KEYS, topUp } from "../../lib/e2e/keyBundle";
import type { Account } from "../../lib/e2e/vodozemac/vodozemac_binding";
import { did, listSigText, type SignedList } from "../../lib/e2e/wire";
import type { Grappa } from "./e2eGrappa";
import { olm } from "./olm";

export const SLUG = "azzurra";

/**
 * grappa's `frame_budget_base` at LINELEN 512 (`line_split_test.exs`): 512 less
 * the worst-case relayed source prefix, `PRIVMSG :` and CRLF.
 */
export const FRAME_BUDGET_BASE = 394;

/** A list of `master`'s at `ver` naming `devices`, keys sorted as the wire wants them. */
export function signedList(master: Account, ver: number, devices: Account[]): SignedList {
  const keys = devices.map((device) => device.ed25519_key()).sort();
  return { ver, devices: keys, sig: master.sign(listSigText(ver, keys)) };
}

/**
 * `devices` of `nick` registered under `master` (one registered already is
 * registered again, which changes nothing), then `list` put as its list.
 */
export async function enlist(
  g: Grappa,
  nick: string,
  master: Account,
  devices: Account[],
  list: SignedList,
): Promise<void> {
  for (const device of devices) {
    await g.api.registerE2eDevice(nick, SLUG, idBlock(device, master.ed25519_key()));
  }
  await g.api.putE2eList(nick, SLUG, { master: master.ed25519_key(), ...list });
}

/** `device` of `nick` uploads four one-time keys and a fallback key, as `topUp` builds them. */
export async function uploadKeys(g: Grappa, nick: string, device: Account): Promise<void> {
  const upload = topUp(device, { one_time_keys: MAX_HOSTED_ONE_TIME_KEYS - 4, fallback: false });
  if (upload === null) throw new Error("no bundle built");
  device.mark_keys_as_published();
  await g.api.uploadE2eDeviceKeys(nick, SLUG, did(olm(), device.ed25519_key()), upload);
}

/**
 * `outbound` through the send door of `nick`'s device `deviceDid`, in order,
 * as `client.ts` sends it; each msgid grappa names for a payload that carries
 * a message goes to `sent` (`Engine.sent`). Answers the msgids, in order. A
 * refusal throws: these tests send nothing grappa should refuse.
 */
export async function throughDoor(
  g: Grappa,
  nick: string,
  deviceDid: string,
  outbound: Outbound[],
  sent: (ref: string, msgid: string) => void,
): Promise<string[]> {
  const msgids: string[] = [];
  for (const o of outbound) {
    const answer = await g.door(nick, deviceDid).send({
      target: o.target,
      verb: o.verb,
      from: o.from,
      to: o.to,
      payload: o.payload,
      priority: o.priority,
      expiresAt: o.expiresAt ?? null,
    });
    if ("refused" in answer) throw new Error(`grappa refused a ${o.verb}: ${answer.refused}`);
    if (o.ref !== undefined) sent(o.ref, answer.msgid);
    msgids.push(answer.msgid);
  }
  return msgids;
}
