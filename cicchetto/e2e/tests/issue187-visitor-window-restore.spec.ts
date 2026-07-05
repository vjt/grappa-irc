// Issue #187 (P0) — last-open-window restore must cover the VISITOR user
// class, not only registered users.
//
// #34/#35 shipped "restore the last-viewed window on reload" but Shell's
// cold-load restore arm gated the whole thing on `m.kind === "user"`, so a
// VISITOR who refreshed / reopened the PWA was dropped back on the $home
// default instead of the channel they last had open. The focus-WRITE
// (selection.ts `on(selectedChannel)` → saveLastFocused) already fired for
// every subject, and a visitor's `/me` id is a stable UUID (resolved from the
// persisted grappa-token), so the read side simply refused to consult a slot
// it was reliably filling. The fix drops the kind gate — restore keys on
// `m.id` for any subject class.
//
// This can only be proven end-to-end: it needs a real visitor IRC session
// (channel joined upstream, session GenServer surviving the browser reload)
// plus cicchetto's real cold-load restore arm reading real localStorage —
// none of which jsdom/vitest exercises. Rides the #153 server de-gate
// (visitors may `/join`), which the testnet already carries.
//
// RED pre-fix: after reload the visitor lands on $home; the #r187 channel row
// never carries `.selected` → the post-reload assertion times out.
// GREEN post-fix: the restore arm re-selects #r187 → the row is `.selected`.

import type { Browser } from "@playwright/test";
import { expect, test } from "../fixtures/test";
import {
  composeSend,
  selectChannel,
  sidebarWindow,
  waitForUserTopicReady,
} from "../fixtures/cicchettoPage";
import { adminDeleteVisitor, mintVisitor } from "../fixtures/grappaApi";
import { getSeededAdmin } from "../fixtures/seedData";

// Boot cic straight into Shell as a freshly-minted visitor (no captcha/anon
// dance) — identical seeding to issue148/issue153/issue154.
async function bootVisitor(browser: Browser, nick: string) {
  const visitor = await mintVisitor(nick);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.addInitScript(
    ([token, subjectJson]) => {
      localStorage.setItem("grappa-token", token);
      localStorage.setItem("grappa-subject", subjectJson);
      localStorage.setItem("cic.installChoice", "browser");
    },
    [
      visitor.token,
      JSON.stringify({
        kind: "visitor",
        id: visitor.id,
        nick: visitor.nick,
        network_slug: visitor.network_slug,
      }),
    ] as const,
  );
  await page.goto("/");
  await expect(page.getByLabel(/open settings/i)).toBeVisible({ timeout: 10_000 });
  return { visitor, ctx, page };
}

test("issue #187 — a visitor's last-open channel is restored on refresh/reopen (not $home)", async ({
  browser,
}) => {
  const admin = getSeededAdmin();
  const stamp = Date.now();
  const channel = `#r187-${stamp}`;
  const { visitor, ctx, page } = await bootVisitor(browser, `v187-${stamp}`);

  try {
    // Focus $server and wait for the registration numerics → the visitor's
    // upstream session is connected (same connection gate as issue148/153/154).
    await selectChannel(page, visitor.network_slug, "Server", { awaitWsReady: false });
    await expect(
      page.locator('[data-testid="scrollback-line"][data-kind="notice"]').first(),
    ).toBeVisible({ timeout: 20_000 });

    // JOIN a channel and focus it — this is the window whose restore we prove.
    // Focusing it fires selection.ts's `on(selectedChannel)` effect, which
    // persists `{network_slug, #r187, channel}` under
    // `cic.lastFocusedChannel.<visitor.id>` (the WRITE path — universal for
    // every subject, pre- and post-fix).
    await waitForUserTopicReady(page, `visitor:${visitor.id}`);
    await composeSend(page, `/join ${channel}`);
    await expect(
      page.locator(".sidebar-network-section li").filter({ hasText: channel }),
    ).toHaveCount(1, { timeout: 15_000 });
    await selectChannel(page, visitor.network_slug, channel, { ownNick: visitor.nick });

    // Baseline: #r187 is the focused window before the reload.
    await expect(sidebarWindow(page, visitor.network_slug, channel)).toHaveClass(/selected/, {
      timeout: 10_000,
    });

    // Refresh the PWA. addInitScript re-seeds the token/subject and
    // localStorage persists across the reload, so cic boots as the SAME
    // visitor — a full document reload resets the in-memory `selectedChannel`
    // signal to null, so the ONLY thing that can re-select #r187 is the
    // cold-load restore arm reading the persisted last-focused slot.
    await page.reload();
    await expect(page.getByLabel(/open settings/i)).toBeVisible({ timeout: 10_000 });

    // HEADLINE (RED pre-fix): the visitor is restored to #r187, NOT stranded on
    // the $home default. The `.selected` class only lands via the cold-load
    // restore path here, so this is a direct proof the restore ran for a
    // visitor subject.
    await expect(sidebarWindow(page, visitor.network_slug, channel)).toHaveClass(/selected/, {
      timeout: 15_000,
    });
  } finally {
    await ctx.close();
    await adminDeleteVisitor(admin.token, visitor.id).catch(() => {});
  }
});
