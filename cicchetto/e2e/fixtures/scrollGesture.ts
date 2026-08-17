// #1336 — a scroll gesture that has actually LANDED before the test moves on.
//
// The idiom this replaces read like a gesture and was not one:
//
//     await expect.poll(async () => { await page.mouse.wheel(0, -4000);
//                                     return distanceToBottom(page) })
//       .toBeGreaterThan(50);
//
// Two independent defects, both measured on `issue168-scroll-authority`
// (2026-08-15, dev host):
//
//   * `page.mouse.wheel()` RESOLVES BEFORE THE SCROLL IS APPLIED. The probe
//     read `scrollTop=1078` immediately after the wheel — byte-identical to
//     the pre-gesture read — and the pane was still at 1078 when the poll
//     returned. On a sibling spec the injected wheel landed ~250 ms later,
//     i.e. inside whatever the test did next.
//   * THE PREDICATE WAS ALREADY TRUE. The pane sat 339 px from the bottom on
//     the cold-mount marker, so `> 50` held before the wheel; the poll exited
//     on its first evaluation and the assertion said "the operator paged up"
//     about a pane nobody had touched. A gate satisfied by the pre-existing
//     state is not a gate — the same shape as #1117's negative assertions
//     passing on an empty recorder.
//
// The consequence is not cosmetic. The scroll lands late, and if it lands
// after a send, `ScrollbackPane`'s `onScroll` reads the scrollTop DECREASE as
// the operator leaving the tail, disarms the follow intent, and the deferred
// tail-follow yields — the pane freezes wherever the late scroll left it, for
// good. That is the whole of #1080 / #1079: a frozen pane's distance-to-bottom
// is invariant under later content growth, which is why both reported the SAME
// number every time they tripped (1417 = a pane at scrollTop 0; 337 = a pane
// still on the marker).
//
// So the contract here is: hover, wheel, then wait for the pane to MOVE and
// then HOLD, and REJECT if it never did either. Rejecting on "never moved" is
// the positive control the old idiom lacked: while building this, an injected
// wheel was silently inert for an entire run because the mouse was not over
// the pane, and every assertion downstream still passed.
//
// Free of Playwright by construction (the caller adapts a Page to `ScrollPane`)
// for the reason `whoisWait.ts` gives: the instrument a claim is judged by has
// to be provable itself, and that means unit-testable without a testnet.

export type ScrollPane = {
  hover(): Promise<void>;
  wheel(deltaY: number): Promise<void>;
  scrollTop(): Promise<number>;
};

export type ScrollGestureOptions = {
  // Wheel delta, in the sign the DOM uses: NEGATIVE scrolls up.
  readonly deltaY: number;
  // Budget for the whole gesture — dispatch, travel and settle.
  readonly timeoutMs: number;
  // Gap between scrollTop samples.
  readonly pollMs: number;
};

export type ScrollGestureResult = {
  readonly from: number;
  readonly to: number;
};

export type ScrollRestOptions = {
  // Budget for the pane to stop moving.
  readonly timeoutMs: number;
  // Gap between scrollTop samples.
  readonly pollMs: number;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Wait for the pane to STOP, and report where it stopped. Rejects rather than
// resolving when it never held still, for the same reason `scrollByGesture`
// rejects: a caller about to assert on a position must not be handed one the
// pane is still leaving.
//
// This is the half of the gesture contract that has nothing to do with a
// wheel, and #1336 S2 is why it exists separately. `scroll-on-window-switch`
// parks on the unread marker through a PROGRAMMATIC activation and then sends,
// and its pre-send barrier was `distance-to-bottom > 50`. Recorded in-page,
// the switch writes scrollTop three times — `7` (the rows recreation resetting
// to the top), `1055` (the marker jump in flight), `1078` (the marker) — and
// the FIRST of those already satisfies `> 50` by a wide margin (distance 1408
// against a maxScroll of 1415). So the barrier could clear on the reset, with
// the marker jump still to come; the jump is a scrollTop DECREASE, `onScroll`
// reads a decrease as the operator leaving the tail, and a decrease landing
// after a send freezes the pane at the marker — 337 from the bottom, which is
// the number #1079 reported twice.
//
// A gate satisfied by a state that is not the one it names is not a gate. The
// distance test says "not at the bottom" while meaning "the switch has
// finished"; rest is the missing half, and unlike the distance it cannot be
// true of a pane mid-jump.
export async function waitForScrollRest(
  pane: Pick<ScrollPane, "scrollTop">,
  opts: ScrollRestOptions,
): Promise<number> {
  const { timeoutMs, pollMs } = opts;
  const read = (): Promise<number> => pane.scrollTop();
  const rest = await sampleUntilRest(read, await read(), false, timeoutMs, pollMs);

  if (rest.settled === null) {
    throw new Error(
      `waitForScrollRest: the pane never came to rest within ${timeoutMs}ms ` +
        `(last ${rest.last}) — it is still being written to`,
    );
  }
  return rest.settled;
}

type RestProbe = {
  readonly settled: number | null;
  readonly last: number;
  readonly moved: boolean;
};

// The one sampling loop both public waits are built from: read `scrollTop`
// until two ADJACENT reads agree.
//
// Adjacency is load-bearing. A pane that returns to a position it held a
// moment ago has not stopped — it has passed through twice — so comparing
// against anything other than the immediately preceding sample would call a
// round trip "rest".
//
// `requireMove` is the 20% the two callers do not share. A GESTURE has to
// displace the pane, so resting back on the baseline is a failure (the wheel
// was never delivered); a BARRIER only has to establish that nothing is being
// written any more, and a pane that was already still satisfies it.
async function sampleUntilRest(
  read: () => Promise<number>,
  baseline: number,
  requireMove: boolean,
  timeoutMs: number,
  pollMs: number,
): Promise<RestProbe> {
  const deadline = Date.now() + timeoutMs;
  let previous = baseline;
  let moved = false;

  while (Date.now() < deadline) {
    // The gap comes FIRST, so every pair being compared is `pollMs` apart.
    // Sleeping at the end of the body instead leaves the very first
    // comparison — baseline against the first sample — separated by nothing
    // but a round trip, and a pane read twice in the same millisecond reads
    // equal whatever it is doing. Measured: with the sleep at the end, this
    // barrier resolved instantly against a pane being written every 20ms,
    // which is precisely the "satisfied without the thing it claims" defect
    // the barrier exists to refuse. The unit fakes cannot see it — they have
    // no clock — so `movingPane` below supplies one.
    await sleep(pollMs);
    const current = await read();
    if (current !== baseline) moved = true;
    if (current === previous && (!requireMove || moved)) {
      return { settled: current, last: current, moved };
    }
    previous = current;
  }

  return { settled: null, last: previous, moved };
}

// Perform the gesture and resolve only once the pane has moved AND come to
// rest. Rejects rather than resolving on either failure, because "it did not
// move" and "it is still moving" are both the wrong thing to tell a caller who
// is about to assert on the position.
//
// SETTLED means two consecutive samples agree at a value different from where
// the pane started. A single post-movement sample is not enough: chromium
// delivers a wheel as an animation, so the first changed value is mid-flight
// and reporting it would name a position the pane is about to leave.
//
// A gesture the pane cannot honour (already clamped at the requested end) is a
// REJECT, not a silent success: the caller asked for a displacement, and
// "already there" does not establish the operator-intent the wheel stands for.
export async function scrollByGesture(
  pane: ScrollPane,
  opts: ScrollGestureOptions,
): Promise<ScrollGestureResult> {
  const { deltaY, timeoutMs, pollMs } = opts;
  const from = await pane.scrollTop();

  await pane.hover();
  await pane.wheel(deltaY);

  const rest = await sampleUntilRest(() => pane.scrollTop(), from, true, timeoutMs, pollMs);
  if (rest.settled !== null) return { from, to: rest.settled };

  throw new Error(
    rest.moved
      ? `scrollByGesture: wheel(${deltaY}) never settled within ${timeoutMs}ms ` +
          `(from ${from}, last ${rest.last}) — the pane was still moving when the budget ran out`
      : `scrollByGesture: wheel(${deltaY}) never moved the pane within ${timeoutMs}ms ` +
          `(scrollTop stayed ${from}) — the gesture was not delivered, or the pane is already clamped`,
  );
}
