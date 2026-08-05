// #904 — the composer's one-deep send queue, in a real browser.
//
// The defect: on a slow link a SINGLE in-flight send shared one buffer with
// the operator. The textarea stayed writable, Enter was a no-op (ComposeBox's
// own `sending()` early-returned), and when the 201 finally landed the
// end-of-submit clear wiped the follow-up the operator had typed meanwhile —
// silently, and without it ever reaching history.
//
// The fix moved the in-flight truth into the store, keyed on the window: the
// message leaves the composer AT DISPATCH, a second Enter parks its line in a
// slot exactly one deep, the pump sends it on the ack, and a third is refused
// visibly (readOnly) instead of being eaten.
//
// Why an e2e and not only jsdom: three of the four properties below are
// browser-rendered state on the real send path — the textarea emptying at
// dispatch, the readOnly refusal, and the queued line actually reaching the
// server in order once the first ack lands (`feedback_cicchetto_browser_smoke`
// — jsdom can observe none of that against a live grappa + leaf).
//
// The slow link is synthesized with `page.route`: the FIRST send POST is held
// open until the spec releases it, which is exactly the ~5s mobile ack the
// issue was reported on, made deterministic. Everything else — the queueing,
// the dispatch, the ordering — is the real client and the real server.
//
// Subject-/platform-agnostic (store state + one `readOnly` binding), so one
// desktop chromium run with the registered seed is sufficient.

import { composeTextarea, loginAs, scrollbackLine, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// POST /networks/{slug}/channels/{channel}/messages (no query string); the GET
// pagination variant carries `?before=`/`?after=` and is let through untouched.
const SEND_POST_RE = /\/channels\/[^/]+\/messages(\?|$)/;

test.setTimeout(60_000);

test("#904 — a slow send frees the composer, queues ONE more, refuses the third, and delivers both in order", async ({
  page,
}) => {
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  const tag = crypto.randomUUID().slice(0, 8);
  const first = `q904 ${tag} first`;
  const second = `q904 ${tag} second`;
  const third = `q904 ${tag} third`;

  // The slow link: hold the FIRST send POST open until this spec releases it.
  // Every later send goes through untouched — the queue drains at full speed
  // once the ack that was blocking it lands.
  let releaseFirst: () => void = () => {};
  const firstHeld = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const sentBodies: string[] = [];
  await page.route(SEND_POST_RE, async (route) => {
    const request = route.request();
    if (request.method() !== "POST") {
      await route.continue();
      return;
    }
    const body = JSON.parse(request.postData() ?? "{}") as { body?: string };
    sentBodies.push(body.body ?? "");
    if (sentBodies.length === 1) await firstHeld;
    await route.continue();
  });

  const ta = composeTextarea(page);

  // 1. The first message leaves the composer at DISPATCH, while its POST is
  //    still hanging. Pre-fix the draft sat here until the 201.
  await ta.fill(first);
  await ta.press("Enter");
  await expect(ta).toHaveValue("", { timeout: 5_000 });
  await expect.poll(() => sentBodies.length).toBe(1);

  // 2. The operator writes the next one while the first is still in flight and
  //    hits Enter. Pre-fix that Enter did nothing at all and this text was
  //    destroyed by the first send's end-of-submit clear.
  await ta.fill(second);
  await ta.press("Enter");
  await expect(ta).toHaveValue("", { timeout: 5_000 });
  // Queued, NOT sent: the link is still blocked on the first message.
  expect(sentBodies).toEqual([first]);

  // 3. Queue full (one in flight + one queued) → the refusal is VISIBLE: the
  //    textarea goes read-only rather than accepting a third message it would
  //    then have to eat. readOnly, never disabled — disabled blurs the box and
  //    collapses the on-screen keyboard (#59).
  await expect(ta).toHaveJSProperty("readOnly", true);
  await expect(ta).toHaveJSProperty("disabled", false);

  // 4. The ack lands. The queued line goes out — after the first, never before
  //    it — and both render in the channel.
  releaseFirst();
  await expect.poll(() => sentBodies, { timeout: 15_000 }).toEqual([first, second]);
  await expect(scrollbackLine(page, "privmsg", first)).toBeVisible({ timeout: 10_000 });
  await expect(scrollbackLine(page, "privmsg", second)).toBeVisible({ timeout: 10_000 });

  // The composer is the operator's again, and it works.
  await expect(ta).toHaveJSProperty("readOnly", false);
  await ta.fill(third);
  await ta.press("Enter");
  await expect(scrollbackLine(page, "privmsg", third)).toBeVisible({ timeout: 10_000 });
});
