// issue 2508 — a plain query's rail offered "start encrypted chat" even when
// an encrypted chat with that peer already existed on the network, and
// pressing it asked the peer to start a second one. With a chat already on
// this device (open, or closed and kept), the rail's button says "chat
// securely" and opens that chat's 🔒 window: no confirm, no request.
//
// One flow, as a person meets it: the query's rail before any encrypted chat
// (the asking button), then with the encrypted window open, then with it
// closed — the button opens it again, and focuses it.
//
// ## What makes this spec able to fail
//
//   * The rail keeps offering "start encrypted chat" once the chat exists.
//   * "chat securely" asks first (a confirm) or sends a request (a POST to
//     grappa's requests), or opens nothing.
//   * A closed chat is read as no chat: the asking button comes back.

import { randomBytes } from "node:crypto";
import type { Page } from "@playwright/test";
import {
  composeSend,
  confirmModal,
  selectChannel,
  sidebarCloseButton,
  sidebarWindow,
  waitForQueryWindowReady,
} from "../fixtures/cicchettoPage";
import { boot, e2eWindow, equery } from "../fixtures/encryptedQuery";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const askButton = (page: Page) => page.getByTestId("rail-start-encrypted-chat");
const securely = (page: Page) => page.getByTestId("rail-chat-securely");

/** Focuses the plaintext query with `nick`. */
async function focusQuery(page: Page, nick: string): Promise<void> {
  await selectChannel(page, NETWORK_SLUG, nick, { awaitWsReady: false });
}

/** "chat securely" opens the 🔒 window and focuses it, asking nothing. */
async function chatSecurely(page: Page, nick: string): Promise<void> {
  await expect(securely(page)).toHaveText("chat securely");
  await expect(askButton(page)).toHaveCount(0);
  await securely(page).click();
  await expect(confirmModal(page)).toHaveCount(0);
  await expect(page.getByTestId("e2e-pane")).toBeVisible();
  await expect(
    sidebarWindow(page, NETWORK_SLUG, e2eWindow(nick)).locator("button").first(),
  ).toHaveAttribute("aria-current", "true");
}

test("issue 2508 — with an encrypted chat with the peer already here, the query's rail says chat securely and opens it", async ({
  page,
}) => {
  const ownNick = specNick();
  const peer = await IrcPeer.connect({ nick: `i2508-${randomBytes(2).toString("hex")}` });
  const requests: string[] = [];
  page.on("request", (req) => {
    if (req.method() !== "GET" && req.url().includes("/e2e/requests")) {
      requests.push(`${req.method()} ${new URL(req.url()).pathname}`);
    }
  });
  try {
    await boot(page, specUser());
    await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0] ?? "", { ownNick });
    await composeSend(page, `/query ${peer.nick}`);
    await waitForQueryWindowReady(page, NETWORK_SLUG, peer.nick);

    // The premise: no encrypted chat yet, so the rail offers to ask.
    await expect(askButton(page)).toHaveText("start encrypted chat");
    await expect(securely(page)).toHaveCount(0);

    // An encrypted chat with the peer, its window open.
    await equery(page, ownNick, peer.nick);
    await focusQuery(page, peer.nick);
    await chatSecurely(page, peer.nick);

    // The window closed (no message in it, so no question): the chat is
    // still on this device, and the rail opens it again.
    await sidebarCloseButton(page, NETWORK_SLUG, e2eWindow(peer.nick)).click();
    await expect(sidebarWindow(page, NETWORK_SLUG, e2eWindow(peer.nick))).toHaveCount(0);
    await focusQuery(page, peer.nick);
    await chatSecurely(page, peer.nick);

    expect(requests).toEqual([]);
  } finally {
    await peer.disconnect("bye").catch(() => {});
  }
});
