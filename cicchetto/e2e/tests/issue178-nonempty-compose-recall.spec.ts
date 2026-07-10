// #178 (as amended by #203) — swipe-up gesture recall on a NON-empty
// compose still recalls history.
//
// History: #178 gated BOTH gesture-recall directions on a non-empty
// draft, to kill a fast up-flick over an EMPTY compose accidentally
// pulling an old sent line into a draft the user never meant to edit
// (an empty rows=1 textarea sits at both scroll edges, so by the #123
// boundary mapping any vertical flick claims the gesture). #203 later
// found that gate was too broad for swipe-UP and restored empty-compose
// swipe-up recall (parity with the ArrowUp key) — see
// issue203-empty-compose-swipe-recall.spec.ts, which now owns the
// empty-compose swipe assertions. What survives from #178 is the
// affordance this spec guards: on a NON-empty (in-progress) draft,
// swipe-up recall stays live — recallPrev stashes the draft and pulls
// the sent line.
//
// chromium-only: the TouchEvent constructor + synthetic swipe physics are
// reliable on chromium, not webkit (same limitation the #123 spec notes).

import { expect, test } from "../fixtures/test";
import { composeSend, composeTextarea, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { synthSwipe } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];

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
  // affordance #178 deliberately keeps (and #203 leaves untouched).
  const editing = `editing ${tag}`;
  await ta.fill(editing);
  await expect(ta).toHaveValue(editing);

  await synthSwipe(page, { startX: 100, startY: 300, endX: 100, endY: 220, slowMs: 0 });
  await expect(ta).toHaveValue(sent, { timeout: 2_000 });
});
