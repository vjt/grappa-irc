// #241 — animated spinner on the send button while a message send is in
// flight. Idle → the paper-plane arrow (`compose-send-glyph`); in-flight →
// a CSS spinner (`compose-send-spinner`) swapped in via Solid `<Show>` keyed
// on the POST-scoped `sending()` signal; resolved → back to the arrow.
//
// Deterministic observation of the transient in-flight window WITHOUT a
// sub-frame race: we HOLD the send POST via `page.route` (await a Node-side
// promise inside the handler before `route.continue()`), which makes the
// in-flight state non-transient so a plain `toBeVisible()` is reliable. This
// is deliberately NOT the issue254-style `addInitScript` fetch-frame snapshot:
// `sending()` is set by `doSubmit` and Solid may batch that signal write
// inside the delegated event handler, so the spinner DOM is not guaranteed to
// be committed at the synchronous fetch call frame — but it IS committed once
// the handler has yielded and the POST is pending. Holding the response is the
// race-free way to catch the swap. (The complementary fetch-wrap snapshot in
// `feedback_e2e_fetch_wrap_sync_race_snapshot` targets a flag set SYNCHRONOUSLY
// before the POST; a batched DOM update is the case where holding wins.)
//
// The spinner→arrow REVERT on the real 201 also validates the POST-scoped
// design in-browser: the server persists+broadcasts atomically, so the 201 is
// a real ack and the spinner clears on it (no optimistic render, no faked row).
//
// Subject-/platform-agnostic (Solid `<Show>` + a CSS animation): a single
// desktop chromium run with the registered seed (vjt) is sufficient — the CSS
// glyph↔spinner swap does not vary by user class or by browser engine.

import { composeTextarea, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { assertMessagePersisted } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];
const MESSAGE_BODY = `issue241-send-spinner-${Date.now()}`;

// POST /networks/{slug}/channels/{channel}/messages (no query string); the GET
// pagination variant carries `?before=`/`?after=` and is let through untouched.
const SEND_POST_RE = /\/channels\/[^/]+\/messages(\?|$)/;

test.setTimeout(60_000);

test("#241 — send button swaps arrow→spinner while a send is in flight, reverts to the arrow on the 201 ack", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  const sendBtn = page.getByRole("button", { name: /send message/i });
  const glyph = sendBtn.locator("[data-testid='compose-send-glyph']");
  const spinner = sendBtn.locator("[data-testid='compose-send-spinner']");

  // Idle: arrow present, spinner absent.
  await expect(glyph).toHaveCount(1);
  await expect(spinner).toHaveCount(0);

  // Hold the send POST so the in-flight window is observable; non-POST
  // (GET pagination) traffic is continued immediately.
  let releaseSend: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    releaseSend = resolve;
  });
  await page.route(SEND_POST_RE, async (route) => {
    if (route.request().method() === "POST") {
      await held;
    }
    await route.continue();
  });

  // Type a message and fire the send.
  const ta = composeTextarea(page);
  await ta.click();
  await ta.pressSequentially(MESSAGE_BODY, { delay: 20 });
  await sendBtn.click();

  // In-flight (POST held): spinner shown, arrow gone.
  await expect(spinner).toBeVisible();
  await expect(glyph).toHaveCount(0);

  // Release the POST → it hits the real server, the 201 clears `sending()`.
  releaseSend();

  // Resolved: arrow returns, spinner gone, draft cleared (send succeeded).
  await expect(glyph).toBeVisible();
  await expect(spinner).toHaveCount(0);
  await expect(ta).toHaveValue("", { timeout: 5_000 });

  // The held-then-continued POST really persisted — the revert was driven by
  // a genuine 201 ack, not a client-side timeout.
  await assertMessagePersisted({
    token: vjt.token,
    networkSlug: NETWORK_SLUG,
    channel: CHANNEL,
    sender: NETWORK_NICK,
    body: MESSAGE_BODY,
  });
});
