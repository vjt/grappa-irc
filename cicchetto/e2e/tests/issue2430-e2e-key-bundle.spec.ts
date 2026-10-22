// issue 2430 — cic's Olm account and the key bundle it keeps on grappa, end
// to end through a real browser and a real ircd.
//
// cic runs vodozemac as WebAssembly, keeps the account in IndexedDB sealed
// under a non-extractable WebCrypto key, and fills the bundle grappa answers
// a peer's KEYREQ from. Nothing of it is on screen; what a peer can see is
// the KEYS answer, so that is what this spec reads, from a peer, the way a
// peer would: reassembled from its fragments, decoded, and both signatures
// verified with node's Ed25519 over the byte strings the wire names.
//
// ## What makes this spec able to fail
//
//   * The binding never loads in the browser (CSP without
//     'wasm-unsafe-eval', a missing asset): no upload, the first wait times
//     out, and the `_cspGuard` fixture names any violation.
//   * The bundle is signed wrong: the peer's verification fails.
//   * The account is not persisted, or a reload makes a new one: the reload
//     shows DELETE instead of GET, and the identity changes.
//   * The test-only wipe does not wipe: the identity stays the same.
//
// The REST calls are read from the page's own requests: the order (DELETE
// before the first POST for a new account, GET for a known one) is the
// contract, and only the page knows it.

import { createPublicKey, randomBytes, verify } from "node:crypto";
import type { Page } from "@playwright/test";
import { e2eBundleUploaded, loginAs } from "../fixtures/cicchettoPage";
import { fetchE2eKeys } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

type Keys = {
  v: number;
  id: { curve25519: string; ed25519: string; sig: string };
  otk: { key: string; fallback: boolean; sig: string };
};

const newMsgid = (): string => randomBytes(8).toString("base64").replace(/=+$/, "");

function ed25519Verifies(publicKey: string, message: string, signature: string): boolean {
  const key = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(publicKey, "base64").toString("base64url") },
    format: "jwk",
  });
  return verify(null, Buffer.from(message, "utf8"), key, Buffer.from(signature, "base64"));
}

// A fresh peer asks `target` for keys and gets grappa's answer from the
// bundle. One nick per ask: grappa answers a nick once per 30 s. The suffix
// keeps parallel repeats of this spec off each other's nick.
async function askForKeys(label: string, target: string): Promise<Keys> {
  const peer = await IrcPeer.connect({ nick: `${label}-${randomBytes(2).toString("hex")}` });
  try {
    const answer = peer.awaitE2e(target, "KEYS", 20_000);
    peer.e2eSend(target, "KEYREQ", newMsgid(), Buffer.from('{"v":1}', "utf8").toString("base64"));
    const keys = JSON.parse(Buffer.from(await answer, "base64").toString("utf8")) as Keys;
    expect(keys.v).toBe(1);
    expect(
      ed25519Verifies(keys.id.ed25519, `irc-e2e:v1:id:${keys.id.curve25519}`, keys.id.sig),
    ).toBe(true);
    expect(ed25519Verifies(keys.id.ed25519, `irc-e2e:v1:otk:${keys.otk.key}`, keys.otk.sig)).toBe(
      true,
    );
    return keys;
  } finally {
    await peer.disconnect("keys read");
  }
}

// The methods of every request the page makes to this network's bundle.
function bundleCalls(page: Page): string[] {
  const calls: string[] = [];
  const path = `/networks/${NETWORK_SLUG}/e2e/keys`;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === path) calls.push(request.method());
  });
  return calls;
}

const bundleUploaded = (page: Page) => e2eBundleUploaded(page, NETWORK_SLUG);

// A new browser has no account: cic makes one, drops whatever grappa held
// for the slot, and uploads a full bundle.
async function loginWithNewAccount(page: Page, calls: string[]): Promise<void> {
  const vjt = specUser();
  const uploaded = bundleUploaded(page);
  await loginAs(page, vjt);
  await uploaded;
  expect(calls).toEqual(["DELETE", "POST"]);
  expect(await fetchE2eKeys(vjt.token, NETWORK_SLUG)).toEqual({
    one_time_keys: 50,
    fallback: true,
  });
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
  const calls = bundleCalls(page);
  await loginWithNewAccount(page, calls);

  const first = await askForKeys("i2430-keys1", nick);
  expect(first.otk.fallback).toBe(false);
  expect(await fetchE2eKeys(vjt.token, NETWORK_SLUG)).toEqual({
    one_time_keys: 49,
    fallback: true,
  });

  // A reload finds the account: it asks what is left and puts back the one
  // key the peer took. Same identity.
  await reloadAndUpload(page, calls);
  expect(calls).toEqual(["GET", "POST"]);
  expect(await fetchE2eKeys(vjt.token, NETWORK_SLUG)).toEqual({
    one_time_keys: 50,
    fallback: true,
  });
  const second = await askForKeys("i2430-keys2", nick);
  expect(second.id.ed25519).toBe(first.id.ed25519);
  expect(second.otk.key).not.toBe(first.otk.key);
});

test("after the test-only wipe the next page starts over with a new identity", async ({ page }) => {
  test.slow();
  const nick = specNick();
  const calls = bundleCalls(page);
  await loginWithNewAccount(page, calls);
  const before = await askForKeys("i2430-wipe1", nick);

  // w2's interop suite uses the hook. This page does not sync again; the
  // next one makes a new account and replaces grappa's bundle.
  await page.evaluate(() => window.__cic_e2eResetForTests?.());
  await reloadAndUpload(page, calls);
  expect(calls).toEqual(["DELETE", "POST"]);
  const after = await askForKeys("i2430-wipe2", nick);
  expect(after.id.ed25519).not.toBe(before.id.ed25519);
  expect(after.id.curve25519).not.toBe(before.id.curve25519);
});
