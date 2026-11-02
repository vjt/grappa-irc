// issue 2497 — writing to a nick that is not on the network says so, end to
// end: a real ircd answers 401 ERR_NOSUCHNICK and grappa turns it into what
// each window shows. The plaintext query already showed it (the 401 is a row
// in the open query, `cp13-s5-msg-ghost-401.spec.ts`); these are the two
// e2ee doors that showed nothing:
//
//   (a) the encrypted query (`/equery`): the message waits for the peer's
//       keys, and the KEYREQ's 401 is filed under `$server`, since no
//       plaintext query is open. grappa pushes `no_such_nick`, and the
//       message's row turns failed at once, saying why;
//   (b) asking the nick for an encrypted chat (issue 2486): the REQUEST's
//       401 is a row in the query the user asked from, and it ends the
//       asking, whose card would otherwise wait out its 24 h deadline.
//
// ## What makes this spec able to fail
//
//   * Without the push, or without cicchetto acting on it, the row keeps
//     "waiting for keys" until its own 90 s deadline (`OUTQ_TTL_MS`), well
//     past the wait here, and then fails for another reason, "no keys came
//     from the peer", not the one asserted.
//   * Without the asking ending on the 401, the card stays "Waiting for … to
//     accept" and the rail button stays disabled. The POST is awaited first,
//     so a card that never came cannot pass for one that went.

import { randomBytes } from "node:crypto";
import type { Page } from "@playwright/test";
import {
  composeSend,
  confirmModal,
  confirmModalYes,
  selectChannel,
  waitForQueryWindowReady,
} from "../fixtures/cicchettoPage";
import { boot, equery, KEYS_TIMEOUT, send } from "../fixtures/encryptedQuery";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

/** A nick nobody holds on the testnet. */
const ghost = () => `ghost-${randomBytes(3).toString("hex")}`;

const card = (page: Page) => page.getByTestId("e2e-request-card");
const railButton = (page: Page) => page.getByTestId("rail-start-encrypted-chat");

test("(a) an encrypted message to a nick that is not on the network fails at once, saying so", async ({
  page,
}) => {
  test.slow();
  const nick = ghost();
  await boot(page, specUser());
  await equery(page, specNick(), nick);

  await send(page, "anyone there?");

  const state = page.getByTestId("e2e-row-state");
  await expect(state).toHaveAttribute("data-state", "failed", { timeout: KEYS_TIMEOUT });
  await expect(state).toHaveText("not sent: there is no such nick on the network");
});

test("(b) asking a nick that is not on the network ends the asking; the 401 stays in the query", async ({
  page,
}) => {
  test.slow();
  const nick = ghost();
  await boot(page, specUser());
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: specNick() });
  await composeSend(page, `/query ${nick}`);
  await waitForQueryWindowReady(page, NETWORK_SLUG, nick);

  await railButton(page).click();
  await expect(confirmModal(page)).toBeVisible();
  const asked = page.waitForResponse(
    (res) => res.request().method() === "POST" && res.url().endsWith("/e2e/requests"),
  );
  await confirmModalYes(page);
  expect((await asked).status()).toBe(202);

  await expect(page.locator(".scrollback-pane .scrollback-notice-error")).toContainText(
    `${nick} No such nick/channel`,
    { timeout: KEYS_TIMEOUT },
  );
  await expect(card(page)).toHaveCount(0, { timeout: KEYS_TIMEOUT });
  await expect(railButton(page)).toBeEnabled();
});
