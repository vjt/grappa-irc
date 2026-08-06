// #772 — an unsent compose draft survives a reload.
//
// The draft lived in an in-memory `identityScopedStore` signal, so it died
// with the document. Every reload path ate it: the #674 refresh banner, a
// manual reload, the #695 stale resume. #674 made reloads automatic once the
// operator has been away past a dwell, which means the draft most likely to
// be discarded is the one they walked away from mid-sentence.
//
// vitest covers the store contract by re-importing the module, which is a
// faithful model of a boot but is still a model: it cannot show that the text
// comes BACK INTO THE TEXTAREA, because the textarea is not in it. That is the
// whole of what the user sees here, so it is what this asserts — type, reload
// for real, read the textarea. `page.reload()` is the same in-place navigation
// `performRefresh` ends in, so it exercises the tier decision too:
// sessionStorage survives exactly this and nothing wider.
//
// Two negatives ride along, both worse-than-the-bug regressions:
//   * a SENT message must not come back — resurrecting text the operator
//     already dispatched would be a new defect, not a fixed one;
//   * the draft must not leak into a DIFFERENT channel's composer.
//
// Sibling coverage: `compose.test.ts` ("compose draft persistence across a
// reload (#772)") pins the store rules, including that history does NOT cross.

import { expect, test } from "@playwright/test";
import { composeTextarea, loginAs, scrollbackLine, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

// The seeder autojoins exactly one channel; `?? ""` satisfies
// noUncheckedIndexedAccess without inventing a fallback that could pass.
const CHANNEL = AUTOJOIN_CHANNELS[0] ?? "";

test.describe("#772 compose drafts survive a reload", () => {
  test("an unsent draft is still in the textarea after a real reload", async ({ page }) => {
    const vjt = getSeededVjt();
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

    // Marker so a stale buffer from another spec cannot green this.
    const draft = `half-written thought ${Date.now()}`;
    const composer = composeTextarea(page);
    await composer.fill(draft);
    await expect(composer).toHaveValue(draft);

    // A real reload — same tab, same origin, exactly what the #674 refresh
    // button and a manual F5 both do.
    await page.reload();
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

    // The point of the issue: the operator gets their sentence back, with no
    // "restored" affordance to dismiss — it just looks like nothing happened.
    await expect(composeTextarea(page)).toHaveValue(draft, { timeout: 10_000 });
  });

  test("a SENT message does not come back on reload", async ({ page }) => {
    const vjt = getSeededVjt();
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

    const composer = composeTextarea(page);
    const body = `issue772 sent ${Date.now()}`;
    await composer.fill(body);
    await composer.press("Enter");
    // The clear is the DISPATCH signal, not the success signal: post-#904
    // `takeDraft` empties the buffer synchronously as the pump takes the text,
    // before the POST is even issued, and the pump's `finally` hands it BACK if
    // that POST fails. So an empty textarea alone still leaves the send in
    // flight — and `page.reload()` aborts it (`TypeError: Failed to fetch`),
    // which IS a failure, so the body is handed back and mirrored to
    // sessionStorage during teardown. Measured on a fast host: reload landed
    // ~35ms after dispatch against an ~87ms POST, and the spec lost by ~50ms
    // (#951). Wait for the row the send produces — that is what "SENT" means
    // here, and it cannot be true while the request is still open.
    await expect(composer).toHaveValue("");
    await expect(scrollbackLine(page, "privmsg", body)).toBeVisible();

    await page.reload();
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

    // Persisting a snapshot of the live store means the clear travels too. If
    // it did not, the operator would find a sent line staged to send again.
    await expect(composeTextarea(page)).toHaveValue("", { timeout: 10_000 });
  });

  test("a draft stays in its own channel — the server window does not inherit it", async ({
    page,
  }) => {
    const vjt = getSeededVjt();
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

    const draft = `channel-scoped ${Date.now()}`;
    await composeTextarea(page).fill(draft);

    await page.reload();

    // Land on the SERVER window first: its composer must be empty, proving
    // the restore is keyed per channel and not a single global buffer.
    await selectChannel(page, NETWORK_SLUG, "Server", { awaitWsReady: false });
    await expect(composeTextarea(page)).toHaveValue("");

    // …and the channel that owns the draft still has it.
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
    await expect(composeTextarea(page)).toHaveValue(draft, { timeout: 10_000 });
  });
});
