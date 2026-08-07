// #974 — Shift+Enter SENDS.
//
// This spec is the inverse of the one it replaces (#816's
// "shift-enter-speaks"), because the product intent moved: vjt's ruling of
// 2026-08-07 reverses his own 2026-08-06 one. The refusal did not merely stay
// silent or speak — it ATE the keystroke, and on his device the modifier arms
// itself on presses he never meant as Shift+Enter, so a message he typed just
// did not go. What arms it is still unknown and deliberately not diagnosed:
// making every Enter send closes the whole class without needing to know.
//
// The vitest half (ComposeBox.test.tsx) proves the handler calls submit in
// jsdom, where the draft store is a static mock. This is the real-browser
// proof of the two things jsdom cannot show: the message reaches the
// scrollback, and `preventDefault` still keeps the textarea's own line break
// out of a composer the async submit has already emptied.

import { composeTextarea, loginAs, scrollbackLine, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// The copy that must NOT be there any more. Spelled out rather than imported:
// the production constant is gone, and a spec asserting the absence of a
// symbol it also imported could not fail.
const GONE_REFUSAL = "IRC does not support multi-line messages";

test("#974 — Shift+Enter sends the message and shows no refusal", async ({ page }) => {
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  const ta = composeTextarea(page);
  await expect(ta).toBeVisible();

  const tag = crypto.randomUUID().slice(0, 8);
  const typed = `se ${tag} sends on shift`;
  await ta.fill(typed);

  // Neither is up yet, so neither assertion below can pass on a leftover.
  await expect(page.getByText(GONE_REFUSAL)).toHaveCount(0);
  await expect(scrollbackLine(page, "privmsg", typed)).toHaveCount(0);

  await ta.press("Shift+Enter");

  // The visible outcome, and the whole point of the issue: it went.
  await expect(scrollbackLine(page, "privmsg", typed)).toBeVisible({ timeout: 5_000 });
  // Nothing was refused, so nothing explains a refusal.
  await expect(page.getByText(GONE_REFUSAL)).toHaveCount(0);
  // `preventDefault` survived: the UA's own line break never got in, so the
  // composer is EMPTY rather than holding a stray "\n" the async clear raced
  // past.
  await expect(ta).toHaveValue("");
});
