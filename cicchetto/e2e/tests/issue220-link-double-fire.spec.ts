// #220 — link-bearing surfaces (/list rows, topic bar) double-fire.
//
// A linkified anchor (MircBody renders URLs as a real <a target=_blank>)
// that lives INSIDE a tappable surface used to double-fire: a single tap
// both performed the surface action AND browsed the link, because the
// anchor click bubbled to the surface's onClick and nothing called
// stopPropagation. The two surfaces want OPPOSITE policies:
//
//   * /list rows  — "link-wins": tapping a LINK just browses; it must NOT
//     join the row. Tapping the rest of the row still joins.
//   * topic bar   — "surface-wins": a tap ALWAYS opens the topic modal;
//     the bar NEVER navigates a link directly. Links are handled inside
//     the modal.
//
// Why chromium-only (no @webkit): this is a `click`-event propagation
// bug. `stopPropagation`/`preventDefault` on a click behave identically
// across engines. The #213/#219 webkit tap lesson was about TOUCH
// gesture delegation (Solid routes touchmove to a passive document
// listener) — a different mechanism that does not apply to click
// routing. chromium is the authoritative signal here.
//
// External navigation is stubbed via a context route so the browse half
// never hits the real network; we only care that a popup page was (or
// was not) created — the browser fires the `page` event as soon as the
// target is created, before any load.

import { loginAs, composeSend, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
import { partChannel } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

// "$list" — LIST_WINDOW_NAME from src/lib/windowKinds.ts. Hardcoded
// here because the e2e tsconfig does not resolve src/ imports.
const LIST_WINDOW_NAME = "$list";

// A cross-host URL the linkifier turns into an <a>. Stubbed via a context
// route so a real browse never leaves the sandbox.
const LINK_URL = "https://example.com/e2e220";

test.describe("#220 link-bearing surfaces double-fire", () => {
  // Stub the external host for every page (incl. popups) in the context
  // so the "browse" half loads instantly and never hits the network.
  test.beforeEach(async ({ context }) => {
    await context.route("**://example.com/**", (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: "<html>stub</html>" }),
    );
  });

  test(
    "/list row: tapping a topic link browses (opens popup) and does NOT join; tapping the row body joins",
    async ({ page, context }) => {
      const vjt = getSeededVjt();
      const channel = `#e2e220-${crypto.randomUUID().slice(0, 8)}`;

      // A peer creates the channel (first joiner → auto chanop +o) and
      // sets a URL-bearing topic, then STAYS joined so bahamut includes
      // the channel in LIST replies (only non-empty channels appear).
      // vjt never joins it — so the /list row is UNJOINED and a tap there
      // exercises the join path (the P0 harm being fixed). The creator's
      // +o beats the default +t topic-lock, so no oper bypass is needed.
      const peer = await IrcPeer.connect({
        nick: `e2e220-${crypto.randomUUID().slice(0, 4)}`,
      });
      try {
        await peer.join(channel);
        await peer.topic(channel, `docs at ${LINK_URL} — join us`);

        await loginAs(page, vjt);

        // Open the channel directory for this network.
        await sidebarWindow(page, NETWORK_SLUG, LIST_WINDOW_NAME)
          .locator(".sidebar-window-btn")
          .click();
        await expect(page.locator(".directory-search")).toBeVisible({ timeout: 5_000 });

        // Force a fresh LIST so the just-created channel is captured.
        await page.locator(".directory-refresh").click();

        const row = page.locator(".directory-row").filter({
          has: page.locator(".directory-row-name", { hasText: channel }),
        });
        await expect(row).toBeVisible({ timeout: 15_000 });

        // The topic link renders inside the row.
        const link = row.locator(".scrollback-link");
        await expect(link).toHaveAttribute("href", LINK_URL);

        // Precondition: the channel is NOT in vjt's sidebar (unjoined).
        await expect(sidebarWindow(page, NETWORK_SLUG, channel)).toHaveCount(0);

        // Tap the LINK → it browses (a popup page opens) …
        const popupPromise = context.waitForEvent("page", { timeout: 5_000 });
        await link.click();
        const popup = await popupPromise;
        expect(popup).not.toBeNull();
        await popup.close();

        // … and it must NOT join: the row's onActivate never fired. Give
        // any (buggy) async join a real window to appear before asserting
        // absence, so this can't pass by racing.
        await page.waitForTimeout(1_000);
        await expect(sidebarWindow(page, NETWORK_SLUG, channel)).toHaveCount(0);

        // Tapping the row BODY (the channel-name span, away from the link)
        // still joins — the surface action is intact.
        await row.locator(".directory-row-name").click();
        await expect(sidebarWindow(page, NETWORK_SLUG, channel)).toHaveCount(1, {
          timeout: 10_000,
        });
      } finally {
        await peer.disconnect("e2e220 list done");
        await partChannel(vjt.token, NETWORK_SLUG, channel).catch(() => {});
      }
    },
  );

  test(
    "topic bar: tapping a link opens the topic modal and does NOT navigate; the modal link is a working anchor",
    async ({ page, context }) => {
      const vjt = getSeededVjt();
      // A per-run unique channel — NOT the shared seeded autojoin #bofh.
      // Mutating #bofh's topic would leak into later specs (the vjt-reset
      // fixture restores autojoin + scrollback, but NOT channel topics),
      // the seed-expansion cascade hazard. vjt creates + joins this one,
      // sets the topic, and we PART it in the finally.
      const channel = `#e2e220t-${crypto.randomUUID().slice(0, 8)}`;

      await loginAs(page, vjt);
      await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: NETWORK_NICK });

      try {
        // Join the fresh channel, then set a URL-bearing topic on it.
        // vjt is the creator (→ chanop), so /topic lands past the default
        // +t lock (same path as slash-commands-bundle). The
        // unsolicited-TOPIC handler drives the channelTopic store →
        // TopicBar strip.
        await composeSend(page, `/join ${channel}`);
        await expect(sidebarWindow(page, NETWORK_SLUG, channel)).toBeVisible({ timeout: 10_000 });
        await selectChannel(page, NETWORK_SLUG, channel, { ownNick: NETWORK_NICK });
        await composeSend(page, `/topic docs at ${LINK_URL} — see here`);

        const strip = page.locator(".topic-bar-topic");
        const stripLink = strip.locator(".scrollback-link");
        await expect(stripLink).toHaveAttribute("href", LINK_URL, { timeout: 10_000 });

        // Tap the link in the strip → the bar's surface action wins: the
        // modal opens, and NO popup is created (the link does not navigate).
        let popupOpened = false;
        const onPage = () => {
          popupOpened = true;
        };
        context.on("page", onPage);
        await stripLink.click();

        const dialog = page.getByRole("dialog", { name: /channel topic/i });
        await expect(dialog).toBeVisible({ timeout: 5_000 });

        // Give a (buggy) navigation a window to fire before asserting none.
        await page.waitForTimeout(1_000);
        context.off("page", onPage);
        expect(popupOpened, "topic-bar link must NOT navigate — the bar opens the modal").toBe(
          false,
        );

        // Inside the modal the link is a working anchor (default policy):
        // correct href + opens in a new tab. Link handling is deferred here.
        const modalLink = dialog.locator(".scrollback-link");
        await expect(modalLink).toHaveAttribute("href", LINK_URL);
        await expect(modalLink).toHaveAttribute("target", "_blank");
      } finally {
        await partChannel(vjt.token, NETWORK_SLUG, channel).catch(() => {});
      }
    },
  );
});
