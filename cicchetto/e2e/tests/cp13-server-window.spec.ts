// CP13 server-window cluster e2e (S6 + S8 + S9 — server-window UX).
//
// Trimmed 2026-05-26 (spec-audit-r5): S5 (compose-driven 401 routing)
// extracted to cp13-s5-msg-ghost-401.spec.ts; S10 (mIRC bold renderer)
// extracted to cp13-s10-mirc-bold.spec.ts — both were distinct
// failure surfaces, not actually "server-window cluster" behaviour.
// This file now covers ONLY the server-window UX cluster:
//   - S6: numericInline ephemeral bottom pane is gone (no
//     `.numeric-inline-pane` in the DOM).
//   - S8: $server window surfaces the unread badge on routed numerics.
//   - S9: $server has a ComposeBox; plain-text submit is rejected
//     with a friendly error; slash-commands pass the gate.

import { test, expect } from "../fixtures/test";
import {
  composeTextarea,
  loginAs,
  selectChannel,
  sidebarMessageBadge,
  sidebarWindow,
} from "../fixtures/cicchettoPage";
import { getSeededVjt, NETWORK_SLUG } from "../fixtures/seedData";

const SERVER_WINDOW_LABEL = "Server";
const TEST_CHANNEL = "#bofh";

test.describe("CP13 server-window cluster", () => {
  test("S6 — bottom numeric-inline pane is gone (no `.numeric-inline-pane` in DOM)", async ({
    page,
  }) => {
    const vjt = getSeededVjt();
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, TEST_CHANNEL);
    // The pane was rendered as a sibling of `.scrollback-pane` content
    // pre-CP13. Asserting page-wide ensures no remnant in other layouts.
    await expect(page.locator(".numeric-inline-pane")).toHaveCount(0);
    await expect(page.locator(".numeric-inline-line")).toHaveCount(0);
  });

  test("S9 — ComposeBox renders on $server + slash-only gate rejects plain text", async ({
    page,
  }) => {
    const vjt = getSeededVjt();
    await loginAs(page, vjt);

    const serverEntry = sidebarWindow(page, NETWORK_SLUG, SERVER_WINDOW_LABEL);
    await expect(serverEntry).toHaveCount(1);
    await selectChannel(page, NETWORK_SLUG, SERVER_WINDOW_LABEL, { awaitWsReady: false });

    // CP13 S9: ComposeBox IS in the DOM on the Server window.
    const ta = composeTextarea(page);
    await expect(ta).toHaveCount(1);

    // Plain text submit returns the friendly error. We can't use
    // composeSend (which waits for the textarea to empty on success);
    // on rejection the draft is preserved, so we drive the keys
    // directly and assert the .compose-box-error banner appears.
    await ta.fill("this is not a slash command");
    await ta.press("Enter");
    await expect(page.locator(".compose-box-error")).toContainText(
      "Server window accepts only slash-commands",
    );
    // Draft preserved on rejection.
    await expect(ta).toHaveValue("this is not a slash command");
  });

  test("S8 — $server window surfaces unread message badge after live numeric arrives", async ({
    page,
  }) => {
    const vjt = getSeededVjt();
    await loginAs(page, vjt);

    // Focus a different window so $server is NOT focused — unread
    // accumulates on non-focused windows only.
    await selectChannel(page, NETWORK_SLUG, TEST_CHANNEL);

    // Trigger a routed numeric AFTER login so the WS subscription on
    // the $server topic is already live. /away triggers an upstream
    // AWAY command; the server replies with 306 RPL_NOWAWAY which is
    // in NumericRouter's @active_numerics deny list → routes to
    // {:server, nil} → persists as a :notice row on $server with
    // meta.numeric=306, severity=:ok. The row arrives on the per-
    // channel WS topic and bumps messagesUnread for $server (the
    // currently-focused window is #bofh, not $server).
    //
    // (MOTD lines persist on $server too but they fire DURING session
    // bootstrap, before cicchetto's WS subscription is ready, so they
    // populate the DB but don't bump the live unread counter.)
    const ta = composeTextarea(page);
    await ta.fill("/away gone for tests");
    await ta.press("Enter");
    await expect(ta).toHaveValue("", { timeout: 5_000 });

    const badge = sidebarMessageBadge(page, NETWORK_SLUG, SERVER_WINDOW_LABEL);
    await expect(badge).toBeVisible({ timeout: 10_000 });
    const text = (await badge.textContent()) ?? "0";
    expect(Number(text)).toBeGreaterThan(0);
  });
});
