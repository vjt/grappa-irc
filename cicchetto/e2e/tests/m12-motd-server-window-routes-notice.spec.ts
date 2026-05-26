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
  scrollbackLine,
} from "../fixtures/cicchettoPage";
import { GRAPPA_BASE_URL } from "../fixtures/grappaApi";
import { getSeededVjt, NETWORK_SLUG } from "../fixtures/seedData";

const SERVER_CHANNEL = "$server";

// Match the testnet's leaf hostnames — leaf4.azzurra.chat | leaf6.azzurra.chat
// (per cicchetto/e2e/infra/compose.yaml). Hub itself doesn't send MOTD to
// remote-server-bound clients; the leaf the bouncer attached to does.
const LEAF_SENDER_PATTERN = /^leaf[46]\.azzurra\.chat$/;

type WireMessage = {
  id: number;
  channel: string;
  kind: string;
  sender: string;
  body: string | null;
};

// Inline fetch-poll variant of assertMessagePersisted (audit 2026-05-26):
// the upstream fixture requires an exact `sender` string; we need to
// accept either leaf hostname so the spec doesn't depend on bahamut's
// autoconnect order. Same retry shape (100ms × 5s deadline).
async function assertMotdPersisted(token: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  const url = `${GRAPPA_BASE_URL}/networks/${encodeURIComponent(NETWORK_SLUG)}/channels/${encodeURIComponent(SERVER_CHANNEL)}/messages`;
  const headers = { Authorization: `Bearer ${token}` };
  let lastSeen: string[] = [];
  while (Date.now() < deadline) {
    const res = await fetch(url, { headers });
    if (res.ok) {
      const messages = (await res.json()) as WireMessage[];
      const matched = messages.find(
        (m) => m.kind === "notice" && LEAF_SENDER_PATTERN.test(m.sender),
      );
      if (matched) return;
      lastSeen = messages.map((m) => `${m.kind}/${m.sender}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `assertMotdPersisted: no kind=notice from leaf[46].azzurra.chat in $server scrollback within 5s; last seen: ${JSON.stringify(lastSeen)}`,
  );
}

test("M12 — MOTD persists into $server channel + cicchetto Server window renders with compose box", async ({ page }) => {
  const vjt = getSeededVjt();

  // Server-side first door: at least one :notice row exists for the
  // synthetic $server channel, sent by one of the testnet's leaves.
  // Bahamut sends MOTD as part of the post-registration handshake, so
  // this is deterministic; the leaf name (leaf4 vs leaf6) depends on
  // bahamut's autoconnect order at boot and must not be hardcoded.
  await assertMotdPersisted(vjt.token);

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

  // Scrollback has at least one :notice row (MOTD lines route as
  // notice). Strengthen vs the prior kind-agnostic first-line check
  // (audit 2026-05-26): pin kind=notice so a regression that routes
  // MOTD as e.g. :privmsg or drops the row entirely still fails the
  // spec, even if other unrelated $server traffic is present.
  const motdRow = scrollbackLine(page, "notice");
  await expect(motdRow.first()).toBeVisible({ timeout: 5_000 });

  // CP13 S9: ComposeBox now renders on the Server window — slash-only
  // enforced inside compose.ts, no read-only DOM-suppression.
  await expect(composeTextarea(page)).toHaveCount(1);
});
