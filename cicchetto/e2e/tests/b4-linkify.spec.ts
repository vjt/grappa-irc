// No-silent-drops B6.4 / B5 HIGH-9 — Playwright coverage for B4
// (clickable URLs in scrollback / linkify).
//
// B4 fix landed in commit 6d09247: ScrollbackPane's mIRC-formatted
// body splits each text run via lib/linkify.ts and renders URL
// segments as `<a href target="_blank" rel="noopener noreferrer"
// class="scrollback-link">`. URL_REGEX matches http(s)/ftp/www
// prefixes; trailing punctuation (`.`, `,`, `!`, `?`) stays as text;
// balanced `()` inside the URL are preserved in the href.
//
// E2E shape:
//   1. operator joined to a real channel
//   2. peer says a body containing a URL with trailing punctuation
//   3. cic renders the URL as <a class="scrollback-link"> with the
//      correct href; trailing `.` stays outside the link
//
// Per `feedback_cicchetto_browser_smoke`: vitest jsdom can render
// the DOM but doesn't execute the click + new-tab flow. This e2e
// pins the DOM shape under a real browser; click semantics are
// covered by the unit tests in ScrollbackPane.test.tsx.

import { expect, test } from "@playwright/test";
import { loginAs, scrollbackLine, selectChannel } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const PEER_NICK = "b4-linker";
const CHANNEL = AUTOJOIN_CHANNELS[0];
const URL = "https://example.com";
const PARENS_URL = "https://en.wikipedia.org/wiki/IRC_(protocol)";

test("B4 — peer URL renders as clickable <a>; trailing '.' stays outside the link", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  try {
    await peer.join(CHANNEL);
    peer.privmsg(CHANNEL, `see ${URL}.`);

    // Wait for the privmsg row to land in scrollback.
    const row = scrollbackLine(page, "privmsg", URL);
    await expect(row).toBeVisible({ timeout: 5_000 });

    // The URL is wrapped in a clickable anchor with target="_blank".
    const link = row.locator(".scrollback-link").first();
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", URL);
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", /noopener/);

    // Trailing `.` is OUTSIDE the link (next to it as text). The
    // simplest assertion: the row's textContent ends with `.` and
    // the link's textContent does NOT.
    await expect(link).toHaveText(URL);
    await expect(row).toContainText(`${URL}.`);
  } finally {
    await peer.disconnect("B4 done");
  }
});

test("B4 — balanced parentheses inside URL are preserved in href", async ({ page }) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  const peer = await IrcPeer.connect({ nick: `${PEER_NICK}-2` });
  try {
    await peer.join(CHANNEL);
    peer.privmsg(CHANNEL, `read ${PARENS_URL}`);

    const row = scrollbackLine(page, "privmsg", PARENS_URL);
    await expect(row).toBeVisible({ timeout: 5_000 });

    const link = row.locator(".scrollback-link").first();
    await expect(link).toHaveAttribute("href", PARENS_URL);
  } finally {
    await peer.disconnect("B4 parens done");
  }
});
