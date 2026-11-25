// issue 2719 — a join on a network with no session used to fail silently.
//
// An invite link (`?go=<network>/<channel>`) for a network the recipient has
// PARKED opened the #648 confirm, "Join #chan?". On a yes the POST answered 404
// `not_found` (no session process to serve it, folded by S14), `performJoin`
// sent the error to `console.warn`, and the screen did not change at all.
//
// The fix (the orch's ruling Q1, option A, consent first): the confirm names
// the reconnect, "<slug> is disconnected. Reconnect it and join <chan>?", and
// a yes runs `joinChannel`, which PATCHes the network to `connected` and only
// then POSTs the join. A cancel sends nothing, so the park stands.
//
// What is proven, in the browser, against the real stack:
//   E1. The question names the reconnect and nothing goes out before the yes.
//       After it, exactly ONE `PATCH /networks/<slug>` carrying
//       `connection_state: connected` and ONE `POST /networks/<slug>/channels`
//       went out, the network section is back in the sidebar (issue 1985 took
//       it out on the park), and the channel window is JOINED and selected,
//       with no modal and no error toast left on screen.
//   E2. A cancel sends neither request and the network stays parked.
//
// Mutants E1 turns red, and how each was established (one was run, one is the
// pre-fix bundle's own red, one is a reading):
//   * a verb that skips the reconnect — RUN in the browser: red where the
//     network section should come back (0 sections after 15 s), because the
//     POST alone opens nothing.
//   * a confirm that does not name the reconnect — EQUIVALENT to the red run on
//     the pre-fix bundle, where E1 and E2 both failed at the body assertion
//     (received `Join #i2719-…?`).
//   * a verb that reconnects and never joins — by READING, not run: the section
//     comes back, but the channel row's count-1 never holds and
//     `traffic.joins` stays 0.
//
// What this cannot prove is the stale-store gap: a store that still reads
// `connected` for a network the server has parked sends the POST alone and
// gets the S14 copy in a toast. That is issue 2725's, not this spec's.

import type { Page } from "@playwright/test";
import {
  confirmModal,
  confirmModalBody,
  confirmModalCancel,
  confirmModalYes,
  inviteUrl,
  loginAs,
  sidebarWindow,
} from "../fixtures/cicchettoPage";
import {
  partChannel,
  patchNetworkConnectionState,
  settleNetworkAutojoin,
} from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const SEED_CHANNEL = AUTOJOIN_CHANNELS[0];

// Lowercase: raw == ASCII-folded, so the sidebar key equals the spelling.
const freshChannel = () => `#i2719-${crypto.randomUUID().slice(0, 6)}`;

// Park + reconnect + autojoin settle, the cp15-b6 budget (see its header).
test.setTimeout(90_000);

let joinedChannel: string | null = null;

test.afterEach(async () => {
  // The testnet does not reset between specs: a network left parked breaks
  // every spec after this one. `settleNetworkAutojoin` reconnects it if the
  // spec did not, and waits for the seeded channel's NAMES.
  const user = specUser();
  await settleNetworkAutojoin(user.token, NETWORK_SLUG, SEED_CHANNEL, specNick());
  if (joinedChannel !== null) {
    // A JOIN persists into autojoin; the PART takes it back out. 404 (never
    // joined) is success here.
    await partChannel(user.token, NETWORK_SLUG, joinedChannel);
    joinedChannel = null;
  }
});

// The two requests the join verb can make, recorded from before the
// invite's navigation. Exact pathnames: `/networks/<slug>/channels/<chan>/…`
// sub-resources are other verbs.
function recordJoinTraffic(page: Page): { patches: unknown[]; joins: number } {
  const traffic = { patches: [] as unknown[], joins: 0 };
  page.on("request", (req) => {
    const path = new URL(req.url()).pathname;
    if (req.method() === "PATCH" && path === `/networks/${NETWORK_SLUG}`) {
      traffic.patches.push(JSON.parse(req.postData() ?? "null"));
    }
    if (req.method() === "POST" && path === `/networks/${NETWORK_SLUG}/channels`) {
      traffic.joins += 1;
    }
  });
  return traffic;
}

function networkSection(page: Page) {
  return page.locator(".sidebar-network-section", {
    has: page.locator(".sidebar-network-header", { hasText: NETWORK_SLUG }),
  });
}

// Signed in, then parked out-of-band, then the invite as a fresh navigation:
// the link is read once at boot, and this is how a recipient meets it.
async function parkThenOpenInvite(page: Page, channel: string) {
  const user = specUser();
  await loginAs(page, user);
  await expect(networkSection(page)).toHaveCount(1);

  await patchNetworkConnectionState(user.token, NETWORK_SLUG, {
    connection_state: "parked",
    reason: "issue 2719 park",
  });
  // issue 1985: a parked network leaves the sidebar.
  await expect(networkSection(page)).toHaveCount(0, { timeout: 10_000 });

  const traffic = recordJoinTraffic(page);
  await page.goto(inviteUrl(NETWORK_SLUG, channel));
  await page.waitForFunction(() => window.__cicInviteLinkApplied === true, null, {
    timeout: 15_000,
  });

  await expect(confirmModal(page)).toBeVisible({ timeout: 15_000 });
  await expect(confirmModalBody(page)).toHaveText(
    `${NETWORK_SLUG} is disconnected. Reconnect it and join ${channel}?`,
  );
  // Consent FIRST: nothing on the wire while the question is open.
  expect(traffic.patches).toEqual([]);
  expect(traffic.joins).toBe(0);
  return traffic;
}

test("issue 2719 — an invite to a parked network asks once, reconnects it, then joins", async ({
  page,
}) => {
  const channel = freshChannel();
  joinedChannel = channel;
  const traffic = await parkThenOpenInvite(page, channel);

  await confirmModalYes(page);

  // The network is back (issue 1985's other half).
  await expect(networkSection(page)).toHaveCount(1, { timeout: 15_000 });

  // Count-1 first, the issue2424 / cp15-b6 barrier: right after the click no
  // row exists, so the count-0 below would hold at once. Once a row has
  // existed, 0 on the pending intersection means it retired to joined.
  const row = sidebarWindow(page, NETWORK_SLUG, channel);
  await expect(row).toHaveCount(1, { timeout: 15_000 });
  await expect(row.and(page.locator("[data-window-state]"))).toHaveCount(0, { timeout: 15_000 });
  await expect(row).toHaveClass(/selected/, { timeout: 15_000 });

  expect(traffic.patches).toEqual([{ connection_state: "connected" }]);
  expect(traffic.joins).toBe(1);
  // Modals, not dialogs: the settings drawer is a non-modal `role="dialog"`
  // that is always mounted (issue 2703's spec measured it).
  await expect(page.locator('[role="dialog"][aria-modal="true"]')).toHaveCount(0);
  await expect(page.locator(".toast-error")).toHaveCount(0);
});

test("issue 2719 — cancelling the invite's question leaves the parked network parked", async ({
  page,
}) => {
  const traffic = await parkThenOpenInvite(page, freshChannel());

  await confirmModalCancel(page);
  await expect(confirmModal(page)).toHaveCount(0);

  // A wire barrier for the negative: a request the cancel had started would
  // be recorded before this round trip's own, so "none" is read after it
  // rather than in the same tick as the click.
  await page.evaluate(() => fetch("/api/config").then((r) => r.status));

  expect(traffic.patches).toEqual([]);
  expect(traffic.joins).toBe(0);
  await expect(networkSection(page)).toHaveCount(0);
});
