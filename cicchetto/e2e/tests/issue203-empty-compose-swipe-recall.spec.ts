// #203 — swipe-UP over an EMPTY compose recalls history again, at
// parity with the physical ArrowUp key.
//
// Background: #178 gated BOTH gesture-recall directions on a non-empty
// draft to kill a fast up-flick over an empty compose accidentally
// pulling an old sent line in. That gate was too broad for swipe-UP: the
// compose textarea is rows=1 — an EMPTY one has nothing to scroll (the
// scrollback pane is a SEPARATE touch surface), so the "empty up-flick =
// scroll/look" premise doesn't hold there, and the only coherent intent
// of an up-flick over an empty compose is recall — exactly what ArrowUp
// does (which #178 always left recalling on empty). #203 restores that
// swipe≡ArrowUp parity for swipe-UP while KEEPING #178's non-empty gate
// on swipe-DOWN (recall-next).
//
// chromium-only (untagged): the TouchEvent constructor + synthetic swipe
// physics are reliable on chromium, not webkit — the same limitation the
// #123 / #178 gesture specs note. Playwright webkit ≠ real iOS Safari
// gesture physics; the on-device empty-swipe-up recall still wants a vjt
// dogfood pass (flagged to orch), but this spec deterministically proves
// the handler WIRING: an empty-compose up-flick now reaches recallPrev.

import { expect, test } from "../fixtures/test";
import {
  composeSend,
  composeTextarea,
  loginAs,
  selectChannel,
  synthSwipe,
} from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];

test("issue203 — fast swipe-up over an EMPTY compose recalls the last sent line (parity with ArrowUp)", async ({
  page,
}) => {
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // Seed history so a recall is observable (empty draft → sent line).
  const tag = crypto.randomUUID().slice(0, 8);
  const sent = `empty-swipe-recall ${tag}`;
  await composeSend(page, sent); // draft clears, history = [sent]

  const ta = composeTextarea(page);
  await expect(ta).toHaveValue("");

  // FAST swipe UP over the EMPTY draft. Post-#203 this recalls `sent`,
  // exactly as pressing ArrowUp on an empty compose would.
  await synthSwipe(page, { startX: 100, startY: 300, endX: 100, endY: 220, slowMs: 0 });
  await expect(ta).toHaveValue(sent, { timeout: 2_000 });
});

test("issue203 — the recalled line matches keydown ArrowUp exactly (swipe≡arrow parity)", async ({
  page,
}) => {
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  const tag = crypto.randomUUID().slice(0, 8);
  const sent = `parity-check ${tag}`;
  await composeSend(page, sent); // history = [sent]

  const ta = composeTextarea(page);
  await expect(ta).toHaveValue("");

  // Physical ArrowUp on the empty compose recalls the sent line…
  await ta.focus();
  await ta.press("ArrowUp");
  await expect(ta).toHaveValue(sent, { timeout: 2_000 });

  // …clear back to empty, then the SWIPE must land on the identical value.
  await ta.fill("");
  await expect(ta).toHaveValue("");
  await synthSwipe(page, { startX: 100, startY: 300, endX: 100, endY: 220, slowMs: 0 });
  await expect(ta).toHaveValue(sent, { timeout: 2_000 });
});

test("issue203 — fast swipe-DOWN over an EMPTY compose does NOT recall (#178 gate kept on recall-next)", async ({
  page,
}) => {
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  const tag = crypto.randomUUID().slice(0, 8);
  const sent = `no-down-recall ${tag}`;
  await composeSend(page, sent); // history = [sent]

  const ta = composeTextarea(page);
  await expect(ta).toHaveValue("");

  // FAST swipe DOWN over the EMPTY draft. recall-next stays #178-gated on
  // a non-empty draft (and recallNext is a no-op at the bottom cursor
  // anyway) → the draft must STAY empty.
  await synthSwipe(page, { startX: 100, startY: 220, endX: 100, endY: 300, slowMs: 0 });
  await page.waitForTimeout(500);
  await expect(ta).toHaveValue("");
});
