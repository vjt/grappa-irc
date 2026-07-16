// #232 — cross-cutting a11y invariant: EVERY modal closes on Esc, consistently.
//
// The real defect (verified at 4c1c644e): Esc was ad-hoc and INCONSISTENT.
// Nine modals wired an ELEMENT-scoped `onKeyDown` on the `role="dialog"` div,
// which fires only when focus sits INSIDE the dialog. None of those nine moved
// focus into the dialog on open, so with focus still in the compose textarea
// (the normal state right after a `/mode`, `/names`, `/info` command) Esc never
// reached the handler and the modal stayed open. ShareSessionModal had no Esc
// handler at all.
//
// Fix (Design U): a single shared Esc authority. Each modal registers its close
// verb on an ordered overlay stack (createOverlayLock's onEscape); the ONE
// global keydown listener (keybindings.ts) closes the topmost open modal first,
// falling back to the drawer only when nothing is stacked. This is
// focus-INDEPENDENT — Esc closes the frontmost modal regardless of where focus
// sits.
//
// This spec drives real modals in a real browser and presses Esc from
// OUTSIDE the dialog (focus parked in the compose textarea) — the exact
// condition the old element-scoped handlers failed. Reverting the fix (the
// modal files + overlayScrollLock.ts + keybindings.ts) while keeping this spec
// makes the focus-outside cases fail (RED); the fix makes them pass (GREEN).
//
// Registered vjt seed suffices — the Esc-close is subject-agnostic modal
// infrastructure, not a per-user-class behavior. Desktop chromium (untagged);
// no iOS-specific physics involved.

import type { Page } from "@playwright/test";
import {
  composeSend,
  composeTextarea,
  confirmModal,
  loginAs,
  selectChannel,
  sidebarCloseButton,
  sidebarWindow,
} from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

test.setTimeout(60_000);

// In-scope, deterministically-openable modals. All were element-scoped (no
// autofocus) pre-fix, so a focus-outside Esc never reached their old onKeyDown.
// Each opens via a read-only compose command (no server-state mutation → safe
// on the shared testnet session).
const ESC_MODALS: { name: string; testid: string; open: (page: Page) => Promise<void> }[] =
  [
    {
      name: "ModeModal (/mode)",
      testid: "mode-modal",
      open: (page) => composeSend(page, `/mode ${CHANNEL}`),
    },
    {
      name: "NamesModal (/names)",
      testid: "names-modal",
      open: (page) => composeSend(page, `/names ${CHANNEL}`),
    },
    {
      name: "ServerReplyModal (/info)",
      testid: "server-reply-modal",
      open: (page) => composeSend(page, "/info"),
    },
  ];

for (const m of ESC_MODALS) {
  test(`#232 ${m.name} closes on Esc pressed from body focus (was focus-trapped)`, async ({
    page,
  }) => {
    const vjt = getSeededVjt();
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

    await m.open(page);
    const modal = page.getByTestId(m.testid);
    await expect(modal).toBeVisible({ timeout: 8_000 });

    // Park focus in the compose textarea — OUTSIDE the dialog. This is the
    // exact condition the old per-dialog onKeyDown handlers could not handle.
    await composeTextarea(page).focus();
    await page.keyboard.press("Escape");

    await expect(modal).toHaveCount(0, { timeout: 5_000 });
  });
}

test("#232 ModeModal: the × button and backdrop click still close it (other doors intact)", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // × button.
  await composeSend(page, `/mode ${CHANNEL}`);
  const modal = page.getByTestId("mode-modal");
  await expect(modal).toBeVisible({ timeout: 8_000 });
  await modal.getByRole("button", { name: "close modes" }).click();
  await expect(modal).toHaveCount(0, { timeout: 5_000 });

  // Backdrop click (top-left corner, clear of the centered dialog).
  await composeSend(page, `/mode ${CHANNEL}`);
  await expect(modal).toBeVisible({ timeout: 8_000 });
  await page.locator(".mode-modal-backdrop").click({ position: { x: 6, y: 6 } });
  await expect(modal).toHaveCount(0, { timeout: 5_000 });
});

test("#232 ConfirmModal: Esc from body focus DISMISSES safely (channel not left)", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // The destructive close × opens the leave-channel confirm (#195).
  await sidebarCloseButton(page, NETWORK_SLUG, CHANNEL).click();
  const confirm = confirmModal(page);
  await expect(confirm).toBeVisible({ timeout: 5_000 });

  // Esc from OUTSIDE the dialog dismisses (the SAFE default) — never PARTs.
  await composeTextarea(page).focus();
  await page.keyboard.press("Escape");
  await expect(confirm).toHaveCount(0, { timeout: 5_000 });

  // The channel is still present — Esc dismissed, it did NOT leave.
  await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toHaveCount(1);
});
