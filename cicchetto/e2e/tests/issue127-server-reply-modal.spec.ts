// #127 — /info, /version, /motd buffer their server reply server-side and,
// on the terminator numeric (374 RPL_ENDOFINFO / 351 RPL_VERSION /
// 376 RPL_ENDOFMOTD|422), drain ONE typed `server_reply` event rendered
// client-side as a centered, scrollable, dismissable retro modal
// (ServerReplyModal). The reply is NOT dumped into scrollback.
//
// This e2e drives /info: unlike /motd, there is NO connect-time INFO burst,
// so the "scrollback stays clean" invert is unambiguous — any INFO line in a
// $server notice row would be the pre-typed-event scrollback-dump bug.
//
// Pre-conditions: vjt logged in, focused on the autojoin channel.
//
// Asserts (the REAL e2e for #127):
//   - The ServerReplyModal renders (data-testid="server-reply-modal") with
//     data-source="info" — NOT scrollback rows.
//   - The header carries the human title "Server Info" (cic maps the typed
//     `source` — the server emits no display strings).
//   - At least one parsed reply LINE renders in the modal body (proof the
//     371 burst was folded into typed lines, not dumped as text).
//   - Scrollback stays CLEAN: the modal's line text does NOT appear as a
//     $server notice row (the drain persists nothing — invert like cp22).
//   - The × button dismisses the modal.
//
// The server-side accumulator + terminator drain + the connect-time-MOTD
// gating are unit-tested in test/grappa/session/event_router_test.exs.

import { expect, test } from "../fixtures/test";
import { composeSend, loginAs, scrollbackLine, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];

test("#127 — /info renders the ServerReplyModal with parsed lines; scrollback stays clean", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  await composeSend(page, "/info");

  // The typed server_reply renders a modal — NOT scrollback notices.
  const modal = page.getByTestId("server-reply-modal");
  await expect(modal).toBeVisible({ timeout: 5_000 });
  await expect(modal).toHaveAttribute("data-source", "info");

  // Header: the human title cic derives from the typed `source`.
  await expect(modal.locator(".server-reply-modal-header h2")).toContainText("Server Info");

  // At least one parsed reply line renders — proof the 371 burst folded into
  // typed lines instead of being dumped to scrollback.
  const lines = modal.locator('[data-testid="server-reply-modal-line"]');
  await expect(lines.first()).toBeVisible();
  const firstLine = ((await lines.first().textContent()) ?? "").trim();
  expect(firstLine.length).toBeGreaterThan(0);

  // Scrollback stays CLEAN — the drain persists nothing. The same INFO line
  // must NOT appear as a $server notice row (the pre-typed-event dump bug).
  await expect(scrollbackLine(page, "notice", firstLine)).toHaveCount(0);

  // × dismisses the modal.
  await modal.getByLabel("close").click();
  await expect(modal).toBeHidden({ timeout: 2_000 });
});
