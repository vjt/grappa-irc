// issue 2647 — the login backdrop drifts on the compositor.
//
// The backdrop's three drift layers used to animate `background-position`,
// which is painted rather than composited, so every frame repainted each
// layer on the renderer's main thread. The cure moves them with `transform`.
//
// WHAT ONLY THIS GATE CAN SEE. `loginMatrixCss.test.ts` reads the stylesheet
// SOURCE: jsdom ingests none of the theme, so it can hold the shape of the
// rules but not what an engine makes of them. Here the engine is asked
// directly, through the Web Animations API: which animations are running on
// the backdrop, and which properties their keyframes carry once the cascade
// has resolved. A rule that lost on specificity, a theme override, or a layer
// whose selector stopped matching all show up here and nowhere else.
//
// WHAT IT DOES NOT SEE: paint and CPU. "Only `transform` is animated" is the
// precondition for the compositor taking a layer over, not proof that it did,
// and a main-thread-busy threshold is not asserted on purpose. On a shared CI
// runner it is either loose enough to pass the regression or flaky. That
// measurement belongs to a one-off bench run, reported on the PR, not to a gate.
//
// WHY BOTH TAGS. The animated property set is a question about what an ENGINE
// resolves, so it is asked of two: `@webkit` runs on `webkit-iphone-15`,
// `@touch` on `chromium-pixel-touch`. A tagged spec does not also run on the
// desktop `chromium` project (its `grepInvert` is the complement of these two
// greps). Nothing is lost by that: `chromium-pixel-touch` is the same Blink as
// the desktop Chrome the defect was reported on.
//
// Parity matrix per `feedback_e2e_user_class_parity_matrix`: the login screen
// is what EVERY subject class sees before it has a subject, so no seeded user
// is involved. Bare `@playwright/test` import, like the other login-screen
// specs (issue204-foolproof-login.spec.ts).

import { expect, type Page, test } from "@playwright/test";

/** The four members of a computed keyframe that are not animated properties. */
const KEYFRAME_META = new Set(["offset", "computedOffset", "easing", "composite"]);

type BackdropMotion = {
  /** One entry per animation whose target sits inside `.login-matrix`. */
  readonly animations: readonly {
    readonly layer: string;
    readonly properties: readonly string[];
  }[];
  /** The three drift layers, as the engine computed them. */
  readonly layers: readonly {
    readonly layer: string;
    readonly present: boolean;
    readonly transform: string | null;
  }[];
};

/**
 * Everything the assertions below need, read in ONE evaluate so the animation
 * set and the layers describe the same instant.
 *
 * A pseudo-element's animation reports the ELEMENT as `effect.target` and the
 * pseudo-element in `effect.pseudoElement`, so `contains()` on the backdrop
 * collects the `::before`/`::after` layers as well as the child.
 */
async function readBackdrop(page: Page): Promise<BackdropMotion> {
  return await page.locator(".login-matrix").evaluate(
    (backdrop, meta) => {
      const skip = new Set(meta);
      const animations = document.getAnimations().flatMap((animation) => {
        const effect = animation.effect;
        if (!(effect instanceof KeyframeEffect) || effect.target === null) return [];
        if (!backdrop.contains(effect.target)) return [];
        const keys = effect.getKeyframes().flatMap((frame) => Object.keys(frame));
        const properties = [...new Set(keys)].filter((key) => !skip.has(key)).sort();
        const layer = `.${effect.target.getAttribute("class") ?? "?"}${effect.pseudoElement ?? ""}`;
        return [{ layer, properties }];
      });
      const mid = backdrop.querySelector(".login-matrix-mid");
      const pseudo = (which: "::before" | "::after") => {
        const style = getComputedStyle(backdrop, which);
        return {
          layer: `.login-matrix${which}`,
          // A pseudo-element without `content` is not generated at all.
          present: style.content !== "none" && style.content !== "normal",
          transform: style.transform,
        };
      };
      const layers = [
        pseudo("::before"),
        {
          layer: ".login-matrix-mid",
          present: mid !== null,
          transform: mid === null ? null : getComputedStyle(mid).transform,
        },
        pseudo("::after"),
      ];
      return { animations, layers };
    },
    [...KEYFRAME_META],
  );
}

/** The login screen, with the install splash suppressed as every login spec does. */
async function openLogin(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem("cic.installChoice", "browser");
  });
  await page.goto("/login");
  await expect(page.getByLabel(/nick or email/i)).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".login-matrix")).toBeAttached();
}

test("@webkit @touch issue 2647 — the backdrop's drift animates nothing but transform", async ({
  page,
}) => {
  // Stated, not inherited: under reduced motion there is nothing to census,
  // and every assertion below would pass on an empty set.
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openLogin(page);

  // Three layers, far / mid / near. Polled because CSS animations are created
  // at the first style resolution after mount, not at `goto`.
  await expect
    .poll(async () => (await readBackdrop(page)).animations.length, {
      timeout: 10_000,
      message: "the backdrop is not running exactly three drift animations",
    })
    .toBe(3);

  const { animations } = await readBackdrop(page);
  expect(
    animations,
    "a backdrop layer animates a property the compositor cannot take over",
  ).toEqual(animations.map((animation) => ({ ...animation, properties: ["transform"] })));
});

test("@webkit @touch issue 2647 — reduced motion stops all three layers where they rest", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openLogin(page);

  // The three layers are there and at rest: frozen, not removed.
  const frozen = await readBackdrop(page);
  expect(frozen.layers).toEqual([
    { layer: ".login-matrix::before", present: true, transform: "none" },
    { layer: ".login-matrix-mid", present: true, transform: "none" },
    { layer: ".login-matrix::after", present: true, transform: "none" },
  ]);
  expect(frozen.animations, "a backdrop layer still moves under reduced motion").toEqual([]);

  // ANTI-HOLLOW-GREEN. The empty set above means something only if the same
  // page starts moving the moment the preference is lifted. Otherwise it would
  // equally describe a backdrop that never animated at all.
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect
    .poll(async () => (await readBackdrop(page)).animations.length, {
      timeout: 10_000,
      message: "lifting reduced motion did not start the three drift animations",
    })
    .toBe(3);
});
