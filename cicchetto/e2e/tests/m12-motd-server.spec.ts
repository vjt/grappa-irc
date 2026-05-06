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
// non-typable read-only pane shows MOTD + future server NOTICEs.
//
// Spec asserts:
//   - server-side: at least one :notice row persisted under $server
//     within the timeout (deterministic — bahamut always sends MOTD)
//   - cicchetto: clicking the Server window button focuses the pane,
//     scrollback contains a notice line, compose box is HIDDEN
//     (Shell.tsx — server windows are read-only per BUG2d fix).

import { test, expect } from "@playwright/test";
import {
  composeTextarea,
  loginAs,
  scrollbackLines,
} from "../fixtures/cicchettoPage";
import { assertMessagePersisted } from "../fixtures/grappaApi";
import { getSeededVjt, NETWORK_SLUG } from "../fixtures/seedData";

const SERVER_CHANNEL = "$server";

test("M12 — MOTD persists into $server channel + cicchetto Server window renders read-only", async ({ page }) => {
  const vjt = getSeededVjt();

  // Server-side first door: at least one :notice row exists for the
  // synthetic $server channel. Bahamut sends MOTD as part of the
  // post-registration handshake, so this is deterministic. We don't
  // pin sender (could be "bahamut-test" or "*") or body — any
  // notice row is sufficient evidence of routing.
  await assertMessagePersisted({
    token: vjt.token,
    networkSlug: NETWORK_SLUG,
    channel: SERVER_CHANNEL,
    // Per BUG2 fix-up, sender is `Message.sender_nick(msg)` — for
    // numerics with a server prefix this is the leaf hostname as the
    // server announces itself in the prefix (RPL_001 / numerics use the
    // server's self-declared name, NOT the docker DNS alias). Bahamut's
    // testnet leaf identifies as `leaf4.azzurra.chat` per its config
    // (see cicchetto/e2e/infra/bahamut/leaf-v4.conf — server name).
    sender: "leaf4.azzurra.chat",
    kind: "notice",
  });

  // Client-side: log in + click the Server window (always-present
  // sidebar slot). Sidebar.tsx renders the synthetic "$server" channel
  // with the visible label "Server" (literal channel name is hidden
  // from the user — `$server` is the wire identifier only). Locate
  // by the rendered label instead of the wire name.
  await loginAs(page, vjt);
  const serverEntry = page
    .locator(".sidebar-network")
    .filter({ has: page.locator("h3").filter({ hasText: "bahamut-test" }) })
    .locator("li")
    .filter({ has: page.locator(".sidebar-channel-name").filter({ hasText: /^Server$/ }) });
  await expect(serverEntry).toHaveCount(1);
  await serverEntry.locator(".sidebar-window-btn").click();

  // Scrollback has at least one rendered row (MOTD lines route via
  // :notice — count gives a kind-agnostic "any traffic" check).
  await expect(scrollbackLines(page).first()).toBeVisible({ timeout: 5_000 });

  // BUG2d invariant: the Server window is read-only — no compose
  // textarea (Shell.tsx Show-fallback gates the ComposeBox on
  // `sel().kind !== "server"`).
  await expect(composeTextarea(page)).toHaveCount(0);
});
