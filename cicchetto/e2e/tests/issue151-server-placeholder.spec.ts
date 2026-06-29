// #151 — the server/network window's ComposeBox placeholder leaked the
// INTERNAL window-name sentinel `$server`. `ComposeBox.tsx` rendered
// `placeholder={`message ${props.channelName}`}`, and for the server
// window `channelName` is `SERVER_WINDOW_NAME = "$server"` (windowKinds.ts) —
// a routing sentinel that must never surface in the UI. The operator saw
// the literal `message $server`.
//
// Fix: `composePlaceholder()` (lib/compose.ts) special-cases the sentinel,
// labelling the server window with its network slug (mirrors the Sidebar's
// `⚙️ <slug>` network-header row) and rejecting ANY `$`-prefixed sentinel.
//
// This e2e drives the visible outcome on the compose textarea:
//   1. operator focuses the $server window (the ⚙️ <slug> tab)
//   2. the textarea placeholder MUST equal the friendly production value
//      (`message <slug>`), built from the seed slug const, AND
//   3. the placeholder MUST NOT contain the `$server` sentinel.
// On the unfixed code the placeholder reads `message $server`, so the
// equality assertion goes RED — the bug reproduces before the fix.
//
// Per `feedback_ux_e2e_mandatory`: every cic UX-touching change ships with
// a Playwright e2e via scripts/integration.sh.

import { expect, test } from "../fixtures/test";
import { composeTextarea, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { getSeededVjt, NETWORK_SLUG } from "../fixtures/seedData";

test("#151 — server-window compose placeholder shows the network slug, not the $server sentinel", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  // Focus the always-present server window. `windowName === networkSlug`
  // resolves to the `$server` tab in sidebarWindow (both desktop + mobile).
  // awaitWsReady:false — the server window has no auto-join echo to wait on;
  // it's backed by NumericRouter scrollback, not a channel JOIN.
  await selectChannel(page, NETWORK_SLUG, NETWORK_SLUG, { awaitWsReady: false });

  const ta = composeTextarea(page);
  await expect(ta).toBeVisible();

  // Friendly production value, built from the seed slug const (NEVER a
  // hand-typed literal that could drift). RED on the unfixed
  // `message ${props.channelName}` which yields `message $server`.
  await expect(ta).toHaveAttribute("placeholder", `message ${NETWORK_SLUG}`);

  // Hard contract: no `$`-prefixed sentinel may surface on ANY compose window.
  const placeholder = await ta.getAttribute("placeholder");
  expect(placeholder).not.toContain("$server");
  expect(placeholder).not.toContain("$");
});
