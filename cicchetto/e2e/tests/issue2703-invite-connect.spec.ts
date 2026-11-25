// issue 2703 — an invite link for a network the recipient has not bound, but
// may, connects that network with no modal of its own and then asks the join
// question exactly as for a bound network.
//
// This is the case the issue was filed for. The "Join #disagio with grappa"
// buttons on disagio.sniffo.org point at `?go=ircnet/disagio`, and a newcomer
// holds no ircnet, so the link used to end in "you are not connected to that
// network" and nothing else. Prod's `ircnet` is `visitor_enabled` with
// autoconnect off. The e2e stack's `azzurra2` (solanum, its own nick
// namespace) is in exactly that position (`e2e/compose.yaml`): it is in every
// subject's `available_networks` and in nobody's bound set.
//
// What is proven is the visible chain, for both subject kinds:
//   1. A signed-in USER opens the link. The network appears in the sidebar,
//      exactly ONE `POST /session/networks` was made, and the ONLY dialog on
//      screen is the join consent naming the channel. Confirming leaves the
//      channel window joined and selected.
//   2. A VISITOR with no session, the issue's real case, opens the link,
//      lands on /login and connects with a nick. The invite survives the login
//      and runs the same chain.
// The dead end (a slug this server does not offer) stays in the #793 spec,
// beside the other two invite outcomes.
//
// What this cannot prove is that the JOIN waits for 001: solanum registers in
// milliseconds, so a confirm always lands after it. ExUnit owns that property
// (server_test.exs, "issue 2703 — a JOIN that arrives before 001 waits for
// 001").

import type { Page } from "@playwright/test";
import {
  confirmModal,
  confirmModalBody,
  confirmModalYes,
  inviteUrl,
  openInviteLink,
  sidebarWindow,
} from "../fixtures/cicchettoPage";
import { partChannel, reapVisitors } from "../fixtures/grappaApi";
import { getSeededAdmin } from "../fixtures/seedData";
import { expect, specUser, test } from "../fixtures/test";

// Offered to every subject, bound by none (see the header).
const OFFERED = "azzurra2";

// Lowercase: raw == ASCII-folded, so the sidebar key equals the spelling.
const freshChannel = (label: string) => `#i2703${label}-${crypto.randomUUID().slice(0, 6)}`;

// Every attach the page makes, counted from before the first navigation.
function recordAttaches(page: Page): string[] {
  const attaches: string[] = [];
  page.on("request", (req) => {
    if (req.method() === "POST" && new URL(req.url()).pathname === "/session/networks") {
      attaches.push(req.url());
    }
  });
  return attaches;
}

// Steps 1–2 of the chain, shared by both subjects. The network arrives first,
// with one attach and no modal for it; then the join question, alone.
async function expectAttachedThenAsked(
  page: Page,
  attaches: string[],
  channel: string,
): Promise<void> {
  await expect(sidebarWindow(page, OFFERED, "Server")).toBeVisible({ timeout: 30_000 });
  await expect(confirmModal(page)).toBeVisible({ timeout: 15_000 });
  await expect(confirmModalBody(page)).toHaveText(`Join ${channel}?`);
  await expect(page.getByRole("dialog")).toHaveCount(1);
  expect(attaches).toHaveLength(1);
}

// Step 3: the window is a JOINED row (a pending one is a pseudo-row carrying
// `data-window-state`), and it is the one in focus.
async function expectJoinedAndSelected(page: Page, channel: string): Promise<void> {
  await expect(
    sidebarWindow(page, OFFERED, channel).and(page.locator("[data-window-state]")),
  ).toHaveCount(0, { timeout: 15_000 });
  await expect(sidebarWindow(page, OFFERED, channel)).toHaveClass(/selected/, {
    timeout: 15_000,
  });
  await expect(confirmModal(page)).toHaveCount(0);
}

test("an invite for a network the user may bind attaches it, then asks to join (issue 2703)", async ({
  page,
}) => {
  const user = specUser();
  const channel = freshChannel("u");
  const attaches = recordAttaches(page);

  await openInviteLink(page, user, OFFERED, channel);
  await page.waitForFunction(() => window.__cicInviteLinkApplied === true, null, {
    timeout: 15_000,
  });

  try {
    await expectAttachedThenAsked(page, attaches, channel);
    await confirmModalYes(page);
    await expectJoinedAndSelected(page, channel);
  } finally {
    // The subject teardown unbinds every credential before it deletes the
    // user, which stops this azzurra2 session synchronously
    // (`SubjectProvision.teardown!/1`). The PART is for the channel.
    await partChannel(user.token, OFFERED, channel);
  }
});

test("a visitor arriving on an invite logs in, gets the network attached, then is asked to join (issue 2703)", async ({
  browser,
}) => {
  const admin = getSeededAdmin();
  const nick = `v2703-${Date.now().toString(36)}`;
  const channel = freshChannel("v");

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const attaches = recordAttaches(page);
  let visitorId: string | null = null;

  try {
    await page.addInitScript(() => localStorage.setItem("cic.installChoice", "browser"));
    // No session: the app sends the link to /login, and the invite read at
    // boot waits in memory for the session the login creates.
    await page.goto(inviteUrl(OFFERED, channel));
    await expect(page.getByLabel(/nick or email/i)).toBeVisible({ timeout: 10_000 });
    await page.getByLabel(/nick or email/i).fill(nick);
    await page.getByRole("button", { name: /^connect$/i }).click();

    await page.waitForFunction(() => window.__cicInviteLinkApplied === true, null, {
      timeout: 30_000,
    });
    visitorId = await page.evaluate(() => {
      const raw = localStorage.getItem("grappa-subject");
      return raw ? (JSON.parse(raw) as { id: string }).id : null;
    });

    await expectAttachedThenAsked(page, attaches, channel);
    await confirmModalYes(page);
    await expectJoinedAndSelected(page, channel);
  } finally {
    await ctx.close();
    // Deleting the visitor takes both of its sessions down (azzurra, from the
    // login's autoconnect, and azzurra2, from the invite).
    await reapVisitors(admin.token, visitorId);
  }
});
