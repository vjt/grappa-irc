import { describe, expect, it } from "vitest";
import {
  SELECTABLE_TEXT_CLASS,
  STANDING_SELECTABLE_SURFACES,
  STANDING_SURFACE_CONTROLS,
} from "../lib/keepKeyboard";
import {
  coarsePointerBlocks,
  hoverGatedBlocks,
  mediaGatedBlocks,
  themeCss,
} from "./helpers/themeCss";

// #1869 — the selection/callout policy is TOUCH behaviour, not iOS behaviour.
//
// It used to sit under `html.is-ios`, a class `lib/platform.ts` adds only when
// `isIos()`, so Android got NONE of it: nothing suppressed Chrome's own
// long-press callout, and one press on a message row opened TWO menus — the
// platform's selection toolbar over a native selection of the row, plus cic's
// message menu behind it. Device-verified on an Android 17 emulator, Chrome
// 151: `window.getSelection()` came back non-collapsed with the pressed word
// while cic's menu reported open in the same frame.
//
// WHY A SOURCE-LEVEL TEST TOO, next to the e2e ones. jsdom applies no
// stylesheet, so nothing here can read a computed value. What this file reads
// is the SHAPE of the sheet — which rules exist and where they are gated —
// which is what rots when someone adds a re-enable and forgets the gate.
//
// The COMPUTED side is covered in e2e and needs no `emulateMedia`: both
// `webkit-iphone-15` and `chromium-pixel-touch` report `pointer: coarse`
// natively, so `issue1869-android-longpress-selection.spec.ts` (Blink) and the
// `@webkit` twins in `text-selection-restored` / `issue250-android-nick-select`
// assert the real cascade on both engine families.
//
// What NO project can do is render a platform's native selection UI, so
// "does the toolbar actually appear?" stays a device question — the limit
// #1067 and #1857 declare, and #1869 verified by hand on Android.
//
// THE DRIFT THIS GUARDS. The kill and its re-enables are one atomic set: #79
// (scrollback; its topic text is now one of issue 2394's standing surfaces), #1067 (the `is-selecting` callout latch), #508
// (<select> pickers), #589 (admin panes), plus the two re-excludes that carve
// out of them. Widening the kill while leaving a re-enable behind does not
// fail loudly — it silently makes that surface uncopyable on every touch
// device. So the assertion is a SET comparison, not a spot-check.

// Every selector the touch policy owns, with the declaration that proves it is
// the policy rule and not something else that happens to share the selector.
const POLICY = [
  { selector: "html", declares: /-webkit-user-select:\s*none/ },
  { selector: "html input", declares: /user-select:\s*text/ },
  { selector: "html textarea", declares: /user-select:\s*text/ },
  // #1869 — the row and BOTH #250 tokens default to unselectable on touch.
  { selector: "html .scrollback", declares: /user-select:\s*none/ },
  { selector: "html .scrollback .nick-clickable", declares: /user-select:\s*none/ },
  { selector: "html .scrollback .channel-clickable", declares: /user-select:\s*none/ },
  // …and the latch lifts all three, callout AND user-select.
  { selector: "html.is-selecting .scrollback", declares: /-webkit-touch-callout:\s*default/ },
  { selector: "html.is-selecting .scrollback", declares: /user-select:\s*text/ },
  { selector: "html.is-selecting .scrollback .nick-clickable", declares: /user-select:\s*text/ },
  {
    selector: "html.is-selecting .scrollback .channel-clickable",
    declares: /user-select:\s*text/,
  },
  { selector: "html select", declares: /user-select:\s*text/ },
  { selector: "html .scrollback-invite-join", declares: /user-select:\s*none/ },
  { selector: "html .admin-tab-panel", declares: /user-select:\s*text/ },
  { selector: "html .admin-tab-panel button", declares: /user-select:\s*none/ },
] as const;

const coarse = () => coarsePointerBlocks().join("\n");

// Rules inside the gate, as `{ selectors, body }`. Innermost blocks only, the
// same shape `allRules` returns — the `[^{}]` classes cannot span a brace.
function coarseRules(): { selectors: string; body: string }[] {
  const out: { selectors: string; body: string }[] = [];
  for (const match of coarse().matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    out.push({ selectors: (match[1] ?? "").trim(), body: match[2] ?? "" });
  }
  return out;
}

// Whether `selector` appears in some rule inside the gate whose body matches
// `declares`. Selector lists are split, because these rules group: the
// scrollback / topic / input / textarea re-enable is ONE rule over four
// selectors and each of them must count.
function gatedDeclares(selector: string, declares: RegExp): boolean {
  return coarseRules().some(
    (rule) =>
      rule.selectors
        .split(",")
        .map((one) => one.trim().replace(/\s+/g, " "))
        .includes(selector) && declares.test(rule.body),
  );
}

const stripped = themeCss.replace(/\/\*[\s\S]*?\*\//g, "");

describe("#1869 — the touch selection policy is gated on pointer, not on iOS", () => {
  // THE CONTROL, first: every assertion below passes just as well against a
  // sheet that deleted the policy outright. Deleting the suppression and
  // re-parenting it are different changes, and only one of them was asked for.
  it("still declares every rule of the policy", () => {
    for (const { selector, declares } of POLICY) {
      expect(
        gatedDeclares(selector, declares),
        `${selector} declaring ${declares} inside @media (pointer: coarse)`,
      ).toBe(true);
    }
  });

  // THE DISCRIMINATOR — the whole set moved, not the kill alone. A kill that
  // widened to Android while a re-enable stayed on `html.is-ios` would leave
  // that surface uncopyable on Android, which is #79 / #508 / #589 regressing
  // sideways rather than #1869 being fixed.
  it("leaves no user-select or touch-callout rule behind on html.is-ios", () => {
    const stranded = stripped
      .split(/(?=^html\.is-ios)/m)
      .filter((chunk) => /^html\.is-ios[^{}]*\{[^{}]*(?:user-select|touch-callout)/.test(chunk))
      .map((chunk) => chunk.slice(0, chunk.indexOf("{")).trim());

    expect(stranded, "html.is-ios rules still declaring selection policy").toEqual([]);
  });

  // `html.is-ios` keeps the half that IS iOS-only. Asserted so the split is
  // read as a split: pushing the layout pin under `pointer: coarse` too would
  // put `position: fixed` on Android, where the layout viewport already reacts
  // to the keyboard — the double-shrink UX-6-D spent 8 iterations on.
  it("keeps the layout-viewport pin on html.is-ios", () => {
    expect(stripped).toMatch(/^html\.is-ios\s*\{[^}]*position:\s*fixed/m);
    expect(stripped).toMatch(/^html\.is-ios body\s*\{[^}]*height:\s*calc\(var\(--vh/m);
  });

  // The gate must not have swallowed the layout pin from the other direction
  // either — an `is-ios` rule INSIDE `(pointer: coarse)` would be dead on a
  // desktop browser reporting `pointer: fine`, which iPadOS-with-trackpad does.
  it("declares no layout pin inside the pointer gate", () => {
    expect(coarse()).not.toMatch(/position:\s*fixed/);
  });

  // THE #1869 defect itself, stated as a rule. `-webkit-touch-callout` is
  // WebKit-only, so on Blink an unlatched `user-select: text` on the row IS the
  // native long-press selection — the two-menu frame. Any rule that grants the
  // scrollback selectability on a coarse pointer must be latched behind
  // `is-selecting`; an unlatched one puts the bug straight back.
  it("grants the scrollback no unlatched selectability on a coarse pointer", () => {
    const unlatched = coarseRules().filter(
      (rule) =>
        /user-select:\s*text/.test(rule.body) &&
        rule.selectors.split(",").some((one) => {
          const sel = one.trim().replace(/\s+/g, " ");
          return sel.includes(".scrollback") && !sel.includes(".is-selecting");
        }),
    );

    expect(
      unlatched.map((r) => r.selectors),
      "scrollback rules granting user-select: text outside the is-selecting latch",
    ).toEqual([]);
  });

  // Desktop keeps #250's mouse-drag guarantee: the tokens' own top-level
  // `user-select: text` must survive, since `pointer: fine` never enters the
  // gate and that declaration is the only thing carrying the nick into a drag.
  it("leaves #250's desktop declarations intact outside the gate", () => {
    expect(stripped).toMatch(/^\.nick-clickable\s*\{[^}]*user-select:\s*text/m);
    expect(stripped).toMatch(/^\.channel-clickable\s*\{[^}]*user-select:\s*text/m);
  });
});

// The scan #1869 generalised out of `hoverGatedBlocks`, tested where it was
// generalised. Its ONE precondition used to be documentation only.
describe("mediaGatedBlocks — the shared media-gate scan", () => {
  // Without `g`, `exec` ignores the `lastIndex` the loop advances and restarts
  // at 0 forever: the helper HANGS instead of failing, and a hung vitest names
  // no caller. A throw is the difference between a diagnosable misuse and a
  // timeout somebody bisects by hand.
  it("refuses an opener without the g flag instead of scanning forever", () => {
    expect(() => mediaGatedBlocks(/@media\s*\(\s*pointer\s*:\s*coarse\s*\)\s*\{/, "no-g")).toThrow(
      /g flag/,
    );
  });

  // The positive control for the guard: the same pattern WITH `g` must still
  // return the gate, or the throw above would be indistinguishable from a
  // helper that rejects everything.
  it("accepts the same opener once it carries g", () => {
    expect(
      mediaGatedBlocks(/@media\s*\(\s*pointer\s*:\s*coarse\s*\)\s*\{/g, "coarse"),
    ).toHaveLength(coarsePointerBlocks().length);
  });

  // And the pre-existing caller is unchanged by the generalisation — the
  // wrapper still finds the hover gate it found before #1869 touched this.
  it("leaves hoverGatedBlocks finding its own gate", () => {
    expect(hoverGatedBlocks().length).toBeGreaterThan(0);
  });
});

// issue 2394 — the STANDING copyable surfaces are ONE list, owned by
// keepKeyboard.ts, and the sheet must say the same thing. CSS cannot import a
// constant, so the agreement is asserted here in both directions: every listed
// surface is re-enabled (and its controls re-excluded) inside the gate, and the
// gate grants no OTHER unlatched selectability the list does not know about —
// a surface added to the sheet alone would be selectable but keep the old
// keyboard policy, the drift the old two-site comment could only ask nobody
// to commit.
describe("issue 2394 — the standing selectable surfaces agree with keepKeyboard", () => {
  // Surfaces the gate re-enables for reasons OUTSIDE the keyboard list, each
  // already argued where it is declared: form controls (#79 / #508 — WebKit
  // honours an inherited none inside them) and the admin pane (#589 — its
  // <Match> arm unmounts ComposeBox, so there is no focused field to keep).
  const NOT_KEYBOARD_SURFACES = [
    "html input",
    "html textarea",
    "html select",
    "html .admin-tab-panel",
  ];

  it("re-enables every standing surface inside the gate, callout included", () => {
    expect(STANDING_SELECTABLE_SURFACES.length).toBeGreaterThan(0);
    for (const surface of STANDING_SELECTABLE_SURFACES) {
      const selector = `html ${surface}`;
      expect(gatedDeclares(selector, /user-select:\s*text/), selector).toBe(true);
      // The inherited `-webkit-touch-callout: none` is what #1067 found leaves
      // an iOS selection without draggable endpoints; these surfaces have no
      // long-press menu of their own to race, unlike `.scrollback`.
      expect(gatedDeclares(selector, /-webkit-touch-callout:\s*default/), selector).toBe(true);
    }
  });

  // The sheet's carve-out is `:not(.selectable-text)`: a control that IS the
  // copyable text (a /names or /who nick) opts back in with the same class,
  // while keepKeyboard still treats it as a control — see the comment there.
  it("re-excludes every non-copyable control of every standing surface", () => {
    for (const surface of STANDING_SELECTABLE_SURFACES) {
      for (const control of STANDING_SURFACE_CONTROLS) {
        const selector = `html ${surface} ${control}:not(.${SELECTABLE_TEXT_CLASS})`;
        expect(gatedDeclares(selector, /user-select:\s*none/), selector).toBe(true);
        expect(gatedDeclares(selector, /-webkit-touch-callout:\s*none/), selector).toBe(true);
      }
    }
  });

  it("grants no unlatched selectability outside the known lists", () => {
    const known = new Set([
      ...STANDING_SELECTABLE_SURFACES.map((surface) => `html ${surface}`),
      ...NOT_KEYBOARD_SURFACES,
    ]);
    const strays = coarseRules()
      .filter((rule) => /user-select:\s*(?:text|all|auto)/.test(rule.body))
      .flatMap((rule) => rule.selectors.split(",").map((one) => one.trim().replace(/\s+/g, " ")))
      .filter((sel) => !sel.startsWith("html.is-selecting") && !known.has(sel));

    expect(strays, "coarse-pointer re-enables keepKeyboard.ts does not list").toEqual([]);
  });
});
