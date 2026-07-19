// #342 — the send-door "send failed" affordance renders a DEDICATED
// throttle copy when the ingress token-bucket (#340) 429s a flooding send.
//
// Server contract (#340): the per-(subject, network) inbound token bucket in
// `messages_controller.ex` rejects a send at the hard cap with HTTP 429 and
// the A7 envelope `{error: "rate_limited"}` — the SAME wire token themes'
// per-day creation quota uses. On the send door that token must mean "slow
// down", NOT themes' "try tomorrow"; `friendlyError` (the send-door
// dispatcher) overrides `rate_limited` to the throttle copy before delegating
// to `friendlyApiError`. This spec pins the browser-rendered surface: a 429
// on the message POST paints the throttle copy in `.compose-box-error`, NOT
// the themes-quota copy, and the draft is preserved for retry.
//
// Why mock the 429 (page.route) rather than flood the real bucket: the bucket
// is burst-tolerant with a refill, so driving it to the hard cap from the
// browser is slow and load-flaky; the issue explicitly scopes this to the cic
// surface (map the 429 → dedicated copy). The unit matrix
// (`friendlyError.test.ts`) pins the mapping; this spec pins that the mapped
// copy actually reaches the DOM affordance in a real browser (per
// `feedback_cicchetto_browser_smoke` — jsdom can't observe the rendered
// compose-box banner). The real 429 wire contract is exercised server-side by
// grappa's own `messages_controller` + `token_bucket` tests.
//
// Subject-/platform-agnostic (a Solid `<Show>` over the `error()` signal +
// the shared `friendlyError` dispatcher): a single desktop chromium run with
// the registered seed (vjt) is sufficient — the copy mapping does not vary by
// user class or browser engine.

import { composeTextarea, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];
const MESSAGE_BODY = `issue342-throttle-${Date.now()}`;

// POST /networks/{slug}/channels/{channel}/messages (no query string); the GET
// pagination variant carries `?before=`/`?after=` and is let through untouched.
const SEND_POST_RE = /\/channels\/[^/]+\/messages(\?|$)/;

test.setTimeout(60_000);

test("#342 — a 429 rate_limited on send paints the throttle copy (not themes' quota copy); draft preserved", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  const errorBanner = page.locator(".compose-box-error");

  // Idle: no error affordance.
  await expect(errorBanner).toHaveCount(0);

  // Force the ingress-throttle rejection: the send POST 429s with the A7
  // envelope `{error: "rate_limited"}`, exactly what #340's FallbackController
  // arm renders. Non-POST (GET pagination) traffic is continued untouched.
  await page.route(SEND_POST_RE, async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({
        status: 429,
        contentType: "application/json",
        body: JSON.stringify({ error: "rate_limited" }),
      });
      return;
    }
    await route.continue();
  });

  // Type a message and fire the send.
  const ta = composeTextarea(page);
  await ta.click();
  await ta.pressSequentially(MESSAGE_BODY, { delay: 20 });
  await page.getByRole("button", { name: /send message/i }).click();

  // The dedicated throttle copy renders — distinctive "throttling"/"too fast"
  // language, and explicitly NOT the themes-quota "try tomorrow" copy that the
  // shared `rate_limited` token would otherwise leak onto the send door.
  await expect(errorBanner).toBeVisible();
  await expect(errorBanner).toHaveText(/throttl|too fast/i);
  await expect(errorBanner).not.toHaveText(/theme limit|try again tomorrow/i);

  // Draft is preserved (compose.ts: no history push, no clear on error) so the
  // user can retry without re-typing.
  await expect(ta).toHaveValue(MESSAGE_BODY);
});
