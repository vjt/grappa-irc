// #816 — Shift+Enter SPEAKS.
//
// A newline cannot travel inside a PRIVMSG (CRLF terminates the frame), so
// honouring Shift+Enter means splitting into N messages — a burst the
// operator never asked for by holding a modifier. cic therefore inserts
// nothing and sends nothing.
//
// vjt's ruling (2026-08-06) is that the refusal must not be SILENT. Every
// other chat app the operator uses honours that combination; a composer that
// simply does nothing reads as a broken key or a cic bug, and there is no way
// to learn that the protocol is what refused. So the composer says
// "IRC does not support multi-line messages" on the #356 feedback seam.
//
// The vitest half (ComposeBox.test.tsx) proves the handler sets the feedback
// signal in jsdom. This spec is the real-browser proof that the line actually
// RENDERS where the operator is looking — and that the refusal is still a
// refusal: no newline in the box, no message on the wire.

import { expect, test } from "../fixtures/test";
import {
  composeSend,
  composeTextarea,
  loginAs,
  scrollbackLine,
  selectChannel,
} from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// vjt's wording, verbatim — this literal IS the requirement, so the spec
// spells it out rather than importing the production constant (which would
// make any rewording silently self-approving).
const REFUSAL = "IRC does not support multi-line messages";

test("#816 — Shift+Enter inserts no newline, sends nothing, and explains why", async ({ page }) => {
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  const ta = composeTextarea(page);
  await expect(ta).toBeVisible();

  const tag = crypto.randomUUID().slice(0, 8);
  const typed = `se ${tag} prima riga`;
  await ta.fill(typed);

  // Nothing is up yet — so the assertion below cannot pass on a stale line
  // left over from some earlier interaction.
  await expect(page.getByText(REFUSAL)).toHaveCount(0);

  await ta.press("Shift+Enter");

  // The composer explains itself.
  await expect(page.getByText(REFUSAL)).toBeVisible();
  // …and it is still a refusal: the draft is untouched (no line break got in)
  // and nothing was sent.
  await expect(ta).toHaveValue(typed);
  await expect(scrollbackLine(page, "privmsg", typed)).toHaveCount(0);

  // Positive control: a plain Enter DOES send the same draft. Without this a
  // dead composer (or a wedged window) would satisfy everything above.
  await composeSend(page, typed);
  await expect(scrollbackLine(page, "privmsg", typed)).toBeVisible({ timeout: 5_000 });
});
