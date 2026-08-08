// #1063 — update delivery: what a real browser can and cannot witness.
//
// READ THIS BEFORE ADDING TO THIS FILE. #1063's acceptance 5 asks for a
// test proving "a client booted on bundle A reaches bundle B after a
// deploy with no manual cache clearing". Part of that is already covered
// and part of it is NOT REACHABLE from Playwright; writing the unreachable
// part anyway would produce a green spec that asserts nothing.
//
// COVERED ELSEWHERE: the CLICK path. `bundle-refresh-real-swap.spec.ts`
// swaps the dist for real and proves one press of the banner converges on
// the new bundle. Nothing here duplicates it.
//
// NOT REACHABLE, and why:
//
//   * The activate-navigate path's POSITIVE branch. `navigateStaleClients`
//     only moves clients that are not visible, and Playwright cannot put a
//     page in the background: `bringToFront` does not background its
//     siblings, and headless chromium reports every page as visible. There
//     is no seam that makes a real browser report a hidden window here, so
//     the positive branch is pinned by vitest (`swLifecycle.test.ts`) and
//     the NEGATIVE branch — the gate holding — is pinned below, where a
//     real worker lifecycle is what makes it meaningful.
//
//   * "Refresh converges even when a step hangs." Tempting, and wrong.
//     `swapToBundleB` leaves `service-worker.js` untouched, so no new
//     worker installs and the OLD precache still holds the OLD
//     `index.html`. Convergence there depends entirely on the cache purge,
//     so hanging the purge and demanding convergence would assert
//     something the fix does not deliver: #1063's ceiling trades a dead
//     button for a reload that may not take. That trade is deliberate — a
//     reload the operator can repeat beats a tap that does nothing — but a
//     spec must not claim more than it.
//
// The two tests below are the part that IS both real and new.

import { expect, test } from "../fixtures/test";
import { awaitServiceWorkerActive, loginAs } from "../fixtures/cicchettoPage";
import { getSeededVjt } from "../fixtures/seedData";
import { snapshotBundle, swapServiceWorker } from "../fixtures/bundleSwap";

test("#1063 — the SPA shell is served with a revalidation policy on the real wire", async ({
  page,
}) => {
  await loginAs(page, getSeededVjt());

  // `page.request` is an APIRequestContext: it bypasses the page AND the
  // service worker, so this reads what the server actually put on the
  // wire through the proxy. That is the difference from the ConnCase test,
  // which can only see the Plug layer — a proxy is free to rewrite headers
  // and this is where that would show.
  const shellUrl = new URL("/", page.url()).toString();
  const resp = await page.request.get(shellUrl);

  expect(resp.status()).toBe(200);
  // The shell is the sole carrier of the `<script src="/assets/index-<hash>.js">`
  // tag, so a cached copy re-boots the same bundle forever.
  expect(resp.headers()["cache-control"] ?? "").toContain("no-cache");
});

test("#1063 — activating a new worker does not reload the window in use", async ({ page }) => {
  // The gate from `lib/swLifecycle.ts`: `activate` moves clients nobody is
  // looking at, and deliberately spares the visible one, because a push
  // event can trigger a worker update check hours after boot and throwing
  // away a foreground window mid-use is worse than the stale bundle it
  // would fix.
  //
  // HONEST LABEL: this also passes on pre-#1063 code, where `activate` did
  // nothing but claim. It is not evidence that the navigate pass works —
  // that is vitest's job. It exists because "spare the visible client" is
  // the kind of restraint a later change removes in one line while
  // believing it is an improvement, and this is the only place a real
  // browser can object.
  const snap = await snapshotBundle();
  try {
    await loginAs(page, getSeededVjt());
    await awaitServiceWorkerActive(page);

    // Sentinel on the document. If the window is navigated, the document
    // is replaced and this is gone — a crisper oracle than watching for a
    // navigation event, and it cannot be satisfied by a page that merely
    // looks similar afterwards. Stash the active worker alongside it so
    // the barrier below compares object identity, not a URL that never
    // changes across an update.
    await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      const w = window as unknown as {
        __i1063: { alive: boolean; before: ServiceWorker | null };
      };
      w.__i1063 = { alive: true, before: reg?.active ?? null };
    });

    // Byte-different worker on disk. Without this the update check finds
    // identical bytes, no worker installs, `activate` never fires, and the
    // assertion below would hold for a reason that has nothing to do with
    // the gate.
    await swapServiceWorker();

    // Drive the update explicitly rather than waiting for the browser's
    // own schedule — the setup is what has to be deterministic.
    await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      await reg?.update();
    });

    // BARRIER: the new worker has actually reached `activated`. Comparing
    // `reg.active` by object identity is what makes this a real barrier —
    // the scriptURL is unchanged across an update, so a URL check would
    // pass instantly and turn the whole spec into a sleep.
    await page.waitForFunction(
      async () => {
        const reg = await navigator.serviceWorker.getRegistration();
        const w = window as unknown as {
          __i1063?: { before: ServiceWorker | null };
        };
        // A navigated document loses `__i1063`; treat that as "stop
        // waiting" so the failure is the explicit assertion below rather
        // than an opaque waitForFunction timeout.
        if (w.__i1063 === undefined) return true;
        const active = reg?.active ?? null;
        return active !== null && active !== w.__i1063.before;
      },
      undefined,
      { timeout: 30_000 },
    );

    const alive = await page.evaluate(() => {
      const w = window as unknown as { __i1063?: { alive: boolean } };
      return w.__i1063?.alive ?? false;
    });

    expect(alive, "a new worker activated and the visible window was reloaded anyway").toBe(true);
  } finally {
    await snap.restore();
  }
});
