// #427 — user aliases may SHADOW built-in commands, except /alias + /unalias.
//
// Reverses #385 decision #3 (which rejected any builtin name). The unit layer
// (slashCommands.test.ts) covers the expander/parse predicate exhaustively;
// this spec drives the VISIBLE outcomes end-to-end against the real stack:
//
//   A. Shadow a builtin (/whois → /me) and the SHADOW takes effect: /whois
//      <tag> renders an ACTION row (the alias fired), not a whois lookup. Plus
//      the deny list: /alias alias … is rejected inline (sticky red).
//   B. Binding condition (issue's non-negotiable): with a builtin shadowed,
//      removal from Settings → Alias stays reachable — the × removes the
//      shadowing alias round-trip against real server state.
//
// SINGLE subject arm (vjt), justified like #385: aliases are subject-agnostic
// (the expander is client-side; the settings sub-page + user_settings REST
// behave identically for every subject class).

import {
  composeSend,
  composeTextarea,
  loginAs,
  openSettingsDrawer,
  scrollbackLine,
  selectChannel,
} from "../fixtures/cicchettoPage";
import { GRAPPA_BASE_URL } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

test.setTimeout(90_000);

// Reset the subject's aliases to empty (same "clear all" shape #385 uses — no
// dedicated DELETE, so PUT the empty map). Idempotent pre-clean + finally.
const clearAliases = (token: string): Promise<unknown> =>
  fetch(`${GRAPPA_BASE_URL}/me/settings/aliases`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ aliases: {} }),
  }).catch(() => {});

test("#427 — an alias shadows a builtin end-to-end (/whois → /me takes effect)", async ({
  page,
}) => {
  const vjt = specUser();
  try {
    await clearAliases(vjt.token);
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { awaitWsReady: false });
    await expect(composeTextarea(page)).toBeVisible();

    // Live per-channel WS gate (mirror #385/#14): the self-echo for our /me
    // send only fires once the channel join completed (own-nick member row).
    await expect(page.locator(".members-pane li", { hasText: specNick() })).toBeVisible({
      timeout: 10_000,
    });

    // Shadow the builtin /whois with /me (no placeholder → implicit append).
    await composeSend(page, "/alias whois me");
    const notice = page.locator(".compose-box-notice");
    await expect(notice).toBeVisible({ timeout: 8_000 });
    await expect(notice).toContainText("/whois");

    // USE the shadowed verb: /whois <tag> now expands to /me <tag> → an action
    // row renders. If the builtin had won, this would be a whois lookup, not an
    // action row — so the action row IS the proof the alias shadowed it.
    const tag = `alias-shadow-${crypto.randomUUID().slice(0, 6)}`;
    await composeSend(page, `/whois ${tag}`);
    await expect(scrollbackLine(page, "action", tag)).toBeVisible({ timeout: 10_000 });

    // Deny list: /alias itself CANNOT be shadowed — rejected inline (sticky
    // red). Draft preserved on error, so drive the textarea directly.
    const ta = composeTextarea(page);
    await ta.fill("/alias alias something");
    await ta.press("Enter");
    const alert = page.locator(".compose-box-error");
    await expect(alert).toBeVisible({ timeout: 5_000 });
    await expect(alert).toContainText(/can't be aliased/i);
  } finally {
    await clearAliases(vjt.token);
  }
});

test("#427 — a shadowing alias stays removable from Settings → Alias (binding condition)", async ({
  page,
}) => {
  const vjt = specUser();
  try {
    await clearAliases(vjt.token);
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

    // Define a builtin-shadowing alias via the CLI, then confirm the Settings
    // escape hatch still lists and removes it — the issue's non-negotiable
    // condition: removal from the UI must remain reachable unconditionally.
    await composeSend(page, "/alias whois me");
    await expect(page.locator(".compose-box-notice")).toBeVisible({ timeout: 8_000 });

    await openSettingsDrawer(page);
    await page.getByTestId("aliases-settings-entry").click();
    await expect(page.getByTestId("aliases-subpage")).toBeVisible({ timeout: 10_000 });

    const row = page.getByTestId("aliases-item-whois");
    await expect(row).toBeVisible({ timeout: 10_000 });
    await expect(row).toContainText("me");

    // × removes the shadowing alias → server round-trip → gone.
    await row.getByRole("button", { name: "Remove alias whois" }).click();
    await expect(row).toHaveCount(0, { timeout: 10_000 });
  } finally {
    await clearAliases(vjt.token);
  }
});
