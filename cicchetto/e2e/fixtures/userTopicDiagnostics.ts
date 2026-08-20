// #1579 — what the user-topic barrier saw when it gave up.
//
// `waitForUserTopicReady` used to throw a bare
// `TimeoutError: page.waitForFunction: Timeout 5000ms exceeded`, which names
// the barrier and nothing else. That one line is compatible with at least four
// different failures, and telling them apart cost a full-suite re-read plus an
// iso-rerun every time it happened:
//
//   * the WS transport never opened, so no JOIN was ever pushed;
//   * the transport is open and the user-topic JOIN alone is unacknowledged;
//   * the stamp is present under a DIFFERENT name than the one awaited
//     (`socketUserName()` disagreeing with the seeded `SeededUser.name`),
//     which is a harness bug and not a race at all;
//   * the page went offline / hidden mid-boot.
//
// Measured on the 759-test suite (2026-08-20, 597 satisfied barriers): the
// healthy population sits at a median of 18 ms and a maximum of 848 ms, while
// the three misses were all the FIRST shape — `state: "connecting"` with a
// single connect attempt and no error, i.e. the server had not finished the
// WebSocket upgrade. Nothing about the budget could have told them apart, and
// nothing about the budget would have saved them; only the state at the
// deadline does. So the barrier keeps its 5 s and gains a voice.
//
// This is diagnosis, never recovery: the timeout still fails the test, at the
// same moment, for the same reason.

import type { Page } from "@playwright/test";

// Console output per page, captured through Playwright's own listener rather
// than by patching the page's `console` — the page under test must behave
// exactly as it does without the harness. `joinUser`/`joinChannel` log the
// phoenix-level "channel join failed" / "channel join timed out" shapes, which
// is the difference between "the socket never opened" and "the socket opened
// and the server refused the topic".
//
// A WeakMap so a closed page's buffer is collectable with the page.
const consoleByPage = new WeakMap<Page, string[]>();

// Cap: a spec that logs in a loop must not turn the buffer into the run's
// memory profile. The tail is what a post-mortem reads, so the cap drops from
// the FRONT.
const CONSOLE_CAP = 200;

// Start recording this page's console. Call before the first navigation —
// `loginAs`'s seeding door does, which covers every caller of the barrier.
export function watchPageConsole(page: Page): void {
  if (consoleByPage.has(page)) return;
  const buffer: string[] = [];
  consoleByPage.set(page, buffer);
  page.on("console", (message) => {
    buffer.push(`${message.type()}: ${message.text()}`);
    if (buffer.length > CONSOLE_CAP) buffer.shift();
  });
}

type Snapshot = {
  readyNames: string[];
  socketHealth: unknown;
  joinedTopicKeys: string[];
  onLine: boolean;
  visibility: string;
};

// One message naming every state that distinguishes the four failures above.
// Returns a string rather than throwing so the caller owns the error type, and
// swallows nothing: a page that can no longer be interrogated says so, because
// "the page was already gone" is itself one of the answers.
export async function describeUserTopicTimeout(
  page: Page,
  userName: string,
  budgetMs: number,
): Promise<string> {
  const head = `waitForUserTopicReady: '${userName}' was not stamped within ${budgetMs}ms`;
  let snapshot: Snapshot;
  try {
    snapshot = await page.evaluate((): Snapshot => {
      const w = window as unknown as {
        __cic_userTopicReady?: Set<string>;
        __cic_socketHealth?: { state: () => unknown };
        __cic_joinedTopicKeys?: () => string[];
      };
      return {
        readyNames: Array.from(w.__cic_userTopicReady ?? []),
        socketHealth: w.__cic_socketHealth?.state() ?? null,
        joinedTopicKeys: w.__cic_joinedTopicKeys?.() ?? [],
        onLine: navigator.onLine,
        visibility: document.visibilityState,
      };
    });
  } catch (err) {
    return `${head}, and the page could not be interrogated afterwards: ${
      err instanceof Error ? err.message : String(err)
    }`;
  }

  const consoleTail = consoleByPage.get(page);
  return [
    head,
    `  stamped names:     ${JSON.stringify(snapshot.readyNames)}`,
    `  socket health:     ${JSON.stringify(snapshot.socketHealth)}`,
    `  joined topic keys: ${JSON.stringify(snapshot.joinedTopicKeys)}`,
    `  navigator.onLine:  ${snapshot.onLine}   visibility: ${snapshot.visibility}`,
    consoleTail === undefined
      ? "  page console:      not recorded (watchPageConsole was never called for this page)"
      : `  page console (last ${Math.min(consoleTail.length, 12)} of ${consoleTail.length}):\n` +
        (consoleTail.length === 0
          ? "    (the page logged nothing)"
          : consoleTail
              .slice(-12)
              .map((line) => `    ${line}`)
              .join("\n")),
    // The reading a triager should reach for first, spelled out rather than
    // left to be re-derived. A socket that is still `connecting` on its first
    // attempt is not a client-side race: the server has not finished the
    // upgrade, and #1579 measured that as an 11-33 s SQLite write-lock stall
    // inside `UserSocket.connect/3`.
    '  If socket health reads state "connecting" with connectAttempts 1 and no',
    "  error, the WS upgrade never completed server-side — read the grappa",
    "  container log for `CONNECTED TO GrappaWeb.UserSocket in <N>ms`, not the",
    "  spec. See #1579.",
  ].join("\n");
}
