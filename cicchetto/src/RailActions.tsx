import { type Component, createEffect, createSignal, onCleanup, Show } from "solid-js";
import { archiveSlugForSelection } from "./lib/archiveContext";
import { channelKey } from "./lib/channelKey";
import { syncedSetChannelPresencePref } from "./lib/displayPrefs";
import { membersByChannel } from "./lib/members";
import { spaceAbove } from "./lib/menuPosition";
import {
  type MobilePanelSetters,
  openAdminPanel,
  openArchivePanel,
  openHomePanel,
  openListPanel,
  openSettingsPanel,
  openThemesPanel,
} from "./lib/mobilePanel";
import { isAdmin } from "./lib/networks";
import { createOverlayLock } from "./lib/overlayScrollLock";
import { channelPresenceVisible } from "./lib/presenceFilter";
import { selectedChannel, setSelectedChannel } from "./lib/selection";
import {
  ADMIN_WINDOW_NAME,
  ADMIN_WINDOW_SLUG,
  HOME_WINDOW_NAME,
  HOME_WINDOW_SLUG,
  LIST_WINDOW_NAME,
} from "./lib/windowKinds";

// #473 → #500 — RailActions: EVERY rail affordance (home · rooms · themes ·
// archive · settings · admin · denoise) lives here, mounted unchanged by BOTH
// branches of Shell's `isMobile()` split — one component, one place, same
// buttons on desktop and mobile.
//
// #500 — the actions are COLLAPSED behind ONE launcher permanently pinned at
// the bottom of the rail; tapping it expands them in a menu that OVERLAYS the
// nick area. Before #500 they were an always-expanded column: on a big channel
// the nick list overflowed and pushed the column below the fold (desktop:
// unreachable) / squeezed the list (mobile). The launcher never shares vertical
// flow with the list, so it is always reachable; the expanded menu overlays
// rather than displaces, so it costs no permanent vertical space. The other
// half of the fix is the sibling `.members-pane`-owns-the-scroll CSS (so the
// pinned launcher stays in view while a long list scrolls internally, on
// desktop as it already did on mobile).
//
// Menu open state is a plain local signal — ephemeral UI state, like Shell's
// `membersOpen` / `settingsOpen`. cic-never-originates-state governs IRC WINDOW
// state (join/part/kick), NOT a client-local drawer toggle.
//
// Dismiss REUSES the shared overlay verb `createOverlayLock`: Escape joins the
// ordered ESC-close stack (keybindings → runTopmostOverlayEscape), and the
// refcount scroll-lock keeps the rail's `touch-action: pan-y` contract intact
// while the menu overlays the members list on mobile (the exact #500 caveat).
// Outside-click closes via a NON-blocking document `pointerdown` listener — NOT
// a covering backdrop scrim: a click outside the rail closes the menu AND still
// reaches its target, so a tap on a sidebar channel / compose selects it in one
// gesture. A full-viewport scrim (the modal family's idiom) would swallow that
// first click — wrong for a lightweight rail popover.
//
// The six window/panel launchers close the menu after firing (single-shot, like
// every overlay). `denoise` does NOT close it — it is a per-channel state toggle
// the operator flips in place (watching the accent flip, re-toggling), not a
// navigation away.
//
// Buttons, in order: home · rooms · themes · archive · settings · admin ·
// denoise. Each carries its NAME as visible text next to the glyph (#473: bare
// emoji had to be guessed / long-pressed).
//
// Gating is CAPABILITY-only — no form-factor gates (#473):
//   * home / themes / settings / archive — always.
//   * rooms — needs a network context (`archiveSlugForSelection()`).
//   * admin — `isAdmin()`.
//   * denoise — channel-gated (a channel window is selected).
//
// #473 — `archive` is ALWAYS shown, like settings — NOT selection-gated: the
// grouped `ArchiveModal` is the SINGLE archive surface and must be reachable
// from home / mentions / admin (no network context) too. rooms stays
// selection-gated because it navigates to a per-network `$list` window.
//
// The window-nav launchers (home / rooms / admin) and the own-signal launchers
// (settings / themes / archive) route through the SAME `lib/mobilePanel` mutex
// helpers, so the members | settings | archive | none invariant is untouched.

export type Props = {
  /**
   * The three Shell-local signals the mobilePanel mutex helpers wrap. The only
   * prop this drawer needs — every other input (selection, isAdmin, network
   * context, presence pref) is read directly from its store, matching the
   * house style (ShellChrome / the former ActionCluster read stores directly).
   */
  setters: MobilePanelSetters;
};

// #588 — px kept clear at the viewport top when the menu is capped to the space
// above the launcher, so the topmost row isn't flush against the screen edge
// (notch / status bar breathing room). Fed to `spaceAbove`.
const RAIL_MENU_TOP_GAP = 8;

const RailActions: Component<Props> = (props) => {
  // The channel this rail is currently showing, or null on non-channel windows
  // — drives the channel-gated denoise toggle (any channel: the toggle writes a
  // pref that persists to reconnect, so it is meaningful on parked channels
  // too). Mirrors the former Shell `railChannel` memo, now owned here.
  const channel = (): { networkSlug: string; channelName: string } | null => {
    const sel = selectedChannel();
    return sel && sel.kind === "channel"
      ? { networkSlug: sel.networkSlug, channelName: sel.channelName }
      : null;
  };

  // #500 — collapsible-menu open state (ephemeral UI-local, see moduledoc).
  const [open, setOpen] = createSignal(false);
  const close = (): void => {
    setOpen(false);
  };
  // Reuse the shared overlay verb: Escape close + refcount scroll-lock (keeps
  // the rail's touch-action/pan-y contract while the menu overlays the list).
  createOverlayLock(() => open(), ".rail-actions-menu", close);
  // #500 — outside-click dismiss via a NON-blocking pointerdown listener (not a
  // covering backdrop scrim): a click outside the rail closes the menu AND still
  // reaches its target, so tapping a sidebar channel / compose / hamburger
  // selects it in one gesture instead of being swallowed by a full-viewport
  // scrim. `rootRef` is the `.rail-actions` box (launcher + menu live inside it),
  // so clicks on the launcher/menu never self-close here — the launcher toggles,
  // the action buttons call close() themselves. Registered only while open; the
  // opening click already fired before the effect runs, so it can't self-close.
  let rootRef: HTMLDivElement | undefined;
  createEffect(() => {
    if (!open()) return;
    const onPointerDown = (e: PointerEvent): void => {
      const target = e.target as Node | null;
      if (rootRef && target && !rootRef.contains(target)) close();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    onCleanup(() => document.removeEventListener("pointerdown", onPointerDown, true));
  });

  // #588 — the menu opens UPWARD from the launcher (`bottom: 100%`), so its
  // usable height is ONLY the space above `rootRef` (the `.rail-actions`
  // container the absolute menu anchors to), NOT the whole viewport. The CSS
  // `max-height: var(--viewport-height)` capped it at the viewport, so on a
  // short viewport the overflowing rows grew off the top of the screen with no
  // scroll (menu shorter than its own oversized cap → `overflow-y: auto` never
  // engaged) and the top actions were unreachable. Measure the real space above
  // on open and cap `max-height` to it via the shared `menuPosition` seam
  // (`spaceAbove`) — the same clamp `UserContextMenu` uses, rather than a
  // second, differently-buggy CSS-only guess. Re-measure on `resize` /
  // `visualViewport` resize: that is where the mobile-keyboard-up case lives
  // (the visual viewport shrinks, the launcher rides up, the space above
  // changes). Null while closed → the menu isn't mounted anyway, and the JSX
  // falls back to the CSS var.
  const [menuMaxHeight, setMenuMaxHeight] = createSignal<number | null>(null);
  createEffect(() => {
    if (!open()) {
      setMenuMaxHeight(null);
      return;
    }
    const measure = (): void => {
      if (!rootRef) return;
      setMenuMaxHeight(spaceAbove(rootRef.getBoundingClientRect().top, RAIL_MENU_TOP_GAP));
    };
    measure();
    window.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("resize", measure);
    onCleanup(() => {
      window.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("resize", measure);
    });
  });

  return (
    // biome-ignore lint/a11y/useSemanticElements: role="group" gives the button cluster an accessible name; biome suggests <fieldset>, a form-control grouping (needs <legend>, paints a border) — wrong for a rail toolbar of action buttons.
    <div class="rail-actions" role="group" aria-label="window actions" ref={rootRef}>
      <Show when={open()}>
        {/* #500 — the expanded menu overlays the nick area above the launcher.
            Holds every action, unchanged. `createOverlayLock` targets this
            element's selector; outside-click dismiss is the pointerdown listener
            above (no covering scrim). */}
        <div
          class="rail-actions-menu"
          role="menu"
          style={
            // #588 — cap to the space above the launcher (JS-measured); the CSS
            // `max-height: var(--viewport-height)` stays as the pre-measure
            // fallback. undefined → the CSS rule applies.
            menuMaxHeight() !== null ? { "max-height": `${menuMaxHeight()}px` } : undefined
          }
        >
          {/* #291 — home launcher. Always visible; leftmost/topmost. */}
          <button
            type="button"
            class="shell-chrome-btn rail-action rail-action-home"
            aria-label="open home"
            data-testid="mobile-panel-home"
            onClick={() => {
              openHomePanel(props.setters, () =>
                setSelectedChannel({
                  networkSlug: HOME_WINDOW_SLUG,
                  channelName: HOME_WINDOW_NAME,
                  kind: "home",
                }),
              );
              close();
            }}
          >
            <span class="rail-action-icon" aria-hidden="true">
              {"\u{1F3E0}"}
            </span>
            <span class="rail-action-label">home</span>
          </button>

          {/* #361 — rooms launcher (channel directory / $list). Gated on a
              network context; labelled `rooms` (#473 naming note), testid kept
              as `mobile-panel-list` so existing tests keep pointing at a real
              thing. */}
          <Show when={archiveSlugForSelection()}>
            {(slug) => (
              <button
                type="button"
                class="shell-chrome-btn rail-action rail-action-rooms"
                aria-label="open rooms"
                data-testid="mobile-panel-list"
                onClick={() => {
                  openListPanel(props.setters, () =>
                    setSelectedChannel({
                      networkSlug: slug(),
                      channelName: LIST_WINDOW_NAME,
                      kind: "list",
                    }),
                  );
                  close();
                }}
              >
                <span class="rail-action-icon" aria-hidden="true">
                  {"\u{1F4C7}"}
                </span>
                <span class="rail-action-label">rooms</span>
              </button>
            )}
          </Show>

          {/* #75/#332 — themes launcher: opens the settings drawer on the themes
              sub-page (openThemesPanel deep-links via settingsNav). Always. */}
          <button
            type="button"
            class="shell-chrome-btn rail-action rail-action-themes"
            aria-label="open themes"
            data-testid="mobile-panel-themes"
            onClick={() => {
              openThemesPanel(props.setters);
              close();
            }}
          >
            <span class="rail-action-icon" aria-hidden="true">
              {"\u{1F3A8}"}
            </span>
            <span class="rail-action-label">themes</span>
          </button>

          {/* #473 — archive launcher. ALWAYS shown (like settings), NOT
              selection-gated: opens the ONE grouped ArchiveModal via the shared
              archive mutex helper. testid kept as `mobile-panel-archive`. */}
          <button
            type="button"
            class="shell-chrome-btn rail-action rail-action-archive"
            aria-label="open archive"
            data-testid="mobile-panel-archive"
            onClick={() => {
              openArchivePanel(props.setters);
              close();
            }}
          >
            <span class="rail-action-icon" aria-hidden="true">
              {"\u{1F4C2}"}
            </span>
            <span class="rail-action-label">archive</span>
          </button>

          {/* #71 INC-2 — settings cog. ALWAYS rendered; the cluster-wide
              "settings reachable from every window kind" rule. testid +
              aria-label kept verbatim: many e2e specs locate it via
              getByLabel(/open settings/i) and the `action-cluster-cog` testid. */}
          <button
            type="button"
            class="shell-chrome-btn rail-action rail-action-cog"
            aria-label="open settings"
            data-testid="action-cluster-cog"
            onClick={() => {
              openSettingsPanel(props.setters);
              close();
            }}
          >
            <span class="rail-action-icon" aria-hidden="true">
              {"\u{2699}\u{FE0F}"}
            </span>
            <span class="rail-action-label">settings</span>
          </button>

          {/* UX-6 bucket C — admin launcher. isAdmin()-gated (capability, not
              form factor). Selection-driven: Shell mounts AdminPane on kind
              "admin". */}
          <Show when={isAdmin()}>
            <button
              type="button"
              class="shell-chrome-btn rail-action rail-action-admin"
              aria-label="open admin"
              data-testid="mobile-panel-admin"
              onClick={() => {
                openAdminPanel(props.setters, () =>
                  setSelectedChannel({
                    networkSlug: ADMIN_WINDOW_SLUG,
                    channelName: ADMIN_WINDOW_NAME,
                    kind: "admin",
                  }),
                );
                close();
              }}
            >
              <span class="rail-action-icon" aria-hidden="true">
                {"\u{1F527}"}
              </span>
              <span class="rail-action-label">admin</span>
            </button>
          </Show>

          {/* #222 — per-channel join/part/quit/nick-change suppression toggle
              (denoise). Channel-gated. One tap writes an EXPLICIT pref
              ("show"/"hide") which by the precedence rule WINS over the
              member-count size default, so it pins the channel regardless of
              size. Reading channelPresenceVisible (tracks the pref signal) keeps
              the icon/accent reactive; memberCount feeds the size-default arm.
              Does NOT close the menu (#500): a state toggle flipped in place,
              not a navigation away. #473 gave it its first visible name:
              "denoise". */}
          <Show when={channel()}>
            {(ch) => {
              const key = () => channelKey(ch().networkSlug, ch().channelName);
              const memberCount = (): number => (membersByChannel()[key()] ?? []).length;
              const presenceShown = (): boolean => channelPresenceVisible(key(), memberCount());
              const togglePresence = (): void =>
                // #449 — local apply + server PUT so the pin converges across devices.
                syncedSetChannelPresencePref(key(), presenceShown() ? "hide" : "show");
              return (
                <button
                  type="button"
                  class="shell-chrome-btn rail-action rail-action-presence-toggle"
                  classList={{ "presence-hidden": !presenceShown() }}
                  data-testid="presence-toggle"
                  aria-pressed={!presenceShown()}
                  title={
                    presenceShown()
                      ? "Hide join/part/quit for this channel"
                      : "Show join/part/quit for this channel"
                  }
                  aria-label="denoise join/part/quit signalling"
                  onClick={togglePresence}
                >
                  <span class="rail-action-icon" aria-hidden="true">
                    {presenceShown() ? "\u{1F441}" : "\u{1F648}"}
                  </span>
                  <span class="rail-action-label">denoise</span>
                </button>
              );
            }}
          </Show>
        </div>
      </Show>

      {/* #500 — the ONE permanently-pinned launcher. Always at the bottom of the
          rail, always reachable (it never shares vertical flow with the nick
          list). Toggles the overlay menu above. */}
      <button
        type="button"
        class="shell-chrome-btn rail-action rail-actions-launcher"
        classList={{ open: open() }}
        aria-haspopup="menu"
        aria-expanded={open() ? "true" : "false"}
        aria-label="window actions"
        data-testid="rail-actions-launcher"
        onClick={() => setOpen((v) => !v)}
      >
        <span class="rail-action-icon" aria-hidden="true">
          {"\u{2630}"}
        </span>
        <span class="rail-action-label">actions</span>
      </button>
    </div>
  );
};

export default RailActions;
