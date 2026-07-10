// #178 — a scroll/navigation swipe over an EMPTY compose must not
// eagerly recall an old sent message into the draft.
//
// Root cause (evidence-first, confirmed): an empty/short rows=1 compose
// textarea sits at BOTH scroll edges, so by the #123 boundary mapping
// (`claimAxis`) any vertical flick over it claims the gesture, and a fast
// up-flick handed off to `recallPrev` — pulling the last sent line into a
// draft the user never meant to edit. The #123 velocity gate does NOT
// disambiguate here: a deliberately fast flick over an empty compose (a
// "scroll / look at history" gesture) still passed. The fix gates GESTURE
// recall on a non-empty draft; the keydown ArrowUp/ArrowDown path is
// unchanged.
//
// chromium-only: the TouchEvent constructor + synthetic swipe physics are
// reliable on chromium, not webkit (same limitation the #123 spec notes).

import { expect, test } from "../fixtures/test";
import { composeSend, composeTextarea, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { synthSwipe } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];

test("issue178 — fast swipe-up over an EMPTY compose does NOT recall (scroll, not hijack)", async ({
  page,
}) => {
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // Seed history so a hijacked recall WOULD be observable (draft → sent).
  const tag = crypto.randomUUID().slice(0, 8);
  const sent = `no-eager-recall ${tag}`;
  await composeSend(page, sent); // draft clears, history = [sent]

  const ta = composeTextarea(page);
  await expect(ta).toHaveValue("");

  // FAST swipe UP over the EMPTY draft (same tick → ≫0.3px/ms, so the
  // #123 velocity gate would have passed pre-#178). The empty compose
  // makes this a scroll/look gesture — it must NOT pull `sent` in.
  await synthSwipe(page, { startX: 100, startY: 300, endX: 100, endY: 220, slowMs: 0 });

  // Give any (buggy) recall a chance to land, then assert the draft is
  // STILL empty — the #178 regression assertion.
  await page.waitForTimeout(500);
  await expect(ta).toHaveValue("");
});

test("issue178 — fast swipe-up over a NON-empty compose still recalls (affordance preserved)", async ({
  page,
}) => {
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  const tag = crypto.randomUUID().slice(0, 8);
  const sent = `recall-when-editing ${tag}`;
  await composeSend(page, sent); // history = [sent]

  const ta = composeTextarea(page);
  await expect(ta).toHaveValue("");

  // With an in-progress (non-empty) draft, swipe-up recall stays live:
  // recallPrev stashes the draft and pulls the sent line. This is the
  // affordance #178 deliberately keeps.
  const editing = `editing ${tag}`;
  await ta.fill(editing);
  await expect(ta).toHaveValue(editing);

  await synthSwipe(page, { startX: 100, startY: 300, endX: 100, endY: 220, slowMs: 0 });
  await expect(ta).toHaveValue(sent, { timeout: 2_000 });
});
