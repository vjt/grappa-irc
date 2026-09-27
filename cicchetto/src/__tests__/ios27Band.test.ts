// Contract under test: issue 2190 — the iOS/iPadOS 27 compositor-band gate.
//
// One file, deliberately, for the same reason the production code is one
// block: this is a PORKAROUND (vjt, #grappa 2026-09-15 16:18 «porkaround per
// ora, magari da rimuovere in seguito») and deleting it must be a revert, not
// an archaeology exercise. When the band goes, this file goes with it.
//
// 🔴 WHAT MADE THIS TEST WORTHLESS ONCE ALREADY — not a hypothetical, the
// reason row 12 exists. Every row below was CONSTRUCTED from what we believed
// iOS sends. The table was green, and the gate was dead on the only phone in
// the world that has the band: iOS 27 still reports the legacy OS token
// (`iPhone OS 18_7`) and puts the true major ONLY in `Version/27.0`, a shape
// no constructed row carried. A device table proves the parser handles the
// devices IN IT, and nothing whatsoever about the one that filed the issue.
// When a real UA becomes available, it goes in here and it outranks our
// beliefs about the platform — that is what happened to row 9.
//
// So the shape is a DEVICE TABLE with the expectation written per row, and
// the rows are chosen so that each half of the parser owns some of them:
//
//   * rows 1, 2, 5 and 11 carry BOTH signals, agreeing on the same major;
//   * row 12 carries BOTH signals DISAGREEING — the class no constructed row
//     had, and the one the real device turned out to be in. It is the only
//     row that can tell "take the first match" from "take the highest";
//   * row 9 carries ONLY the `OS <n>_<n> like Mac OS X` shape (underscores,
//     and the iPad spelling drops the device word). HYPOTHETICAL: we have
//     never observed it, and row 12 falsified the belief that the installed
//     PWA looks like this. Kept because it is the only falsifier of that
//     clause;
//   * rows 3, 4 and 7 carry ONLY `Version/<n>`, the version signal on the
//     iPadOS-desktop-mode UA, which says `Macintosh` and has no `iPad` token;
//   * rows 6, 8 and 10 carry no iOS version signal in either shape.
//
// Rows 4 and 7 are the SAME USER-AGENT STRING, byte for byte. An iPad in
// desktop mode and a real Mac are told apart by `navigator.maxTouchPoints`
// alone — that is why `isIos()` carries its `Mac` + touch clause, and why the
// parser deliberately does not pretend to answer "is this Apple mobile?".
//
// Mutation check that this table actually discriminates (run by hand,
// recorded in the issue-2190 report). Each clause of the parser owns rows no
// other clause can cover, so each one falls alone:
//   * drop the `Version/` alternative  → rows 3, 4, 7 and 12 fail, ONLY those;
//   * drop the `OS … like Mac OS X` one → row 9 fails, and ONLY that one;
//   * take the FIRST match instead of the highest → row 12 fails, ONLY it.
// If everything falls, or nothing does, the table is a mirror and not a
// measurement. The third line is the one this file was missing: the parser
// shipped with first-match-wins, every row agreed with itself, and nothing
// was red.

import { afterEach, describe, expect, it } from "vitest";
import {
  applyIos27BandClass,
  hasIos27Band,
  IOS27_BAND_CLASS,
  iosMajorVersion,
} from "../lib/platform";
import {
  resetPlatformStubs,
  stubMatchMedia,
  stubMaxTouchPoints,
  stubUserAgent,
} from "./helpers/platformStubs";
import { allRules, ruleBody, selectorList } from "./helpers/themeCss";

afterEach(() => {
  resetPlatformStubs();
  document.documentElement.classList.remove(IOS27_BAND_CLASS);
});

// The iPadOS-desktop-mode UA. Named once because rows 4 and 7 must be the
// same bytes — spelling it twice would let the two drift and quietly turn the
// "only maxTouchPoints separates them" row pair into two unrelated cases.
const MAC_SHAPED_UA_27 =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15";

type DeviceRow = {
  /** Row label, printed by `it.each`. */
  readonly name: string;
  readonly ua: string;
  /** What `isIos()`'s desktop-mode clause reads. jsdom's baseline is 0. */
  readonly maxTouchPoints: number;
  /** Installed PWA? The band is PWA chrome — Safari in a tab must not pay. */
  readonly standalone: boolean;
  /** Expected `iosMajorVersion(ua)`. */
  readonly major: number | null;
  /** Expected `hasIos27Band()`. */
  readonly band: boolean;
};

const DEVICES: readonly DeviceRow[] = [
  {
    name: "1. iPhone, iOS 26, installed PWA — below the band's first major",
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
    maxTouchPoints: 5,
    standalone: true,
    major: 26,
    band: false,
  },
  {
    name: "2. iPhone, iOS 27, installed PWA — the reported device",
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1",
    maxTouchPoints: 5,
    standalone: true,
    major: 27,
    band: true,
  },
  {
    name: "3. iPad in desktop mode, iPadOS 26, installed PWA — Version/ is the only signal",
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
    maxTouchPoints: 5,
    standalone: true,
    major: 26,
    band: false,
  },
  {
    name: "4. iPad in desktop mode, iPadOS 27, installed PWA — the device morph reported second",
    ua: MAC_SHAPED_UA_27,
    maxTouchPoints: 5,
    standalone: true,
    major: 27,
    band: true,
  },
  {
    name: "5. iPad in mobile mode, iPadOS 27, installed PWA — `CPU OS`, no device word",
    ua: "Mozilla/5.0 (iPad; CPU OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1",
    maxTouchPoints: 5,
    standalone: true,
    major: 27,
    band: true,
  },
  {
    name: "6. Android Chrome, installed PWA — standalone and touch, but not Apple",
    ua: "Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
    maxTouchPoints: 5,
    standalone: true,
    major: null,
    band: false,
  },
  {
    name: "7. macOS Safari 27 — byte-identical UA to row 4, told apart by maxTouchPoints alone",
    ua: MAC_SHAPED_UA_27,
    maxTouchPoints: 0,
    standalone: false,
    major: 27,
    band: false,
  },
  {
    name: "8. Windows desktop Chrome — no version signal in either shape",
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    maxTouchPoints: 0,
    standalone: false,
    major: null,
    band: false,
  },
  {
    // 🔴 HYPOTHETICAL, AND IT USED TO CLAIM THE OPPOSITE. This comment read
    // "NOT a hypothetical shape: iOS home-screen web apps have dropped the
    // `Version/` and `Safari/` tokens since the feature existed", and the row
    // was named "installed PWA UA" on the strength of it. Row 12 measures the
    // real thing and falsifies that on BOTH axes: the installed PWA on iOS 27
    // sends the FULL UA, `Version/27.0` and `Safari/604.1` included, and its
    // OS token reads `18_7` rather than `27_0`. The name moved to row 12,
    // where it is earned.
    //
    // KEPT ANYWAY, and not out of sentiment — measured: this is the ONLY row
    // in the table that falsifies the OS-token clause. Deleting the
    // `OS … like Mac OS X` alternative changes no other row's outcome, so
    // without this row that clause could be removed entirely and the suite
    // would stay green. It is defensive coverage of a UA shape we have never
    // observed, and it is labelled as such so the table stops teaching that
    // the PWA drops `Version/`.
    name: "9. iPhone, iOS 27, HYPOTHETICAL UA with no `Version/` token — never observed",
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
    maxTouchPoints: 5,
    standalone: true,
    major: 27,
    band: true,
  },
  {
    // 🔴 THE KNOWN GAP, asserted so it is visible rather than discovered —
    // and now LESS likely than when it was written, though still unmeasured.
    // It used to reason "if iPadOS strips `Version/` from the standalone UA
    // the same way iOS does"; row 12 measures iOS doing no such thing, so the
    // analogy that motivated this row is gone. What survives is the shape
    // itself: IF some iPad standalone UA arrives without `Version/`, the
    // desktop-mode form is left with no version signal at all —
    // `Intel Mac OS X 10_15_7` is the frozen lie every such UA carries — and
    // the iPad half of the cure never fires. We have no recorded iPadOS
    // standalone UA, in this tree or anywhere we can reach, so this row
    // states what the code DOES (nothing), not what the platform does. The
    // reading that would settle it is the same one that settled row 12:
    // `navigator.userAgent` from inside the installed PWA, on the iPad.
    name: "10. iPad desktop-mode, installed PWA, `Version/` stripped — KNOWN GAP, does not fire",
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
    maxTouchPoints: 5,
    standalone: true,
    major: null,
    band: false,
  },
  {
    name: "11. iPhone, iOS 27, Safari TAB — the standalone half of the gate, on its own",
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1",
    maxTouchPoints: 5,
    standalone: false,
    major: 27,
    band: false,
  },
  {
    // 🔴 MEASURED, and the only row in this table that is. Every other UA
    // here was written from what we believed the platform sends; this one was
    // read off the staging nginx access log — 293 of 293 requests from the
    // reporter's device, one single form. It is in the table because the
    // table was GREEN while the gate was dead on the only phone that has the
    // band, and it was green precisely because no row carried the shape the
    // device actually sends.
    //
    // What it shows: iOS 27 STILL reports the legacy OS token — `iPhone OS
    // 18_7` — and the true major lives ONLY in `Version/27.0`. The two
    // signals DISAGREE, which no constructed row did. Under the old
    // first-match-wins `??` the OS clause matched, captured 18, short-
    // circuited `Version/` away, and 18 >= 27 is false: the class never
    // applied, so every rule gated on it was dead code on the device it was
    // written for.
    //
    // WHERE `standalone: true` COMES FROM, precisely, because the two halves
    // have different sources and only one of them is a measurement. The UA is
    // from the log. That the client sending it was the INSTALLED PWA rather
    // than a Safari tab is vjt's word (#grappa 2026-09-19 09:15, «pwa
    // ovviamente»), and it has to be: an access log cannot answer it, since
    // `isStandalonePwa()` reads the display-mode in the browser and not the
    // UA, and one uniform UA form cannot distinguish "only ever used the tab"
    // from "the PWA sends this same form". So the row is measured-plus-
    // attested, never measured alone — and with the standalone half settled,
    // the misread major is the ONLY reason the gate did not fire.
    name: "12. iPhone, iOS 27, installed PWA UA — MEASURED; legacy `OS 18_7`, true major only in `Version/`",
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1",
    maxTouchPoints: 5,
    standalone: true,
    major: 27,
    band: true,
  },
];

function stubDevice(row: DeviceRow): void {
  stubUserAgent(row.ua);
  stubMaxTouchPoints(row.maxTouchPoints);
  stubMatchMedia(row.standalone);
}

describe("iosMajorVersion — the parser, both UA shapes", () => {
  it.each(DEVICES)("$name", (row) => {
    expect(iosMajorVersion(row.ua)).toBe(row.major);
  });

  it("returns null rather than a number for a UA it cannot read", () => {
    expect(iosMajorVersion("")).toBe(null);
    expect(iosMajorVersion("Resentin/1.2")).toBe(null);
  });

  it("reads a two-digit major, not the first digit of it", () => {
    // The guard against `OS (\d)` — iOS 9 shipped, and a parser that stops at
    // one digit reads 27 as 2 and the gate never fires again.
    expect(
      iosMajorVersion("Mozilla/5.0 (iPhone; CPU iPhone OS 9_3_5 like Mac OS X) Version/9.0"),
    ).toBe(9);
    expect(
      iosMajorVersion("Mozilla/5.0 (iPhone; CPU iPhone OS 127_0 like Mac OS X) Version/127.0"),
    ).toBe(127);
  });
});

describe("hasIos27Band — the composed gate", () => {
  it.each(DEVICES)("$name", (row) => {
    stubDevice(row);
    expect(hasIos27Band()).toBe(row.band);
  });

  it("a UA with no version signal does NOT satisfy the >= 27 comparison", () => {
    // Explicit because the JS coercion is a trap worth pinning rather than
    // trusting: `null >= 27` is false, but so is `undefined >= 27`, and a
    // reader cannot tell a deliberate guard from a lucky one.
    stubUserAgent("Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Mobile Safari/604.1");
    stubMaxTouchPoints(5);
    stubMatchMedia(true);
    expect(iosMajorVersion(navigator.userAgent)).toBe(null);
    expect(hasIos27Band()).toBe(false);
  });
});

describe("applyIos27BandClass — the <html> hook", () => {
  it.each(DEVICES)("$name", (row) => {
    stubDevice(row);
    applyIos27BandClass();
    expect(document.documentElement.classList.contains(IOS27_BAND_CLASS)).toBe(row.band);
  });

  it("is idempotent — boot may call it more than once and the class list stays one entry", () => {
    stubDevice(DEVICES[1] as DeviceRow);
    applyIos27BandClass();
    applyIos27BandClass();
    const classes = [...document.documentElement.classList].filter(
      (one) => one === IOS27_BAND_CLASS,
    );
    expect(classes).toHaveLength(1);
  });
});

// The CSS half. The clearance is a stylesheet rule, so what is pinnable here
// is the SOURCE: that the value is the approved 24px, that the rule ADDS it
// to the inset rather than replacing it, and — the property the ruling asks
// for in point 5 — that no rule reading it is reachable without the class.
// jsdom cascades none of this and resolves no length; the RESOLVED px are
// asserted in e2e (issue2190-ios27-compositor-band.spec.ts), which is also
// where the "exceeds the inset" half becomes a number rather than a shape.
describe("the clearance rules are gated — no platform without the class pays", () => {
  it("declares the approved 24px exactly once, on the gating class", () => {
    // FOUR numbers have sat in this token and they are NOT interchangeable,
    // which is why the value is asserted here at all rather than left to the
    // sheet. The FIRST 16 was a reported constant — what other PWA authors
    // had used — with nothing behind it; it shipped and did not cure the
    // report. 38 replaced it off probe photographs: the veil ends 100 CSS px
    // from the SCREEN edge, of which the first 62 are the status bar and are
    // ceded anyway. That correctly clears the whole veil, and on the device
    // it read as too far down. The SECOND 16 is derived from a measured
    // screenshot of the installed PWA and trades some residual veil at the
    // top of the chrome for 22px of vertical space — same digits as the
    // first one, an entirely different claim.
    //
    // THIS 24 is APPROVED, NOT COMPUTED, and that is why the literal is
    // written out here and in the sheet rather than expressed as a step off
    // the last value. It is the reporter's verdict on staging (2026-09-24
    // 23:46, issue 2295) that the second 16 is «meglio di niente ma non ci
    // siamo, ci aggiungerei altri 8px» — a distance judged by eye against
    // the veil on a phone nobody on this side owns. A `16 * 1.5` spelling
    // would read as arithmetic that never happened, and would make the next
    // verdict expensive to honour unless it too fell on a multiple.
    // The stylesheet comment carries all four numbers and their provenance.
    expect(ruleBody(`html.${IOS27_BAND_CLASS}`)).toMatch(/--ios27-band-clearance:\s*24px;/);
  });

  it("ADDS the clearance to the inset on `.shell` — never replaces it", () => {
    // 🔴 THE REGRESSION THIS FILE EXISTS TO STOP, and it was one edit away.
    // `.shell` already declares `padding-top: var(--safe-area-inset-top)`, so
    // the natural-looking gated rule — `padding-top:
    // var(--ios27-band-clearance)` — does not ADD the clearance, it hands the
    // element the clearance INSTEAD OF the inset (specificity 0,2,1 against
    // 0,1,0), so a gated device ends up HIGHER than an ungated one rather
    // than lower, pulling content up under the Dynamic Island. Stated without
    // a figure on purpose: the token has been retuned three times and the
    // failure is identical at every value. It is the #913 trap with the
    // sign flipped: that one doubled the inset by re-adding it, this one
    // annihilates it by overwriting it.
    //
    // So the assertion is on the SUM, and deliberately NOT an equality
    // against the bare clearance — that equality is precisely the bug,
    // written down and blessed. Both terms, in a calc, or red.
    const gated = ruleBody(`html.${IOS27_BAND_CLASS} .shell`);
    expect(gated).toContain(
      "padding-top: calc(var(--safe-area-inset-top) + var(--ios27-band-clearance));",
    );
  });

  it("the ungated `.shell` still pays the inset ALONE — the negative control", () => {
    // The other half of the pair above: the base rule is what the gated one
    // restates, so a drift there (a floor added, the token renamed) makes the
    // restatement a lie while the gated rule still reads fine on its own.
    // This is also the control that gives the sum its meaning — without it,
    // "the gated rule mentions the inset" says nothing about what any
    // platform WITHOUT the class actually gets.
    const base = ruleBody(".shell");
    expect(base).toContain("padding-top: var(--safe-area-inset-top);");
    expect(base).not.toContain("--ios27-band-clearance");
  });

  it("leaves `.scrollback` alone — the clearance moved to the shell", () => {
    // Ruling point 4 (vjt, #grappa 2026-09-16 00:42): the clearance sits on
    // `.shell`, so the scrollback pair that used to carry it — `padding-top:
    // calc(0.5rem + …)` plus the matching `scroll-padding-top` — came out.
    // Pinned as an ABSENCE rather than deleted quietly: a future edit that
    // re-adds clearance on the scroll container while the shell already
    // shifts the whole flow pays the clearance twice, and nothing else would say
    // so. `scrollbackBottomAlign.test.ts` lost its coupling test for the
    // same reason.
    const readers = allRules().filter((rule) => rule.body.includes("--ios27-band-clearance"));
    const onScrollback = readers.filter((rule) =>
      selectorList(rule.selectors).some((one) => one.includes(".scrollback")),
    );
    expect(onScrollback).toEqual([]);
  });

  it("every rule that mentions the clearance token carries the class in EVERY selector", () => {
    const readers = allRules().filter((rule) => rule.body.includes("--ios27-band-clearance"));
    // Positive control: the census is only worth reading if it found the
    // rules at all. A typo'd token name would otherwise pass vacuously.
    expect(readers.length).toBeGreaterThan(1);
    for (const rule of readers) {
      for (const one of selectorList(rule.selectors)) {
        expect(one).toContain(IOS27_BAND_CLASS);
      }
    }
  });
});

// ── issue 2302 — the census of TOP-ANCHORED surfaces ───────────────────────
//
// #2190 put the clearance on `.shell`, and on `.shell` alone. Every surface
// that is `position: fixed` / `absolute` and anchors to the bare
// `--safe-area-inset-top` sits OUTSIDE the shell's padding box, so the
// clearance never reaches it: on the reporter's phone the members drawer's
// `MEMBERS (43)` heading rendered inside the WebKit standalone top fade while
// the channel header behind it — in the shell's flow — sat below the band.
//
// 🔴 `hit > 0` WOULD NOT BE A CENSUS, and that distinction is the whole file.
// #2190 shipped with a "STILL VEILED AFTER THIS" list that named three
// surfaces and missed the two drawers, which is how they reached a device.
// So the assertion is a SET EQUALITY IN BOTH DIRECTIONS: every surface in the
// table has exactly one gated rule, AND no gated rule exists that the table
// does not name. One-directional coverage would let a fourteenth surface be
// cured silently, and — the failure this file already warns about further up
// — would let a SECOND gated `.shell` rule pay the clearance twice.
//
// WHY NOT FOLD THE CLEARANCE INTO THE TOKEN, which would cure the class in
// one declaration instead of thirteen rules. Measured and rejected, and NOT
// on taste: `--safe-area-inset-top: calc(var(--safe-area-inset-top) + …)` is
// a self-reference and invalid at computed-value time, and the only other
// spelling needs a SECOND `env(safe-area-inset-` write, which
// `safeAreaInsetToken.test.ts` rejects by census with nothing to add yourself
// to. Even granting both, `:root:root` (0,2,0) — how issue913, issue1751 and
// issue2190 all stub the inset — beats `html.is-ios27-band` (0,1,1), so the
// grown token would be discarded in exactly the specs that measure it.
//
// EVIDENCE IS A COLUMN, not decoration. THREE of these surfaces were seen
// veiled on a device; TEN were read off the stylesheet and have never been
// observed by anyone. The ruling covers all thirteen, so all thirteen are
// cured — but the table records which claim is which, because a census that
// reads uniformly confident about thirteen surfaces when three were measured
// is teaching something false.

/** Seen veiled on a device, or inferred from the stylesheet alone. */
type BandEvidence = "device" | "css";

type BandSurface = {
  /** Selector WITHOUT the gate; `gated()` prepends it. */
  readonly surface: string;
  /** Declarations the gated rule must carry. Compared whitespace-insensitively. */
  readonly declarations: readonly string[];
  readonly evidence: BandEvidence;
};

/**
 * The offset a top-anchored surface owes on a banded device. Spelled once:
 * thirteen hand-written copies is how a retune of the clearance would come to
 * miss one of them.
 */
const SUM = "calc(var(--safe-area-inset-top) + var(--ios27-band-clearance))";

const gated = (surface: string): string => `html.${IOS27_BAND_CLASS} ${surface}`;

const BAND_SURFACES: readonly BandSurface[] = [
  // The two mobile drawers. BOTH halves, and the pairing is not optional:
  // `top` grows by the clearance and `height` shrinks by the same term, so
  // the drawer's BOTTOM stays exactly where it is today. Move `top` alone and
  // the drawer overruns the bottom edge it reaches now — which is the check
  // the issue body asks for, and the rule the stylesheet states for itself at
  // the sidebar: put the clearance on `top` and compensate `height`.
  {
    surface: ".shell-mobile .shell-sidebar",
    declarations: [
      `top: ${SUM};`,
      "height: calc(var(--viewport-height, 100dvh) - var(--safe-area-inset-top) - var(--ios27-band-clearance));",
    ],
    evidence: "device",
  },
  {
    surface: ".shell-mobile .shell-members",
    declarations: [
      `top: ${SUM};`,
      "height: calc(var(--viewport-height, 100dvh) - var(--safe-area-inset-top) - var(--ios27-band-clearance));",
    ],
    evidence: "device",
  },
  // The floors stay OUTSIDE the sum, and the arithmetic is the reason. A
  // floor is a minimum breathing room; the clearance is part of the distance
  // from the screen edge the content owes. `max(1rem, inset + clearance)` is
  // right and `max(1rem, inset) + clearance` is not: at inset 0 the second
  // spelling pushes a surface to 1rem + the clearance, further down than the
  // band needs, while the first lands exactly on the clearance.
  {
    surface: ".archive-modal",
    declarations: [
      `padding: max(0.75rem, ${SUM}) 1rem max(1.5rem, var(--safe-area-inset-bottom));`,
    ],
    evidence: "device",
  },
  {
    surface: ".error-banners",
    declarations: [`padding-top: ${SUM};`],
    evidence: "css",
  },
  {
    surface: ".modal-backdrop-viewport",
    declarations: [
      `padding: max(1rem, ${SUM}) 1rem max(1.5rem, var(--safe-area-inset-bottom)) 1rem;`,
    ],
    evidence: "css",
  },
  {
    surface: ".settings-drawer",
    declarations: [
      `padding: max(1rem, ${SUM}) 1rem max(1.5rem, var(--safe-area-inset-bottom)) 1rem;`,
    ],
    evidence: "css",
  },
  {
    surface: ".delete-account-modal",
    declarations: [
      `padding: max(0.75rem, ${SUM}) 1rem max(1.5rem, var(--safe-area-inset-bottom));`,
    ],
    evidence: "css",
  },
  {
    surface: ".theme-editor-modal",
    declarations: [
      `padding: max(0.75rem, ${SUM}) 1rem max(1.5rem, var(--safe-area-inset-bottom));`,
    ],
    evidence: "css",
  },
  // Only the TOP component moves. The other three keep the bare tokens: the
  // band is a top-edge artefact and a `inset`/`padding` shorthand that grew
  // on all four sides would inset the whole ruler for no reason.
  {
    surface: ".context-menu-safe-area",
    declarations: [
      `inset: ${SUM} var(--safe-area-inset-right) var(--safe-area-inset-bottom) var(--safe-area-inset-left);`,
    ],
    evidence: "css",
  },
  {
    surface: ".diag-float",
    declarations: [`top: max(0.5rem, ${SUM});`],
    evidence: "css",
  },
  {
    surface: ".credits-chrome",
    declarations: [`top: max(0.5rem, ${SUM});`],
    evidence: "css",
  },
  // The two credits surfaces carry a 3rem floor, which on the reporter's
  // phone (62px inset) is already below the band — so these two plausibly
  // need nothing. Cured anyway, because "3rem probably covers it" is an
  // inference about ONE device's inset and the gate fires on every iOS 27
  // PWA including the iPad. The sum costs nothing where the floor already
  // wins: `max()` picks the larger either way.
  {
    surface: ".credits-roll",
    declarations: [`padding: max(3rem, ${SUM}) 1.5rem max(3rem, var(--safe-area-inset-bottom));`],
    evidence: "css",
  },
  {
    surface: ".credits-roll-ended",
    declarations: [`padding: max(3rem, ${SUM}) 1.5rem max(3rem, var(--safe-area-inset-bottom));`],
    evidence: "css",
  },
];

/**
 * Rules that READ the clearance, which is not the same as rules that mention
 * the token: `html.is-ios27-band` DECLARES it and must not be counted as a
 * surface. Filtering on `var(` is the difference between counting uses and
 * counting occurrences of a name.
 */
function clearanceReaders(): { selectors: string; body: string }[] {
  return allRules().filter((rule) => rule.body.includes("var(--ios27-band-clearance)"));
}

/**
 * A declaration's SHAPE, with formatting normalised away: whitespace runs
 * collapsed, and the padding biome inserts when it wraps a long `calc()` over
 * several lines removed from inside the parentheses.
 *
 * Deliberately NOT a byte comparison. The formatter owns how these
 * declarations are broken across lines — the drawer pair's `calc()` is long
 * enough that it wraps — so pinning the bytes would make this census fail on a
 * biome version bump while the stylesheet still said exactly the right thing.
 * Every token, operator and its order stays pinned; only the whitespace the
 * formatter is free to move does not.
 */
const collapse = (text: string): string =>
  text.replace(/\s+/g, " ").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").trim();

describe("issue 2302 — every top-anchored surface clears the band", () => {
  it.each(BAND_SURFACES)("$surface — evidence: $evidence", (surface) => {
    const matching = clearanceReaders().filter((rule) =>
      selectorList(rule.selectors).includes(gated(surface.surface)),
    );
    // Exactly one, not at-least-one: two gated rules on the same surface is
    // the double-count, and `toHaveLength(1)` is what makes that red.
    expect(matching).toHaveLength(1);
    const body = collapse(matching[0]?.body ?? "");
    for (const declaration of surface.declarations) {
      expect(body).toContain(collapse(declaration));
    }
  });

  it("the census names EVERY clearance reader, and every reader is in the census", () => {
    // The set equality, in both directions at once. `.shell` is #2190's own
    // rule and belongs to the set even though it is not one of this issue's
    // surfaces — leaving it out would make the comparison one-directional
    // again by way of an exception.
    const expected = [...BAND_SURFACES.map((one) => gated(one.surface)), gated(".shell")].sort();
    const actual = clearanceReaders()
      .flatMap((rule) => selectorList(rule.selectors))
      .sort();
    expect(actual).toEqual(expected);
  });

  it("records that ten of the thirteen surfaces were never observed veiled", () => {
    // Not a coverage assertion — a HONESTY one. If a later reader promotes a
    // row to `device` they have to have a screenshot; if they add a surface
    // and forget the column, the counts below move and say so.
    const byEvidence = (kind: BandEvidence): string[] =>
      BAND_SURFACES.filter((one) => one.evidence === kind).map((one) => one.surface);
    expect(byEvidence("device")).toEqual([
      ".shell-mobile .shell-sidebar",
      ".shell-mobile .shell-members",
      ".archive-modal",
    ]);
    expect(byEvidence("css")).toHaveLength(10);
  });
});
