// Login Advanced-section reachability — the login card must SCROLL so its
// full content stays reachable when it exceeds a short viewport.
//
// ## The bug (measured on current code)
//
// `.login` was `display:flex; align-items:center; justify-content:center;
// min-height:100%; overflow:hidden`. Open the Advanced disclosure and the
// `.login-form` grows to ~643px; on a 480px viewport it overflows. But NO
// ancestor is a scroll container (`overflow:hidden` clips, nothing offers
// `auto`), so a real user wheel/touch gesture scrolls NOTHING — Connect (and
// the password/realname/ident inputs) sit permanently off-screen, unreachable.
// `overflow:hidden` was deliberate (it blocks the iOS document-drag-chrome
// bug), so the fix makes the card scroll INTERNALLY without letting the
// document overflow.
//
// ## Why a REAL wheel gesture, not scrollIntoViewIfNeeded
//
// `locator.scrollIntoViewIfNeeded()` sets `scrollTop` PROGRAMMATICALLY, which
// bypasses `overflow:hidden` — so it "reaches" Connect even on the broken
// code and would GREEN-wash the bug. A user has only wheel/touch, which
// `overflow:hidden` blocks. This spec drives the wheel the operator actually
// has, so it is RED on the clipped layout and GREEN only once a real scroll
// container exists.
//
// RED pre-fix: wheel scrolls nothing → Connect never enters the viewport →
// the poll times out. GREEN post-fix: the card scrolls, both ends reachable.
//
// No auth is seeded (we test the login screen itself). We DO seed
// `cic.installChoice = "browser"` so the install splash doesn't overlay the
// form (mirror of issue204-foolproof-login).

import { expect, test } from "@playwright/test";

test.describe("login Advanced section stays reachable on a short viewport", () => {
  // Short enough that the open Advanced form (brand + nick + toggle +
  // password + realname + ident + two hints + Connect) overflows.
  test.use({ viewport: { width: 390, height: 480 } });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("cic.installChoice", "browser");
    });
    await page.goto("/login");
    await expect(page.getByLabel(/nick or email/i)).toBeVisible({ timeout: 10_000 });
  });

  test("open Advanced → wheel reaches Connect (bottom) then password (top)", async ({ page }) => {
    const connect = page.getByRole("button", { name: /^connect$/i });
    const password = page.getByLabel(/password/i);

    // Open the disclosure so the form grows past the viewport.
    await page.getByRole("button", { name: /advanced/i }).click();
    await expect(password).toBeVisible();

    // Sanity: the form overflows this short viewport — Connect sits below the
    // fold before any scroll. If this ever fails the viewport got too tall and
    // the rest of the test would be vacuous.
    await expect(connect).not.toBeInViewport();

    // A scroll container must exist and actually overflow (reinforces the
    // outcome below; fails loud if a refactor removes the scroller). RED
    // pre-fix: no ancestor has overflow-y:auto/scroll with content taller than
    // its box.
    const hasScroller = await page.evaluate(() => {
      let el: Element | null = document.querySelector(".login-connect");
      while (el) {
        const cs = getComputedStyle(el);
        const e = el as HTMLElement;
        if (["auto", "scroll"].includes(cs.overflowY) && e.scrollHeight > e.clientHeight) {
          return true;
        }
        el = el.parentElement;
      }
      return false;
    });
    expect(hasScroller).toBe(true);

    // Wheel DOWN over the login area — the operator's real gesture. Poll:
    // keep wheeling until Connect enters the viewport. RED pre-fix: nothing
    // scrolls, Connect never appears, the poll times out.
    await page.locator("main.login").hover();
    await expect
      .poll(
        async () => {
          await page.mouse.wheel(0, 600);
          return await connect.isVisible().then(() => connect.evaluate((el) => {
            const r = el.getBoundingClientRect();
            return r.top >= 0 && r.bottom <= window.innerHeight;
          }));
        },
        { timeout: 10_000 },
      )
      .toBe(true);
    await expect(connect).toBeInViewport();
    await expect(connect).toBeEnabled();

    // Wheel back UP — the TOP of the disclosure must be reachable too (the
    // centered-clip bug clipped BOTH ends). Poll until the password input is
    // back in the viewport.
    await expect
      .poll(
        async () => {
          await page.mouse.wheel(0, -600);
          return await password.evaluate((el) => {
            const r = el.getBoundingClientRect();
            return r.top >= 0 && r.bottom <= window.innerHeight;
          });
        },
        { timeout: 10_000 },
      )
      .toBe(true);
    await expect(password).toBeInViewport();
  });
});

test.describe("login on a tall viewport — fix must not break the common case", () => {
  // Desktop-shaped: the open Advanced form fits without scrolling. Guards the
  // margin:auto centering — the fix must not push the card off-screen or
  // require a scroll when there's plenty of room.
  test.use({ viewport: { width: 1024, height: 900 } });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("cic.installChoice", "browser");
    });
    await page.goto("/login");
    await expect(page.getByLabel(/nick or email/i)).toBeVisible({ timeout: 10_000 });
  });

  test("open Advanced → every field + Connect is visible with no scroll", async ({ page }) => {
    await page.getByRole("button", { name: /advanced/i }).click();
    // No wheel — everything is on screen immediately when the viewport is tall.
    await expect(page.getByLabel(/password/i)).toBeInViewport();
    await expect(page.getByLabel(/real name/i)).toBeInViewport();
    await expect(page.getByLabel(/^ident$/i)).toBeInViewport();
    await expect(page.getByRole("button", { name: /^connect$/i })).toBeInViewport();
  });
});

