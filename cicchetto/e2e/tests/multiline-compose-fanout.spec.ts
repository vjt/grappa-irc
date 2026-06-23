// Multiline compose fan-out — a body with embedded newlines (Shift+Enter
// in ComposeBox, or a pasted block) must send one PRIVMSG per line.
//
// Pre-fix the whole multiline draft went as a single PRIVMSG and the
// server bounced it as `:invalid_line` (CRLF is the IRC frame delimiter)
// — the operator saw an "invalid" error and nothing sent. The fix splits
// client-side (compose.ts → messageLines.ts) so each line round-trips as
// its own row. This spec is the end-to-end proof that the server ACCEPTS
// the per-line sends — the whole point of the fix; jsdom unit tests only
// assert the split, not that grappa + leaf accept the frames.

import { expect, test } from "../fixtures/test";
import { composeSend, loginAs, scrollbackLine, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];

test("multiline compose sends one PRIVMSG per line", async ({ page }) => {
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // Unique per run so prior runs' persisted rows don't satisfy the
  // assertion. A blank middle line proves blank lines are dropped (no
  // empty PRIVMSG) rather than bounced.
  const tag = crypto.randomUUID().slice(0, 8);
  const l1 = `ml ${tag} uno`;
  const l2 = `ml ${tag} due`;
  const l3 = `ml ${tag} tre`;
  await composeSend(page, `${l1}\n${l2}\n\n${l3}`);

  // Each non-blank line arrives as its own :privmsg row via the WS echo.
  await expect(scrollbackLine(page, "privmsg", l1)).toBeVisible({ timeout: 5_000 });
  await expect(scrollbackLine(page, "privmsg", l2)).toBeVisible({ timeout: 5_000 });
  await expect(scrollbackLine(page, "privmsg", l3)).toBeVisible({ timeout: 5_000 });
});
