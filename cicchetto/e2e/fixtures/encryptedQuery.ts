// issue 2430 — the encrypted query, driven the way a person drives it: log
// in and wait for the key bundle, open the query with `/equery`, read our own
// key off the pane, pin a key by hand, send. Shared by the specs that put two
// people (two browser contexts, two grappa users) in one encrypted query.

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

/** Opens the encrypted query with `nick` from a channel's compose box. */
export async function equery(page: Page, ownNick: string, nick: string): Promise<void> {
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick });
  await composeSend(page, `/equery ${nick}`, { expectUnmount: true });
  await expect(page.getByTestId("e2e-pane")).toBeVisible();
  await expect(page.getByTestId("e2e-compose-input")).toHaveAttribute(
    "placeholder",
    `encrypted message to ${nick}`,
  );
}

/** Our identity's MASTER Ed25519 key (what a peer pins), as the pane shows it. */
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

/** Pastes `key` as the peer's and pins it: verified. */
export async function pin(page: Page, key: string): Promise<void> {
  await page.getByTestId("e2e-pin-input").fill(key);
  await page.getByTestId("e2e-pin-submit").click();
  await expect(page.getByTestId("e2e-peer-key")).toHaveText(key);
  await expect(page.getByTestId("e2e-peer-trust")).toHaveAttribute("data-trust", "verified");
}

export async function send(page: Page, body: string): Promise<void> {
  await page.getByTestId("e2e-compose-input").fill(body);
  await page.getByTestId("e2e-compose-input").press("Enter");
  await expect(page.getByTestId("e2e-compose-input")).toHaveValue("");
}

/** The rows of `kind` in the open encrypted query, that read `text`. */
export const row = (page: Page, kind: string, text: string) =>
  page.locator(`[data-testid="e2e-row"][data-row-kind="${kind}"]`, { hasText: text });

/** A second browser context, for the peer: another person's browser. */
export async function peerPage(browser: Browser) {
  const context = await browser.newContext();
  return { context, page: await context.newPage() };
}
