import { fireEvent, render, screen } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

// UX-4 bucket L (2026-05-19) — ShellChrome unit tests.
//
// #71 INC-2 — ShellChrome is now MOBILE-ONLY and its old settings cog is
// gone: R1 moved the cog into the permanent right rail (RailActions,
// tested in RailActions.test.tsx), and this bar's right-edge button is
// now the ☰ RAIL OPENER (`shell-chrome-rail-opener`, prop `onOpenRail`)
// that opens that rail on non-channel mobile windows.
//
// #473 — the standalone archive button (📂) was REMOVED from ShellChrome.
// It was a third archive entry point; archive now lives as an always-on
// button in the RailActions drawer (reachable via this same ☰ opener), so
// the inline button + its `setArchiveModalNetwork` wiring are gone.
//
// #986 — the @ mentions button went the same way, into the RailActions menu
// (`rail-action-mentions`, tested there — including the gate that used to
// live here). That leaves this bar holding NOTHING but the opener, which is
// the precondition #985 needs to drop `.shell-chrome` entirely and float a
// lone ☰. The tests below are what stops the @ drifting back: this component
// no longer imports selection, mentionsWindow or theme at all.
//
// UX-5 bucket A (2026-05-19) — the hamburger slot was dropped from
// ShellChrome entirely. Pre-bucket the chrome rendered a hamburger
// that duplicated TopicBar's `.topic-bar-hamburger` on mobile and
// toggled a no-op `.open` class on desktop. Hamburger-related tests
// moved out; only the rail opener remains.
//
// UX-5 bucket BM (2026-05-20) — the `ChromeButtons` named export was
// dropped (BT introduced it for the mobile-channel `inlineChromeSlot`
// path; BM moved that surface into the members drawer footer, so the
// only consumer is gone and the export folded back into the default
// ShellChrome body). The `describe("ChromeButtons inline export")`
// block was deleted with the export.

import ShellChrome from "../ShellChrome";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ShellChrome (bucket L)", () => {
  // #71 INC-2 — the cog left this bar for the rail; the always-present
  // right-edge button is now the ☰ rail opener.
  it("always renders the rail opener (no window selected)", () => {
    render(() => <ShellChrome onOpenRail={vi.fn()} />);
    const opener = screen.getByTestId("shell-chrome-rail-opener");
    expect(opener).toBeInTheDocument();
  });

  it("clicking the rail opener fires onOpenRail", () => {
    const onOpenRail = vi.fn();
    render(() => <ShellChrome onOpenRail={onOpenRail} />);
    fireEvent.click(screen.getByTestId("shell-chrome-rail-opener"));
    expect(onOpenRail).toHaveBeenCalled();
  });

  // #71 INC-2 — the cog no longer lives in ShellChrome (moved to the rail's
  // ActionCluster). Guard against a regression that reintroduces it here.
  it("does NOT render the settings cog (moved to the rail's ActionCluster)", () => {
    render(() => <ShellChrome onOpenRail={vi.fn()} />);
    expect(screen.queryByTestId("shell-chrome-cog")).toBeNull();
    expect(screen.queryByTestId("action-cluster-cog")).toBeNull();
  });

  it("UX-5 bucket A — does NOT render a hamburger button (slot dropped)", () => {
    const { container } = render(() => <ShellChrome onOpenRail={vi.fn()} />);
    expect(container.querySelectorAll(".shell-chrome-hamburger").length).toBe(0);
    expect(screen.queryByLabelText(/open channel sidebar/i)).toBeNull();
    expect(screen.queryByLabelText(/open members sidebar/i)).toBeNull();
  });

  // #473 — the standalone archive button was removed from ShellChrome (it
  // was a third archive entry point). Guard against a regression that
  // reintroduces it: it must never render, on any window kind or viewport.
  it("does NOT render an archive button (#473 — archive lives in the RailActions drawer)", () => {
    render(() => <ShellChrome onOpenRail={vi.fn()} />);
    expect(screen.queryByTestId("shell-chrome-archive")).toBeNull();
  });

  // #986 — the @ mentions button moved into the RailActions menu. The gate
  // that decided whether to show it (a bundle exists for the selected
  // network) went WITH it and is asserted in RailActions.test.tsx; what this
  // owns is that no copy stayed behind. Rendered with no store mocks at all
  // — the component reads no stores any more, so a reintroduced @ would have
  // to re-import them and this bar would stop being the lone-☰ band #985
  // is about to delete.
  it("#986 — renders the opener and NOTHING else (no @ mentions button)", () => {
    const { container } = render(() => <ShellChrome onOpenRail={vi.fn()} />);
    expect(screen.queryByTestId("shell-chrome-mentions")).toBeNull();
    expect(screen.queryByLabelText(/open mentions/i)).toBeNull();
    expect(container.querySelectorAll("button")).toHaveLength(1);
  });
});
