// issue 2430 — the fake grappa every E2E test runs on (`helpers/e2eGrappa.ts`).
// It must answer and refuse the way the real one does, or a test built on it
// proves the wrong thing: its KEYS is held against what
// `Grappa.E2eKeys.answer/3` documents and its own test pins, its refusals
// against `GrappaWeb.E2eController` and `Grappa.E2eKeys`. The keys are real
// vodozemac keys, signed by the production code that signs them in cic.
import { describe, expect, it } from "vitest";
import { idBlock, signedKey } from "../lib/e2e/keyBundle";
import type { Account } from "../lib/e2e/vodozemac/vodozemac_binding";
import { listSigText, type SendVerb } from "../lib/e2e/wire";
import { Grappa } from "./helpers/e2eGrappa";
import { olm } from "./helpers/olm";

const SLUG = "azzurra";

type Device = { account: Account; did: string };

/** An identity on `grappa` for `nick`: a master listing `n` registered devices at version 1. */
async function identity(grappa: Grappa, nick: string, n: number) {
  const master = new (olm().Account)();
  const devices: Device[] = [];
  for (let i = 0; i < n; i++) {
    const account = new (olm().Account)();
    const { did } = await grappa.api.registerE2eDevice(
      nick,
      SLUG,
      idBlock(account, master.ed25519_key()),
    );
    devices.push({ account, did });
  }
  const keys = devices.map((d) => d.account.ed25519_key()).sort();
  const list = {
    master: master.ed25519_key(),
    ver: 1,
    devices: keys,
    sig: master.sign(listSigText(1, keys)),
  };
  await grappa.api.putE2eList(nick, SLUG, list);
  return { master, devices, list };
}

/** `count` signed one-time keys of `device`, and its signed fallback key when asked for. */
function keysOf(device: Device, count: number, fallback: boolean) {
  device.account.generate_one_time_keys(count);
  if (fallback) device.account.generate_fallback_key();
  const one_time_keys = device.account.one_time_keys().map((k) => signedKey(device.account, k));
  const fb = device.account.fallback_key();
  device.account.mark_keys_as_published();
  return { one_time_keys, fallback: fb === undefined ? null : signedKey(device.account, fb) };
}

const keyreq = (from: string, target: string) => ({
  target,
  verb: "keyreq" as const,
  from,
  to: "*",
  payload: '{"v":2}',
  priority: "control" as const,
  expiresAt: null,
});

/** What waits for `nick`'s device `did`, taken off its queue (an empty ack is a 400). */
async function keysFor(grappa: Grappa, nick: string, did: string) {
  const { messages } = await grappa.api.listE2eDeviceInbox(nick, SLUG, did, 0);
  const ids = messages.map((m) => m.id);
  if (ids.length > 0) await grappa.api.ackE2eDeviceInbox(nick, SLUG, did, ids);
  return messages;
}

describe("fake grappa v2: KEYS", () => {
  it("answers a KEYREQ as answer/3 composes KEYS: the list, then each listed device in the list's order with its oldest key, from * to the asking device", async () => {
    const grappa = new Grappa();
    const bob = await identity(grappa, "Bob", 2);
    const [d1, d2] = bob.devices as [Device, Device];
    const k1 = keysOf(d1, 2, true);
    const k2 = keysOf(d2, 1, false);
    await grappa.api.uploadE2eDeviceKeys("Bob", SLUG, d1.did, k1);
    await grappa.api.uploadE2eDeviceKeys("Bob", SLUG, d2.did, k2);
    const alice = await identity(grappa, "alice", 1);
    const asker = (alice.devices[0] as Device).did;

    await grappa.api.sendE2e("alice", SLUG, keyreq(asker, "Bob"));

    const [keys, ...more] = await keysFor(grappa, "alice", asker);
    expect(more).toEqual([]);
    expect(keys).toMatchObject({
      kind: "e2e_message",
      network: SLUG,
      from: "Bob",
      from_did: "*",
      to_did: asker,
      verb: "keys",
    });
    // The compact JSON a frame carries as is: no space, nothing but ASCII.
    expect(keys?.payload).toMatch(/^[\x21-\x7e]+$/);
    const entry = (d: Device, otk: { key: string; sig: string }, fallback: boolean) => ({
      id: idBlock(d.account, bob.list.master),
      otk: { key: otk.key, fallback, sig: otk.sig },
    });
    const byKey = new Map([
      [
        d1.account.ed25519_key(),
        entry(d1, k1.one_time_keys[0] as { key: string; sig: string }, false),
      ],
      [
        d2.account.ed25519_key(),
        entry(d2, k2.one_time_keys[0] as { key: string; sig: string }, false),
      ],
    ]);
    expect(JSON.parse(keys?.payload ?? "")).toEqual({
      v: 2,
      master: {
        ed25519: bob.list.master,
        list: { ver: 1, devices: bob.list.devices },
        sig: bob.list.sig,
      },
      devices: bob.list.devices.map((key) => byKey.get(key)),
    });
  });

  it("hands out each one-time key once, then the fallback key again and again; a device with neither is left out", async () => {
    const grappa = new Grappa();
    const bob = await identity(grappa, "Bob", 2);
    const [d1, d2] = bob.devices as [Device, Device];
    const k1 = keysOf(d1, 1, true);
    const k2 = keysOf(d2, 1, false);
    await grappa.api.uploadE2eDeviceKeys("Bob", SLUG, d1.did, k1);
    await grappa.api.uploadE2eDeviceKeys("Bob", SLUG, d2.did, k2);
    const asker = ((await identity(grappa, "alice", 1)).devices[0] as Device).did;

    const handedOut: { key: string; fallback: boolean }[][] = [];
    for (let i = 0; i < 3; i++) {
      await grappa.api.sendE2e("alice", SLUG, keyreq(asker, "Bob"));
      const [keys] = await keysFor(grappa, "alice", asker);
      const { devices } = JSON.parse(keys?.payload ?? "") as {
        devices: { otk: { key: string; fallback: boolean } }[];
      };
      handedOut.push(devices.map(({ otk }) => ({ key: otk.key, fallback: otk.fallback })));
    }

    const first = bob.list.devices.map((key) =>
      key === d1.account.ed25519_key()
        ? { key: k1.one_time_keys[0]?.key, fallback: false }
        : { key: k2.one_time_keys[0]?.key, fallback: false },
    );
    const fallback = { key: k1.fallback?.key, fallback: true };
    expect(handedOut).toEqual([first, [fallback], [fallback]]);
    expect(await grappa.api.getE2eDeviceKeys("Bob", SLUG, d1.did)).toEqual({
      one_time_keys: 0,
      fallback: true,
    });
  });

  it("leaves a KEYREQ unanswered with no list to answer from, and when told to", async () => {
    const grappa = new Grappa();
    const asker = ((await identity(grappa, "alice", 1)).devices[0] as Device).did;
    await grappa.api.sendE2e("alice", SLUG, keyreq(asker, "nobody"));
    expect(await keysFor(grappa, "alice", asker)).toEqual([]);

    const bob = await identity(grappa, "Bob", 1);
    const d = bob.devices[0] as Device;
    await grappa.api.uploadE2eDeviceKeys("Bob", SLUG, d.did, keysOf(d, 1, true));
    grappa.unanswered = () => true;
    await grappa.api.sendE2e("alice", SLUG, keyreq(asker, "Bob"));
    expect(await keysFor(grappa, "alice", asker)).toEqual([]);
    // Unanswered, the key was not handed out.
    expect(await grappa.api.getE2eDeviceKeys("Bob", SLUG, d.did)).toEqual({
      one_time_keys: 1,
      fallback: true,
    });
  });
});

describe("fake grappa v2: routing", () => {
  it("routes by to: a did reaches that listed device only, * every listed one, an unlisted device nothing", async () => {
    const grappa = new Grappa();
    const bob = await identity(grappa, "Bob", 2);
    const [d1, d2] = bob.devices as [Device, Device];
    // Registered, never listed: one being paired.
    const pending = await grappa.api.registerE2eDevice(
      "Bob",
      SLUG,
      idBlock(new (olm().Account)(), bob.list.master),
    );
    const from = ((await identity(grappa, "alice", 1)).devices[0] as Device).did;
    const msg = (to: string, payload: string) => ({
      target: "bob",
      verb: "msg" as const,
      from,
      to,
      payload,
      priority: "text" as const,
      expiresAt: null,
    });

    const all = await grappa.api.sendE2e("alice", SLUG, msg("*", '{"n":1}'));
    await grappa.api.sendE2e("alice", SLUG, msg(d2.did, '{"n":2}'));
    await grappa.api.sendE2e("alice", SLUG, msg(pending.did, '{"n":3}'));

    const queued = async (did: string) =>
      (await grappa.api.listE2eDeviceInbox("Bob", SLUG, did, 0)).messages.map((m) => [
        m.payload,
        m.from_did,
        m.to_did,
        m.msgid,
      ]);
    expect(await queued(d1.did)).toEqual([['{"n":1}', from, d1.did, all.msgid]]);
    expect(await queued(d2.did)).toEqual([
      ['{"n":1}', from, d2.did, all.msgid],
      ['{"n":2}', from, d2.did, expect.any(String)],
    ]);
    expect(await queued(pending.did)).toEqual([]);
  });

  it("a list that leaves a device out revokes it: its row, its keys and its queue go", async () => {
    const grappa = new Grappa();
    const bob = await identity(grappa, "Bob", 2);
    const [d1, d2] = bob.devices as [Device, Device];
    const kept = [d1.account.ed25519_key()];
    await grappa.api.putE2eList("Bob", SLUG, {
      master: bob.list.master,
      ver: 2,
      devices: kept,
      sig: bob.master.sign(listSigText(2, kept)),
    });

    expect((await grappa.api.listE2eDevices("Bob", SLUG)).map((d) => d.did)).toEqual([d1.did]);
    await expect(grappa.api.getE2eDeviceKeys("Bob", SLUG, d2.did)).rejects.toMatchObject({
      status: 404,
    });
    await expect(grappa.api.listE2eDeviceInbox("Bob", SLUG, d2.did, 0)).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe("fake grappa v2: refusals", () => {
  it("refuses expires_at anywhere but a control MSG/PKMSG (400), as the send door does", async () => {
    const grappa = new Grappa();
    await identity(grappa, "Bob", 1);
    const from = ((await identity(grappa, "alice", 1)).devices[0] as Device).did;
    const send = (priority: "control" | "text", verb: SendVerb) =>
      grappa.api.sendE2e("alice", SLUG, {
        target: "Bob",
        verb,
        from,
        to: "*",
        payload: '{"v":2}',
        priority,
        expiresAt: 1_700_000_000,
      });

    await expect(send("text", "msg")).rejects.toMatchObject({ status: 400, code: "bad_request" });
    await expect(send("control", "keyreq")).rejects.toMatchObject({ status: 400 });
    await expect(send("control", "msg")).resolves.toEqual({ msgid: expect.any(String) });
  });

  it("refuses a send from a device the sender's list does not name (422), and addresses its verb may not carry (400)", async () => {
    const grappa = new Grappa();
    const alice = await identity(grappa, "alice", 1);
    const unlisted = await grappa.api.registerE2eDevice(
      "alice",
      SLUG,
      idBlock(new (olm().Account)(), alice.list.master),
    );
    const base = {
      target: "Bob",
      verb: "msg" as const,
      payload: '{"v":2}',
      priority: "text" as const,
    };

    await expect(
      grappa.api.sendE2e("alice", SLUG, { ...base, from: unlisted.did, to: "*", expiresAt: null }),
    ).rejects.toMatchObject({ status: 422, code: "unknown_device" });
    const from = (alice.devices[0] as Device).did;
    await expect(
      grappa.api.sendE2e("alice", SLUG, { ...base, verb: "nack", from, to: "*", expiresAt: null }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      grappa.api.sendE2e("alice", SLUG, {
        ...base,
        from,
        to: "*",
        payload: '{"v": 2}',
        expiresAt: null,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("refuses a list whose ver does not rise (409 stale_list), takes the very list again, and refuses another master (409)", async () => {
    const grappa = new Grappa();
    const bob = await identity(grappa, "Bob", 1);
    const held = [...bob.list.devices];

    // A retried put: answered as the first time.
    await expect(grappa.api.putE2eList("Bob", SLUG, bob.list)).resolves.toEqual(bob.list);
    const extra = await grappa.api.registerE2eDevice(
      "Bob",
      SLUG,
      idBlock(new (olm().Account)(), bob.list.master),
    );
    const grown = [...held, extra.ed25519].sort();
    await expect(
      grappa.api.putE2eList("Bob", SLUG, {
        master: bob.list.master,
        ver: 1,
        devices: grown,
        sig: bob.master.sign(listSigText(1, grown)),
      }),
    ).rejects.toMatchObject({ status: 409, code: "stale_list" });

    const mallory = new (olm().Account)();
    await expect(
      grappa.api.putE2eList("Bob", SLUG, {
        master: mallory.ed25519_key(),
        ver: 9,
        devices: held,
        sig: mallory.sign(listSigText(9, held)),
      }),
    ).rejects.toMatchObject({ status: 409, code: "master_mismatch" });
    // A bad signature is a 400, whoever's master it claims.
    await expect(grappa.api.putE2eList("Bob", SLUG, { ...bob.list, ver: 2 })).rejects.toMatchObject(
      { status: 400 },
    );
  });

  it("refuses a list naming a key no device registered (422 unknown_device)", async () => {
    const grappa = new Grappa();
    const master = new (olm().Account)();
    const stranger = [new (olm().Account)().ed25519_key()];
    await expect(
      grappa.api.putE2eList("Bob", SLUG, {
        master: master.ed25519_key(),
        ver: 1,
        devices: stranger,
        sig: master.sign(listSigText(1, stranger)),
      }),
    ).rejects.toMatchObject({ status: 422, code: "unknown_device" });
  });

  it("refuses a fifth device (409 too_many_devices); registering one again keeps it one device", async () => {
    const grappa = new Grappa();
    const bob = await identity(grappa, "Bob", 4);
    const again = bob.devices[0] as Device;
    await expect(
      grappa.api.registerE2eDevice("Bob", SLUG, idBlock(again.account, bob.list.master)),
    ).resolves.toMatchObject({ did: again.did });

    await expect(
      grappa.api.registerE2eDevice("Bob", SLUG, idBlock(new (olm().Account)(), bob.list.master)),
    ).rejects.toMatchObject({ status: 409, code: "too_many_devices" });
    expect(await grappa.api.listE2eDevices("Bob", SLUG)).toHaveLength(4);
  });

  it("refuses an upload past 50 one-time keys a device whole (413), and a device that is not one (404)", async () => {
    const grappa = new Grappa();
    const bob = await identity(grappa, "Bob", 1);
    const d = bob.devices[0] as Device;
    await grappa.api.uploadE2eDeviceKeys("Bob", SLUG, d.did, keysOf(d, 48, false));

    await expect(
      grappa.api.uploadE2eDeviceKeys("Bob", SLUG, d.did, keysOf(d, 3, true)),
    ).rejects.toMatchObject({ status: 413, code: "too_large" });
    expect(await grappa.api.getE2eDeviceKeys("Bob", SLUG, d.did)).toEqual({
      one_time_keys: 48,
      fallback: false,
    });
    await expect(
      grappa.api.uploadE2eDeviceKeys("Bob", SLUG, "AAAAAAAAAAA", keysOf(d, 1, false)),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("fake grappa v2: claim and copy to a sibling", () => {
  it("the fake grappa's claim answers the sibling block and consumes the key, like grappa", async () => {
    const grappa = new Grappa();
    const bob = await identity(grappa, "Bob", 2);
    const [d1, d2] = bob.devices as [Device, Device];
    const k2 = keysOf(d2, 1, true);
    await grappa.api.uploadE2eDeviceKeys("Bob", SLUG, d2.did, k2);

    const { keys } = await grappa.api.claimE2eDeviceKeys("Bob", SLUG, d2.did, d1.did);

    const otk = k2.one_time_keys[0] as { key: string; sig: string };
    expect(JSON.parse(keys)).toEqual({
      v: 2,
      master: {
        ed25519: bob.list.master,
        list: { ver: 1, devices: bob.list.devices },
        sig: bob.list.sig,
      },
      devices: [
        {
          id: idBlock(d2.account, bob.list.master),
          otk: { key: otk.key, fallback: false, sig: otk.sig },
        },
      ],
    });
    // The one-time key went; the next claim is the fallback key, which stays.
    expect(await grappa.api.getE2eDeviceKeys("Bob", SLUG, d2.did)).toEqual({
      one_time_keys: 0,
      fallback: true,
    });
    const again = JSON.parse(
      (await grappa.api.claimE2eDeviceKeys("Bob", SLUG, d2.did, d1.did)).keys,
    );
    expect(again.devices[0].otk.fallback).toBe(true);

    await expect(grappa.api.claimE2eDeviceKeys("Bob", SLUG, d1.did, d1.did)).rejects.toMatchObject({
      status: 409,
      code: "self",
    });
    await expect(grappa.api.claimE2eDeviceKeys("Bob", SLUG, d1.did, d2.did)).rejects.toMatchObject({
      status: 409,
      code: "empty",
    });
    await expect(
      grappa.api.claimE2eDeviceKeys("Bob", SLUG, d2.did, "AAAAAAAAAAA"),
    ).rejects.toMatchObject({ status: 422, code: "unknown_device" });
    await expect(
      grappa.api.claimE2eDeviceKeys("Bob", SLUG, "AAAAAAAAAAA", d1.did),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("a copy lands in the sibling's inbox flagged own and is refused past the own 1 MiB share", async () => {
    const grappa = new Grappa();
    const bob = await identity(grappa, "Bob", 2);
    const [d1, d2] = bob.devices as [Device, Device];
    const copy = (payload: string, verb: SendVerb = "msg") =>
      grappa.api.copyE2e("Bob", SLUG, d2.did, { from_did: d1.did, verb, payload });

    const first = await copy('{"v":2}');
    const [item] = await keysFor(grappa, "Bob", d2.did);
    expect(item).toMatchObject({
      id: first.id,
      kind: "e2e_message",
      network: SLUG,
      from: "Bob",
      from_did: d1.did,
      to_did: d2.did,
      verb: "msg",
      msgid: first.msgid,
      payload: '{"v":2}',
      own: true,
    });

    // The share counts the payload plus 256 bytes a row, whatever the nick.
    const payload = "A".repeat(30_000);
    const fits = Math.floor(1_048_576 / (payload.length + 256));
    for (let i = 0; i < fits; i++) await copy(payload);
    await expect(copy(payload)).rejects.toMatchObject({ status: 413, code: "full" });

    await expect(copy('{"v":2}', "keyreq")).rejects.toMatchObject({ status: 400 });
    await expect(
      grappa.api.copyE2e("Bob", SLUG, d1.did, { from_did: d1.did, verb: "msg", payload: "x" }),
    ).rejects.toMatchObject({ status: 409, code: "self" });
    await expect(
      grappa.api.copyE2e("Bob", SLUG, d2.did, {
        from_did: "AAAAAAAAAAA",
        verb: "msg",
        payload: "x",
      }),
    ).rejects.toMatchObject({ status: 422, code: "unknown_device" });
  });
});
