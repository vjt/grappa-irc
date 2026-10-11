// issue 2375 — the services console `>` prompt, in a real browser.
//
//   (1) Opening the modal with a bare `/ns` focuses the prompt: the user types
//       straight away, without a tap. Asserted on the OUTCOME the user sees —
//       keystrokes sent with no click land in the prompt and send — not only
//       on `document.activeElement`.
//   (3) The typed text clears the inset #96 focus ring: the prompt's computed
//       inline padding is wider than the ring it sits inside
//       (`outline-offset: -2px` puts the 2px ring on the innermost 2px).
//
// The unit side is ServiceModal.test.tsx (focus per open, per service) and
// focusVisible.test.ts (the declared padding). What neither can prove — and
// this spec cannot either — is that iOS raises the on-screen keyboard for
// the programmatic focus: WebKit does so only inside a user gesture, and the
// Playwright WebKit leg is not iOS. That needs a device.

import { composeSend, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

test("issue 2375 — bare /ns focuses the `>` prompt, and its text clears the focus ring", async ({
  page,
}) => {
  await loginAs(page, specUser());
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

  await composeSend(page, "/ns");

  const modal = page.getByTestId("service-modal");
  await expect(modal).toBeVisible({ timeout: 5_000 });
  const prompt = page.getByTestId("service-modal-input");
  await expect(prompt).toBeFocused();

  // (1) No click: the keyboard goes to the prompt, and Enter sends from it.
  const lines = modal.locator('[data-testid="service-modal-line"]');
  await expect(lines.first()).toBeVisible({ timeout: 8_000 });
  const before = await lines.count();
  await page.keyboard.type("HELP");
  await expect(prompt).toHaveValue("HELP");
  await page.keyboard.press("Enter");
  await expect(prompt).toHaveValue("");
  await expect.poll(async () => lines.count(), { timeout: 8_000 }).toBeGreaterThan(before);

  // (3) The painted geometry: each inline padding is wider than the inset
  // ring, read off the focused element's computed style. A ring that stops
  // being inset (offset >= 0) intrudes 0 and the bar becomes "any padding".
  const box = await prompt.evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      paddingLeft: Number.parseFloat(cs.paddingLeft),
      paddingRight: Number.parseFloat(cs.paddingRight),
      // The outline is drawn outward from the offset line, so a negative
      // offset is exactly how far it reaches inside the border edge.
      ring: Math.max(0, -Number.parseFloat(cs.outlineOffset)),
    };
  });
  expect(box.paddingLeft).toBeGreaterThan(box.ring);
  expect(box.paddingRight).toBeGreaterThan(box.ring);
});
