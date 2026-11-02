// issue 2430 — the encrypted query, driven the way a person drives it: log
// in and wait for the key bundle, open the query with `/equery`, read our own
// key off the rail (issue 2485: the keys live there), pin a key by hand, send,
// compare emoji. Shared by the specs that put two people (two browser
// contexts, two grappa users) in one encrypted query.

import type { Browser, Page } from "@playwright/test";
import {
  awaitServiceWorkerActive,
  composeSend,
  e2eBundleUploaded,
  loginAs,
  selectChannel,
} from "./cicchettoPage";
import type { SeededUser } from "./grappaApi";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "./seedData";
import { expect } from "./test";

/** How long a message may wait for the peer's keys, and a reply for the drain. */
export const KEYS_TIMEOUT = 30_000;

// grappa answers a nick's KEYREQ at most once per 15 s (`E2eKeyAnswers`) and
// drops the rest without a word; cic asks again only after its own 30 s
// (`KEYREQ_RETRY_MS`, lib/e2e/engine.ts). A request for keys right after
// another one to the same nick may wait that long before it is answered.
export const AFTER_A_REASK = 30_000 + KEYS_TIMEOUT;

/** The sidebar window of the encrypted query with `nick`. */
export const e2eWindow = (nick: string) => `$e2e:${nick}`;

// Logs in, waits for the key bundle (a peer's KEYREQ is answered from it),
// and lets the service worker take the page, so no reload lands mid-test and
// takes the (unpersisted) encrypted window with it.
export async function boot(page: Page, user: SeededUser): Promise<void> {
  const uploaded = e2eBundleUploaded(page, NETWORK_SLUG);
  await loginAs(page, user);
  await uploaded;
  await awaitServiceWorkerActive(page);
}

/**
 * Opens the encrypted query with `nick` from a channel's compose box. The
 * window composes in the compose box every window has (issue 2512), named for
 * the peer as typed.
 */
export async function equery(page: Page, ownNick: string, nick: string): Promise<void> {
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick });
  // The channel's compose box gives way to the window's own, so the box never
  // unmounts: the send settles as any other does.
  await composeSend(page, `/equery ${nick}`);
  await expect(page.getByTestId("e2e-pane")).toBeVisible();
  await expect(composer(page)).toHaveAttribute("placeholder", `encrypted message to ${nick}`);
}

/** Our identity's MASTER Ed25519 key (what a peer pins), as the rail shows it. */
export async function ownKey(page: Page): Promise<string> {
  const key = page.getByTestId("e2e-own-identity");
  await expect(key).toHaveText(/^[A-Za-z0-9+/]{43}$/);
  return (await key.textContent()) ?? "";
}

/**
 * A browser that lost its identity on an account whose identity grappa still
 * holds reads "elsewhere": the user starts a new identity on purpose, behind
 * the inline confirm (first click arms, second confirms). Resolves once the
 * new identity's key bundle is on grappa and the pane shows the new master.
 * Call it with the encrypted pane open.
 */
export async function replaceIdentity(page: Page): Promise<void> {
  const uploaded = e2eBundleUploaded(page, NETWORK_SLUG);
  const replace = page.getByTestId("e2e-identity-replace");
  await replace.click();
  await expect(replace).toHaveClass(/confirming/);
  await replace.click();
  await uploaded;
  await expect(page.getByTestId("e2e-identity-elsewhere")).toHaveCount(0);
}

/** Pastes `key` as the peer's in the rail's pin form and pins it: verified. */
export async function pin(page: Page, key: string): Promise<void> {
  await page.getByTestId("e2e-pin-input").fill(key);
  await page.getByTestId("e2e-pin-submit").click();
  await expect(page.getByTestId("e2e-peer-key")).toHaveText(key);
  await expect(page.getByTestId("e2e-peer-trust")).toHaveAttribute("data-trust", "verified");
}

/** The open encrypted query's compose box: the one every window has (issue 2512). */
export const composer = (page: Page) =>
  page.getByTestId("e2e-pane").locator(".compose-box textarea");

export async function send(page: Page, body: string): Promise<void> {
  await expect(composer(page)).toBeVisible();
  await composeSend(page, body);
}

/** The open encrypted query's messages: the scrollback's own lines (issue 2498). */
export const chatLines = (page: Page) =>
  page.getByTestId("e2e-pane").getByTestId("scrollback-line");

/**
 * The messages in the open encrypted query that read `text`: ours ("out",
 * the lines that carry a delivery state) or the peer's ("in").
 */
export const row = (page: Page, kind: "in" | "out", text: string) => {
  const found = page
    .getByTestId("e2e-pane")
    .locator('[data-testid="scrollback-line"][data-kind="privmsg"]', { hasText: text });
  const state = page.getByTestId("e2e-row-state");
  return kind === "out" ? found.filter({ has: state }) : found.filter({ hasNot: state });
};

/** The window's trust badge: verified, unverified, or alarm (`data-trust`). */
export const trust = (page: Page) => page.getByTestId("e2e-peer-trust");

const phase = (page: Page, value: string, timeout: number) =>
  expect(page.getByTestId("e2e-sas")).toHaveAttribute("data-phase", value, { timeout });

const emoji = (page: Page): Promise<(string | null)[]> =>
  page
    .getByTestId("e2e-sas-emoji")
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-index")));

// Alice asks, Bob accepts, both compare the same 7 emoji and both say they
// match: each one's key reads verified on the other side. The request
// reaches Bob within `askedWithin`.
export async function compareEmoji(
  alice: Page,
  bob: Page,
  aliceKey: string,
  bobKey: string,
  askedWithin: number,
): Promise<void> {
  await alice.getByTestId("e2e-rail").getByTestId("e2e-sas-start").click();
  await phase(alice, "waiting", KEYS_TIMEOUT);

  await phase(bob, "asked", askedWithin);
  await expect(bob.getByTestId("e2e-sas")).toContainText("asks to compare emoji with you");
  await bob.getByTestId("e2e-sas-accept").click();

  await phase(alice, "compare", KEYS_TIMEOUT);
  await phase(bob, "compare", KEYS_TIMEOUT);
  const seenByAlice = await emoji(alice);
  expect(seenByAlice).toHaveLength(7);
  expect(await emoji(bob)).toEqual(seenByAlice);

  await alice.getByTestId("e2e-sas-match").click();
  await phase(alice, "confirmed", KEYS_TIMEOUT);
  await bob.getByTestId("e2e-sas-match").click();

  for (const [page, key] of [
    [alice, bobKey],
    [bob, aliceKey],
  ] as const) {
    await expect(trust(page)).toHaveAttribute("data-trust", "verified", {
      timeout: KEYS_TIMEOUT,
    });
    await expect(page.getByTestId("e2e-peer-key")).toHaveText(key);
    await expect(page.getByTestId("e2e-rail-comparison")).toHaveText("matched");
    await expect(page.getByTestId("e2e-sas")).toHaveCount(0);
    await expect(page.getByTestId("e2e-sas-start")).toHaveCount(0);
  }
}

/** A second browser context, for the peer: another person's browser. */
export async function peerPage(browser: Browser) {
  const context = await browser.newContext();
  return { context, page: await context.newPage() };
}
