// issue 2486 — asking a peer to start an encrypted chat, end to end: a real
// ircd, grappa holding the asking (`Grappa.E2eRequests`, CLIENT_PROTOCOL
// §4i), and either a second cicchetto (another grappa user, another browser)
// or a bare IRC client that speaks no E2E at all. One test per acceptance
// bullet of the issue and of vjt's rulings on it:
//
//   (a) one button in the query's rail starts it, and the confirm says what
//       the peer needs BEFORE anything is sent;
//   (e) no CTCP VERSION anywhere: the asking itself is the probe (both
//       directions, read off the wire by a client that is not cicchetto);
//   (b) our asking is pending, survives a reload, and Cancel withdraws it on
//       both sides;
//   (c) the peer may accept while the requester's browser is closed: the
//       requester comes back to the encrypted chat, and both sides hold the
//       other's key;
//   (d) a refusal reaches the requester, live and after being away.
//
// ## What makes this spec able to fail
//
//   * Anything leaves before the confirm's Ask (a probe, the asking itself):
//     the bare client's record holds a line, or the page made a POST.
//   * A CTCP VERSION, or any other line, goes with the asking or the answer:
//     the record is not exactly the consent verbs, closed by a plain barrier
//     line sent once they have arrived (IRC keeps a connection's order, and
//     grappa's own plain queue is FIFO, so nothing plain the flow sent can
//     arrive after it; E2E lines are paced apart, hence "once arrived").
//   * The pending state lives only in the page: the reload loses it.
//   * Cancel does not reach the peer: their banner stays.
//   * An answer given while the requester is away is lost, or never acted
//     on: no encrypted window comes back, or a side holds no key ("none
//     yet"), or the request outlives its job (the banner is still up).
//   * A refusal is shown only to a connected requester, or not at all.

import { randomBytes } from "node:crypto";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import {
  composeSend,
  confirmModal,
  confirmModalBody,
  confirmModalCancel,
  confirmModalYes,
  loginAs,
  selectChannel,
  sidebarWindow,
  waitForQueryWindowReady,
} from "../fixtures/cicchettoPage";
import { boot, e2eWindow, KEYS_TIMEOUT, ownKey } from "../fixtures/encryptedQuery";
import type { SeededUser } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { provisionPeerSubject, teardownSpecSubject } from "../fixtures/specSubject";
import { expect, specLiveNick, specNick, specUser, test } from "../fixtures/test";

const banner = (page: Page) => page.getByTestId("e2e-request-banner");
const railButton = (page: Page) => page.getByTestId("rail-start-encrypted-chat");

/** A browser of its own, for one person: closing its page is closing the browser, its storage stays. */
async function browserFor(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  return { context, page: await context.newPage() };
}

/** Opens the plaintext query with `nick` from a channel's compose box, and waits until it is live. */
async function openQuery(page: Page, ownNick: string, nick: string): Promise<void> {
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick });
  await composeSend(page, `/query ${nick}`);
  await waitForQueryWindowReady(page, NETWORK_SLUG, nick);
}

/** Focuses the plaintext query with `nick`, once it is in the sidebar. */
async function focusQuery(page: Page, nick: string): Promise<void> {
  await expect(sidebarWindow(page, NETWORK_SLUG, nick)).toHaveCount(1, { timeout: KEYS_TIMEOUT });
  await selectChannel(page, NETWORK_SLUG, nick, { awaitWsReady: false });
}

/** The rail's button, the confirm, Ask: our asking then waits, on the banner and on the button. */
async function ask(page: Page): Promise<void> {
  await railButton(page).click();
  await expect(confirmModal(page)).toBeVisible();
  await confirmModalYes(page);
  await expect(banner(page)).toHaveAttribute("data-state", "pending", { timeout: KEYS_TIMEOUT });
  await expect(railButton(page)).toBeDisabled();
}

/** A browser coming back: a new page in the same context (its storage, its identity), logged in. */
async function comeBack(context: BrowserContext, user: SeededUser): Promise<Page> {
  const page = await context.newPage();
  await loginAs(page, user);
  return page;
}

// A line a bare IRC client got, read as what it is: an E2E frame (its verb,
// its two addresses, its payload), or plain text.
type Heard = { verb: string; from: string; to: string; payload: string };
const CTCP = String.fromCharCode(1);
const FRAME = new RegExp(
  `^PRIVMSG \\S+ :${CTCP}E2E (\\S+) \\S+ (\\d+)/(\\d+) (\\S+) (\\S+) (\\S+)${CTCP}$`,
);

function heard(line: string): Heard {
  const m = FRAME.exec(line);
  if (m === null)
    return { verb: "text", from: "", to: "", payload: line.replace(/^\S+ \S+ :/, "") };
  return { verb: m[1] ?? "", from: m[4] ?? "", to: m[5] ?? "", payload: m[6] ?? "" };
}

const CONSENT_PAYLOAD = /^\{"v":2,"master":"[A-Za-z0-9+/]{43}"\}$/;
const DID = /^[A-Za-z0-9_-]{11}$/;

test("(a, e) the rail asks only once confirmed, with one E2E REQUEST and no CTCP VERSION", async ({
  browser,
}) => {
  test.slow();
  const alice = specUser();
  const aliceNick = specNick();
  const me = await browserFor(browser);
  const peer = await IrcPeer.connect({ nick: `i2486-${randomBytes(2).toString("hex")}` });
  const posts: string[] = [];
  me.page.on("request", (req) => {
    if (req.method() !== "GET" && req.url().includes("/e2e/requests")) {
      posts.push(`${req.method()} ${new URL(req.url()).pathname}`);
    }
  });
  try {
    await boot(me.page, alice);
    await openQuery(me.page, aliceNick, peer.nick);
    const record = peer.recordFrom(await specLiveNick());

    // The confirm comes first and says what the peer needs; Cancel sends nothing.
    await railButton(me.page).click();
    await expect(confirmModal(me.page)).toBeVisible();
    await expect(confirmModalBody(me.page)).toContainText("cicchetto");
    await expect(confirmModalBody(me.page)).toContainText("24 hours");
    await confirmModalCancel(me.page);
    await expect(confirmModal(me.page)).toHaveCount(0);
    await expect(banner(me.page)).toHaveCount(0);
    expect(posts).toEqual([]);

    // Ask: one POST, and one line on the wire.
    await ask(me.page);
    expect(posts).toEqual([`POST /networks/${NETWORK_SLUG}/e2e/requests`]);

    // The barrier: a plain line sent once the asking has ARRIVED. grappa
    // paces E2E lines on a queue of their own, so a plain line sent earlier
    // can overtake one; sent after the arrival, it closes the window on both
    // paths, since anything plain the flow had sent is ahead of it.
    await expect.poll(() => record.lines().length, { timeout: KEYS_TIMEOUT }).toBe(1);
    const barrier = `barrier ${randomBytes(3).toString("hex")}`;
    await composeSend(me.page, barrier);
    await expect.poll(() => record.lines().length, { timeout: KEYS_TIMEOUT }).toBe(2);
    const [request, last] = record.lines().map(heard);
    expect(last).toEqual({ verb: "text", from: "", to: "", payload: barrier });
    expect(request?.verb).toBe("REQUEST");
    expect(request?.from).toMatch(DID);
    expect(request?.to).toBe("*");
    expect(request?.payload).toMatch(CONSENT_PAYLOAD);
    expect(record.lines().filter((l) => l.includes("VERSION"))).toEqual([]);

    // Cancel on the banner: the CANCEL goes, from the same device.
    await me.page.getByTestId("e2e-request-cancel").click();
    await expect(banner(me.page)).toHaveCount(0);
    await expect(railButton(me.page)).toBeEnabled();
    await expect.poll(() => record.lines().length, { timeout: KEYS_TIMEOUT }).toBe(3);
    const cancel = heard(record.lines()[2] ?? "");
    expect(cancel).toMatchObject({ verb: "CANCEL", from: request?.from, to: "*" });
    record.stop();
  } finally {
    await peer.disconnect("issue2486 (a, e) done");
    await me.context.close();
  }
});

test("(e) a bare client's asking, accepted: ACCEPT then this device's KEYREQ, and no CTCP VERSION", async ({
  browser,
}) => {
  test.slow();
  const alice = specUser();
  const me = await browserFor(browser);
  const peer = await IrcPeer.connect({ nick: `i2486-${randomBytes(2).toString("hex")}` });
  try {
    await boot(me.page, alice);
    const live = await specLiveNick();
    const record = peer.recordFrom(live);

    // The peer asks the way cicchetto would, from a device of its own.
    const did = randomBytes(8).toString("base64url");
    const master = randomBytes(32).toString("base64").replace(/=+$/, "");
    const msgid = randomBytes(8).toString("base64").replace(/=+$/, "");
    peer.e2eSend(live, "REQUEST", msgid, did, "*", `{"v":2,"master":"${master}"}`);

    // grappa opens the plaintext query with the peer, where the asking shows.
    await focusQuery(me.page, peer.nick);
    await expect(banner(me.page)).toHaveAttribute("data-state", "incoming", {
      timeout: KEYS_TIMEOUT,
    });
    await expect(banner(me.page)).toContainText(
      `${peer.nick} would like to start an encrypted chat with you`,
    );
    await me.page.getByTestId("e2e-request-accept").click();

    // Accepting lands in the encrypted window with the peer.
    await expect(me.page.getByTestId("e2e-pane")).toBeVisible({ timeout: KEYS_TIMEOUT });
    await expect(sidebarWindow(me.page, NETWORK_SLUG, e2eWindow(peer.nick))).toHaveCount(1);

    // Both lines arrive; the KEYREQ rides the urgent lane and the ACCEPT the
    // reactive one, so either may come first. Then the barrier, from the
    // plaintext query (the banner there is gone), as in the test above.
    await expect.poll(() => record.lines().length, { timeout: KEYS_TIMEOUT }).toBe(2);
    await focusQuery(me.page, peer.nick);
    await expect(banner(me.page)).toHaveCount(0);
    await waitForQueryWindowReady(me.page, NETWORK_SLUG, peer.nick);
    const barrier = `barrier ${randomBytes(3).toString("hex")}`;
    await composeSend(me.page, barrier);
    await expect.poll(() => record.lines().length, { timeout: KEYS_TIMEOUT }).toBe(3);
    const lines = record.lines().map(heard);
    const accept = lines.find((l) => l.verb === "ACCEPT");
    const keyreq = lines.find((l) => l.verb === "KEYREQ");
    expect(
      lines
        .slice(0, 2)
        .map((l) => l.verb)
        .sort(),
    ).toEqual(["ACCEPT", "KEYREQ"]);
    expect(accept?.from).toMatch(DID);
    expect(accept?.to).toBe("*");
    expect(accept?.payload).toMatch(CONSENT_PAYLOAD);
    // The keys are asked for by this device, never by grappa.
    expect(keyreq).toMatchObject({ from: accept?.from, to: "*" });
    expect(lines[2]).toEqual({ verb: "text", from: "", to: "", payload: barrier });
    expect(record.lines().filter((l) => l.includes("VERSION"))).toEqual([]);
    record.stop();
  } finally {
    await peer.disconnect("issue2486 (e) done");
    await me.context.close();
  }
});

test("(b) our asking survives a reload, and Cancel withdraws it on both sides", async ({
  browser,
}, testInfo) => {
  test.slow();
  const alice = specUser();
  const aliceNick = specNick();
  const bob = await provisionPeerSubject(testInfo, "bob");
  const a = await browserFor(browser);
  const b = await browserFor(browser);
  try {
    await boot(a.page, alice);
    await boot(b.page, bob.user);
    await openQuery(a.page, aliceNick, bob.nick);
    await ask(a.page);

    await focusQuery(b.page, await specLiveNick());
    await expect(banner(b.page)).toHaveAttribute("data-state", "incoming", {
      timeout: KEYS_TIMEOUT,
    });

    // grappa holds the asking, not the page.
    await loginAs(a.page, alice);
    await focusQuery(a.page, bob.nick);
    await expect(banner(a.page)).toHaveAttribute("data-state", "pending", {
      timeout: KEYS_TIMEOUT,
    });
    await expect(railButton(a.page)).toBeDisabled();

    await a.page.getByTestId("e2e-request-cancel").click();
    await expect(banner(a.page)).toHaveCount(0);
    await expect(railButton(a.page)).toBeEnabled();
    // The CANCEL reached Bob: his banner goes too.
    await expect(banner(b.page)).toHaveCount(0, { timeout: KEYS_TIMEOUT });
  } finally {
    await a.context.close();
    await b.context.close();
    await teardownSpecSubject(bob);
  }
});

test("(c) accepted while the requester's browser is closed: she comes back to the encrypted chat, and each side holds the other's key", async ({
  browser,
}, testInfo) => {
  test.setTimeout(240_000);
  const alice = specUser();
  const aliceNick = specNick();
  const bob = await provisionPeerSubject(testInfo, "bob");
  const a = await browserFor(browser);
  const b = await browserFor(browser);
  try {
    await boot(a.page, alice);
    await boot(b.page, bob.user);
    await openQuery(a.page, aliceNick, bob.nick);
    await ask(a.page);
    await a.page.close();

    // Bob accepts with no cicchetto of Alice's connected: he lands in the
    // encrypted window, and Alice's key comes from her bundle on grappa.
    await focusQuery(b.page, await specLiveNick());
    await b.page.getByTestId("e2e-request-accept").click();
    await expect(b.page.getByTestId("e2e-pane")).toBeVisible({ timeout: KEYS_TIMEOUT });
    await expect(b.page.getByTestId("e2e-peer-key")).toHaveText(/^[A-Za-z0-9+/]{43}$/, {
      timeout: KEYS_TIMEOUT,
    });
    const bobKey = await ownKey(b.page);

    // Alice comes back: the encrypted chat with Bob is there, with his key.
    const back = await comeBack(a.context, alice);
    const encrypted = sidebarWindow(back, NETWORK_SLUG, e2eWindow(bob.nick));
    await expect(encrypted).toHaveCount(1, { timeout: KEYS_TIMEOUT });
    await selectChannel(back, NETWORK_SLUG, e2eWindow(bob.nick), { awaitWsReady: false });
    await expect(back.getByTestId("e2e-pane")).toBeVisible();
    await expect(back.getByTestId("e2e-peer-key")).toHaveText(bobKey, { timeout: KEYS_TIMEOUT });
    await expect(back.getByTestId("e2e-rail-trust")).toHaveAttribute("data-trust", "unverified");
    // ... and Bob holds hers.
    await expect(b.page.getByTestId("e2e-peer-key")).toHaveText(await ownKey(back));

    // The request did its job and went: no banner over the plaintext query.
    await focusQuery(back, bob.nick);
    await expect(back.getByTestId("scrollback-pinned")).toBeAttached();
    await expect(banner(back)).toHaveCount(0);
    await expect(railButton(back)).toBeEnabled();
  } finally {
    await a.context.close();
    await b.context.close();
    await teardownSpecSubject(bob);
  }
});

test("(d) a refusal reaches the requester, live and after being away", async ({
  browser,
}, testInfo) => {
  test.setTimeout(240_000);
  const alice = specUser();
  const aliceNick = specNick();
  const bob = await provisionPeerSubject(testInfo, "bob");
  const a = await browserFor(browser);
  const b = await browserFor(browser);
  try {
    await boot(a.page, alice);
    await boot(b.page, bob.user);
    await openQuery(a.page, aliceNick, bob.nick);

    // Live: Bob refuses, Alice reads it and dismisses it.
    await ask(a.page);
    await focusQuery(b.page, await specLiveNick());
    await b.page.getByTestId("e2e-request-reject").click();
    await expect(banner(b.page)).toHaveCount(0);
    await expect(banner(a.page)).toHaveAttribute("data-state", "refused", {
      timeout: KEYS_TIMEOUT,
    });
    await expect(banner(a.page)).toContainText(`${bob.nick} refused the encrypted chat`);
    await a.page.getByTestId("e2e-request-dismiss").click();
    await expect(banner(a.page)).toHaveCount(0);

    // Away: Alice asks again and closes her browser; Bob refuses again.
    await ask(a.page);
    await a.page.close();
    await expect(banner(b.page)).toHaveAttribute("data-state", "incoming", {
      timeout: KEYS_TIMEOUT,
    });
    await b.page.getByTestId("e2e-request-reject").click();
    await expect(banner(b.page)).toHaveCount(0);

    const back = await comeBack(a.context, alice);
    await focusQuery(back, bob.nick);
    await expect(banner(back)).toHaveAttribute("data-state", "refused", { timeout: KEYS_TIMEOUT });
    await back.getByTestId("e2e-request-dismiss").click();
    await expect(banner(back)).toHaveCount(0);

    // Dismissed on grappa, not just here.
    await loginAs(back, alice);
    await focusQuery(back, bob.nick);
    await expect(back.getByTestId("scrollback-pinned")).toBeAttached();
    await expect(banner(back)).toHaveCount(0);
  } finally {
    await a.context.close();
    await b.context.close();
    await teardownSpecSubject(bob);
  }
});
