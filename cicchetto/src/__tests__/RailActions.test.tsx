import { fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetForTest as resetOverlayLock } from "../lib/overlayScrollLock";

// #473 — RailActions is the ONE labelled button drawer at the bottom of the
// members rail. It carries every rail affordance — home · rooms · themes ·
// archive · settings · admin · denoise — each as an icon + TEXT label,
// identical on desktop and mobile. It supersedes the two split surfaces
// (#71 INC-2 ActionCluster at the top + the mobile `.mobile-panel-actions`
// footer) AND the desktop Sidebar `<details>` archive. Per-button gating that
// is about CAPABILITY, not form factor, stays: admin is isAdmin()-gated, rooms
// needs a network context, denoise is channel-gated. Archive is ALWAYS shown
// (like settings) — the grouped multi-network ArchiveModal must be reachable
// from every window kind. The mobile-only form-factor gates are dropped —
// desktop gets the same set.
//
// Store reads (selection, networks isAdmin, archiveContext) are mocked so the
// gates are driven deterministically; the mobilePanel helpers are spied to
// assert the buttons route through the shared mutex layer (CLAUDE.md: assert
// outcomes, and reuse the ONE launcher-mutex path). channelKey is stubbed and
// the REAL presenceFilter + members stores drive the denoise toggle wiring
// (use production code, don't re-implement logic).

vi.mock("../lib/channelKey", () => ({
  channelKey: (slug: string, name: string) => `${slug} ${name}`,
}));

const adminHolder = { value: false };
vi.mock("../lib/networks", () => ({
  isAdmin: () => adminHolder.value,
}));

type Sel = { networkSlug: string; channelName: string; kind: string } | null;
const selHolder: { value: Sel } = { value: null };
const setSelectedChannel = vi.fn();
vi.mock("../lib/selection", () => ({
  selectedChannel: () => selHolder.value,
  setSelectedChannel: (...args: unknown[]) => setSelectedChannel(...args),
}));

const roomsSlugHolder: { value: string | null } = { value: "freenode" };
vi.mock("../lib/archiveContext", () => ({
  archiveSlugForSelection: () => roomsSlugHolder.value,
}));

const openHomePanel = vi.fn();
const openListPanel = vi.fn();
const openThemesPanel = vi.fn();
const openAdminPanel = vi.fn();
const openSettingsPanel = vi.fn();
const openArchivePanel = vi.fn();
vi.mock("../lib/mobilePanel", () => ({
  openHomePanel: (...a: unknown[]) => openHomePanel(...a),
  openListPanel: (...a: unknown[]) => openListPanel(...a),
  openThemesPanel: (...a: unknown[]) => openThemesPanel(...a),
  openAdminPanel: (...a: unknown[]) => openAdminPanel(...a),
  openSettingsPanel: (...a: unknown[]) => openSettingsPanel(...a),
  openArchivePanel: (...a: unknown[]) => openArchivePanel(...a),
}));

import RailActions from "../RailActions";

const channelSel: Sel = { networkSlug: "freenode", channelName: "#italia", kind: "channel" };

const setters = {
  membersOpen: () => false,
  setMembersOpen: vi.fn(),
  setSettingsOpen: vi.fn(),
};

beforeEach(() => {
  adminHolder.value = false;
  selHolder.value = null;
  roomsSlugHolder.value = "freenode";
});

afterEach(() => {
  vi.clearAllMocks();
  // togglePresence persists an explicit pref in localStorage — clear it so it
  // can't leak into sibling tests reading the same key.
  localStorage.clear();
  // #500 — the launcher menu drives createOverlayLock (refcount + document
  // touchmove listener); reset the module singleton so a leaked open menu
  // can't bleed the refcount / listener into a sibling test.
  resetOverlayLock();
});

// #500 — the launcher testid (the ONE permanently-pinned button) + a helper
// that opens the collapsible menu. Every existing per-button assertion below
// now goes THROUGH the launcher: the buttons are collapsed by default and only
// reachable after a tap. That mirrors the e2e contract (open the launcher,
// THEN assert the action is reachable + clickable) — proving the #500 bug is
// fixed instead of photographing the old always-expanded layout.
const LAUNCHER = "rail-actions-launcher";
function openMenu(): void {
  fireEvent.click(screen.getByTestId(LAUNCHER));
}

// #473 button-set + gating contract. Post-#500 every assertion goes THROUGH the
// launcher: `openMenu()` expands the collapsible menu, THEN the button is
// asserted reachable / clickable / gated. Opening first is load-bearing — with
// the menu collapsed a gated button is absent too, so a bare queryByTestId
// would pass trivially and prove nothing about the gate.
describe("RailActions (#473)", () => {
  it("always renders the settings cog with the kept testid + aria-label", () => {
    render(() => <RailActions setters={setters} />);
    openMenu();
    const cog = screen.getByTestId("action-cluster-cog");
    expect(cog).toBeInTheDocument();
    // Many e2e specs locate the cog via getByLabel(/open settings/i) — the
    // aria-label is a load-bearing contract, kept verbatim.
    expect(cog).toHaveAttribute("aria-label", "open settings");
  });

  it("clicking the cog routes through openSettingsPanel(setters)", () => {
    render(() => <RailActions setters={setters} />);
    openMenu();
    fireEvent.click(screen.getByTestId("action-cluster-cog"));
    expect(openSettingsPanel).toHaveBeenCalledWith(setters);
  });

  it("renders home / themes always, each with an icon and a TEXT label", () => {
    render(() => <RailActions setters={setters} />);
    openMenu();
    const home = screen.getByTestId("mobile-panel-home");
    const themes = screen.getByTestId("mobile-panel-themes");
    expect(home).toBeInTheDocument();
    expect(themes).toBeInTheDocument();
    // #473 — the button now carries its name as visible text next to the glyph.
    expect(home).toHaveTextContent("home");
    expect(themes).toHaveTextContent("themes");
  });

  it("the /list launcher is labelled 'rooms' but keeps the mobile-panel-list testid", () => {
    render(() => <RailActions setters={setters} />);
    openMenu();
    const rooms = screen.getByTestId("mobile-panel-list");
    expect(rooms).toBeInTheDocument();
    expect(rooms).toHaveTextContent("rooms");
    // Trap #1: the button survives, so its testid stays pointed at a real thing.
    expect(rooms).not.toHaveTextContent("list");
  });

  it("home routes through openHomePanel; rooms through openListPanel", () => {
    render(() => <RailActions setters={setters} />);
    // home is a navigation action → it closes the menu, so re-open for rooms.
    openMenu();
    fireEvent.click(screen.getByTestId("mobile-panel-home"));
    expect(openHomePanel).toHaveBeenCalledTimes(1);
    openMenu();
    fireEvent.click(screen.getByTestId("mobile-panel-list"));
    expect(openListPanel).toHaveBeenCalledTimes(1);
  });

  it("always renders the archive button with an icon and a TEXT label", () => {
    render(() => <RailActions setters={setters} />);
    openMenu();
    const archive = screen.getByTestId("mobile-panel-archive");
    expect(archive).toBeInTheDocument();
    expect(archive).toHaveTextContent("archive");
    expect(archive).toHaveAttribute("aria-label", "open archive");
  });

  it("archive is NOT selection-gated: shown even with no network context", () => {
    // rooms hides on a null slug, but archive stays — the grouped
    // ArchiveModal is the single archive surface and must be reachable from
    // home / mentions / admin (which have no network) too.
    roomsSlugHolder.value = null;
    selHolder.value = null;
    render(() => <RailActions setters={setters} />);
    openMenu();
    expect(screen.queryByTestId("mobile-panel-list")).toBeNull();
    expect(screen.getByTestId("mobile-panel-archive")).toBeInTheDocument();
  });

  it("clicking archive routes through openArchivePanel(setters)", () => {
    render(() => <RailActions setters={setters} />);
    openMenu();
    fireEvent.click(screen.getByTestId("mobile-panel-archive"));
    expect(openArchivePanel).toHaveBeenCalledWith(setters);
  });

  it("gates rooms on a network context (archiveSlugForSelection null ⇒ hidden)", () => {
    roomsSlugHolder.value = null;
    render(() => <RailActions setters={setters} />);
    openMenu();
    expect(screen.queryByTestId("mobile-panel-list")).toBeNull();
  });

  it("gates admin on isAdmin(): hidden when false, shown when true", () => {
    const { unmount } = render(() => <RailActions setters={setters} />);
    openMenu();
    expect(screen.queryByTestId("mobile-panel-admin")).toBeNull();
    unmount();
    adminHolder.value = true;
    render(() => <RailActions setters={setters} />);
    openMenu();
    const admin = screen.getByTestId("mobile-panel-admin");
    expect(admin).toBeInTheDocument();
    expect(admin).toHaveTextContent("admin");
  });

  it("does NOT render the denoise toggle on a non-channel window (selection null)", () => {
    selHolder.value = null;
    render(() => <RailActions setters={setters} />);
    openMenu();
    expect(screen.queryByTestId("presence-toggle")).toBeNull();
  });

  it("renders the channel-gated denoise toggle (with label) on a channel window", () => {
    selHolder.value = channelSel;
    render(() => <RailActions setters={setters} />);
    openMenu();
    const toggle = screen.getByTestId("presence-toggle");
    expect(toggle).toBeInTheDocument();
    expect(toggle).toHaveTextContent("denoise");
    expect(toggle).toHaveClass("shell-chrome-btn");
  });

  it("toggling denoise flips the .presence-hidden accent state (explicit pref wins)", () => {
    selHolder.value = channelSel;
    const { container } = render(() => <RailActions setters={setters} />);
    // denoise is a state toggle, NOT a navigation action — it does NOT close the
    // menu, so the toggle stays mounted and its accent flip is observable.
    openMenu();
    const toggle = container.querySelector("[data-testid='presence-toggle']") as HTMLElement;
    expect(toggle).not.toHaveClass("presence-hidden");
    fireEvent.click(toggle);
    expect(toggle).toHaveClass("presence-hidden");
    expect(toggle).toHaveClass("shell-chrome-btn");
  });
});

// #588 → #913 — the upward-opening menu's max-height cap. #588 established
// that the cap is the space ABOVE the launcher, measured in JS. #913 is the
// residue: `getBoundingClientRect().top` is measured from the LAYOUT viewport
// origin, which under `viewport-fit=cover` is the PHYSICAL top of the display
// — behind the status bar. The inset itself is NOT resolvable from JS (an
// unregistered custom property's `env()` is not guaranteed to compute through
// `getComputedStyle`), so the split is: JS publishes the one number CSS cannot
// know (the anchor's viewport offset, gap already applied) as
// `--rail-menu-space-above`, and the stylesheet subtracts
// `var(--safe-area-inset-top)` from it. These tests pin the JS half; the CSS
// half is pinned in railMenuSafeArea.test.ts.
describe("RailActions upward-menu cap (#588 → #913)", () => {
  function stubAnchorTop(top: number): void {
    const root = document.querySelector(".rail-actions");
    if (!(root instanceof HTMLElement)) throw new Error(".rail-actions did not render");
    root.getBoundingClientRect = (): DOMRect =>
      ({ top, y: top, bottom: top, left: 0, x: 0, right: 0, width: 0, height: 0 }) as DOMRect;
  }

  function menuEl(): HTMLElement {
    const menu = document.querySelector(".rail-actions-menu");
    if (!(menu instanceof HTMLElement)) throw new Error(".rail-actions-menu did not render");
    return menu;
  }

  it("publishes the space above the launcher, gap deducted, as a custom property", () => {
    render(() => <RailActions setters={setters} />);
    stubAnchorTop(500);
    openMenu();
    // 500 (anchor top) - 8 (RAIL_MENU_TOP_GAP) — the CSS then takes the
    // safe-area inset off this, which is the whole #913 fix.
    expect(menuEl().style.getPropertyValue("--rail-menu-space-above")).toBe("492px");
  });

  it("re-measures when the viewport changes (rotation / keyboard reflow)", () => {
    render(() => <RailActions setters={setters} />);
    stubAnchorTop(500);
    openMenu();
    expect(menuEl().style.getPropertyValue("--rail-menu-space-above")).toBe("492px");
    // Rotation and `interactive-widget=resizes-content` both move the launcher;
    // a cap measured once at open would go stale and re-open the #588 overflow.
    stubAnchorTop(200);
    window.dispatchEvent(new Event("resize"));
    expect(menuEl().style.getPropertyValue("--rail-menu-space-above")).toBe("192px");
  });

  it("clamps at zero when the launcher sits above the gap", () => {
    render(() => <RailActions setters={setters} />);
    stubAnchorTop(4);
    openMenu();
    // A NEGATIVE length would be an invalid max-height → declaration dropped →
    // the uncapped #588 overflow returns.
    expect(menuEl().style.getPropertyValue("--rail-menu-space-above")).toBe("0px");
  });
});

// #500 — the always-expanded button column became unreachable on a big channel
// (desktop: it sat below the overflowing nick list; mobile: it ate the rail).
// vjt's fix: collapse every action behind ONE launcher permanently pinned at
// the bottom of the rail; tapping it expands the actions OVER the nick area.
// One component, both form factors — the launcher is the only permanent row.
describe("RailActions launcher (#500)", () => {
  it("renders the pinned launcher; the action buttons are collapsed (absent) by default", () => {
    selHolder.value = channelSel;
    render(() => <RailActions setters={setters} />);
    const launcher = screen.getByTestId("rail-actions-launcher");
    expect(launcher).toBeInTheDocument();
    // A11y: it advertises a menu it toggles, collapsed to start.
    expect(launcher).toHaveAttribute("aria-haspopup", "menu");
    expect(launcher).toHaveAttribute("aria-expanded", "false");
    // The actions are NOT in the DOM while collapsed — that is the whole point:
    // they cost no permanent vertical space beyond the single launcher row.
    expect(screen.queryByTestId("action-cluster-cog")).toBeNull();
    expect(screen.queryByTestId("mobile-panel-home")).toBeNull();
    expect(screen.queryByTestId("presence-toggle")).toBeNull();
  });

  it("tapping the launcher expands the menu and makes every action reachable", () => {
    selHolder.value = channelSel;
    render(() => <RailActions setters={setters} />);
    openMenu();
    expect(screen.getByTestId("rail-actions-launcher")).toHaveAttribute("aria-expanded", "true");
    // The collapsed actions are now reachable inside the expanded menu.
    expect(screen.getByTestId("action-cluster-cog")).toBeInTheDocument();
    expect(screen.getByTestId("mobile-panel-home")).toBeInTheDocument();
    expect(screen.getByTestId("presence-toggle")).toBeInTheDocument();
  });

  it("clicking an action runs it AND closes the menu (reachable then works)", () => {
    render(() => <RailActions setters={setters} />);
    openMenu();
    fireEvent.click(screen.getByTestId("action-cluster-cog"));
    // The action fired through the shared mutex helper …
    expect(openSettingsPanel).toHaveBeenCalledWith(setters);
    // … and the menu collapsed again (single-shot, like every other overlay).
    expect(screen.getByTestId("rail-actions-launcher")).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("action-cluster-cog")).toBeNull();
  });

  it("an outside pointerdown closes the menu without firing any action", () => {
    render(() => <RailActions setters={setters} />);
    openMenu();
    expect(screen.getByTestId("action-cluster-cog")).toBeInTheDocument();
    // A pointerdown OUTSIDE the rail closes the menu (non-blocking dismiss) — the
    // click still reaches its target, unlike a covering backdrop scrim.
    fireEvent.pointerDown(document.body);
    expect(screen.getByTestId("rail-actions-launcher")).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("action-cluster-cog")).toBeNull();
    expect(openSettingsPanel).not.toHaveBeenCalled();
  });
});
