// issue 2359 — the auto-away site default is an admin knob, and every user
// sees its value in the "use site default (…)" entry of their own control.
//
// Two browser contexts on purpose: a regular user with the settings drawer
// OPEN, and the seeded admin in Admin → Settings. The claim worth a real
// browser is the cross-surface one — the admin saves, the server fans out
// `server_settings_changed`, and the user's label changes with no reload
// and no REST refetch. jsdom can only feed the store by hand; vitest
// already covers that half.
//
// The integration env's boot fallback is 2 s (`config/dev.exs`,
// `auto_away_debounce_ms: 2_000`), and it is OFF the ladder on purpose
// here: the first assertion proves the label names whatever the server
// resolves, not only a rung cic happens to know.
//
// 🔴 Cleanup is load-bearing for two other specs. `issue671` and `issue348`
// both read the 2 s fallback as the deployment default. The afterEach PUTs
// `null` — deleting the row — which is the ONLY value that hands back the
// config fallback; PUTting `2` is impossible (off the ladder, 422) and
// would not be the same state anyway. Both of those specs spawn their
// subject AFTER this one ends (`specUser()` provisions per test, workers: 1),
// so their sessions resolve the restored fallback at spawn.
//
// Per `feedback_ux_e2e_mandatory`: a server setting a client renders.

import type { APIRequestContext, Page } from "@playwright/test";
import {
  adminLogin,
  loginAs,
  openAdminConsole,
  openSettingsDrawer,
} from "../fixtures/cicchettoPage";
import { getSeededAdmin } from "../fixtures/seedData";
import { expect, specUser, test } from "../fixtures/test";

async function putSiteDefault(request: APIRequestContext, seconds: number | null): Promise<void> {
  const res = await request.put("/admin/settings", {
    headers: { authorization: `Bearer ${getSeededAdmin().token}` },
    data: { auto_away: { default_debounce_seconds: seconds } },
  });
  expect(res.ok()).toBe(true);
}

// The entry, not the select's selected text: the user has picked nothing,
// so the entry IS the selection, but asserting the option itself keeps the
// claim about the label even if a stored preference were selected.
function siteDefaultOption(page: Page) {
  return page.getByTestId("auto-away-select").locator('option[value=""]');
}

async function adminSaveSiteDefault(admin: Page, value: string): Promise<void> {
  await admin.getByTestId("admin-settings-auto-away-default").selectOption(value);
  const saved = admin.waitForResponse(
    (r) => r.url().includes("/admin/settings") && r.request().method() === "PUT",
  );
  await admin.getByTestId("admin-settings-save").click();
  expect((await saved).status()).toBe(200);
  await expect(admin.getByTestId("admin-settings-saved")).toBeVisible({ timeout: 5_000 });
}

test.describe("issue 2359 — auto-away site default", () => {
  test.afterEach(async ({ request }) => {
    await putSiteDefault(request, null);
  });

  test("the user's label names the site default and follows the admin's change live", async ({
    page,
    browser,
  }) => {
    test.setTimeout(90_000);

    // ---- the user, drawer open on the auto-away control -------------------
    await loginAs(page, specUser());
    await openSettingsDrawer(page);
    await page.getByTestId("general-settings-entry").click();
    await expect(page.getByTestId("auto-away-select")).toBeVisible({ timeout: 5_000 });

    // Nothing stored server-side: the boot fallback, off the ladder.
    await expect(siteDefaultOption(page)).toHaveText("use site default (2 seconds)");

    // ---- the admin, in a context of their own ------------------------------
    const adminCtx = await browser.newContext();
    try {
      const admin = await adminCtx.newPage();
      await adminLogin(admin, getSeededAdmin());
      await openAdminConsole(admin);
      await admin.getByTestId("admin-tab-settings").click();
      await expect(admin.getByTestId("admin-settings-tab")).toBeVisible();

      // The knob reads "follow config" and names the value that stands for.
      const knob = admin.getByTestId("admin-settings-auto-away-default");
      await expect(knob).toHaveValue("");
      await expect(knob.locator('option[value=""]')).toHaveText("server config (2 seconds)");

      // ---- admin picks a rung → the user's OPEN drawer re-labels ----------
      await adminSaveSiteDefault(admin, "600");
      await expect(knob).toHaveValue("600");
      await expect(siteDefaultOption(page)).toHaveText("use site default (10 minutes)", {
        timeout: 10_000,
      });

      // ---- admin switches auto-away off site-wide ------------------------
      await adminSaveSiteDefault(admin, "0");
      await expect(siteDefaultOption(page)).toHaveText("use site default (off)", {
        timeout: 10_000,
      });

      // ---- and back to the config fallback (the PUT null path) ------------
      await adminSaveSiteDefault(admin, "");
      await expect(knob).toHaveValue("");
      await expect(siteDefaultOption(page)).toHaveText("use site default (2 seconds)", {
        timeout: 10_000,
      });
    } finally {
      await adminCtx.close();
    }
  });

  test("the REST door reads back the resolved value the admin stored", async ({ request }) => {
    const read = async (): Promise<unknown> => {
      const res = await request.get("/api/server-settings", {
        headers: { authorization: `Bearer ${getSeededAdmin().token}` },
      });
      expect(res.ok()).toBe(true);
      return (await res.json()).auto_away;
    };

    expect(await read()).toEqual({ default_debounce_seconds: 2 });
    await putSiteDefault(request, 1800);
    expect(await read()).toEqual({ default_debounce_seconds: 1800 });
    await putSiteDefault(request, null);
    expect(await read()).toEqual({ default_debounce_seconds: 2 });
  });
});
