// #409 item 3 — an existing alias is EDITABLE in place from settings.
//
// The aliases sub-page shipped with add + × remove only (#385); #409 adds
// in-place edit of an existing alias's name AND expansion, routed through the
// store's editAlias (one rename-aware full-map PUT). This spec drives the
// VISIBLE outcome end-to-end and PROVES persistence: edit a row, then re-boot
// the SPA and re-open the sub-page (a fresh server GET) — the renamed alias is
// there with its new expansion and the old name is gone.
//
// SINGLE subject arm (vjt user), like #385: the settings sub-page + the
// user_settings REST round-trip behave identically for every subject class.

import type { Page } from "@playwright/test";
import { composeSend, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { GRAPPA_BASE_URL } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

test.setTimeout(90_000);

const clearAliases = (token: string): Promise<unknown> =>
  fetch(`${GRAPPA_BASE_URL}/me/settings/aliases`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ aliases: {} }),
  }).catch(() => {});

// Bare /alias deep-links straight into the aliases sub-page.
const openAliasesSubpage = async (page: Page): Promise<void> => {
  await composeSend(page, "/alias");
  await expect(page.getByTestId("aliases-subpage")).toBeVisible({ timeout: 10_000 });
};

test("#409 item 3 — edit an existing alias in place; the rename persists across a re-boot", async ({
  page,
}) => {
  const vjt = specUser();
  try {
    await clearAliases(vjt.token);
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

    await openAliasesSubpage(page);

    // Seed a row via the add form (real server round-trip).
    await page.getByTestId("aliases-name-add").fill("wii");
    await page.getByTestId("aliases-expansion-add").fill("whois $1 $1");
    await page.getByTestId("aliases-expansion-add").press("Enter");
    await expect(page.getByTestId("aliases-item-wii")).toBeVisible({ timeout: 10_000 });

    // Edit IN PLACE: rename wii→w AND change the expansion. The edit button
    // swaps the row for a two-field form prefilled with the current values.
    await page.getByRole("button", { name: "Edit alias wii" }).click();
    const nameEdit = page.getByTestId("aliases-edit-name");
    const expansionEdit = page.getByTestId("aliases-edit-expansion");
    await expect(nameEdit).toHaveValue("wii");
    await expect(expansionEdit).toHaveValue("whois $1 $1");
    await nameEdit.fill("w");
    await expansionEdit.fill("whois $1");
    await page.getByTestId("aliases-edit-save").click();

    // Store mirrors the server PUT echo → the row re-keys wii→w in place.
    await expect(page.getByTestId("aliases-item-w")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("aliases-item-w")).toContainText("whois $1");
    await expect(page.getByTestId("aliases-item-wii")).toHaveCount(0);

    // PROVE persistence — re-boot the SPA (fresh page load → fresh server GET
    // on sub-page open) and re-open the sub-page.
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
    await openAliasesSubpage(page);
    await expect(page.getByTestId("aliases-item-w")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("aliases-item-w")).toContainText("whois $1");
    await expect(page.getByTestId("aliases-item-wii")).toHaveCount(0);
  } finally {
    await clearAliases(vjt.token);
  }
});
