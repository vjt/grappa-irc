import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  overlayCount,
  __resetForTest as resetOverlayLock,
  runTopmostOverlayEscape,
} from "../lib/overlayScrollLock";

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
// outcomes, and reuse the ONE launcher-mutex path). The REAL channelKey,
// presenceFilter and members stores drive the denoise toggle wiring
// (use production code, don't re-implement logic).

// #1038 — `channelKey` used to be stubbed here with an UNFOLDED
// `${slug} ${name}`, justified by "conversationMute folds the mute key through
// canonicalChannel anyway, and that fold is what the picker must emit". That
// justification died with this issue: the mute key is now BUILT by
// `channelKey`, so the stub would swallow the exact fold the picker is
// supposed to emit and every assertion below would be measuring the stub.
// Nothing asserted on the stubbed denoise key, so it went rather than growing
// a fold of its own.

// #950 — the mute WRITE is a server round-trip (GET-then-PUT, see
// notificationPrefs.ts). Stub the two verbs and the mirrored signal so the
// picker's gating and its argument are what these tests constrain; the verbs
// themselves are covered in notificationPrefs.test.ts.
const applyConversationMute = vi.fn().mockResolvedValue(undefined);
const clearConversationMute = vi.fn().mockResolvedValue(undefined);
const mutedHolder = vi.hoisted(() => ({
  value: {} as Record<string, { until: number | null }> | undefined,
}));
vi.mock("../lib/notificationPrefs", () => ({
  applyConversationMute: (...a: unknown[]) => applyConversationMute(...a),
  clearConversationMute: (...a: unknown[]) => clearConversationMute(...a),
  notificationPrefs: () => ({ muted_targets: mutedHolder.value }),
}));

const adminHolder = { value: false };
vi.mock("../lib/networks", () => ({
  isAdmin: () => adminHolder.value,
  // #986 — pulled in transitively by lib/lifecycle (updateIdentity refetches
  // /me). Unused by the rail, but a named import must resolve.
  refetchUser: vi.fn(),
}));

// #986 — the two lifecycle entries land the operator on /login once the
// teardown resolves. House pattern (DeleteAccountModal.test / SettingsDrawer
// .test): stub the router hook rather than wrapping every render in a Router.
const navigateMock = vi.fn();
vi.mock("@solidjs/router", () => ({
  useNavigate: () => navigateMock,
}));

// #188/#986 — the @ mentions entry only surfaces when the network implied by
// the current selection HAS a bundle to re-open. Mutable holder per test.
const mentionsBundles = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock("../lib/mentionsWindow", () => ({
  mentionsBundleBySlug: () => mentionsBundles.value,
}));

// #986 — the subject drives BOTH the detach gate and which of the three quit
// bodies the modal shows. Spread the REAL auth module so the shared
// `isPersistentIdentity` predicate runs for real against the stubbed
// getSubject — the classification IS what is under test. lib/lifecycle stays
// UNMOCKED so the copy asserted below is the copy that ships; only its
// side-effecting leaves (logout / quitAll / the REST verbs) are stubbed.
const subjectHolder = vi.hoisted(() => ({
  current: null as
    | { kind: "user"; id: string; name: string }
    | { kind: "visitor"; id: string; nick: string; registered?: boolean }
    | null,
}));
vi.mock("../lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/auth")>()),
  logout: vi.fn().mockResolvedValue(undefined),
  token: () => "test-bearer",
  getSubject: () => subjectHolder.current,
}));

vi.mock("../lib/quit", () => ({
  quitAll: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/api", () => ({
  deleteAccount: vi.fn().mockResolvedValue(undefined),
  updateNetworkIdentity: vi.fn().mockResolvedValue(undefined),
}));

type Sel = { networkSlug: string; channelName: string; kind: string } | null;
// #1040 — a REAL signal behind the holder, not the plain object this was. The
// rail now varies by window KIND (home expands the column, every other kind
// keeps #500's launcher), so a test that lands on home mid-life has to notify
// consumers: a plain getter stores the new value and re-renders nothing (the
// same upgrade Shell.test.tsx made for its selection mock, for the same
// reason). The `.value` accessor keeps every existing call site untouched.
const [selSignal, setSelSignal] = createSignal<Sel>(null);
const selHolder = {
  get value(): Sel {
    return selSignal();
  },
  set value(v: Sel) {
    setSelSignal(v);
  },
};
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
const openMentionsPanel = vi.fn();
vi.mock("../lib/mobilePanel", () => ({
  openHomePanel: (...a: unknown[]) => openHomePanel(...a),
  openListPanel: (...a: unknown[]) => openListPanel(...a),
  openThemesPanel: (...a: unknown[]) => openThemesPanel(...a),
  openAdminPanel: (...a: unknown[]) => openAdminPanel(...a),
  openSettingsPanel: (...a: unknown[]) => openSettingsPanel(...a),
  openArchivePanel: (...a: unknown[]) => openArchivePanel(...a),
  openMentionsPanel: (...a: unknown[]) => openMentionsPanel(...a),
}));

import ConfirmModal from "../ConfirmModal";
import { channelKey } from "../lib/channelKey";
import { dismissConfirm } from "../lib/confirmDialog";
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
  mentionsBundles.value = {};
  subjectHolder.current = null;
  mutedHolder.value = {};
  dismissConfirm();
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
// #1040 — the contract is "the actions are reachable", not "click the
// launcher": on home they are already expanded in flow and no launcher exists
// to click. Keyed on the MENU being rendered rather than on the kind, so a
// channel window whose launcher went missing still fails loudly here instead of
// silently no-opping. Same adaptation the e2e `openRailMenu` fixture needed.
function openMenu(): void {
  if (document.querySelector(".rail-actions-menu") !== null) return;
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

// #986 — the three arrivals. The @ mentions door left `.shell-chrome` (whose
// band #985 removes) and the two lifecycle verbs left the settings drawer,
// where detach fired with NO confirmation at all and quit armed a two-tap
// that said "really quit IRC?" to every subject alike. Here they are rail
// entries behind the shared #195 confirm modal.
//
// The load-bearing assertions are about the modal BODY, mounted for real:
// a naive "the modal opens" test passes with one shared sentence, which is
// precisely the defect this issue exists to close.
describe("RailActions — @ mentions (#986)", () => {
  it("shows the entry when the selected network has a bundle to re-open", () => {
    selHolder.value = channelSel;
    mentionsBundles.value = { freenode: {} };
    render(() => <RailActions setters={setters} />);
    openMenu();
    const entry = screen.getByTestId("rail-action-mentions");
    expect(entry).toBeInTheDocument();
    expect(entry).toHaveTextContent("mentions");
  });

  it("hides the entry when that network has no bundle — nothing to re-open", () => {
    selHolder.value = channelSel;
    mentionsBundles.value = {};
    render(() => <RailActions setters={setters} />);
    openMenu();
    expect(screen.queryByTestId("rail-action-mentions")).toBeNull();
  });

  it("hides the entry with no network context at all (home)", () => {
    roomsSlugHolder.value = null;
    mentionsBundles.value = { freenode: {} };
    render(() => <RailActions setters={setters} />);
    openMenu();
    expect(screen.queryByTestId("rail-action-mentions")).toBeNull();
  });

  it("routes through the shared nav mutex to the mentions window", () => {
    selHolder.value = channelSel;
    mentionsBundles.value = { freenode: {} };
    render(() => <RailActions setters={setters} />);
    openMenu();
    fireEvent.click(screen.getByTestId("rail-action-mentions"));
    expect(openMentionsPanel).toHaveBeenCalledWith(setters, expect.any(Function));
    // The nav thunk is what actually selects the window — run it and assert
    // the payload, rather than trusting that the mutex helper was called.
    const navThunk = openMentionsPanel.mock.calls[0]?.[1] as (() => void) | undefined;
    if (navThunk === undefined) throw new Error("openMentionsPanel got no nav thunk");
    navThunk();
    expect(setSelectedChannel).toHaveBeenCalledWith({
      networkSlug: "freenode",
      channelName: "",
      kind: "mentions",
    });
  });

  // #473's capability-only rule, applied. The @ was `isMobile()`-gated in
  // ShellChrome to avoid duplicating the desktop Sidebar mentions row (#71
  // INC-2); in the rail that gate would be the one thing this component says
  // it never does, and `home` is the standing precedent for a rail launcher
  // that doubles a sidebar row.
  it("carries NO form-factor gate — desktop gets it too", () => {
    selHolder.value = channelSel;
    mentionsBundles.value = { freenode: {} };
    render(() => <RailActions setters={setters} />);
    openMenu();
    // isMobile is never consulted: the module is not even imported, so a
    // reintroduced gate would have to add it back. Assert the outcome the
    // rule produces — the entry is there with no viewport stubbing at all.
    expect(screen.getByTestId("rail-action-mentions")).toBeInTheDocument();
  });
});

describe("RailActions — detach + quit (#986)", () => {
  const USER = { kind: "user" as const, id: "u1", name: "alice" };
  const REGISTERED_VISITOR = {
    kind: "visitor" as const,
    id: "v1",
    nick: "vjt",
    registered: true,
  };
  const ANON_VISITOR = { kind: "visitor" as const, id: "v2", nick: "guest", registered: false };

  const mountWithSubject = (subject: typeof subjectHolder.current): void => {
    subjectHolder.current = subject;
    render(() => (
      <>
        <RailActions setters={setters} />
        <ConfirmModal />
      </>
    ));
    openMenu();
  };

  const quitBodyFor = (subject: typeof subjectHolder.current): string => {
    mountWithSubject(subject);
    fireEvent.click(screen.getByTestId("quit-irc-btn"));
    return screen.getByTestId("confirm-modal-body").textContent ?? "";
  };

  it("offers quit to every subject and detach only to a persistent identity", () => {
    mountWithSubject(ANON_VISITOR);
    expect(screen.getByTestId("quit-irc-btn")).toBeInTheDocument();
    expect(screen.queryByTestId("detach-btn")).toBeNull();

    cleanup();
    mountWithSubject(USER);
    expect(screen.getByTestId("detach-btn")).toBeInTheDocument();

    cleanup();
    mountWithSubject(REGISTERED_VISITOR);
    expect(screen.getByTestId("detach-btn")).toBeInTheDocument();
  });

  it("carries a name next to the glyph, like every other rail row", () => {
    mountWithSubject(USER);
    expect(screen.getByTestId("detach-btn")).toHaveTextContent("detach");
    expect(screen.getByTestId("quit-irc-btn")).toHaveTextContent("quit");
  });

  // THE assertion of this issue. Three subjects, three visibly different
  // sentences in the rendered modal — not three calls that happen to open a
  // modal carrying one shared string.
  it("renders a DIFFERENT quit modal body for each of the three subject shapes", () => {
    const user = quitBodyFor(USER);
    cleanup();
    const registeredVisitor = quitBodyFor(REGISTERED_VISITOR);
    cleanup();
    const anon = quitBodyFor(ANON_VISITOR);

    expect(user).not.toBe("");
    expect(new Set([user, registeredVisitor, anon]).size).toBe(3);
    // …and each says the thing that is TRUE for it: only the anon session is
    // destroyed, both persistent ones survive.
    expect(anon).toMatch(/delete|permanently/i);
    expect(user).toMatch(/survive/i);
    expect(registeredVisitor).toMatch(/survive/i);
    expect(user).not.toMatch(/delete/i);
    expect(registeredVisitor).not.toMatch(/delete/i);
  });

  it("opens ONE confirm paradigm — the shared modal, never a two-tap arm", () => {
    mountWithSubject(USER);
    const quit = screen.getByTestId("quit-irc-btn");
    fireEvent.click(quit);
    // The old settings control re-labelled itself to "really quit IRC?" on
    // the first tap and fired on the second. The rail entry does neither: it
    // keeps its label and hands off to the modal.
    expect(quit).toHaveTextContent("quit");
    expect(quit).not.toHaveTextContent(/really quit/i);
    expect(screen.getByTestId("confirm-modal")).toBeInTheDocument();
  });

  it("a tap tears NOTHING down until the modal is confirmed", async () => {
    const quitMod = await import("../lib/quit");
    const auth = await import("../lib/auth");
    mountWithSubject(USER);

    fireEvent.click(screen.getByTestId("quit-irc-btn"));
    expect(quitMod.quitAll).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("confirm-modal-cancel"));
    expect(quitMod.quitAll).not.toHaveBeenCalled();
    expect(auth.logout).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("confirming quit parks all networks and lands on /login", async () => {
    const quitMod = await import("../lib/quit");
    mountWithSubject(USER);

    fireEvent.click(screen.getByTestId("quit-irc-btn"));
    fireEvent.click(screen.getByTestId("confirm-modal-confirm"));

    expect(quitMod.quitAll).toHaveBeenCalled();
    await vi.waitFor(() => expect(navigateMock).toHaveBeenCalledWith("/login", { replace: true }));
  });

  it("confirming detach revokes the web session WITHOUT parking anything", async () => {
    const quitMod = await import("../lib/quit");
    const auth = await import("../lib/auth");
    mountWithSubject(USER);

    fireEvent.click(screen.getByTestId("detach-btn"));
    fireEvent.click(screen.getByTestId("confirm-modal-confirm"));

    expect(auth.logout).toHaveBeenCalled();
    // detach is the ABSENCE of teardown — the bouncer stays up.
    expect(quitMod.quitAll).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(navigateMock).toHaveBeenCalledWith("/login", { replace: true }));
  });

  // The full row order with EVERY gate satisfied. Shell.test.tsx asserts the
  // same list against a mounted Shell but its auth fixture has no subject, so
  // detach is absent there; this is the one place the complete contract —
  // navigation set first, lifecycle pair last — is pinned.
  it("puts the lifecycle pair LAST, after the whole navigation set", () => {
    adminHolder.value = true;
    selHolder.value = channelSel;
    mentionsBundles.value = { freenode: {} };
    subjectHolder.current = USER;
    const { container } = render(() => <RailActions setters={setters} />);
    openMenu();
    const order = Array.from(
      container.querySelectorAll<HTMLElement>(".rail-actions-menu .rail-action"),
    ).map((b) => b.getAttribute("data-testid"));
    expect(order).toEqual([
      "mobile-panel-home",
      "mobile-panel-list",
      "rail-action-mentions",
      "mobile-panel-themes",
      "mobile-panel-archive",
      "action-cluster-cog",
      "mobile-panel-admin",
      "presence-toggle",
      "rail-action-mute",
      "detach-btn",
      "quit-irc-btn",
    ]);
  });

  it("closes the menu on tap so no live menu waits under the modal", () => {
    mountWithSubject(USER);
    fireEvent.click(screen.getByTestId("quit-irc-btn"));
    expect(screen.queryByTestId("action-cluster-cog")).toBeNull();
  });
});

// #950 — the mute/snooze picker. #866 shipped the storage, both expiry readers
// and the tests; NOTHING wrote an integer `until`, so the snooze was
// unreachable. This is the door.
//
// Two properties separate it from its neighbour `denoise`:
//   * the GATE is a selected CONVERSATION — a channel OR a query — because the
//     mute is keyed on the conversation, and for a DM that key is the PEER
//     (#866: an inbound DM is stored with `channel = own_nick`, so keying on
//     the row's channel would collapse every DM onto one entry).
//   * a snooze is a CHOICE, not a toggle: it resolves in place and THEN closes
//     the menu, where denoise deliberately stays open to be re-flipped.
describe("RailActions — mute snooze picker (#950)", () => {
  const querySel: Sel = { networkSlug: "freenode", channelName: "Alice", kind: "query" };
  // #1038 — the rail writes the composite ChannelKey. `channelSel` is on
  // "freenode", so the key it produces is that slug plus the folded target.
  const ITALIA = channelKey("freenode", "#italia");
  const ALICE = channelKey("freenode", "alice");
  const NOW_MS = 1_800_000_000_000;
  const NOW_SECONDS = NOW_MS / 1000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const openWith = (sel: Sel): void => {
    selHolder.value = sel;
    render(() => <RailActions setters={setters} />);
    openMenu();
  };

  const pick = (value: string): void => {
    const picker = screen.getByTestId("rail-mute-picker") as HTMLSelectElement;
    picker.value = value;
    fireEvent.change(picker);
  };

  it("is absent on a window that is not a conversation (home / server / admin)", () => {
    openWith({ networkSlug: "$home", channelName: "home", kind: "home" });
    expect(screen.queryByTestId("rail-mute-picker")).toBeNull();
  });

  it("offers the snooze durations on a channel window", () => {
    openWith(channelSel);
    const picker = screen.getByTestId("rail-mute-picker") as HTMLSelectElement;
    const values = Array.from(picker.options).map((o) => o.value);
    expect(values).toEqual(expect.arrayContaining(["1h", "8h", "tomorrow", "forever"]));
  });

  it("is offered on a QUERY window too — a DM is a conversation", () => {
    openWith(querySel);
    expect(screen.getByTestId("rail-mute-picker")).toBeInTheDocument();
  });

  it("writes now + one hour under the folded channel key", () => {
    openWith({ ...channelSel, channelName: "#Italia" });
    pick("1h");
    expect(applyConversationMute).toHaveBeenCalledWith(ITALIA, NOW_SECONDS + 3_600);
  });

  // The DM row of the #866 truth table, at the door: the key is the PEER, and
  // it is folded. A picker keyed on anything else silences the wrong thing.
  it("keys a DM snooze on the folded PEER nick", () => {
    openWith(querySel);
    pick("8h");
    expect(applyConversationMute).toHaveBeenCalledWith(ALICE, NOW_SECONDS + 28_800);
  });

  it("writes a null until for the permanent offer", () => {
    openWith(channelSel);
    pick("forever");
    expect(applyConversationMute).toHaveBeenCalledWith(ITALIA, null);
  });

  it("closes the menu once the choice is made — a snooze is not a toggle", () => {
    openWith(channelSel);
    pick("1h");
    expect(screen.queryByTestId("action-cluster-cog")).toBeNull();
  });

  it("stays put — and writes nothing — when the placeholder row is re-picked", () => {
    openWith(channelSel);
    pick("");
    expect(applyConversationMute).not.toHaveBeenCalled();
    expect(screen.getByTestId("action-cluster-cog")).toBeInTheDocument();
  });

  it("offers unmute only for a conversation that is currently muted", () => {
    mutedHolder.value = { [ITALIA]: { until: NOW_SECONDS + 60 } };
    openWith(channelSel);
    const picker = screen.getByTestId("rail-mute-picker") as HTMLSelectElement;
    expect(Array.from(picker.options).map((o) => o.value)).toContain("off");
  });

  it("offers no unmute for a conversation nobody muted", () => {
    openWith(channelSel);
    const picker = screen.getByTestId("rail-mute-picker") as HTMLSelectElement;
    expect(Array.from(picker.options).map((o) => o.value)).not.toContain("off");
  });

  it("unmuting routes through the clear verb, not a mute with a past expiry", () => {
    mutedHolder.value = { [ITALIA]: { until: null } };
    openWith(channelSel);
    pick("off");
    expect(clearConversationMute).toHaveBeenCalledWith(ITALIA);
    expect(applyConversationMute).not.toHaveBeenCalled();
  });

  it("does NOT read as muted when only ANOTHER network's copy is muted (#1038)", () => {
    // Same channel name, different network. Pre-#1038 the rail keyed on the
    // bare name, so this row claimed "muted" for a conversation the operator
    // had never silenced — and offered `off`, which would have written a
    // clear for the other network's mute.
    mutedHolder.value = { [channelKey("azzurra", "#italia")]: { until: null } };
    openWith(channelSel);

    expect(screen.getByTestId("rail-action-mute")).not.toHaveTextContent(/muted/i);
    const picker = screen.getByTestId("rail-mute-picker") as HTMLSelectElement;
    expect(Array.from(picker.options).map((o) => o.value)).not.toContain("off");
  });

  it("says on the row itself whether the conversation is already silenced", () => {
    mutedHolder.value = { [ITALIA]: { until: NOW_SECONDS + 60 } };
    openWith(channelSel);
    expect(screen.getByTestId("rail-action-mute")).toHaveTextContent(/muted/i);
  });
});

// #1040 — HOME is the one window where #500's collapse buys nothing. #500
// collapsed the column because a big channel's NICK LIST pushed it below the
// fold; `RailContext` renders nothing for home, so there is no list, no
// overflow, and the tap the launcher costs buys no space back. vjt: "in home il
// menu actions deve essere espanso, e i bottoni visibili".
//
// The expanded state is NOT "the overlay, left open". These tests pin the three
// things that separate the two readings, each of which the issue calls out:
//   * the buttons are in the DOM with no interaction, and the LAUNCHER is gone
//     (a door is not needed from inside the room),
//   * no overlay refcount is held — a permanent column is not a popover, and a
//     stuck refcount freezes ScrollbackPane (#608),
//   * Escape cannot close it — there would be no visible way to bring it back.
// The collapsed contract for every OTHER kind is pinned by the #500 describe
// above, which runs on a channel selection.
describe("RailActions expanded home rail (#1040)", () => {
  const homeSel: Sel = { networkSlug: "$home", channelName: "$home", kind: "home" };

  // createOverlayLock defers its push a microtask (the #608 leak-safe shape),
  // so the refcount must be read after one turn of the loop, not synchronously.
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  it("renders every action with no interaction, and no launcher to tap", () => {
    selHolder.value = homeSel;
    const { container } = render(() => <RailActions setters={setters} />);
    // No openMenu() anywhere in this test — that is the point.
    expect(screen.getByTestId("action-cluster-cog")).toBeInTheDocument();
    expect(screen.getByTestId("mobile-panel-home")).toBeInTheDocument();
    expect(screen.getByTestId("mobile-panel-archive")).toBeInTheDocument();
    expect(screen.queryByTestId(LAUNCHER)).toBeNull();
    // The CSS switches the popover geometry off this class (position/max-height
    // /margin — pinned in railExpandedHome.test.ts), so its absence would leave
    // the column laid out as a bottom-anchored overlay.
    expect(container.querySelector(".rail-actions")).toHaveClass("expanded");
  });

  it("an action still fires through the shared mutex, and the column stays up", () => {
    selHolder.value = homeSel;
    render(() => <RailActions setters={setters} />);
    fireEvent.click(screen.getByTestId("action-cluster-cog"));
    expect(openSettingsPanel).toHaveBeenCalledWith(setters);
    // `close()` runs on every action; on home it must not empty the rail — the
    // column is the window's content, not a single-shot popover.
    expect(screen.getByTestId("action-cluster-cog")).toBeInTheDocument();
  });

  it("holds no overlay refcount and cannot be closed by Escape", async () => {
    selHolder.value = homeSel;
    render(() => <RailActions setters={setters} />);
    await settle();
    // A permanent column that pushed the refcount would scroll-lock the app for
    // as long as the operator stays on home, and freeze the scrollback's
    // overlay snapshot with it (#608).
    expect(overlayCount()).toBe(0);
    // Escape closing it would strand the operator: there is no launcher left to
    // reopen it with.
    expect(runTopmostOverlayEscape()).toBe(false);
    expect(screen.getByTestId("action-cluster-cog")).toBeInTheDocument();
  });

  it("retires a menu opened on a channel when the operator lands on home", async () => {
    selHolder.value = channelSel;
    render(() => <RailActions setters={setters} />);
    openMenu();
    await settle();
    expect(overlayCount()).toBe(1);

    // Arriving on home by a door that is NOT a rail action (the #986 demote
    // redirect, a sidebar row while the pointerdown dismiss is mid-flight)
    // would otherwise leave the transient menu's refcount held under a column
    // that is not transient at all …
    selHolder.value = homeSel;
    await settle();
    expect(overlayCount()).toBe(0);
    expect(screen.getByTestId("action-cluster-cog")).toBeInTheDocument();

    // … and hand the menu straight back, already expanded, on the way out.
    selHolder.value = channelSel;
    await settle();
    expect(screen.getByTestId(LAUNCHER)).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("action-cluster-cog")).toBeNull();
  });

  // #1048 — the shape the rail wears BEFORE the selection resolves. Shell lands
  // on `$home` provisionally so the app is never blank, but it does so in an
  // effect: for the first paint `selectedChannel()` is still `null`, `expanded()`
  // is false, and the rail shows #500's COLLAPSED shape — a launcher with no
  // menu — then swaps. The #1048 CI traces caught it as two DOM snapshots 128ms
  // apart, and six specs went red because the e2e `openRailMenu` fixture read
  // that first snapshot ONCE and then waited out its deadline on a launcher home
  // was about to unmount. Pinned here so the flash is a known, deliberate state
  // rather than a thing rediscovered from a red gate: any probe of this rail has
  // to keep looking, which is why that fixture's menu check now lives inside its
  // retry loop. Remove the flash and that fixture comment goes stale with it.
  it("wears the collapsed shape until the selection resolves, then expands", () => {
    selHolder.value = null;
    const { container } = render(() => <RailActions setters={setters} />);
    expect(screen.getByTestId(LAUNCHER)).toBeInTheDocument();
    expect(container.querySelector(".rail-actions-menu")).toBeNull();
    expect(container.querySelector(".rail-actions")).not.toHaveClass("expanded");

    selHolder.value = homeSel;
    expect(screen.queryByTestId(LAUNCHER)).toBeNull();
    expect(container.querySelector(".rail-actions-menu")).not.toBeNull();
    expect(container.querySelector(".rail-actions")).toHaveClass("expanded");
  });
});
