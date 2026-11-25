// issue 2738 — a push the server never answers must not lock the composer.
//
// The defect: 26 of cic's 30 promise-returning push helpers had no `timeout`
// arm, and phoenix.js ends an unanswered push ONLY by firing that hook. The
// helper's promise never settled, compose.ts awaited it at the head of the
// #904 outbox, and the window's composer stayed busy until a reload: the next
// Enter parked, the one after was refused, and the textarea went readOnly.
//
// What makes "no answer" happen here: `routeWebSocket` proxies the real
// socket and SWALLOWS every client frame whose event is `raw` — the shape of
// a half-open link or a stalled channel process. Everything else (the joins,
// the heartbeats, every server push) passes verbatim, so the rest of the app
// runs for real. `/quote` is the verb because `raw` carries nothing else.
//
// The wait is real time: the deadline is cic's REPLY_DEADLINE_MS (20 s,
// lib/transportFailure.ts), sized above the server's own longest bounded
// wait, and a fake clock would put phoenix's heartbeat and reconnect timers
// under test too.

import { composeSend, composeTextarea, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

test.setTimeout(90_000);

const CHANNEL = AUTOJOIN_CHANNELS[0];

test("issue 2738 — a /quote the server never answers hands the line back at the deadline and the composer works again", async ({
  page,
}) => {
  const swallowed: string[] = [];
  await page.routeWebSocket(/\/socket\/websocket/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      if (typeof message === "string") {
        try {
          // Phoenix v2 JSON frame: [join_ref, ref, topic, event, payload].
          const frame: unknown = JSON.parse(message);
          if (Array.isArray(frame) && frame[3] === "raw") {
            swallowed.push(message);
            return;
          }
        } catch {
          // Not a JSON frame — forward it like everything else.
        }
      }
      server.send(message);
    });
    server.onMessage((message) => ws.send(message));
  });

  await loginAs(page, specUser());
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

  // NOT composeSend: it waits for the pump to go idle, which is exactly what
  // the defect prevented.
  const ta = composeTextarea(page);
  await ta.fill("/quote VERSION");
  await ta.press("Enter");
  // The frame really left the page and died in the route: "sent, unanswered".
  await expect.poll(() => swallowed.length).toBe(1);

  // At the deadline the push rejects NoReply. The copy leaves the outcome open
  // and the line comes back for the operator to judge (vjt's D2).
  const banner = page.locator(".compose-box-error[role='alert']");
  await expect(banner).toHaveText(/may still have gone through/i, { timeout: 30_000 });
  await expect(ta).toHaveValue("/quote VERSION");
  await expect(ta).not.toHaveAttribute("readonly");

  // And the composer is the operator's again: a plain line goes out and lands.
  const line = `issue 2738 composer free ${Date.now()}`;
  await composeSend(page, line);
  await expect(page.getByTestId("scrollback")).toContainText(line);
});
