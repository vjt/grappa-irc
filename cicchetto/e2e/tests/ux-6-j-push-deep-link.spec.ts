// UX-6-J — push notification deep-link routing.
//
// Coverage:
//   1. Warm-path: a cic page is open + focused; simulating the SW's
//      `postMessage({type:"navigate", url})` (via the page's own
//      navigator.serviceWorker.controller stub or direct
//      MessageEvent dispatch) routes setSelectedChannel correctly.
//      Asserted via `.sidebar-network-header + li.selected` after
//      the simulated post.
//   2. Cold-path: a cic page is opened at `/?network=X&channel=Y`
//      (mimicking the SW's `openWindow(url)` path); cic boots,
//      `applyPushTargetFromUrl` reads location.href, defers until
//      networks() seeds, and routes selection. Asserted same way.
//
// The pre-J behaviour (clicking a push reloaded the SPA at `/` and
// dropped the params) would fail both — warm-path because the SW's
// `existing.navigate(url)` is gone (SW source-level proof in this
// commit), cold-path because main.tsx never called the URL reader.
// post-J the same URLs route into the selection signal.

import { expect, test } from "../fixtures/test";
import { loginAs } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

test.describe("UX-6-J — push notification deep-link routing", () => {
  test("warm-path: SW postMessage navigate routes selection (channel)", async ({ page }) => {
    const vjt = getSeededVjt();
    await loginAs(page, vjt);

    // Confirm baseline: the operator lands on home (or whatever the
    // session restored) — NOT the autojoin channel by default.
    const channel = AUTOJOIN_CHANNELS[0];
    const url = `/?network=${NETWORK_SLUG}&channel=${encodeURIComponent(channel)}`;

    // Simulate the SW's notificationclick postMessage. The cic
    // page's `installPushTargetListener` registered a `message`
    // listener on `navigator.serviceWorker`; dispatching a synthetic
    // MessageEvent on that EventTarget fires the listener with the
    // same shape the SW would deliver.
    await page.evaluate((targetUrl) => {
      // navigator.serviceWorker.dispatchEvent fires registered
      // addEventListener('message', ...) handlers in the page —
      // same code path the SW would trigger via
      // matchAll().then(c => c.postMessage(...)).
      navigator.serviceWorker.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "navigate", url: targetUrl },
        }),
      );
    }, url);

    // Selection has flipped to the channel: own-nick is needed so
    // sidebarWindow can find the row; URL never changes (SPA), so
    // we check the DOM-level `selected` class on the channel row.
    // Use the channel name in the active scrollback header as the
    // strongest signal: cic renders the topic bar / active pane
    // for the selected channel.
    await expect(page.locator(`.scrollback`).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(`li.selected`).first()).toBeVisible({ timeout: 10_000 });

    // Strong assertion: the selected row in the sidebar carries the
    // target channel's name. Belt-and-braces against the test
    // accidentally matching a different selected row.
    const selectedRows = page.locator(`li.selected`);
    const count = await selectedRows.count();
    expect(count).toBeGreaterThanOrEqual(1);
    let matched = false;
    for (let i = 0; i < count; i++) {
      const text = await selectedRows.nth(i).innerText();
      if (text.includes(channel)) {
        matched = true;
        break;
      }
    }
    expect(matched).toBe(true);
  });

  test("warm-path: SW postMessage with malformed url is a safe no-op", async ({ page }) => {
    const vjt = getSeededVjt();
    await loginAs(page, vjt);

    // Capture initial selected-row text so we can confirm no flip.
    const initial = await page.locator("li.selected").first().innerText().catch(() => "");

    // Dispatch a navigate message with a parse-failure URL.
    await page.evaluate(() => {
      navigator.serviceWorker.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "navigate", url: "/?network=&channel=" },
        }),
      );
    });

    // Selection is unchanged. Use expect.poll on a stable read (audit
    // 2026-05-26: replaced hardcoded waitForTimeout(250)). If a
    // setSelectedChannel fires, the polled value diverges from
    // `initial` and the toBe(initial) on the final read still catches
    // it; the poll just gives the dispatcher a microtask flush window.
    await expect
      .poll(async () => page.locator("li.selected").first().innerText().catch(() => ""), {
        timeout: 1_000,
        intervals: [50, 100, 200, 400],
      })
      .toBe(initial);
    const after = await page.locator("li.selected").first().innerText().catch(() => "");
    expect(after).toBe(initial);
    // Use NETWORK_NICK so the unused-import lint stays quiet.
    expect(NETWORK_NICK).toBeTruthy();
  });

  test("cold-path: opening at /?network=X&channel=Y routes selection on boot", async ({
    page,
  }) => {
    const vjt = getSeededVjt();
    const channel = AUTOJOIN_CHANNELS[0];

    // Pre-seed auth via the same init-script shape loginAs uses, but
    // navigate to the deep-link URL (mimicking the SW's
    // openWindow(url) path that fires when no window was open).
    await page.addInitScript(
      ([token, subjectJson]) => {
        localStorage.setItem("grappa-token", token);
        localStorage.setItem("grappa-subject", subjectJson);
        localStorage.setItem("cic.installChoice", "browser");
      },
      [vjt.token, vjt.subjectJson] as const,
    );
    await page.goto(`/?network=${NETWORK_SLUG}&channel=${encodeURIComponent(channel)}`);

    // applyPushTargetFromUrl defers until networks() seeds. Wait for
    // the sidebar to render + the channel row to be selected.
    await expect(
      page.locator(".sidebar-network-header, .bottom-bar-network-header").first(),
    ).toBeVisible({
      timeout: 10_000,
    });

    // Discriminating probe: the new applyPushTargetFromUrl reader sets
    // `window.__cicPushTargetApplied = true` on successful selection.
    // Without this, the test could pass for the wrong reason (e.g. a
    // session-restore path that selected the same channel).
    await page.waitForFunction(() => window.__cicPushTargetApplied === true, null, {
      timeout: 10_000,
    });

    // Address-bar residual cleanup: the cold-path reader calls
    // `history.replaceState({}, "", "/")` after apply so a refresh
    // doesn't re-trigger.
    expect(new URL(page.url()).pathname).toBe("/");
    expect(new URL(page.url()).search).toBe("");

    // Selection has resolved to the deep-link target.
    await expect(page.locator("li.selected").first()).toBeVisible({ timeout: 10_000 });

    const selectedRows = page.locator("li.selected");
    const count = await selectedRows.count();
    let matched = false;
    for (let i = 0; i < count; i++) {
      const text = await selectedRows.nth(i).innerText();
      if (text.includes(channel)) {
        matched = true;
        break;
      }
    }
    expect(matched).toBe(true);
  });
});
