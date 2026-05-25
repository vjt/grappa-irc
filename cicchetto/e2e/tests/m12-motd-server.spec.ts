// M12 — MOTD numerics route to the synthetic $server window.
//
// Manual matrix: on bouncer connect to a real IRC server, the server
// emits RPL_MOTDSTART (375) / RPL_MOTD (372) / RPL_ENDOFMOTD (376) as
// part of the post-registration handshake. These would be dropped by
// the catch-all numeric handler if not routed; BUG2's fix in
// `Grappa.Session.EventRouter.route/2` persists each MOTD line into
// the synthetic `$server` channel as a `:notice` row so the
// server-messages window has content. The sender is the leaf's
// hostname (e.g. `bahamut-test`) when present, else the anonymous
// sender sentinel `*`.
//
// Cicchetto's Sidebar always renders the `$server` window slot
// (Sidebar.tsx:71 — "always present, not closeable"); selecting it
// loads scrollback from REST keyed on channel="$server", and the
// pane shows MOTD + future server NOTICEs. CP13 S9 added a compose
// box (slash-only) — the read-only constraint from BUG2d is reverted.
//
// Spec asserts:
//   - server-side: at least one :notice row persisted under $server
//     within the timeout (deterministic — bahamut always sends MOTD)
//   - cicchetto: clicking the Server window button focuses the pane,
//     scrollback contains a notice line, compose box IS PRESENT
//     (CP13 S9 — slash-only enforced inside compose.ts).

import { test, expect } from "../fixtures/test";
import {
  composeTextarea,
  loginAs,
  scrollbackLines,
} from "../fixtures/cicchettoPage";
import { assertMessagePersisted } from "../fixtures/grappaApi";
import { getSeededVjt, NETWORK_SLUG } from "../fixtures/seedData";

const SERVER_CHANNEL = "$server";

test("M12 — MOTD persists into $server channel + cicchetto Server window renders with compose box", async ({ page }) => {
  const vjt = getSeededVjt();

  // Server-side first door: at least one :notice row exists for the
  // synthetic $server channel. Bahamut sends MOTD as part of the
  // post-registration handshake, so this is deterministic.
  await assertMessagePersisted({
    token: vjt.token,
    networkSlug: NETWORK_SLUG,
    channel: SERVER_CHANNEL,
    sender: "leaf4.azzurra.chat",
    kind: "notice",
  });

  // Client-side: log in + click the network-header row (UX-4 bucket C
  // collapsed the per-network `<h3>` + separate "Server" `<li>` into a
  // single `<li class="sidebar-network-header">` that IS both the
  // network grouping label AND the server-window selector. The row's
  // visible text is `⚙️ <slug>`; selecting it dispatches
  // `selectedChannel.kind = "server"`.
  await loginAs(page, vjt);
  const serverEntry = page
    .locator(".sidebar-network-section")
    .filter({ has: page.locator(".sidebar-network-header").filter({ hasText: "bahamut-test" }) })
    .locator(".sidebar-network-header");
  await expect(serverEntry).toHaveCount(1);
  await serverEntry.locator(".sidebar-window-btn").click();

  // Scrollback has at least one rendered row (MOTD lines route via
  // :notice — count gives a kind-agnostic "any traffic" check).
  await expect(scrollbackLines(page).first()).toBeVisible({ timeout: 5_000 });

  // CP13 S9: ComposeBox now renders on the Server window — slash-only
  // enforced inside compose.ts, no read-only DOM-suppression.
  await expect(composeTextarea(page)).toHaveCount(1);
});
