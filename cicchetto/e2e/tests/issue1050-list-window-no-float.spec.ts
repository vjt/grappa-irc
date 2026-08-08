// @webkit — #1050. On the mobile /list window the floating ☰ sat on top of the
// directory pane's own close ✕, and the ☰ won: the tap that should leave the
// directory opened the rail instead.
//
// Two independent controls, one corner. `.directory-close` is the LAST child of
// `.directory-pane-header` (#125), so it lands top-right in normal flow; since
// #985 `.shell-chrome` is a zero-height row whose lone ☰ overflows into that
// same corner at `z-index: 41`. #1039 is what brought them together — it
// retargeted the float's margin onto the topic bar's `--pane-chrome-inset-*`
// tokens, moving the glyph off the very corner and straight onto the ✕. The
// admin window paid this first and was given an inline mount in its own header;
// the owner's call for the directory is the opposite one, that this window does
// not want the rail at all, so the whole row goes.
//
// WHY A NEW SPEC. Nothing existing covers it: all seven specs that assert
// `shell-chrome-rail-opener` (issue1039-hamburger-corner,
// issue71-inc2-mobile-rail-openers, issue985-mobile-floating-opener,
// ux-4-z-cluster-journey, ux-5-a-hamburger-dedupe, ux-5-bm-mobile-hamburger,
// ux-5-bt-narrow-chrome-compression) run on a channel, query, home or admin
// window. The suppression therefore breaks no assertion — and without this one
// it would come back unnoticed.
//
// WHY THE OUTCOME IS "THE ✕ CLOSES", not "the ✕ is visible. Visibility is
// exactly what the bug already satisfied: the float painted OVER a perfectly
// visible button. Only the click distinguishes the two.
//
// Mobile-only shape — `ShellChrome` has a single mount, inside Shell's
// `isMobile()` branch — so this runs on webkit-iphone-15 alone via @webkit; the
// chromium project grepInverts the tag.
//
// Parity per `feedback_e2e_user_class_parity_matrix`: a UI shape contract, no
// subject-shaped branch. The registered seed suffices.

import { loginAs, openRailMenu, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// ONE oracle, read by BOTH the barrier and the probe. They ask the same
// question about the same corner at two different instants, and the whole
// #1050 CI archaeology turned on comparing their answers — so they must not be
// two hand-rolled readings that can drift apart.
//
// Runs inside the page: passed to `evaluate`, never called from node, so it
// may close over nothing. Everything it can cheaply see about the corner goes
// in, because the expensive half of a red here is not the failure, it is not
// knowing which of paint, hit-test and layout disagreed at that instant.
function inspectCorner(el: Element) {
  const describe = (n: Element) =>
    `${n.tagName.toLowerCase()}${[...n.classList].map((c) => `.${c}`).join("")}` +
    (n.getAttribute("data-testid") ? `[${n.getAttribute("data-testid")}]` : "");
  const drawer = document.querySelector(".shell-members");
  const r = el.getBoundingClientRect();
  const x = r.x + r.width / 2;
  const y = r.y + r.height / 2;
  const stack = document.elementsFromPoint(x, y);
  const top = stack.length === 0 ? null : stack[0];
  const nAnim = drawer === null ? 0 : drawer.getAnimations().length;
  return {
    t: Math.round(performance.now()),
    hit: top !== null && (top === el || el.contains(top)),
    inViewport: x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight,
    clear: drawer === null || (nAnim === 0 && stack.length > 0 && !stack.includes(drawer)),
    point: [Math.round(x), Math.round(y)],
    viewport: [window.innerWidth, window.innerHeight],
    rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
    nMembers: document.querySelectorAll(".shell-members").length,
    nAnim,
    drawerLeft: drawer === null ? null : Math.round(drawer.getBoundingClientRect().left),
    drawerTransform: drawer === null ? null : getComputedStyle(drawer).transform,
    stack: stack.slice(0, 6).map(describe),
  };
}

type CornerReading = ReturnType<typeof inspectCorner>;

// SELF-REPORTING, ON GREEN TOO. The one red this spec has produced in CI cost
// a full reconstruction from the trace's screencast — barrier release instant
// against painted drawer edge, fitted to the transition curve — to establish
// something the barrier itself could simply have said: how many times it
// polled, and what it saw each time. It polled ONCE and released 48ms before
// the probe, with the drawer still ~59px over the point. None of that is in
// any artifact; all of it was in the barrier's own hands.
//
// So every reading is printed unconditionally. It costs nothing while the spec
// passes and it turns the next red from archaeology into a read. Two exits and
// a `finally`, mirroring `issue988-rail-menu-first-row`: node-side
// `console.log` (the `list` reporter prints stdout from PASSING tests, which
// is the run whose numbers matter most here) plus a `testInfo.attach`, which
// survives into the HTML report instead of being interleaved with the rest of
// the suite. From a `finally`, so a barrier that times out still reports the
// samples that led there.
async function reportCorner(
  testInfo: import("@playwright/test").TestInfo,
  label: string,
  readings: CornerReading[],
): Promise<void> {
  if (readings.length === 0) return;
  for (const r of readings) console.log(`#1050 ${label} ${JSON.stringify(r)}`);
  await testInfo.attach(`issue1050-corner-${label}`, {
    body: JSON.stringify(readings, null, 2),
    contentType: "application/json",
  });
}

test.setTimeout(90_000);

test("@webkit #1050 — the /list window drops the floating ☰, and its ✕ actually closes the directory", async ({
  page,
}, testInfo) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // Reach the directory the way a phone does: the rail's rooms button. This
  // also proves the rail is still reachable from the window we START on — the
  // suppression is scoped to `list`, not a general retreat from bucket L.
  await openRailMenu(page);
  await page.getByTestId("mobile-panel-list").tap();

  const pane = page.locator(".directory-pane");
  await expect(pane).toBeVisible({ timeout: 15_000 });

  // THE SUPPRESSION. Whole row, not a hidden glyph: a `display: none` on the
  // button would leave `.shell-chrome` in the tree carrying its `z-index: 41`
  // and its zero-height box over the pane header, so the row's ABSENCE is the
  // thing worth asserting.
  await expect(page.getByTestId("shell-chrome")).toHaveCount(0);
  await expect(page.getByTestId("shell-chrome-rail-opener")).toHaveCount(0);
  await expect(page.locator(".shell-chrome")).toHaveCount(0);

  // THE MECHANISM, measured rather than argued: the element under the finger at
  // the ✕'s own centre IS the ✕. Pre-fix this resolved to the floated ☰.
  //
  // The probe returns the whole hit stack, not a bare boolean, and it is
  // reported whatever the outcome. The first red here was unreadable: a lone
  // `false` says a layer won the corner but never names it, and the artifacts
  // do not settle it either — `elementFromPoint` returns null for a point
  // outside the viewport, so "covered by an invisible layer" and "pushed
  // off-screen" produce the identical failure. `elementsFromPoint` names every
  // layer in the stack, including transparent ones, so the NEXT red diagnoses
  // itself instead of costing another CI round.
  const closeBtn = pane.locator(".directory-close");
  await expect(closeBtn).toBeVisible();

  // BARRIER, and the reason the first run of this spec was red. We reached
  // /list through the rail, so `openRailMenu` opened the members drawer;
  // `openListPanel` closes it (the #291/#361 nav mutex), but `.shell-members`
  // on mobile is `position: fixed; right: 0; z-index: 90` with
  // `transform: translateX(100%)` and `transition: transform 200ms ease-out`.
  // Closing is therefore a 200ms SLIDE, and for the first tens of ms the
  // drawer still covers the pane's top-right corner — the exact point tested
  // below — at a z-index above everything in the pane. The three `toHaveCount`
  // assertions above are already satisfied when they run, so they cost almost
  // nothing and the probe landed inside the slide: the drawer won
  // `elementFromPoint`, honestly, and the spec read it as a float that had not
  // been suppressed.
  //
  // Nothing about the assertion is relaxed to fix that — the drawer covering
  // the corner mid-animation is the animation WORKING, and it is not the state
  // #1050 is about. What was missing is the pre-state, so it is established
  // here, and NOT slept for 200ms: the barrier does not hardcode the
  // transition and cannot rot if the duration changes.
  //
  // THE BARRIER POLLS THE HIT STACK, and the first version of it polled
  // `getBoundingClientRect` instead — which in webkit is a LIE mid-slide.
  // Measured on the two identical reds of main `346f7c62` (trace.zip, ms on
  // the trace clock): the rect barrier answered true at `1302140`, the probe
  // 17ms later at `1302157` found `aside.shell-members` on top, and the
  // screencast frames bracketing both (`1302132`, `1302174`) show the drawer
  // PAINTED at `left≈325` then `left≈378` — still over a ✕ that lives at
  // `[350..379]`. During an accelerated `transform` transition webkit can
  // already report the FINAL rect from `getBoundingClientRect` while paint and
  // `elementFromPoint` are still using the interpolated one. Two oracles, one
  // instant, opposite answers.
  //
  // ⚠️ IF YOU RE-MEASURE THOSE FRAMES: the trace's own metadata LIES about
  // their size. `0-trace.trace` declares the screencast at `1179x1977` while
  // the JPEGs on disk are `391x657` — a factor of 3, the device pixel ratio,
  // applied in the wrong direction. Reading the frames at the declared size
  // yields the OPPOSITE conclusion about where the drawer edge was, which is
  // exactly the wrong turn taken once already while diagnosing this. Check with
  // `sips -g pixelWidth <frame>.jpeg` before converting a pixel to a CSS px.
  //
  // So the barrier now asks the SAME oracle the assertion below asks. It waits
  // ONLY for the drawer to leave the ✕'s hit stack — deliberately not for the
  // ✕ to win it, which would fold the #1050 regression itself into a barrier
  // timeout and cost the diagnostic stack dump that the probe prints.
  //
  // This is NOT webkit-specific, despite only webkit having reported it: the
  // chromium project `grepInvert`s `@webkit`, so chromium has never run this
  // spec. The race is in the flow, not the engine.
  //
  // TWO THINGS THE HIT-STACK BARRIER STILL GOT WRONG, both fixed below and both
  // established by reading, not by a red this closes.
  //
  // ONE — the release condition was INSTANTANEOUS where a barrier must be
  // DURABLE. "the drawer is not under this point right now" is a property of a
  // LIVE animation: instrumenting the barrier locally, it holds ~5–15ms before
  // the slide ends (`getAnimations().length === 1`, drawer left at 377..389
  // against a final 393) in 9 runs out of 10. The assertion then samples at
  // some LATER, unbounded instant — 4–15ms locally, 48ms in the CI trace. A
  // barrier that samples a moving target and hopes is a coin flip by design, no
  // matter which engine internal decides the toss. So it now also requires the
  // transition to be FINISHED: `getAnimations().length === 0`. That is the
  // durable pre-state; "momentarily off the point" never was one.
  //
  // TWO — an EMPTY hit stack was read as "clear". `elementsFromPoint` returns
  // an empty list for a point outside the viewport, which is precisely the
  // conflation the probe below was rewritten to eliminate, quietly reintroduced
  // one block earlier: a ✕ pushed off-screen would release the barrier
  // instantly. An empty stack is now NOT free — it is a state to keep waiting
  // through, and the probe's own `inViewport` assertion stays the one that
  // names it.
  //
  // Neither relaxes anything, and neither can mask the #1050 regression: the
  // float is `.shell-chrome`, a DIFFERENT element, never consulted here; and if
  // the drawer genuinely failed to leave, the hit-stack half would still fail.
  await expect(page.locator(".shell-members.open")).toHaveCount(0);
  const barrierReadings: CornerReading[] = [];
  try {
    await expect
      .poll(
        async () => {
          const reading = await closeBtn.evaluate(inspectCorner);
          barrierReadings.push(reading);
          return reading.clear;
        },
        { timeout: 10_000, message: "#1050 — the rail drawer never left the ✕'s hit stack" },
      )
      .toBe(true);
  } finally {
    await reportCorner(testInfo, "barrier", barrierReadings);
  }

  const probe = await closeBtn.evaluate(inspectCorner);
  await reportCorner(testInfo, "probe", [probe]);

  // Split from the hit test on purpose. A ✕ pushed off-screen fails the hit
  // test too, for a reason that has nothing to do with anything painting over
  // it — and #1050 is about the corner collision, not about layout drift. Two
  // assertions, so the failure says which of the two happened.
  expect(
    probe.inViewport,
    `#1050 — the directory's ✕ must be inside the viewport. ${JSON.stringify(probe)}`,
  ).toBe(true);
  expect(
    probe.hit,
    `#1050 — nothing may paint over the directory's close ✕. ${JSON.stringify(probe)}`,
  ).toBe(true);

  // THE OUTCOME. Not "the ✕ is visible" — the bug satisfied that. The tap has
  // to LEAVE the directory. Playwright's hit-target check would already fail
  // here if something intercepted the pointer, and the pane going away is the
  // user-visible half.
  await closeBtn.tap();
  await expect(pane).toHaveCount(0, { timeout: 10_000 });

  // …and #125's contract holds: closing restores the previous window rather
  // than dropping the operator on a blank pane. Back on a channel, the ☰ is
  // hosted in the TopicBar again, which is also the proof that the row's
  // absence above was scoped to `list` and not a global regression.
  await expect(page.locator(".topic-bar")).toHaveCount(1, { timeout: 10_000 });
});
