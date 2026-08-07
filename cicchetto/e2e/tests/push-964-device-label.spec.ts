// push-964 — naming a device, and the ordinal that names the ones you have not.
//
// The sibling spec (`push-964-device-row.spec.ts`) covers the two
// disambiguators derived from data the row already carried: the activity
// instant and the "this device" marker. This one covers the two that needed a
// schema change — the user's own label, and the ordinal that separates the
// twins nobody has named yet.
//
// Four contracts, every one asserted on what a person would SEE:
//
//   1. Two devices that parse to the same `Browser on OS` render DIFFERENT
//      names, numbered oldest-first.
//   2. Renaming one from its row replaces that name, and demotes the parsed
//      string to the secondary line instead of dropping it.
//   3. Naming one twin drops the OTHER's ordinal. This is the assertion a
//      STORED ordinal would fail: a column written while the pair collided
//      keeps its `#2` forever, whereas the derived name re-reads the list and
//      finds the survivor alone in its group.
//   4. Clearing the label hands the row back to the derived default — the
//      twins collide again and BOTH are numbered once more.
//
// ## Why the rows are POSTed rather than registered from two browsers
//
// The contract under test is about two rows whose `user_agent` parses to the
// same string. The runner has one engine per project, so a second browser
// would supply the same UA — but also a second push stub, a second SW
// registration and a second opt-in dance for rows this spec only ever reads.
// POSTing them is the same insert the server would have performed, and it lets
// the spec pin the UA, so the expected names are literal (`Firefox on Linux
// #1`) instead of "whatever this engine calls itself".
//
// ## Why there is no page.reload()
//
// On boot `installPushResubscribe` renews a subscription the per-document push
// stub makes look dropped; the renewal POSTs `supersedes`, which DELETES the
// old row and inserts a fresh one — losing the very label under assertion. The
// persistence leg therefore reads from a second BrowserContext, which carries
// no opt-in intent and so renews nothing. Same reasoning as the sibling spec.
//
// No @webkit twin: every assertion is on rendered text, so nothing here is
// engine-dependent.

import { expect, test } from "../fixtures/test";
import { loginAs, openSettingsSection } from "../fixtures/cicchettoPage";
import { resetPushSubscriptions } from "../fixtures/push";
import { getSeededVjt } from "../fixtures/seedData";

const GRAPPA = "http://grappa-test:4000";

// One UA for both rows: `parseUserAgent` collapses it to "Firefox on Linux",
// which is precisely the collision Hypnotize reported.
const TWIN_UA = "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0";
const TWIN_NAME = "Firefox on Linux";

test("twins carry ordinals, a rename replaces one, and the survivor drops its number", async ({
  page,
  browser,
}) => {
  const vjt = getSeededVjt();
  await resetPushSubscriptions(vjt.token);

  // Oldest first — the ordinal is assigned by creation instant, so the order
  // of these two POSTs is what makes `#1` deterministic.
  await registerDevice(vjt.token, TWIN_UA, "https://push.example/964-label-older");
  await registerDevice(vjt.token, TWIN_UA, "https://push.example/964-label-newer");

  await loginAs(page, vjt);
  await openSettingsSection(page, "push");

  const rows = page.locator('[data-testid="devices-list"] li');
  await expect(rows).toHaveCount(2);

  // ── 1. Both numbered, and the two names differ.
  const first = rows.filter({ hasText: `${TWIN_NAME} #1` });
  const second = rows.filter({ hasText: `${TWIN_NAME} #2` });
  await expect(first).toHaveCount(1);
  await expect(second).toHaveCount(1);

  // ── 2. Rename the second one from its row.
  await second.getByTestId("device-rename").click();
  const input = page.getByTestId("device-name-input");
  await expect(input).toBeVisible();
  await input.fill("il portatile");
  await page.getByTestId("device-rename-save").click();

  const renamed = rows.filter({ hasText: "il portatile" });
  await expect(renamed.getByTestId("device-name")).toHaveText("il portatile");
  // The parsed string is not lost — it demotes to the secondary line.
  await expect(renamed.getByTestId("device-parsed")).toHaveText(TWIN_NAME);

  // ── 3. The other twin is now alone among the unnamed, so its ordinal is
  // gone. A stored ordinal would still read "#1" here.
  const survivor = rows.filter({ hasNotText: "il portatile" });
  await expect(survivor.getByTestId("device-name")).toHaveText(TWIN_NAME);

  // ── The label lives on the SERVER: a browser that has never seen this
  // session reads the same name back.
  const observerCtx = await browser.newContext();
  try {
    const observer = await observerCtx.newPage();
    await loginAs(observer, vjt);
    await openSettingsSection(observer, "push");
    await expect(
      observer.locator('[data-testid="devices-list"] li').filter({ hasText: "il portatile" }),
    ).toHaveCount(1);
  } finally {
    await observerCtx.close();
  }

  // ── 4. Clearing the label hands the row back to its derived default, and
  // the twins collide again — both numbered once more.
  await renamed.getByTestId("device-rename").click();
  await page.getByTestId("device-name-input").fill("");
  await page.getByTestId("device-rename-save").click();

  await expect(rows.filter({ hasText: `${TWIN_NAME} #1` })).toHaveCount(1);
  await expect(rows.filter({ hasText: `${TWIN_NAME} #2` })).toHaveCount(1);
  await expect(page.getByTestId("device-parsed")).toHaveCount(0);
});

/**
 * POSTs a push subscription for `token`'s subject with an explicit UA, so the
 * spec controls what the row parses to. Keys are the fixture pair the push
 * helpers use — the changeset's length caps apply to every insert, whoever
 * makes it.
 */
async function registerDevice(token: string, userAgent: string, endpoint: string): Promise<void> {
  const res = await fetch(`${GRAPPA}/push/subscriptions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": userAgent,
    },
    body: JSON.stringify({
      endpoint,
      keys: {
        p256dh:
          "BCfaYE5dGabdzef68MI0SN24b4Gsf1t_N3ftUlWaFGzkuudjHLor0CRjosM3c7SLZ7PfFufpsFUh8vsO1t8wCHs",
        auth: "dGVzdC1hdXRoLXNlY3JldDE2Yg",
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`registerDevice: ${res.status} ${await res.text()}`);
  }
}
