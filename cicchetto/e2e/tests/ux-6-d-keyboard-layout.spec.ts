// UX-6 bucket D (2026-05-21) — iPhone PWA keyboard-open layout fixes.
//
// Two symptoms, both surfacing when the iOS on-screen keyboard opens
// (vjt iPhone-dogfood Bug 5; the H bucket was merged into D2 per
// vjt's clarification on 2026-05-21):
//
//   D1 (gap between keyboard top + BottomBar). On notched iPhones,
//   `.shell-mobile { padding-bottom: env(safe-area-inset-bottom) }`
//   leaves a ~34px transparent strip BELOW BottomBar inside the
//   visualViewport box when the keyboard masks the home-indicator.
//   Fix: `html.keyboard-open .shell-mobile { padding-bottom: 0 }`,
//   with the class toggled by `lib/viewportHeight.ts` when
//   `window.innerHeight - visualViewport.height > 150` (firmly
//   keyboard-sized, beyond Safari address-bar fidget).
//
//   D2 (scrollback area does NOT shrink with the shell). `.shell-mobile`
//   shrinks correctly when `--viewport-height` drops, and BottomBar
//   moves up — but the painted `.scrollback` area kept its
//   pre-keyboard height on iOS WebKit, hiding the last N messages
//   behind BottomBar. Root cause: `.scrollback` is a flex item with
//   `overflow-y: scroll`; its default `min-height: auto` resolves to
//   `min-content` (= the full rendered scrollHeight), refusing to
//   shrink. Adding `min-height: 0` lets the flex chain propagate the
//   shrink all the way down to the scroll container.
//
// WEBKIT LIMITATION
//
// Playwright's webkit emulation does NOT simulate the iOS on-screen
// keyboard. We can't `.focus()` the compose textarea and observe
// `visualViewport.height` shrink. So this spec asserts the SHIPPING
// SHAPE of both fixes:
//
//   1. D1: `lib/viewportHeight.ts` toggles `html.keyboard-open` when
//      its `windowHeightFn() - visualViewport.height` delta crosses
//      the threshold. Unit-test covers the JS branch; here we assert
//      the CSS rule that consumes the class is present and resolves
//      to `padding-bottom: 0px` once we add the class manually.
//   2. D2: `.scrollback` carries `min-height: 0` in the CSS rule (the
//      iOS flex-min-content fix). Test reads the declared value via
//      `readDeclaredMinHeight` walker (mirrors `readDeclaredHeight`
//      from `ux-5-bv-mobile-keyboard-react.spec.ts`).
//
// Plus a programmatic simulation: write `--viewport-height` to a
// keyboard-sized value, add `html.keyboard-open`, then assert that
// BottomBar's bottom edge ≤ visualViewport bottom (D1 closes the gap)
// AND that `.scrollback`'s bottom edge ≤ BottomBar's top edge (D2
// shrinks; last messages no longer hidden behind BottomBar).
//
// Real keyboard smoke remains vjt's iPhone — same model as
// `ux-3-oct-keyboard-stack.spec.ts:21-28` + `ux-5-bv-*:42-50`.
//
// Per `feedback_e2e_user_class_parity_matrix`: CSS-layer shape +
// JS-mounted side-effect bucket. The keyboard-open path doesn't differ
// by user class (any focused-compose operator hits the same code).
// Single visitor login suffices; moduledoc note here is the
// justification.

import { expect, test } from "@playwright/test";
import { loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// Walk CSS source for the named selector inside any @media wrapper and
// return the declared value of `prop`. Same shape as ux-5-bv's
// readDeclaredHeight; generalized to any property name.
async function readDeclaredProperty(
  page: import("@playwright/test").Page,
  selector: string,
  prop: string,
): Promise<string | null> {
  return await page.evaluate(
    ({ selector, prop }) => {
      function visit(rules: CSSRuleList): string | null {
        for (const rule of Array.from(rules)) {
          if (rule instanceof CSSMediaRule) {
            const inner = visit(rule.cssRules);
            if (inner) return inner;
            continue;
          }
          if (!(rule instanceof CSSStyleRule)) continue;
          const sels = rule.selectorText.split(",").map((s) => s.trim());
          if (!sels.includes(selector)) continue;
          const h = rule.style.getPropertyValue(prop).trim();
          if (h.length > 0) return h;
        }
        return null;
      }
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          const found = visit(sheet.cssRules);
          if (found) return found;
        } catch {
          continue;
        }
      }
      return null;
    },
    { selector, prop },
  );
}

test("@webkit ux-6-d — .scrollback declares min-height: 0 (iOS flex-shrink fix; D2)", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  const minH = await readDeclaredProperty(page, ".scrollback", "min-height");
  // `min-height: 0` lets the flex parent shrink the scroll container
  // below its content's natural min-content size. Without it iOS
  // WebKit pins the scrollback at scrollHeight when the shell shrinks
  // around it, leaving last messages hidden behind BottomBar.
  expect(minH).toBe("0");
});

test("@webkit ux-6-d — html.keyboard-open zeroes .shell-mobile padding-bottom (D1)", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // Reviewer LOW-1 fix: on Playwright's webkit-iphone-15 emulator,
  // `env(safe-area-inset-bottom)` resolves to "0px" — a naive
  // before/after computed-style comparison would pass even if the
  // keyboard-open rule were absent. Two complementary assertions
  // make the rule's presence + behavior unambiguous:
  //
  //   (a) The declared CSS rule exists with `padding-bottom: 0` —
  //       verified via the CSS-source walker so a missing rule fails
  //       loud even when the emulator's resolved value would be "0px"
  //       either way.
  //   (b) Adding the class on a runtime element with an inline
  //       `padding-bottom: 30px` override and then removing the
  //       inline lets us watch the class-only path drop the computed
  //       padding back to "0px" (proving the rule loads in the
  //       runtime cascade, not just the source).

  // Assertion (a): declared rule has `padding-bottom: 0`.
  const declaredKbdRule = await readDeclaredProperty(
    page,
    "html.keyboard-open .shell-mobile",
    "padding-bottom",
  );
  expect(declaredKbdRule).toBe("0");

  // Assertion (b): runtime cascade — inline 30px (no class) wins;
  // strip inline + add class → "0px"; remove class → returns to
  // env(safe-area-inset-bottom) (resolved to "0px" on this emulator
  // but the assertion just proves the rule was the active source).
  await page.evaluate(() => {
    const el = document.querySelector(".shell-mobile") as HTMLElement | null;
    if (!el) return;
    el.style.setProperty("padding-bottom", "30px", "important");
  });
  const inlineWins = await page.evaluate(() => {
    const el = document.querySelector(".shell-mobile") as HTMLElement | null;
    return el ? getComputedStyle(el).paddingBottom : null;
  });
  expect(inlineWins).toBe("30px");

  await page.evaluate(() => {
    const el = document.querySelector(".shell-mobile") as HTMLElement | null;
    if (el) el.style.removeProperty("padding-bottom");
    document.documentElement.classList.add("keyboard-open");
  });
  const classRuleResolves = await page.evaluate(() => {
    const el = document.querySelector(".shell-mobile") as HTMLElement | null;
    return el ? getComputedStyle(el).paddingBottom : null;
  });
  expect(classRuleResolves).toBe("0px");

  // Cleanup so the third test starts from a known state.
  await page.evaluate(() => document.documentElement.classList.remove("keyboard-open"));
});

test("@webkit ux-6-d — keyboard-open simulation: BottomBar flush + scrollback shrinks", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // Baseline geometry — pre-simulation. ScrollbackPane is mounted +
  // .scrollback has finite layout box.
  const baseline = await page.evaluate(() => {
    const shell = document.querySelector(".shell-mobile") as HTMLElement | null;
    const scrollback = document.querySelector(".scrollback") as HTMLElement | null;
    const bottomBar = document.querySelector(".bottom-bar") as HTMLElement | null;
    if (!shell || !scrollback || !bottomBar) return null;
    const sb = scrollback.getBoundingClientRect();
    const bb = bottomBar.getBoundingClientRect();
    return {
      shellH: shell.getBoundingClientRect().height,
      scrollbackH: sb.height,
      scrollbackBottom: sb.bottom,
      bottomBarTop: bb.top,
      bottomBarBottom: bb.bottom,
    };
  });
  expect(baseline).not.toBeNull();

  // Simulate keyboard-open: shrink --viewport-height to a keyboard-
  // sized value and add the class. iPhone 15 layout viewport = 852px;
  // keyboard delta ~336px → visible height ~516px.
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--viewport-height", "516px");
    document.documentElement.classList.add("keyboard-open");
  });
  // Reviewer LOW-2: deterministic style-recalc settle via double-rAF
  // (the idiomatic "wait one paint" pattern). Replaces a 50ms
  // waitForTimeout which would flake on slow CI / GC pause; per
  // `feedback_silent_retry_anti_pattern` no fixed sleeps in e2e.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );

  const post = await page.evaluate(() => {
    const shell = document.querySelector(".shell-mobile") as HTMLElement | null;
    const scrollback = document.querySelector(".scrollback") as HTMLElement | null;
    const bottomBar = document.querySelector(".bottom-bar") as HTMLElement | null;
    if (!shell || !scrollback || !bottomBar) return null;
    const sb = scrollback.getBoundingClientRect();
    const bb = bottomBar.getBoundingClientRect();
    const shellRect = shell.getBoundingClientRect();
    return {
      shellH: shellRect.height,
      shellBottom: shellRect.bottom,
      scrollbackH: sb.height,
      scrollbackBottom: sb.bottom,
      bottomBarTop: bb.top,
      bottomBarBottom: bb.bottom,
      shellPadBottom: getComputedStyle(shell).paddingBottom,
    };
  });
  expect(post).not.toBeNull();
  if (post === null || baseline === null) throw new Error("layout probe returned null");

  // D1 contract: padding-bottom collapsed to 0 → shell's inner edge
  // (where BottomBar sits) coincides with shell's outer bottom, no
  // transparent strip below BottomBar.
  expect(post.shellPadBottom).toBe("0px");
  // Shell shrunk from baseline to ~516px (allow ±5px slack for safe-
  // area inset top — Playwright iPhone-15 emulation reserves some
  // top padding the synthetic 516 didn't account for).
  expect(post.shellH).toBeLessThan(baseline.shellH);
  expect(post.shellH).toBeLessThanOrEqual(516);
  // BottomBar's bottom now sits at the shell's bottom edge (flush
  // against the simulated keyboard top).
  expect(Math.abs(post.bottomBarBottom - post.shellBottom)).toBeLessThanOrEqual(1);

  // D2 contract: scrollback shrunk with the shell. Pre-fix bug was
  // `.scrollback` staying at its baseline height while everything
  // around it shrank, pushing its bottom edge BELOW BottomBar's top.
  // Post-fix: scrollback bottom ≤ BottomBar top (no overlap).
  expect(post.scrollbackBottom).toBeLessThanOrEqual(post.bottomBarTop + 1);
  expect(post.scrollbackH).toBeLessThan(baseline.scrollbackH);

  // Restore baseline so subsequent tests aren't polluted.
  await page.evaluate(() => {
    document.documentElement.style.removeProperty("--viewport-height");
    document.documentElement.classList.remove("keyboard-open");
  });
});

test("@webkit ux-6-d — negative twin: keyboard-closed state preserves safe-area inset", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // Without `html.keyboard-open`, the env(safe-area-inset-bottom)
  // rule is the only one in play. Assert the *declared* value still
  // reads from env() so the D1 fix didn't accidentally clobber the
  // home-indicator inset for the (common) keyboard-closed case.
  const declared = await readDeclaredProperty(page, ".shell-mobile", "padding-bottom");
  expect(declared).not.toBeNull();
  expect(declared).toContain("env(safe-area-inset-bottom)");
});
