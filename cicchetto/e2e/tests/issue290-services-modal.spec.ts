// #290 — a BARE services command (`/ns`, `/cs`, …) opens the dedicated
// services console modal (titled by the service) and fires `help`, so the
// service's multi-NOTICE help wall lands confined in the modal instead of
// flooding the server window. The reply notices are a CLIENT-SIDE filtered
// view on the service source — they ALSO stay in the $server scrollback
// (mirror, not move — nothing lost). Nick is stripped per line (the service
// name lives in the modal title, not repeated on every row). A bottom `>`
// prompt sends raw commands to the service, whose replies mirror back in.
//
// This drives /ns end-to-end against the real testnet NickServ (Anope-shape,
// so HELP replies with real NOTICEs like Azzurra). Asserts (the REAL e2e for
// #290):
//   - bare /ns opens the modal (data-service="NickServ", titled "NickServ")
//   - real NickServ HELP NOTICEs render as modal lines (proof the fired help
//     + the client-side notice-mirror + the since-open capture all wire up)
//   - nick stripped: the modal renders body-only — NO `.scrollback-sender`
//     nick chip on any line
//   - the `>` prompt sends a command to the service and its reply mirrors in
//     (the modal stays open long enough to catch the async reply)
//   - mirror, not move: NickServ notices ALSO live in the $server window as
//     :notice rows WITH the sender kept (the modal was a filtered view)
//   - × dismisses the modal
//
// The parser (bare→service-modal, args→inline msg) + the store's since-open
// capture + the component's filter/strip are unit-pinned in
// slashCommands.test.ts, serviceModal.test.ts, ServiceModal.test.tsx,
// compose.test.ts. This spec is the browser integration proof.

import { composeSend, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { expect, test } from "../fixtures/test";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];

test("#290 — bare /ns opens the services console modal; nick stripped; prompt + mirror work", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // Bare /ns opens the modal AND fires `help` (a full `/ns <cmd>` would stay
  // inline — that path is unit-covered).
  await composeSend(page, "/ns");

  const modal = page.getByTestId("service-modal");
  await expect(modal).toBeVisible({ timeout: 5_000 });
  await expect(modal).toHaveAttribute("data-service", "NickServ");
  // The service name titles the modal (not repeated per line).
  await expect(modal.locator(".service-modal-header h2")).toContainText("NickServ");

  // Real NickServ HELP NOTICEs mirror into the modal body — proof the fired
  // help reply landed AND the since-open client-side filter surfaced it.
  const lines = modal.locator('[data-testid="service-modal-line"]');
  await expect(lines.first()).toBeVisible({ timeout: 8_000 });
  const firstLine = ((await lines.first().textContent()) ?? "").trim();
  expect(firstLine.length).toBeGreaterThan(0);

  // Nick stripped: the modal renders body-only — NO `.scrollback-sender` nick
  // chip on any line (the $server mirror keeps the sender; asserted below).
  await expect(modal.locator(".scrollback-sender")).toHaveCount(0);

  // The `>` prompt sends a raw command to the service; its reply mirrors in.
  // Count grows past the pre-send count once the fresh NOTICEs land (the
  // modal must stay open long enough to catch the async reply — it never
  // auto-closes).
  const before = await lines.count();
  const prompt = page.getByTestId("service-modal-input");
  await prompt.fill("HELP");
  await prompt.press("Enter");
  await expect(prompt).toHaveValue("");
  await expect.poll(async () => lines.count(), { timeout: 8_000 }).toBeGreaterThan(before);

  // Mirror, not move: dismiss the modal and confirm NickServ notices ALSO
  // live in the $server window (as :notice rows WITH the sender kept — the
  // modal was a filtered, nick-stripped view; nothing was removed).
  await modal.getByLabel("close").click();
  await expect(modal).toBeHidden({ timeout: 2_000 });

  await selectChannel(page, NETWORK_SLUG, NETWORK_SLUG, { awaitWsReady: false });
  const serverNickservNotice = page
    .locator('[data-testid="scrollback-line"][data-kind="notice"]')
    .filter({ has: page.locator(".scrollback-sender", { hasText: /NickServ/i }) });
  await expect(serverNickservNotice.first()).toBeVisible({ timeout: 5_000 });
});
