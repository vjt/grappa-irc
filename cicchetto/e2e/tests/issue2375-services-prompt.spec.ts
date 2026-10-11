// issue 2375 — the services console `>` prompt, in a real browser.
//
//   (1) Opening the modal with a bare `/ns` focuses the prompt: the user types
//       straight away, without a tap. Asserted on the OUTCOME the user sees —
//       keystrokes sent with no click land in the prompt and send — not only
//       on `document.activeElement`.
//   (2) Tab completes nicks and channels in the prompt through the compose
//       box's engine (vjt's ruling): the members of the window behind the
//       modal plus the network's joined channels, a plain space after a nick
//       (the line opens with a command, so no `nick: `), and the compose
//       draft behind the scrim untouched.
//   (2b) Focus stays inside the `aria-modal` dialog. Native traversal used to
//       walk out onto the covered page (the modal precedes the compose box in
//       Shell's DOM), where the irssi auto-focus sent the next printable key
//       into the compose box BEHIND the scrim. The prompt now consumes Tab
//       (it completes), and Shift+Tab off the close button wraps back to it.
//   (3) The typed text clears the inset #96 focus ring: the prompt's computed
//       inline padding is wider than the ring it sits inside.
//   (4) The prompt is a `<textarea rows=1>` (vjt's ruling, aimed at the iOS
//       Contacts AutoFill) that still behaves single-line: Enter sends and
//       leaves no line break behind.
//
// The unit side is ServiceModal.test.tsx, tabCompletion.test.ts,
// focusTrap.test.ts and focusVisible.test.ts. What none of them — and not
// this spec — can prove needs an iPhone: that iOS raises the on-screen
// keyboard for the programmatic focus (WebKit does so only inside a user
// gesture), and whether the textarea silences the Contacts AutoFill. The
// Playwright WebKit leg is not iOS.

import { composeSend, composeTextarea, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

test("issue 2375 — bare /ns focuses the `>` prompt, which completes, keeps focus in, and clears its ring", async ({
  page,
}) => {
  const nick = specNick();
  await loginAs(page, specUser());
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: nick });

  await composeSend(page, "/ns");

  const modal = page.getByTestId("service-modal");
  await expect(modal).toBeVisible({ timeout: 5_000 });
  const prompt = page.getByTestId("service-modal-input");
  await expect(prompt).toBeFocused();

  // (4) The composer's shape.
  expect(await prompt.evaluate((el) => [el.tagName, el.getAttribute("rows")])).toEqual([
    "TEXTAREA",
    "1",
  ]);

  // (1) + (4) No click: the keyboard goes to the prompt, and Enter sends from
  // it, leaving the prompt empty — no line break behind.
  const lines = modal.locator('[data-testid="service-modal-line"]');
  await expect(lines.first()).toBeVisible({ timeout: 8_000 });
  const before = await lines.count();
  await page.keyboard.type("HELP");
  await expect(prompt).toHaveValue("HELP");
  await page.keyboard.press("Enter");
  await expect(prompt).toHaveValue("");
  await expect.poll(async () => lines.count(), { timeout: 8_000 }).toBeGreaterThan(before);

  // (2) A member of the window behind the modal — our own nick is in its
  // NAMES — completes with a plain space, and a channel prefix completes
  // against the network's joined channels.
  await page.keyboard.type(`INFO ${nick.slice(0, -1)}`);
  await page.keyboard.press("Tab");
  await expect(prompt).toHaveValue(`INFO ${nick} `);
  await expect(prompt).toBeFocused();
  await page.keyboard.type(CHANNEL.slice(0, 4));
  await page.keyboard.press("Tab");
  await expect(prompt).toHaveValue(`INFO ${nick} ${CHANNEL} `);
  await expect(composeTextarea(page)).toHaveValue("");

  // (2b) Shift+Tab off the close button (the first stop) wraps to the prompt,
  // and the keystrokes after that still belong to the prompt, not to the
  // compose box behind the scrim.
  await modal.getByLabel("close").focus();
  await page.keyboard.press("Shift+Tab");
  await expect(prompt).toBeFocused();
  await page.keyboard.type("x");
  await expect(prompt).toHaveValue(`INFO ${nick} ${CHANNEL} x`);
  await expect(composeTextarea(page)).toHaveValue("");

  // (3) The painted geometry: each inline padding is wider than how far the
  // outline reaches inside the border edge. The outline is drawn outward from
  // the offset line, so a negative offset is exactly that reach; a ring that
  // stops being inset intrudes 0 and the bar becomes "any padding".
  const box = await prompt.evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      paddingLeft: Number.parseFloat(cs.paddingLeft),
      paddingRight: Number.parseFloat(cs.paddingRight),
      ring: Math.max(0, -Number.parseFloat(cs.outlineOffset)),
    };
  });
  expect(box.paddingLeft).toBeGreaterThan(box.ring);
  expect(box.paddingRight).toBeGreaterThan(box.ring);
});
