// #240 — set param modes (+k key / +l limit) FROM the /mode editor modal,
// proven end-to-end against the live upstream.
//
// The #216 modal showed param-taking modes read-only: an op could see a
// key/limit but could only SET one via the raw `/mode #chan +k <secret>`
// command. #240 adds the value input. This witness drives the input path
// only — type a value, click Set — and asserts the round-trip: the value
// is reflected back from the server (the MODE echo / 324 re-query lands in
// modesByChannel and re-renders the modal + the TopicBar indicator). A
// hollow spec that only checked "input exists" would pass without the
// wire actually carrying the param; asserting the reflected VALUE proves
// the MODE was sent, accepted, and echoed.
//
// vjt creates a fresh per-run channel (→ sole op, so the edit gate opens
// and no peer is needed) and PARTs it in `finally`. jsdom/vitest cannot
// do this — it needs the live ircd MODE round-trip.

import { composeSend, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

test("#240 — an op sets +k <key> and +l <n> from the mode modal and the MODE is reflected", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  const channel = `#t240-${Date.now()}`;
  const key = `s3cr3t${Date.now() % 100000}`;
  const limit = "42";

  await loginAs(page, vjt);
  // Focus the autojoin channel first to confirm login + WS-ready before
  // issuing the /join (mirrors issue216 boot order).
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: NETWORK_NICK });

  try {
    // vjt creates the channel → becomes op (@) → the modal's edit gate opens.
    await composeSend(page, `/join ${channel}`);
    await expect(
      page.locator(".sidebar-network-section li").filter({ hasText: channel }),
    ).toHaveCount(1, { timeout: 15_000 });
    await selectChannel(page, NETWORK_SLUG, channel, { ownNick: NETWORK_NICK });

    // Open the editor for the fresh channel. `/mode #chan` (no mode args)
    // opens the modal deterministically — the TopicBar indicator is hidden
    // until a mode exists, so we don't tap it here.
    await composeSend(page, `/mode ${channel}`);
    const modal = page.getByTestId("mode-modal");
    await expect(modal).toBeVisible({ timeout: 5_000 });

    // --- SET +k <key> from the input -------------------------------------
    const keyInput = modal.getByTestId("mode-param-input-k");
    await expect(keyInput).toBeVisible(); // op → editable input, not read-only
    await keyInput.fill(key);
    await modal.getByTestId("mode-param-set-k").click();

    // Reflected: the server echoed `MODE #chan +k <key>` → modesByChannel
    // re-seeds → the +k row renders as active with the key value.
    await expect(modal.locator(".mode-modal-param-row-active").filter({ hasText: key })).toBeVisible(
      { timeout: 15_000 },
    );

    // --- SET +l <n> from the input ---------------------------------------
    const limitInput = modal.getByTestId("mode-param-input-l");
    await limitInput.fill(limit);
    await modal.getByTestId("mode-param-set-l").click();

    await expect(
      modal.locator(".mode-modal-param-row-active").filter({ hasText: limit }),
    ).toBeVisible({ timeout: 15_000 });

    // --- Visible outcome outside the modal -------------------------------
    // Close the modal and confirm the TopicBar mode indicator now shows
    // both letters — the same server-owned modesByChannel the modal read.
    await modal.getByLabel("close modes").click();
    await expect(modal).toBeHidden({ timeout: 2_000 });

    const modeIndicator = page.locator(".topic-bar-modes");
    await expect(modeIndicator).toBeVisible({ timeout: 15_000 });
    await expect(modeIndicator).toContainText("k");
    await expect(modeIndicator).toContainText("l");
  } finally {
    await composeSend(page, `/part ${channel}`).catch(() => {});
  }
});
