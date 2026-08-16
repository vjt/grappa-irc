import { fireEvent, render } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

// #1358 — the iOS SYMPTOM is the keyboard closing as a draft shrinks back
// under the single-frame limit. The MECHANISM under it is DOM node movement:
// a focused element that leaves the DOM loses the focus in EVERY browser,
// with nobody calling `blur()`. Solid's reconciliation is plain
// `removeChild`/`insertBefore` on the same nodes in every DOM, so the
// mechanism is measurable in jsdom and is measured here; only the keyboard
// consequence needs a device, and vjt has already measured that one.
//
// Its own file, not a block in ComposeBox.test.tsx: that file mocks
// `../lib/compose` wholesale, so the draft there is a constant and the seams
// cannot be CROSSED — and the crossing is the entire subject. Here the
// compose store, the frame budget and the ISUPPORT table are the real ones,
// and the draft moves the way a thumb moves it: `input` on the textarea.
//
// Only `../lib/networks` is stubbed, and only `networkBySlug`: the view looks
// the published budget up under a network id, and that store is fed by an
// HTTP resource.
vi.mock("../lib/networks", async () => {
  const actual = await vi.importActual<typeof import("../lib/networks")>("../lib/networks");
  return {
    ...actual,
    networkBySlug: (slug: string) => ({
      kind: "user" as const,
      id: NETWORK_ID,
      slug,
      nick: "vjt",
      inserted_at: "",
      updated_at: "",
      connection_state: "connected",
      connection_state_reason: null,
      connection_state_changed_at: null,
    }),
  };
});

import ComposeBox from "../ComposeBox";
import { channelKey } from "../lib/channelKey";
import { setDraft } from "../lib/compose";
import { frameBudgetForTarget } from "../lib/frameBudget";
import { DEFAULT_ISUPPORT, seedIsupport } from "../lib/isupport";

const NETWORK_ID = 7;
const SLUG = "azzurra";
const CHANNEL = "#a";
const FRAME_BUDGET_BASE = 393;

const BUDGET = frameBudgetForTarget(FRAME_BUDGET_BASE, CHANNEL) as number;

// Drafts sized off the production budget, never off a literal. A single `x`
// run holds no space to break on, so the split is the plain byte cut.
const room = (bytes: number) => "x".repeat(BUDGET - bytes);
const over = (bytes: number) => "x".repeat(BUDGET + bytes);

const countdownOf = (root: ParentNode) =>
  root.querySelector("[data-testid=compose-frame-countdown]");
const splitWarningOf = (root: ParentNode) => root.querySelector(".compose-box-warning");

// What is on the seam, as a pair of booleans: the countdown above the form,
// the split warning below it.
const seamsUp = (root: ParentNode) => ({
  countdown: countdownOf(root) !== null,
  warning: splitWarningOf(root) !== null,
});

type Crossing = {
  label: string;
  from: string;
  to: string;
  before: { countdown: boolean; warning: boolean };
  after: { countdown: boolean; warning: boolean };
};

// Every transition the two seams can make, not just the one vjt's thumb
// found. The bug is a property of how the root fragment reconciles, so the
// invariant is stated over the whole class: NO seam transition may move the
// composer out from under the focus.
const CROSSINGS: Crossing[] = [
  {
    label: "countdown appears, no split on either side",
    from: room(200),
    to: room(3),
    before: { countdown: false, warning: false },
    after: { countdown: true, warning: false },
  },
  {
    label: "countdown value changes inside the band (its <p> is keyed)",
    from: room(3),
    to: room(2),
    before: { countdown: true, warning: false },
    after: { countdown: true, warning: false },
  },
  {
    label: "countdown disappears, no split on either side",
    from: room(3),
    to: room(200),
    before: { countdown: true, warning: false },
    after: { countdown: false, warning: false },
  },
  {
    label: "up over the limit: countdown out above, warning in below",
    from: room(3),
    to: over(1),
    before: { countdown: true, warning: false },
    after: { countdown: false, warning: true },
  },
  {
    label: "down under the limit: warning out below, countdown in above",
    from: over(1),
    to: room(3),
    before: { countdown: false, warning: true },
    after: { countdown: true, warning: false },
  },
  {
    label: "split warning appears alone, out of the countdown band",
    from: room(200),
    to: over(1),
    before: { countdown: false, warning: false },
    after: { countdown: false, warning: true },
  },
  {
    label: "split warning disappears alone, out of the countdown band",
    from: over(1),
    to: room(200),
    before: { countdown: false, warning: true },
    after: { countdown: false, warning: false },
  },
  {
    label: "split warning text changes, two frames to three",
    from: over(1),
    to: over(BUDGET),
    before: { countdown: false, warning: true },
    after: { countdown: false, warning: true },
  },
];

describe("#1358 — no frame-seam transition may unmount the focused composer", () => {
  beforeEach(() => {
    seedIsupport(NETWORK_ID, { ...DEFAULT_ISUPPORT, frameBudgetBase: FRAME_BUDGET_BASE });
    setDraft(channelKey(SLUG, CHANNEL), "");
  });

  for (const crossing of CROSSINGS) {
    it(`keeps the focus: ${crossing.label}`, () => {
      setDraft(channelKey(SLUG, CHANNEL), crossing.from);
      const { container } = render(() => <ComposeBox networkSlug={SLUG} channelName={CHANNEL} />);

      const textarea = container.querySelector("textarea");
      if (textarea === null) throw new Error("no composer textarea rendered");
      const form = container.querySelector("form");
      if (form === null) throw new Error("no composer form rendered");
      textarea.focus();

      // Pre-state, asserted rather than assumed: the seams really are where
      // this row says they are and the focus really is on the box. Without
      // it a row could pass having crossed nothing.
      expect(seamsUp(container)).toEqual(crossing.before);
      expect(document.activeElement).toBe(textarea);

      // The gesture: one `input`, the way a keystroke or a deletion reports.
      // The form is watched across it, because Solid can hand the same node
      // object back after having detached and re-attached it — node identity
      // alone is a blind oracle here (measured: same node, focus gone).
      let formDetached = false;
      const observer = new MutationObserver(() => {});
      observer.observe(container, { childList: true, subtree: true });
      fireEvent.input(textarea, { target: { value: crossing.to } });
      for (const record of observer.takeRecords()) {
        for (const node of Array.from(record.removedNodes)) {
          if (node === form || node.contains(form)) formDetached = true;
        }
      }
      observer.disconnect();

      // The crossing really happened.
      expect(seamsUp(container)).toEqual(crossing.after);

      // The measurement. The focus is the oracle that matters — a detached
      // and re-attached composer keeps its node identity and loses the
      // keyboard — and the detach is reported alongside it so a red says
      // WHY, not just that.
      expect({ formDetached, focused: document.activeElement === textarea }).toEqual({
        formDetached: false,
        focused: true,
      });
    });
  }
});
