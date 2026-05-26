// CP13 S5 — /msg to nonexistent nick: 401 lands in the query window live.
//
// Split out from cp13-server-window-cluster-ux.spec.ts 2026-05-26 (spec-audit-r5):
// the parent CP13 cluster spec was bundling 5 unrelated tests in 218
// lines. S5 is a substantive multi-system trip (compose → upstream →
// 401 → NumericRouter → EventRouter → query-window WS pipeline) that
// deserves an isolated file for failure-readability.
//
// Caveat S5 (orchestrator): `/whois nonexistent` should land the 401
// in the queried nick's query window. Cicchetto's /whois isn't wired
// as a client-side command yet, so the equivalent observable trip is
// `/msg <ghost> hi`: cic opens the query window client-side (compose.ts
// /msg handler), sends the PRIVMSG, the server responds with 401 (no
// such nick), NumericRouter resolves to {:query, ghost}, EventRouter
// persists a :notice row on channel=ghost, and the existing per-(slug,
// nick) WS subscription delivers it live to the open query window.
// This spec confirms the loop closes without needing a server-side
// `query_window_opened` push event for first-contact numerics.
//
// Belt-and-suspenders invariants: a 401 NOTICE in response to the
// operator's own /msg must NOT inflate the in-pane unread-marker
// NOR the sidebar unread badge for the query window — both
// regressions share one predicate (lib/operatorActionEcho.ts).

import { test, expect } from "../fixtures/test";
import {
  composeTextarea,
  loginAs,
  selectChannel,
  sidebarMessageBadge,
} from "../fixtures/cicchettoPage";
import { getSeededVjt, NETWORK_SLUG } from "../fixtures/seedData";

const TEST_CHANNEL = "#bofh";

test("CP13 S5 — /msg to nonexistent nick: 401 lands in the query window live", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, TEST_CHANNEL);

  // Pick a nick guaranteed to not exist on the testnet.
  const ghostNick = `ghost-${Date.now().toString(36)}`;

  // Type /msg <ghost> hi via the compose box. compose.ts's /msg
  // handler opens a query window client-side AND switches focus to
  // it AND sends the PRIVMSG upstream. Server tries to deliver, gets
  // 401 ERR_NOSUCHNICK back, NumericRouter resolves to {:query, nick},
  // EventRouter persists a :notice row on channel=nick. The query
  // window's WS subscription (already live since the client-side
  // open) delivers the row.
  //
  // Use composeTextarea + raw fill so we don't depend on
  // composeSend's "textarea empties on success" wait — /msg's outbound
  // PRIVMSG path resolves immediately client-side and clears the
  // draft, but the timing is dependent on the WS join completing
  // for the new query window. Driving keys directly + asserting the
  // notice DOM row decouples the two waits.
  const ta = composeTextarea(page);
  await ta.fill(`/msg ${ghostNick} hi`);
  await ta.press("Enter");

  // After /msg, focus switches to the query window. The 401 :notice
  // row should appear in the scrollback within a few seconds. Wider
  // timeout because the round-trip is grappa→bahamut→401→grappa→
  // persist→broadcast→cicchetto, and the WS subscription on the
  // newly-opened query topic has to settle first.
  await expect(
    page.locator(".scrollback-pane .scrollback-notice-error"),
  ).toHaveCount(1, { timeout: 15_000 });

  // The 401 NOTICE is server feedback to the operator's own /msg —
  // it must NOT inflate the in-pane unread-marker NOR the sidebar
  // unread badge for the query window. Pre-fix, the marker rendered
  // between the operator's outbound PRIVMSG and the 401 reply with
  // "1 unread message" pinned above the 401 line; the badge fix in
  // subscribe.ts and the marker fix in ScrollbackPane.tsx share one
  // predicate (lib/operatorActionEcho.ts).
  await expect(page.locator('[data-testid="unread-marker"]')).toHaveCount(0);
  await expect(sidebarMessageBadge(page, NETWORK_SLUG, ghostNick)).toHaveCount(0);
});
