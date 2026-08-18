// #385 — user-defined command aliases, e2e.
//
// The unit layers cover the expander grammar/recursion/builtin-precedence,
// the /alias /unalias parsing, the REST client, and the store in isolation.
// This spec drives the VISIBLE outcomes end-to-end against the real
// integration stack — the spec's mandatory gate: "define an alias, use it,
// see the expanded command take effect", not just unit tests on the expander.
//
//   A. Define via the /alias CLI, then USE the alias: `/act <tag>` expands to
//      `/me <tag>` and the expanded command TAKES EFFECT — an action row
//      (data-kind=action) renders in the channel scrollback. Plus the
//      precedence rule: an alias name colliding with a builtin is rejected
//      inline (sticky red).
//   B. The settings surface (mirrors #356): bare `/alias` deep-links into the
//      aliases sub-page; the nav row opens it; add via the two-field form and
//      the row round-trips against real server state; a bad name surfaces the
//      422 field_errors inline; × removes it.
//
// SINGLE subject arm (vjt user), justified like #356: aliases are a
// subject-AGNOSTIC surface — the expander is client-side, the settings
// sub-page + user_settings REST behave identically for every subject class
// (the server stores them per-subject via the same XOR-FK shape). No
// subject-shaped branch to parameterize.

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

// Reset the subject's aliases to empty — the durable per-subject map has no
// dedicated DELETE, so PUT the empty map (the "clear all" shape the sub-page
// and /unalias-to-zero both produce). Idempotent pre-clean + finally cleanup.
const clearAliases = (token: string): Promise<unknown> =>
  fetch(`${GRAPPA_BASE_URL}/me/settings/aliases`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ aliases: {} }),
  }).catch(() => {});

test("#385 — define via /alias, then the expanded command takes effect (/act → /me)", async ({
  page,
}) => {
  const vjt = specUser();
  try {
    await clearAliases(vjt.token);
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { awaitWsReady: false });
    await expect(composeTextarea(page)).toBeVisible();

    // Live per-channel WS subscription gate (mirror issue #14): the self-echo
    // broadcast for our /me send only fires once the Phoenix channel join
    // completed, signalled by the members-pane own-nick row.
    await expect(page.locator(".members-pane li", { hasText: specNick() })).toBeVisible({
      timeout: 10_000,
    });

    // Define an alias mapping /act → /me (no placeholder → implicit append).
    await composeSend(page, "/alias act me");
    // Green notice confirms the define round-trip completed AND the store
    // mirrored it — so the next send's expander sees the alias.
    const notice = page.locator(".compose-box-notice");
    await expect(notice).toBeVisible({ timeout: 8_000 });
    await expect(notice).toContainText("/act");

    // USE it: /act <tag> → expands to /me <tag> → the expanded command takes
    // effect (action row renders; envelope stripped so the inner body shows).
    const tag = `alias-act-${crypto.randomUUID().slice(0, 6)}`;
    await composeSend(page, `/act ${tag}`);
    await expect(scrollbackLine(page, "action", tag)).toBeVisible({ timeout: 10_000 });
    // Not rendered as a raw privmsg — the alias resolved to /me, not text.
    await expect(scrollbackLine(page, "privmsg", tag)).toHaveCount(0);

    // #427 — precedence REVERSED: a name colliding with a builtin is now
    // ALLOWED (shadowing). Only the two-verb deny list (/alias, /unalias) is
    // rejected inline (sticky red). Draft is preserved on error, so drive the
    // textarea directly rather than composeSend.
    const ta = composeTextarea(page);
    await ta.fill("/alias unalias something");
    await ta.press("Enter");
    const alert = page.locator(".compose-box-error");
    await expect(alert).toBeVisible({ timeout: 5_000 });
    await expect(alert).toContainText(/can't be aliased/i);
  } finally {
    await clearAliases(vjt.token);
  }
});

test("#385 — aliases settings sub-page: deep-link, add round-trip, 422 inline, × remove", async ({
  page,
}) => {
  const vjt = specUser();
  try {
    await clearAliases(vjt.token);
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

    const subpage = page.getByTestId("aliases-subpage");

    // Bare /alias → opens the drawer directly on the aliases sub-page.
    await composeSend(page, "/alias");
    await expect(subpage).toBeVisible({ timeout: 10_000 });
    await page.getByTestId("settings-drawer-close").click();
    await expect(subpage).toHaveCount(0);

    // Open via the settings nav row (proves the row exists too).
    await openSettingsDrawer(page);
    await page.getByTestId("aliases-settings-entry").click();
    await expect(subpage).toBeVisible({ timeout: 10_000 });

    const row = page.getByTestId("aliases-item-wii");

    // Add via the two-field form → server round-trip → the store mirrors the
    // authoritative {aliases} → the row appears (cic never originates state).
    await page.getByTestId("aliases-name-add").fill("wii");
    await page.getByTestId("aliases-expansion-add").fill("whois $1 $1");
    await page.getByTestId("aliases-expansion-add").press("Enter");
    await expect(row).toBeVisible({ timeout: 10_000 });
    await expect(row).toContainText("whois $1 $1");

    // A bad name (whitespace) → server 422 → field_errors.aliases surfaces
    // inline via friendlyError, and no phantom row is added.
    await page.getByTestId("aliases-name-add").fill("wi i");
    await page.getByTestId("aliases-expansion-add").fill("whois");
    await page.getByTestId("aliases-expansion-add").press("Enter");
    await expect(page.getByTestId("aliases-error")).toBeVisible({ timeout: 10_000 });

    // × removes the valid alias → server round-trip → gone.
    await row.getByRole("button", { name: "Remove alias wii" }).click();
    await expect(row).toHaveCount(0, { timeout: 10_000 });
  } finally {
    await clearAliases(vjt.token);
  }
});
