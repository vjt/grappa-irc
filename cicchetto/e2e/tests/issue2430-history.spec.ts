// issue 2430 slice f — an encrypted chat's history, which lives only on the
// device (2430 "cicchetto side"): the window searches it, its × asks whether
// to keep or delete it, and "delete this chat" deletes it for good. Two
// browsers, two grappa users, two real vodozemac engines, one real ircd;
// grappa holds none of these rows, so everything here is cic's IndexedDB.
//
// ## What makes this spec able to fail
//
//   * The search matches by case, looks at more than the messages, or its
//     count lies: the rows shown or "N of M" differ.
//   * Keep deletes or Delete keeps: `/equery` shows the wrong rows.
//   * A deleted chat comes back with its old rows when the peer writes
//     again: there is more than the new row.
//   * The delete clears only the window's copy: the reload reads the rows
//     back from IndexedDB. Or it drops the index entry and leaves the chat's
//     sealed record behind: the `chats` store still counts it.
//   * Deleting resets trust (fork 1, 2430 comment 6341689166): the peer's
//     key is gone from the pane.

import type { Page } from "@playwright/test";
import {
  confirmModalAlternative,
  confirmModalBody,
  confirmModalYes,
  sidebarCloseButton,
  sidebarWindow,
} from "../fixtures/cicchettoPage";
import {
  boot,
  e2eWindow,
  equery,
  KEYS_TIMEOUT,
  ownKey,
  peerPage,
  row,
  send,
} from "../fixtures/encryptedQuery";
import { NETWORK_SLUG } from "../fixtures/seedData";
import { provisionPeerSubject, teardownSpecSubject } from "../fixtures/specSubject";
import { expect, specNick, specUser, test } from "../fixtures/test";

// The sealed records in cic's `chats` object store (`E2E_DATABASE`,
// lib/e2e/accountStore.ts): one index per network, and one per chat.
const chatRecords = (page: Page): Promise<number> =>
  page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const request = indexedDB.open("grappa-e2e");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const count = db.transaction("chats", "readonly").objectStore("chats").count();
          count.onsuccess = () => resolve(count.result);
          count.onerror = () => reject(count.error);
          db.close();
        };
      }),
  );

test("an encrypted chat's history: searched in the window, kept or deleted on close, deleted for good", async ({
  page,
  browser,
}, testInfo) => {
  test.slow();
  const alice = specUser();
  const aliceNick = specNick();
  const bob = await provisionPeerSubject(testInfo, "bob");
  const peer = await peerPage(browser);
  const rows = page.getByTestId("e2e-row");
  try {
    await boot(page, alice);
    await boot(peer.page, bob.user);
    await equery(page, aliceNick, bob.nick);
    await equery(peer.page, bob.nick, aliceNick);
    const bobKey = await ownKey(peer.page);

    for (const body of ["ciao bob", "the codes are 1234", "a domani"]) await send(page, body);
    await expect(row(peer.page, "in", "a domani")).toHaveCount(1, { timeout: KEYS_TIMEOUT });
    await send(peer.page, "which CODES?");
    await expect(row(page, "in", "which CODES?")).toHaveCount(1, { timeout: KEYS_TIMEOUT });
    await expect(rows).toHaveCount(4);

    // The search: any case, the messages only, counted; Esc shows all again.
    const search = page.getByTestId("e2e-search-input");
    await search.fill("codes");
    await expect(rows).toHaveCount(2);
    await expect(row(page, "out", "the codes are 1234")).toHaveCount(1);
    await expect(row(page, "in", "which CODES?")).toHaveCount(1);
    await expect(page.getByTestId("e2e-search-count")).toHaveText("2 of 4 messages");
    await search.press("Escape");
    await expect(search).toHaveValue("");
    await expect(rows).toHaveCount(4);
    await expect(page.getByTestId("e2e-search-count")).toHaveCount(0);

    // Close and keep (the third door): the window goes, and `/equery` shows
    // the same rows.
    const window_ = sidebarWindow(page, NETWORK_SLUG, e2eWindow(bob.nick));
    const close = sidebarCloseButton(page, NETWORK_SLUG, e2eWindow(bob.nick));
    await close.click();
    await expect(confirmModalBody(page)).toContainText(bob.nick);
    await confirmModalAlternative(page).click();
    await expect(window_).toHaveCount(0);
    await equery(page, aliceNick, bob.nick);
    await expect(rows).toHaveCount(4);
    expect(await chatRecords(page)).toBe(2);

    // Close and delete (the red yes): the rows go, the key the nick is
    // pinned to stays.
    await close.click();
    await confirmModalYes(page);
    await expect(window_).toHaveCount(0);
    await expect.poll(() => chatRecords(page)).toBe(1);
    await equery(page, aliceNick, bob.nick);
    await expect(page.getByTestId("e2e-peer-key")).toHaveText(bobKey);
    await expect(rows).toHaveCount(0);

    // Bob writes again: the chat starts over with that message alone.
    await send(peer.page, "still there?");
    await expect(row(page, "in", "still there?")).toHaveCount(1, { timeout: KEYS_TIMEOUT });
    await expect(rows).toHaveCount(1);

    // "Delete this chat" takes two taps; a reload then reads IndexedDB again
    // and finds nothing. After the reload the window has no copy of its own
    // until the chat is read, and a read writes the rows before the trust:
    // once the peer's key shows, the empty list is what IndexedDB holds.
    const del = page.getByTestId("e2e-delete-chat");
    await del.click();
    await expect(del).toHaveText("really delete?");
    await expect(rows).toHaveCount(1);
    expect(await chatRecords(page)).toBe(2);
    await del.click();
    await expect(window_).toHaveCount(0);
    await expect.poll(() => chatRecords(page)).toBe(1);
    await page.reload();
    await equery(page, aliceNick, bob.nick);
    await expect(page.getByTestId("e2e-peer-key")).toHaveText(bobKey);
    await expect(rows).toHaveCount(0);
  } finally {
    await peer.context.close();
    await teardownSpecSubject(bob);
  }
});
