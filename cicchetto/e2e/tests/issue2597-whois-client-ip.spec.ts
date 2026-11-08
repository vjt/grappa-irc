// Issue 2597 — a WHOIS made through grappa, on a nick a grappa user holds
// upstream, also names the address that user's client connects to grappa
// from: to a requester whose session holds umode `o`/`O`, or to a grappa
// admin on a full web session. Anyone else gets `null` for both keys ON THE
// WIRE — hiding the row in cic would not be enough, so the non-oper half reads
// the frame, not only the DOM.
//
// What this pins over the real socket, a real bahamut and real sessions,
// which the ExUnit cases (`whois_client_ip_test.exs`, a fake ircd) cannot:
//   1. an OPER (visitor A, `/oper testoper testoperpass`, 381) asking
//      `/whois <B>` while visitor B has a browser open gets the WHOIS card's
//      "client IP" row, holding addresses;
//   2. a NON-oper (visitor C) asking the same gets the card without the row,
//      and its `whois_bundle` frame carries both keys as `null`;
//   3. a visitor with no browser open (D, minted over REST, never booted)
//      reads "no socket connected", beside the address its login came from;
//   4. the automatic rail WHOIS of a query (`origin: rail`, P3) carries the
//      row too.
//
// NOT pinned, on purpose: WHOSE address the row shows. On one test host every
// client reaches grappa from the same few addresses, so B's and C's are not
// told apart here; the address is asserted as an address, nothing more.
// Which socket's address it is, is `whois_client_ip_test.exs`'s.
//
// Creds: the testnet O:line is host-unrestricted, NAME field `testoper`
// (see issue148-visitor-oper.spec.ts) — any visitor nick can oper with it.
// Feature logic is engine-agnostic → chromium only.

import type { Page, WebSocket } from "@playwright/test";
import {
  bootVisitor,
  bootVisitorContext,
  composeSend,
  expectShellReady,
  scrollbackLine,
  selectChannel,
  waitForQueryWindowReady,
} from "../fixtures/cicchettoPage";
import { type MintedVisitor, mintVisitor, reapVisitors } from "../fixtures/grappaApi";
import { getSeededAdmin } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

const RUN_ID = crypto.randomUUID().slice(0, 6);
const RPL_YOUREOPER_TEXT = /you are now an irc operator/i;
// One address (IPv4 dotted or IPv6), or a comma-separated list of them.
const ADDRESSES = /^([0-9.]+|[0-9a-f:]+)(, ([0-9.]+|[0-9a-f:]+))*$/i;

type WhoisFrame = Record<string, unknown> & { kind: "whois_bundle"; target: string };

// Every `whois_bundle` this page's sockets receive. Attached before boot, or
// the boot socket is missed (issue1769-presence-suppressed-on-the-socket.spec.ts).
function recordWhoisBundles(page: Page): WhoisFrame[] {
  const seen: WhoisFrame[] = [];
  page.on("websocket", (ws: WebSocket) => {
    ws.on("framereceived", ({ payload }) => {
      if (typeof payload !== "string") return;
      let frame: unknown;
      try {
        frame = JSON.parse(payload);
      } catch {
        return;
      }
      // Phoenix V2 frame: [join_ref, ref, topic, event, payload].
      if (!Array.isArray(frame) || frame[3] !== "event") return;
      const p = frame[4] as { kind?: unknown } | null;
      if (p?.kind === "whois_bundle") seen.push(p as WhoisFrame);
    });
  });
  return seen;
}

async function focusServer(page: Page, visitor: MintedVisitor): Promise<void> {
  await expectShellReady(page);
  await selectChannel(page, visitor.network_slug, "Server", { awaitWsReady: false });
  // Registration numerics land in $server as notices: the session is up.
  await expect(
    page.locator('[data-testid="scrollback-line"][data-kind="notice"]').first(),
  ).toBeVisible({ timeout: 20_000 });
}

test("issue 2597 — an oper's WHOIS names a grappa user's client address; nobody else's does", async ({
  browser,
}) => {
  const admin = getSeededAdmin();
  const oper = await mintVisitor(`op2597-${RUN_ID}`);
  const target = await mintVisitor(`tg2597-${RUN_ID}`);
  const plain = await mintVisitor(`pl2597-${RUN_ID}`);
  const away = await mintVisitor(`aw2597-${RUN_ID}`);

  const a = await bootVisitorContext(browser, { id: oper.id, token: oper.token });
  const b = await bootVisitorContext(browser, { id: target.id, token: target.token });
  const cCtx = await browser.newContext();
  const cPage = await cCtx.newPage();
  const cBundles = recordWhoisBundles(cPage);
  await bootVisitor(cPage, { id: plain.id, token: plain.token });

  try {
    await focusServer(a.page, oper);
    // B's live socket is what the oper's row reports.
    await focusServer(b.page, target);
    await focusServer(cPage, plain);

    await test.step("A opers", async () => {
      await composeSend(a.page, "/oper testoper testoperpass");
      await expect(scrollbackLine(a.page, "notice", RPL_YOUREOPER_TEXT).first()).toBeVisible({
        timeout: 15_000,
      });
    });

    await test.step("the oper's /whois of a connected visitor shows its addresses", async () => {
      await composeSend(a.page, `/whois ${target.nick}`);
      const card = a.page.locator(".scrollback-overlay").getByTestId("whois-card");
      await expect(card.locator(".whois-card-target")).toHaveText(target.nick, { timeout: 8_000 });
      await expect(card.locator(".whois-card-client-ips")).toHaveText(ADDRESSES);
      await card.locator(".whois-card-close").click();
    });

    await test.step("a non-oper's /whois shows no row, and its frame says null", async () => {
      await composeSend(cPage, `/whois ${target.nick}`);
      const card = cPage.locator(".scrollback-overlay").getByTestId("whois-card");
      await expect(card.locator(".whois-card-target")).toHaveText(target.nick, { timeout: 8_000 });
      await expect(card.locator(".whois-card-client-ips")).toHaveCount(0);

      const bundle = cBundles.find((f) => f.target === target.nick);
      expect(bundle, "C received the whois_bundle the card rendered").toBeDefined();
      // Both keys present (E3) and null: the server withheld them.
      expect(bundle).toHaveProperty("grappa_client_ips", null);
      expect(bundle).toHaveProperty("grappa_client_last_known_ip", null);
    });

    await test.step("a visitor with no browser open reads as such, beside its login address", async () => {
      await composeSend(a.page, `/whois ${away.nick}`);
      const card = a.page.locator(".scrollback-overlay").getByTestId("whois-card");
      await expect(card.locator(".whois-card-target")).toHaveText(away.nick, { timeout: 8_000 });
      await expect(card.locator(".whois-card-client-ips")).toHaveText(
        /^no socket connected, last known address ([0-9.]+|[0-9a-f:]+)$/i,
      );
      await card.locator(".whois-card-close").click();
    });

    await test.step("the rail's automatic WHOIS of a query carries the row too", async () => {
      await composeSend(a.page, `/q ${target.nick}`);
      await waitForQueryWindowReady(a.page, oper.network_slug, target.nick);
      const railCard = a.page.locator(".shell-members").getByTestId("whois-card");
      await expect(railCard.locator(".whois-card-target")).toHaveText(target.nick, {
        timeout: 8_000,
      });
      await expect(railCard.locator(".whois-card-client-ips")).toHaveText(ADDRESSES);
    });
  } finally {
    await a.ctx.close();
    await b.ctx.close();
    await cCtx.close();
    await reapVisitors(admin.token, oper.id, target.id, plain.id, away.id);
  }
});
