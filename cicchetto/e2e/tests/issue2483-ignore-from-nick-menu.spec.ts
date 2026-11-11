// issue 2483 — Ignore / Unignore in the nick context menu.
//
// The row writes the same per-network ignore list `/ignore` and the settings
// sub-page write, as the PERSON entry `nick!*@*`, and its label follows that
// list: a nick already on it offers Unignore.
//
// Why this can only be proven here:
//
//   * the row crosses every stack in one click — cic's store builds the mask
//     and POSTs it, `Grappa.UserSettings` normalises and stores it, the
//     controller pushes the list into the live session, and
//     `Session.EventRouter` drops a line from a REAL ircd against it. The unit
//     tests fake `fetch`; only this sees the stacks agree on the mask.
//   * the outcome is an ABSENCE in the scrollback, decided server-side before
//     the row exists. A client-side hide would look the same in the pane and
//     still write the row, badge it and push it.
//
// The absence needs a barrier, and the ignored nick cannot supply one by
// speaking: every PRIVMSG of theirs is dropped. A PART is not (the filter
// covers PRIVMSG, NOTICE and INVITE only), so the peer speaks and then PARTs on
// the SAME connection, and IRC ordering makes the part row's arrival proof
// that the line before it was already processed — or dropped. Same technique
// as `issue2294-ignore-text-pattern.spec.ts`, with the part as the kept line.
//
// Five assertions, each failing for a different defect:
//
//   1. BEFORE the ignore, the peer's line renders: an absence that was never a
//      presence proves nothing.
//   2. After Ignore, the peer's next line does not render (the part row after
//      it does): the row wrote a rule the server applies to that nick.
//   3. The settings sub-page lists exactly `nick!*@*`: the rule is the person
//      entry, stored where `/ignore` and the sub-page see it.
//   4. The menu, reopened, offers Unignore: the label follows the list.
//   5. After Unignore, the peer's lines render again: the removal named the
//      entry the click wrote.
//
// No ignore cleanup: `_specSubject` (fixtures/test.ts) provisions a fresh user
// for every test and deletes it afterwards, and the list lives in its
// `user_settings` row.
//
// Parity matrix per `feedback_e2e_user_class_parity_matrix`: the list is keyed
// by the subject and the menu has no subject branch — the registered spec user
// suffices.

import type { Page } from "@playwright/test";
import {
  closeSettings,
  loginAs,
  openSettingsSection,
  scrollbackLine,
  scrollbackLines,
  selectChannel,
} from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const TEST_CHANNEL = AUTOJOIN_CHANNELS[0];

const ignoresUrl = `/networks/${NETWORK_SLUG}/ignores`;

const memberName = (page: Page, nick: string) =>
  page.locator(".members-pane .member-name", { hasText: nick });

const menuRow = (page: Page, label: string) =>
  page.locator(".context-menu .context-menu-item", { hasText: new RegExp(`^${label}$`) });

async function openNickMenu(page: Page, nick: string): Promise<void> {
  await memberName(page, nick).click({ button: "right" });
  await expect(page.locator(".context-menu")).toBeVisible({ timeout: 5_000 });
}

test("issue 2483 — Ignore from the nick menu silences that nick, and Unignore brings them back", async ({
  page,
}) => {
  await loginAs(page, specUser());
  // awaitWsReady=false for the reason issue2294's spec gives: in full-suite
  // ordering the bootstrap JOIN line has already arrived, so the helper's
  // fresh-JOIN probe would time out.
  await selectChannel(page, NETWORK_SLUG, TEST_CHANNEL, { awaitWsReady: false });
  // The live per-channel subscription must exist before the peer speaks, or
  // its line lands in the void and is absent for a reason unrelated to the
  // ignore. Our own nick in the members pane proves the channel join completed.
  await expect(memberName(page, specNick())).toBeVisible({ timeout: 10_000 });

  // Unique per run: a static nick collides with an earlier repeat's ghost, and
  // a static body lets a previous pass satisfy the counts from scrollback.
  const tag = crypto.randomUUID().slice(0, 6);
  const peerNick = `ign2483-${tag}`;
  const mask = `${peerNick}!*@*`;
  const before = `BEFORE-${tag}`;
  const hushed = `HUSHED-${tag}`;
  const after = `AFTER-${tag}`;
  const barrier = `barrier-${tag}`;

  const peer = await IrcPeer.connect({ nick: peerNick });
  try {
    await peer.join(TEST_CHANNEL);
    await expect(memberName(page, peerNick)).toBeVisible({ timeout: 10_000 });

    // (1) The positive control.
    peer.privmsg(TEST_CHANNEL, before);
    await expect(scrollbackLines(page).filter({ hasText: before })).toHaveCount(1, {
      timeout: 10_000,
    });

    // Nothing has loaded this network's list yet, so opening the menu fetches
    // it. Wait for that answer before clicking: the store mirrors whichever
    // answer lands last, and a late GET would overwrite the POST's list.
    const listed = page.waitForResponse(
      (r) => r.request().method() === "GET" && r.url().endsWith(ignoresUrl),
    );
    await openNickMenu(page, peerNick);
    expect((await listed).status()).toBe(200);
    await expect(menuRow(page, "Ignore")).toBeVisible();
    await expect(menuRow(page, "Unignore")).toHaveCount(0);

    // The controller pushes the resulting list into the live session BEFORE it
    // answers, so once the POST is back the server is already filtering. 201:
    // `IgnoresController.create` answers a new entry as Created.
    const added = page.waitForResponse(
      (r) => r.request().method() === "POST" && r.url().endsWith(ignoresUrl),
    );
    await menuRow(page, "Ignore").click();
    expect((await added).status()).toBe(201);

    // (2) The ignored nick speaks, then PARTs on the same connection: the part
    // row's arrival is the barrier that makes the absence a fact.
    peer.privmsg(TEST_CHANNEL, hushed);
    await peer.part(TEST_CHANNEL, barrier);
    await expect(scrollbackLine(page, "part", barrier)).toHaveCount(1, { timeout: 10_000 });
    await expect(scrollbackLines(page).filter({ hasText: hushed })).toHaveCount(0);
    // The drop is at delivery: the line from before the rule is still there.
    await expect(scrollbackLines(page).filter({ hasText: before })).toHaveCount(1);

    // (3) The rule is the person entry, where the settings sub-page shows it.
    await openSettingsSection(page, "ignores");
    await expect(
      page.getByTestId(`ignores-list-${NETWORK_SLUG}`).getByText(mask, { exact: true }),
    ).toHaveCount(1, { timeout: 10_000 });
    await closeSettings(page);

    // (4) Back in the channel, the reopened menu offers the way off.
    await peer.join(TEST_CHANNEL);
    await expect(memberName(page, peerNick)).toBeVisible({ timeout: 10_000 });
    await openNickMenu(page, peerNick);
    await expect(menuRow(page, "Unignore")).toBeVisible();
    await expect(menuRow(page, "Ignore")).toHaveCount(0);
    const removed = page.waitForResponse(
      (r) =>
        r.request().method() === "DELETE" &&
        r.url().endsWith(`${ignoresUrl}/${encodeURIComponent(mask)}`),
    );
    await menuRow(page, "Unignore").click();
    expect((await removed).status()).toBe(200);

    // (5) The nick is heard again.
    peer.privmsg(TEST_CHANNEL, after);
    await expect(scrollbackLines(page).filter({ hasText: after })).toHaveCount(1, {
      timeout: 10_000,
    });
    // The line dropped while the rule stood stays dropped: nothing replays it.
    await expect(scrollbackLines(page).filter({ hasText: hushed })).toHaveCount(0);
  } finally {
    await peer.disconnect("done");
  }
});
