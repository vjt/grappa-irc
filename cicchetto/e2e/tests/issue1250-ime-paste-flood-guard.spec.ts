// #1250 — the paste flood guard on the IME path.
//
// GBoard's clipboard chip does not fire a `paste` event. It commits the text
// through the input method, which surfaces as `beforeinput` with an
// `insertFromPaste` inputType, and both pre-#1250 doors into the router were
// `paste` listeners. The guard was therefore not weak on that path, it was
// ABSENT: `classifyPaste` never ran, and an operator could send a burst of any
// size by choosing the chip over the long-press Paste menu — never shown the
// count, never offered the .txt door that the 2026-08-06 ruling made the only
// way out above the cap. Reporter's A/B: chip → no dialog, long-press → dialog.
//
// What each test here is for:
//
//   1-2. The IME door itself. A synthetic `beforeinput[insertFromPaste]` is the
//        closest a browser harness gets to the chip — Playwright cannot drive
//        GBoard, and no CDP verb commits an insertFromPaste. This is a stated
//        LIMIT of the simulation, not a claim about GBoard: what is proven is
//        that cic answers the event GBoard emits. The oracle is the visible
//        outcome the reporter did NOT get — a dialog, and a composer that
//        stays empty.
//
//   3.   The ORDERING, measured rather than assumed. The no-double-dialog
//        argument in pasteRoute.ts rests on a browser contract: `paste` fires
//        first, and only an UNCANCELLED paste produces the insertion that
//        fires `beforeinput`, so a guarded arm's preventDefault suppresses the
//        second report. #1250's text claims some engines fire `beforeinput`
//        first, which would break that argument. A synthetic ClipboardEvent
//        cannot settle it — an untrusted event performs no default action, so
//        no `beforeinput` ever follows it and the measurement would be
//        vacuous. This test therefore drives a REAL clipboard gesture
//        (copy from a scratch field, paste with the keyboard) and records the
//        order the page actually observes.

import type { Page } from "@playwright/test";

import {
  composeTextarea,
  confirmModal,
  confirmModalBody,
  confirmModalCancel,
  confirmModalYes,
  loginAs,
  selectChannel,
} from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

// The slice of TestInfo this spec uses — the attach verb only, so the shared
// journey does not have to take the whole fixture just to record one string.
type AttachFn = (name: string, options: { body: string; contentType: string }) => Promise<void>;

const CHANNEL = AUTOJOIN_CHANNELS[0];

// 7 messages — past PASTE_HARD_MESSAGE_LIMIT (5), so the hard-close arm.
const OVER_LIMIT = ["uno", "due", "tre", "quattro", "cinque", "sei", "sette"].join("\n");
// 4 messages — the confirm arm.
const MID_SIZE = ["uno", "due", "tre", "quattro"].join("\n");

async function openCompose(page: Page): Promise<void> {
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
  await loginAs(page, specUser());
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
  await expect(composeTextarea(page)).toBeVisible();
}

// The GBoard chip, as closely as a harness can state it: the insertion event
// an IME commit produces, carrying the text on a DataTransfer. NO `paste`
// event is dispatched — that absence IS the bug this reproduces.
async function imePaste(page: Page, text: string): Promise<void> {
  await composeTextarea(page).evaluate((el, t) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", t);
    el.dispatchEvent(
      new InputEvent("beforeinput", {
        inputType: "insertFromPaste",
        dataTransfer: dt,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, text);
}

test("#1250 — an over-limit IME paste is hard-closed: dialog, and the block never lands", async ({
  page,
}) => {
  await openCompose(page);
  const ta = composeTextarea(page);
  await expect(ta).toHaveValue("");

  await imePaste(page, OVER_LIMIT);

  // The outcome the reporter never saw on this gesture.
  await expect(confirmModal(page)).toBeVisible();
  await expect(confirmModalBody(page)).toContainText("7");
  await expect(confirmModalBody(page)).toContainText(CHANNEL ?? "");
  // Hard close: above the cap the paste door is gone, so the text must not be
  // in the composer while the dialog is up.
  await expect(ta).toHaveValue("");

  // Cancel is the safe default here too — nothing lands, nothing uploads.
  await confirmModalCancel(page);
  await expect(confirmModal(page)).toHaveCount(0);
  await expect(ta).toHaveValue("");
});

test("#1250 — a mid-size IME paste asks, and the affirmative lands the block", async ({ page }) => {
  await openCompose(page);
  const ta = composeTextarea(page);

  await imePaste(page, MID_SIZE);
  await expect(confirmModal(page)).toBeVisible();
  await expect(confirmModalBody(page)).toContainText("4");
  await expect(ta).toHaveValue("");

  await confirmModalYes(page);
  await expect(confirmModal(page)).toHaveCount(0);
  await expect(ta).toHaveValue(MID_SIZE);
});

async function realPasteOrderJourney(page: Page, testInfo: { attach: AttachFn }): Promise<void> {
  await openCompose(page);
  const ta = composeTextarea(page);

  // Record what the textarea actually receives, in order. Capture phase so the
  // recorder cannot be skipped by the app's own handling, and it only reads.
  await ta.evaluate((el) => {
    const w = window as unknown as { __pasteSeq?: string[] };
    w.__pasteSeq = [];
    for (const type of ["paste", "beforeinput"]) {
      el.addEventListener(
        type,
        (e) => {
          w.__pasteSeq?.push(
            type === "beforeinput" ? `beforeinput:${(e as InputEvent).inputType}` : "paste",
          );
        },
        { capture: true },
      );
    }
  });

  // Load the OS clipboard through a real user gesture: a scratch field, then
  // select-all + copy from the keyboard. `navigator.clipboard.writeText` is
  // deliberately avoided — it needs a permission grant that is chromium-only,
  // and this measurement has to mean the same thing on both engines.
  await page.evaluate((text) => {
    const scratch = document.createElement("textarea");
    scratch.id = "clip-scratch";
    scratch.value = text;
    // Top of the viewport and above everything: at the BOTTOM the bar's
    // network label intercepts the pointer on the 390px iPhone project, and
    // the click never lands.
    scratch.style.position = "fixed";
    scratch.style.top = "0";
    scratch.style.left = "0";
    scratch.style.width = "120px";
    scratch.style.height = "40px";
    scratch.style.zIndex = "2147483647";
    document.body.appendChild(scratch);
  }, MID_SIZE);
  const scratch = page.locator("#clip-scratch");
  await scratch.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("ControlOrMeta+c");
  await page.evaluate(() => document.getElementById("clip-scratch")?.remove());

  await ta.click();
  await page.keyboard.press("ControlOrMeta+v");

  // The product invariant: ONE gesture, ONE dialog. If a second report reached
  // the router, the operator would be asked the same question twice.
  await expect(confirmModal(page)).toBeVisible();
  await expect(confirmModal(page)).toHaveCount(1);
  await expect(ta).toHaveValue("");

  const seq = await page.evaluate(
    () => (window as unknown as { __pasteSeq?: string[] }).__pasteSeq ?? [],
  );
  // Attached as well as asserted, so the raw observation survives in the run's
  // artefacts for comparison after a future engine update.
  await testInfo.attach("paste-event-order", { body: seq.join(" → "), contentType: "text/plain" });

  // The PIN, and the whole reason this test drives a real gesture: exactly one
  // report reaches the guard, and it is the `paste` one. That is the contract
  // pasteRoute.ts's no-bookkeeping design rests on — the guarded arm cancels,
  // so the insertion never happens and its `beforeinput` never fires. #1250's
  // text claims some engines report `beforeinput` first; if this ever observes
  // that, the design needs the gesture-claim it deliberately does without, and
  // this assertion is what says so out loud instead of leaving a double dialog
  // for an operator to find.
  expect(
    seq.filter((s) => s === "paste" || s === "beforeinput:insertFromPaste"),
    `a cancelled paste must be the ONLY report the guard sees — observed: ${seq.join(" → ")}`,
  ).toEqual(["paste"]);
}

test("#1250 — a REAL paste is reported once to the guard: one dialog, and the measured order", async ({
  page,
}, testInfo) => {
  await realPasteOrderJourney(page, testInfo);
});

// The same measurement on the other shipped engine. The ordering is a browser
// contract, so one engine's answer is not the answer.
test("#1250 — a REAL paste is reported once to the guard: one dialog, and the measured order @webkit", async ({
  page,
}, testInfo) => {
  await realPasteOrderJourney(page, testInfo);
});
