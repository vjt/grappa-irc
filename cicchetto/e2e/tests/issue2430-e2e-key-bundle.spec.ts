// issue 2430 — cic's Olm account and the key bundle it keeps on grappa, end
// to end through a real browser and a real ircd (wire v2, grappa protocol 49).
//
// cic runs vodozemac as WebAssembly, keeps the device account and the
// identity's master in IndexedDB sealed under a non-extractable WebCrypto
// key, and fills the bundle grappa answers a peer's KEYREQ from: this
// browser is ONE DEVICE of a per-network identity, registered on grappa and
// named by the master's signed list. Nothing of it is on screen but the
// master key; what a peer can see is the KEYS answer, so that is what this
// spec reads, from a peer, the way a peer would: reassembled from its
// fragments, parsed, and every signature verified with node's Ed25519 over
// the byte strings the wire names (the list under the master, the device's
// id block and one-time key under the device).
//
// ## What makes this spec able to fail
//
//   * The binding never loads in the browser (CSP without
//     'wasm-unsafe-eval', a missing asset): no upload, the first wait times
//     out, and the `_cspGuard` fixture names any violation.
//   * The list, id block or one-time key is signed wrong: the peer's
//     verification fails.
//   * The account is not persisted, or a reload makes a new one: the reload
//     shows the registration calls again, and the master changes.
//   * The test-only wipe does not wipe, or a wiped browser quietly replaces
//     the identity grappa holds (an identity is never replaced silently): a
//     write call shows up before the user confirms, or the identity changes
//     without the confirm.
//
// The REST calls are read from the page's own requests: their order (list,
// register, put list, upload keys for a new identity; list and keys for a
// known one; no writes at all for a wiped browser) is the contract, and only
// the page knows it.

import { createPublicKey, randomBytes, verify } from "node:crypto";
import type { Page } from "@playwright/test";
import { e2eBundleUploaded, loginAs } from "../fixtures/cicchettoPage";
import { equery, replaceIdentity } from "../fixtures/encryptedQuery";
import { fetchE2eKeys, soleE2eDevice } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

// What grappa composes for a KEYREQ (CLIENT_PROTOCOL §4f): the master's
// signed list, then each listed device's id block and one key.
type Keys = {
  v: number;
  master: { ed25519: string; list: { ver: number; devices: string[] }; sig: string };
  devices: {
    id: { curve25519: string; ed25519: string; sig: string };
    otk: { key: string; fallback: boolean; sig: string };
  }[];
};

const newMsgid = (): string => randomBytes(8).toString("base64").replace(/=+$/, "");

// A device id as the wire spells it: the first 8 bytes of a hash, base64url.
// The asking peer's is made up: grappa addresses the answer to it and checks
// nothing else about it.
const newDid = (): string => randomBytes(8).toString("base64url");

function ed25519Verifies(publicKey: string, message: string, signature: string): boolean {
  const key = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(publicKey, "base64").toString("base64url") },
    format: "jwk",
  });
  return verify(null, Buffer.from(message, "utf8"), key, Buffer.from(signature, "base64"));
}

// A fresh peer asks `target` for keys and gets grappa's answer from the
// bundle, from `*` (grappa, not a device) to the device that asked. One nick
// per ask: grappa answers a nick once per 15 s. The suffix keeps parallel
// repeats of this spec off each other's nick.
async function askForKeys(label: string, target: string): Promise<Keys> {
  const peer = await IrcPeer.connect({ nick: `${label}-${randomBytes(2).toString("hex")}` });
  try {
    const asking = newDid();
    const answer = peer.awaitE2e(target, "KEYS", 20_000);
    peer.e2eSend(target, "KEYREQ", newMsgid(), asking, "*", '{"v":2}');
    const { from, to, payload } = await answer;
    expect(from).toBe("*");
    expect(to).toBe(asking);
    const keys = JSON.parse(payload) as Keys;
    expect(keys.v).toBe(2);
    const { master } = keys;
    expect(
      ed25519Verifies(
        master.ed25519,
        `irc-e2e:v2:list:${master.list.ver}:${master.list.devices.join(",")}`,
        master.sig,
      ),
    ).toBe(true);
    expect(keys.devices.length).toBeGreaterThan(0);
    for (const { id, otk } of keys.devices) {
      expect(master.list.devices).toContain(id.ed25519);
      expect(
        ed25519Verifies(id.ed25519, `irc-e2e:v2:id:${id.curve25519}:${master.ed25519}`, id.sig),
      ).toBe(true);
      expect(ed25519Verifies(id.ed25519, `irc-e2e:v1:otk:${otk.key}`, otk.sig)).toBe(true);
    }
    return keys;
  } finally {
    await peer.disconnect("keys read");
  }
}

// `METHOD route` of every request the page makes to this network's E2E
// doors, the device in a route written as `:did`: the identity's and the
// bundle's, and the queue's own traffic (inbox, its ack, the send door).
function e2eCalls(page: Page): string[] {
  const calls: string[] = [];
  const prefix = `/networks/${NETWORK_SLUG}/e2e`;
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (!path.startsWith(`${prefix}/`)) return;
    const route = path.slice(prefix.length).replace(/^\/devices\/[^/]+\//, "/devices/:did/");
    calls.push(`${request.method()} ${route}`);
  });
  return calls;
}

// The identity's and the bundle's calls alone, in the order a sync makes
// them: the queue's traffic (inbox, ack, send) is not the identity's.
const identityOnly = (calls: string[]): string[] =>
  calls.filter((call) => !call.includes("/inbox") && !call.endsWith(" /messages"));

// The calls that write, on any E2E door: a wiped browser makes none of them.
const writes = (calls: string[]): string[] => calls.filter((call) => !call.startsWith("GET "));

// A new identity, as the page makes it: look for a list, register this
// device, put the master's list, upload the device's keys. Nothing is
// DELETEd: there was nothing to drop.
const NEW_IDENTITY = ["GET /list", "POST /devices", "PUT /list", "POST /devices/:did/keys"];

const bundleUploaded = (page: Page) => e2eBundleUploaded(page, NETWORK_SLUG);

// A new browser on a new account makes an identity and uploads a full
// bundle for its device. Returns that device's id.
async function loginWithNewAccount(page: Page, calls: string[]): Promise<string> {
  const vjt = specUser();
  const uploaded = bundleUploaded(page);
  await loginAs(page, vjt);
  await uploaded;
  expect(identityOnly(calls)).toEqual(NEW_IDENTITY);
  const { did } = await soleE2eDevice(vjt.token, NETWORK_SLUG);
  expect(await fetchE2eKeys(vjt.token, NETWORK_SLUG, did)).toEqual({
    one_time_keys: 50,
    fallback: true,
  });
  return did;
}

async function reloadAndUpload(page: Page, calls: string[]): Promise<void> {
  calls.length = 0;
  const uploaded = bundleUploaded(page);
  await page.reload();
  await uploaded;
}

// Two tests, two asks each: grappa spends at most 22 s of fake-lag bank on
// KEYS answers per connection per minute, and one answer costs about 8 s,
// so a third ask on the same session inside a minute is refused, by design.

test("cic fills the key bundle; a peer gets validly signed keys, and the same identity after a reload", async ({
  page,
}) => {
  test.slow();
  const vjt = specUser();
  const nick = specNick();
  const calls = e2eCalls(page);
  const did = await loginWithNewAccount(page, calls);

  const first = await askForKeys("i2430-keys1", nick);
  expect(first.devices.map(({ id }) => id.ed25519)).toEqual(first.master.list.devices);
  expect(first.devices[0]?.otk.fallback).toBe(false);
  expect(await fetchE2eKeys(vjt.token, NETWORK_SLUG, did)).toEqual({
    one_time_keys: 49,
    fallback: true,
  });

  // A reload finds the identity: it reads the list, asks what is left of its
  // device's bundle and puts back the one key the peer took. Same identity.
  await reloadAndUpload(page, calls);
  expect(identityOnly(calls)).toEqual([
    "GET /list",
    "GET /devices/:did/keys",
    "POST /devices/:did/keys",
  ]);
  expect(await fetchE2eKeys(vjt.token, NETWORK_SLUG, did)).toEqual({
    one_time_keys: 50,
    fallback: true,
  });
  const second = await askForKeys("i2430-keys2", nick);
  expect(second.master.ed25519).toBe(first.master.ed25519);
  expect(second.devices[0]?.id.ed25519).toBe(first.devices[0]?.id.ed25519);
  expect(second.devices[0]?.otk.key).not.toBe(first.devices[0]?.otk.key);
});

test("after the test-only wipe the browser reads 'elsewhere' and writes nothing; only the confirmed new identity replaces grappa's", async ({
  page,
}) => {
  test.slow();
  const vjt = specUser();
  const nick = specNick();
  const calls = e2eCalls(page);
  const oldDid = await loginWithNewAccount(page, calls);
  const before = await askForKeys("i2430-wipe1", nick);

  // w2's interop suite uses the hook. It deletes this browser's state and
  // nothing on grappa, which still holds the identity: the next page cannot
  // speak for it, and an identity is never replaced silently.
  await page.evaluate(() => window.__cic_e2eResetForTests?.());
  calls.length = 0;
  await page.reload();
  await equery(page, nick, "i2430-nobody");
  await expect(page.getByTestId("e2e-identity-elsewhere")).toBeVisible();
  await expect(page.getByTestId("e2e-own-identity")).toHaveCount(0);
  await expect(page.getByTestId("e2e-compose-input")).toBeDisabled();

  // The primary way out is a pairing link: a paste that is not one is
  // refused where it was typed, and nothing is navigated or written.
  await page.getByTestId("e2e-identity-pair-code").fill("not a pairing link");
  await page.getByTestId("e2e-identity-pair-submit").click();
  await expect(page.getByTestId("e2e-identity-pair-error")).toBeVisible();
  await expect(page).not.toHaveURL(/\/pair/);

  // Only reads so far, on every E2E door (no key, list or device written, no
  // inbox acknowledged, nothing sent), and grappa still holds the same device
  // and identity.
  expect(calls).toContain("GET /list");
  expect(writes(calls)).toEqual([]);
  expect((await soleE2eDevice(vjt.token, NETWORK_SLUG)).did).toBe(oldDid);

  // The secondary way: start a new identity here, behind the confirm. It
  // drops the old one on grappa FIRST, then makes a new one as a fresh
  // browser does.
  calls.length = 0;
  await replaceIdentity(page);
  expect(writes(identityOnly(calls))).toEqual(["DELETE /keys", ...NEW_IDENTITY.slice(1)]);
  const newDevice = await soleE2eDevice(vjt.token, NETWORK_SLUG);
  expect(newDevice.did).not.toBe(oldDid);

  const after = await askForKeys("i2430-wipe2", nick);
  expect(after.master.ed25519).not.toBe(before.master.ed25519);
  expect(after.devices[0]?.id.ed25519).toBe(newDevice.ed25519);
  expect(after.devices[0]?.id.curve25519).not.toBe(before.devices[0]?.id.curve25519);
  await expect(page.getByTestId("e2e-own-identity")).toHaveText(after.master.ed25519);
});
