// #409 item 1 — Tab is scoped to the compose box.
//
// nick-completion previously swallowed Tab in EVERY form: keybindings.ts keyed
// off the element TAG (any input/textarea/contenteditable), not the compose
// scope, so the alias settings form could not Tab from name→expansion. The fix
// scopes the Tab handler to the compose box's `data-compose-input` marker.
//
// This spec asserts BOTH halves of the fix in ONE flow — the regression guard
// that scoping Tab did not break compose:
//   A. Tab in a NON-compose form (the alias add form) performs NATIVE focus
//      traversal: focus the name field → Tab → focus lands on the expansion
//      field.
//   B. The compose box STILL nick-completes on Tab: focus compose → type a
//      partial member nick → Tab → the draft completes and focus stays in
//      compose (no traversal escape).
//
// SINGLE subject arm (vjt user), like #385: Tab handling + the alias form are
// subject-agnostic client surfaces, no subject-shaped branch to parameterize.

import { composeSend, composeTextarea, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { GRAPPA_BASE_URL } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

test.setTimeout(90_000);

// Reset the subject's aliases to empty (no dedicated DELETE — PUT the empty
// map, the "clear all" shape). Idempotent pre-clean + finally cleanup, so the
// add form's tab order is name→expansion with no stray rows in between.
const clearAliases = (token: string): Promise<unknown> =>
  fetch(`${GRAPPA_BASE_URL}/me/settings/aliases`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ aliases: {} }),
  }).catch(() => {});

test("#409 item 1 — Tab traverses a non-compose form while compose still nick-completes", async ({
  page,
}) => {
  const vjt = specUser();
  try {
    await clearAliases(vjt.token);
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
    await expect(composeTextarea(page)).toBeVisible();
    // Members present so tab-complete has a nick to complete against.
    await expect(page.locator(".members-pane li", { hasText: specNick() })).toBeVisible({
      timeout: 10_000,
    });

    // ── A. Native Tab traversal in the alias add form ──────────────────
    // Bare /alias deep-links straight into the aliases sub-page.
    await composeSend(page, "/alias");
    const subpage = page.getByTestId("aliases-subpage");
    await expect(subpage).toBeVisible({ timeout: 10_000 });

    const nameField = page.getByTestId("aliases-name-add");
    const expansionField = page.getByTestId("aliases-expansion-add");
    await nameField.click();
    await expect(nameField).toBeFocused();
    // The bug: nick-completion ate this Tab and focus never moved. Fixed:
    // native focus traversal moves to the next field.
    await nameField.press("Tab");
    await expect(expansionField).toBeFocused();

    // Close the drawer to get back to compose.
    await page.getByTestId("settings-drawer-close").click();
    await expect(subpage).toHaveCount(0);

    // ── B. Compose STILL nick-completes on Tab (regression guard) ──────
    const ta = composeTextarea(page);
    // A prefix that uniquely matches the own-nick member. First token on the
    // line → tab-complete appends ": ".
    const prefix = specNick().slice(0, specNick().length - 2);
    await ta.click();
    await ta.fill(prefix);
    await ta.press("Tab");
    // Completed to the full nick — and focus stayed in compose (Tab did NOT
    // traverse away, because inside compose the cycle owns Tab).
    await expect(ta).toHaveValue(`${specNick()}: `, { timeout: 5_000 });
    await expect(ta).toBeFocused();
  } finally {
    await clearAliases(vjt.token);
  }
});
