// #666 — a multi-line paste that outruns the server's send-door throttle must
// NOT lose the lines past the 429, and must NOT leave the whole body in the
// composer (which duplicates the delivered lines on resend). The fix makes the
// fan-out (compose.ts sendBodyLines) resumable + self-pacing: a send-door 429
// PAUSES on the server's `retry-after` and retries the SAME (refused, never-
// delivered) line, draining the whole paste over time; the draft holds ONLY the
// unsent remainder throughout and empties once every line is out. No line is
// dropped; the refused line is delivered exactly once (no dup).
//
// The dev/e2e stack runs the send throttle effectively OFF (config/dev.exs:
// capacity 1000, refill 1000/s) so a plain paste can't trip it here — so this
// spec SIMULATES the throttle at cic's fetch boundary: one middle line is
// refused ONCE with a real 429 + `retry-after` header (exactly what
// messages_controller/#666 now emits), then admitted on retry; every other POST
// passes to the LIVE server so its WS echo renders the row. That drives the
// CLIENT's resumable/paced path against a real 429 frame end to end — the flow
// jsdom can't observe (no live WS echo, no real retry-after round-trip). The
// unit matrix (compose.test.ts) pins the residue mechanics; this pins the live
// wire outcome (per feedback_cicchetto_browser_smoke).
//
// The stub answers inside the page (`answerFetchInPage`), not on `page.route`:
// in CI on main 75fcd75bb and on PR #2460 all eight lines reached the server
// and none reached the route, so nothing was refused. Why the route missed them
// is not established; the fixture's header has what was measured.
//
// Safe on the shared vjt: the send-door 429 does NOT feed the coarse #630 sever
// ladder (only RequestBudget.check does), and 9 POSTs are nowhere near the dev
// coarse capacity (200), so nothing severs vjt's bearer.

import { composeTextarea, loginAs, scrollbackLine, selectChannel } from "../fixtures/cicchettoPage";
import { answerFetchInPage } from "../fixtures/fetchInPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// POST /networks/{slug}/channels/{channel}/messages; the GET pagination
// variant carries `?before=`/`?after=` and is let through by the method.
const SEND_POST_RE = /\/channels\/[^/]+\/messages(\?|$)/;

test.setTimeout(60_000);

test("#666 — a throttled multi-line paste auto-paces: no drop, no dup, composer drains", async ({
  page,
}) => {
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");

  // Unique per run so prior runs' persisted rows don't satisfy the assertions.
  const tag = crypto.randomUUID().slice(0, 8);
  const lines = Array.from({ length: 8 }, (_, i) => `pr ${tag} L${i + 1}`);
  const refusedLine = lines[3]; // the 4th line — refused ONCE, then admitted.
  if (refusedLine === undefined) throw new Error("lines[3] missing");

  // Simulate the send door: refuse the 4th line ONCE with a real 429 +
  // retry-after (2s), then admit on retry; every other POST (and the 4th's
  // retry) passes to the LIVE server so it persists + broadcasts the WS echo.
  // Installed before the login: the wrapper rides in on the page's first load.
  let refused = false;
  await answerFetchInPage(page, { url: SEND_POST_RE, method: "POST" }, ({ body }) => {
    const parsed = JSON.parse(body ?? "{}") as { body?: string };
    if (parsed.body !== refusedLine || refused) return undefined;
    refused = true;
    return {
      status: 429,
      headers: { "retry-after": "2", "content-type": "application/json" },
      body: JSON.stringify({ error: "rate_limited" }),
    };
  });

  const vjt = specUser();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

  // Paste the whole block + submit.
  const ta = composeTextarea(page);
  await ta.fill(lines.join("\n"));
  await ta.press("Enter");

  // While paused on the 429, the composer holds ONLY the unsent residue — it
  // now STARTS at the refused line, proving the delivered lines are gone (the
  // pre-#666 bug left the WHOLE body, starting at L1, which duplicated on
  // resend). The `^…L4` anchor fails against a whole-body draft.
  await expect(ta).toHaveValue(new RegExp(`^pr ${tag} L4`), { timeout: 10_000 });

  // Every line eventually arrives — the refused one was PACED + retried, not
  // dropped. (Playwright polls each assertion, so the ~2s pace is absorbed.)
  for (const l of lines) {
    await expect(scrollbackLine(page, "privmsg", l)).toBeVisible({ timeout: 20_000 });
  }

  // The refused line was delivered EXACTLY once (refused → never delivered →
  // delivered on retry) — no duplicate from a whole-body resend.
  await expect(scrollbackLine(page, "privmsg", refusedLine)).toHaveCount(1);

  // The composer drained to empty: the residue was tracked + consumed, never
  // left holding the whole body (the resend-duplicates bug).
  await expect(ta).toHaveValue("", { timeout: 20_000 });

  // Sanity: the throttle actually fired (guards against the stub missing).
  expect(refused).toBe(true);
});
