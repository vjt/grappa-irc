// #356 — /notify + /hilight feedback rewire + classic-IRC rename, e2e.
//
// The unit layers cover the ComposeBox notice seam, the slash-command
// grammar, the compose dispatch, and the WatchlistsSettings component in
// isolation. This spec drives the VISIBLE outcomes end-to-end against the
// real integration stack:
//   1. `/notify <nick>` → GREEN inline notice (role=status) that
//      AUTO-DISMISSES; a failing command → STICKY red alert (role=alert)
//      that survives the notice window.
//   2. Bare `/notify` and bare `/hilight` → open the unified "watch lists"
//      settings section (one section, BOTH lists); the home page no longer
//      shows a standalone watched list.
//   3. The keyword list in settings round-trips add/× against real server
//      state (brand-new surface — there was no highlight UI before).
//
// SINGLE subject arm (vjt user), justified: the surface is subject-AGNOSTIC
// — the notice seam is client-side compose feedback, the settings section +
// rename behave identically for every subject class, and the presence REST
// is shared by user + visitor alike. There is no subject-shaped branch to
// parameterize (the parity-matrix rule applies only to subject-shaped
// surfaces). The deep presence protocol arm lives in issue247-notify-watch.

import { composeSend, composeTextarea, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { expect, test } from "../fixtures/test";
import { GRAPPA_BASE_URL } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const SEED_CHANNEL = AUTOJOIN_CHANNELS[0];
const PEER_NICK = "i356-watched";
const KEYWORD = "i356-keyword";

test.setTimeout(90_000);

const deleteNotifyList = (token: string): Promise<unknown> =>
  fetch(`${GRAPPA_BASE_URL}/networks/${NETWORK_SLUG}/notify`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  }).catch(() => {});

test("#356 — with-arg /notify shows a green auto-dismissing notice; a bad command stays sticky", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  try {
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, SEED_CHANNEL, { ownNick: NETWORK_NICK });

    // WITH arg → execute AND a green NOTICE (role=status), naming the nick.
    await composeSend(page, `/notify ${PEER_NICK}`);
    const notice = page.locator(".compose-box-notice");
    await expect(notice).toBeVisible({ timeout: 5_000 });
    await expect(notice).toHaveAttribute("role", "status");
    await expect(notice).toContainText(PEER_NICK);
    // AUTO-DISMISS: it clears itself (~3s) with no further user action —
    // the operator need not type or send to make it go away.
    await expect(notice).toHaveCount(0, { timeout: 8_000 });

    // A failing command → STICKY red alert (role=alert). Not composeSend:
    // on error the draft is preserved, so drive the textarea directly.
    const ta = composeTextarea(page);
    await ta.fill("/i356nonexistentcmd");
    await ta.press("Enter");
    const alert = page.locator(".compose-box-error");
    await expect(alert).toBeVisible({ timeout: 5_000 });
    await expect(alert).toHaveAttribute("role", "alert");
    // Survives well past the notice auto-dismiss window — errors you must read.
    await page.waitForTimeout(4_000);
    await expect(alert).toBeVisible();
  } finally {
    await deleteNotifyList(vjt.token);
  }
});

test("#356 — bare /notify and bare /hilight open the watch-lists section; home shows none", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, SEED_CHANNEL, { ownNick: NETWORK_NICK });

  const subpage = page.getByTestId("watchlists-subpage");

  // Bare /notify → opens the drawer directly on the watch-lists sub-page.
  await composeSend(page, "/notify");
  await expect(subpage).toBeVisible({ timeout: 10_000 });
  // ONE section, BOTH lists (presence + keyword).
  await expect(page.getByTestId("watchlists-section-notify")).toBeVisible();
  await expect(page.getByTestId("watchlists-section-highlight")).toBeVisible();

  // Close, then bare /hilight opens the SAME section.
  await page.getByTestId("settings-drawer-close").click();
  await expect(subpage).toHaveCount(0);
  await composeSend(page, "/hilight");
  await expect(subpage).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("settings-drawer-close").click();
  await expect(subpage).toHaveCount(0);

  // Home no longer shows the standalone watched list (moved to settings).
  await page.locator(".sidebar-channel-name").filter({ hasText: /^Home$/ }).click();
  await expect(page.locator(".watched-panel")).toHaveCount(0);
  await expect(page.getByTestId(`watched-panel-${NETWORK_SLUG}`)).toHaveCount(0);
});

test("#356 — settings keyword list add + × round-trips against real server state", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, SEED_CHANNEL, { ownNick: NETWORK_NICK });

  // Open the section via the settings nav row (proves the row exists too).
  await page.getByLabel(/open settings/i).click();
  await page.getByTestId("watchlists-settings-entry").click();
  await expect(page.getByTestId("watchlists-subpage")).toBeVisible({ timeout: 10_000 });

  const list = page.getByTestId("watchlists-highlight-list");
  const kwRow = list.locator(".watchlists-item", { hasText: KEYWORD });
  const removeBtn = kwRow.getByRole("button", { name: `Remove highlight ${KEYWORD}` });

  // Idempotent pre-clean — a prior failed run may have stranded the keyword
  // (no REST cleanup surface for highlight patterns; the × is the tool).
  if ((await kwRow.count()) > 0) {
    await removeBtn.click();
    await expect(kwRow).toHaveCount(0, { timeout: 10_000 });
  }

  // Add via the form → server round-trip → the store mirrors {patterns} →
  // the row appears (cic never originates state; the list is server truth).
  const addInput = page.getByTestId("watchlists-highlight-add");
  await addInput.fill(KEYWORD);
  await addInput.press("Enter");
  await expect(kwRow).toHaveCount(1, { timeout: 10_000 });

  // × removes it → server round-trip → gone. Self-cleans the durable list.
  await removeBtn.click();
  await expect(kwRow).toHaveCount(0, { timeout: 10_000 });
});
