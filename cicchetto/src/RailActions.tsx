import { useNavigate } from "@solidjs/router";
import { type Component, createEffect, createSignal, onCleanup, Show } from "solid-js";
import { archiveSlugForSelection } from "./lib/archiveContext";
import { channelKey } from "./lib/channelKey";
import { syncedSetChannelPresencePref } from "./lib/displayPrefs";
import { canDetach, confirmDetach, confirmQuit } from "./lib/lifecycle";
import { membersByChannel } from "./lib/members";
import { mentionsBundleBySlug } from "./lib/mentionsWindow";
import { spaceAbove } from "./lib/menuPosition";
import {
  type MobilePanelSetters,
  openAdminPanel,
  openArchivePanel,
  openHomePanel,
  openListPanel,
  openMentionsPanel,
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
// Every launcher closes the menu after firing (single-shot, like every
// overlay) — including the two lifecycle entries, which hand the operator to
// a modal and must not leave a live menu waiting underneath it for the
// Cancel. `denoise` does NOT close it — it is a per-channel state toggle the
// operator flips in place (watching the accent flip, re-toggling), not a
// navigation away.
//
// Buttons, in order: home · rooms · mentions · themes · archive · settings ·
// admin · denoise · detach · quit. Each carries its NAME as visible text next
// to the glyph (#473: bare emoji had to be guessed / long-pressed).
//
// Gating is CAPABILITY-only — no form-factor gates (#473):
//   * home / themes / settings / archive / quit — always.
//   * rooms — needs a network context (`archiveSlugForSelection()`).
//   * mentions — needs a bundle to re-open for that network context.
//   * admin — `isAdmin()`.
//   * denoise — channel-gated (a channel window is selected).
//   * detach — `canDetach()`: a persistent identity has a bouncer to leave
//     running, an ephemeral visitor does not.
//
// #986 — three arrivals, and the two lifecycle verbs among them are why this
// menu now carries a destructive class of action:
//
//   * `@` mentions moved OFF `.shell-chrome`, the band #985 removes. It was
//     gated `isMobile() && bundle` there, because on desktop it would have
//     duplicated the Sidebar mentions row (#71 INC-2). That gate does NOT
//     travel with it: #473 already settled that the rail carries the same set
//     on both form factors, and `home` is the standing precedent — a sidebar
//     row AND a rail launcher, deliberately. A form-factor gate here would be
//     the one thing this component says it does not do.
//   * `detach` / `quit` moved out of the settings drawer, each behind the
//     shared #195 confirm modal via lib/lifecycle's `confirmDetach` /
//     `confirmQuit`. ONE confirm paradigm: the drawer's two-tap
//     `InlineConfirmButton` arm is NOT reproduced here (the component keeps
//     serving its ~20 other call sites unchanged — only its use as a
//     lifecycle-verb gate ends). The modal body is subject-TRUE; the copy
//     block in lib/lifecycle.ts records why one sentence could not honestly
//     serve three different events.
//
// The lifecycle pair sits LAST, after the navigation set — the conventional
// slot for a destructive verb, and one the confirm modal makes affordable.
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

// #588 — px kept clear above the menu so the topmost row isn't flush against
// whatever is above it. Breathing room ONLY: #913 established that clearing the
// notch / status bar is a separate, ~59px job that this constant was silently
// being asked to do. The inset is subtracted in CSS (see below); this is what
// remains on top of it. Fed to `spaceAbove`.
const RAIL_MENU_TOP_GAP = 8;

const RailActions: Component<Props> = (props) => {
  // #986 — the two lifecycle verbs land the operator on /login once the
  // teardown resolves. `logout()` nulls the token and main.tsx's RequireAuth
  // would redirect on its own, but the explicit navigation makes the landing
  // deterministic instead of effect-ordered (the shape SettingsDrawer used
  // before these buttons moved here).
  const navigate = useNavigate();
  const toLogin = (): void => navigate("/login", { replace: true });

  // #188 item 6 / #986 — which network's mentions bundle can be re-opened?
  // Derived from the current selection exactly as `rooms` derives its network
  // (`archiveSlugForSelection`), and null unless that network HAS a bundle:
  // there is nothing to re-open otherwise. Returns null while the mentions
  // panel is itself selected, which correctly hides the redundant entry.
  const mentionsSlug = (): string | null => {
    const slug = archiveSlugForSelection();
    if (slug === null) return null;
    return mentionsBundleBySlug()[slug] ? slug : null;
  };

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
  // changes) — and where rotation lands too, which matters now that the cap's
  // other operand (the safe-area inset) also changes with orientation. Null
  // while closed → the menu isn't mounted anyway, and the CSS var() chain
  // falls back to the viewport height.
  //
  // #913 — this measurement is only HALF the cap. `getBoundingClientRect()` is
  // relative to the layout viewport, whose origin under `viewport-fit=cover` is
  // the physical top of the display, behind the status bar. The stylesheet
  // takes `var(--safe-area-inset-top)` off what we publish here; we do NOT read
  // the inset in JS, because `getComputedStyle().getPropertyValue()` on an
  // unregistered custom property is not guaranteed to resolve `env()` to a
  // length — it can return the token stream, and the NaN that follows would
  // fail silently as a no-op fix.
  const [menuSpaceAbove, setMenuSpaceAbove] = createSignal<number | null>(null);
  createEffect(() => {
    if (!open()) {
      setMenuSpaceAbove(null);
      return;
    }
    const measure = (): void => {
      if (!rootRef) return;
      setMenuSpaceAbove(spaceAbove(rootRef.getBoundingClientRect().top, RAIL_MENU_TOP_GAP));
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
            // #588/#913 — publish the JS-measured space above the launcher; the
            // stylesheet's `max-height` subtracts the safe-area inset from it
            // and clamps. undefined → the var() falls back to the viewport
            // height (pre-measure only).
            menuSpaceAbove() !== null
              ? { "--rail-menu-space-above": `${menuSpaceAbove()}px` }
              : undefined
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

          {/* #986 — mentions launcher (@). The ONE door back into a network's
              "you were /away" bundle now that `.shell-chrome` is losing its
              copy (#985). Gated on there BEING a bundle for the current
              network context — capability, not form factor (see moduledoc).
              Routes through the same nav mutex as home / rooms / admin. */}
          <Show when={mentionsSlug()}>
            {(slug) => (
              <button
                type="button"
                class="shell-chrome-btn rail-action rail-action-mentions"
                aria-label="open mentions"
                data-testid="rail-action-mentions"
                onClick={() => {
                  openMentionsPanel(props.setters, () =>
                    setSelectedChannel({
                      networkSlug: slug(),
                      channelName: "",
                      kind: "mentions",
                    }),
                  );
                  close();
                }}
              >
                <span class="rail-action-icon" aria-hidden="true">
                  @
                </span>
                <span class="rail-action-label">mentions</span>
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

          {/* #986 — detach: leave cic, KEEP the bouncer running. Offered to a
              persistent identity only, via lib/lifecycle's `canDetach()` —
              the SAME `isPersistentIdentity` question `quit()` routes on, so
              the affordance and the teardown cannot drift. The confirm modal
              is what makes this a rail entry rather than the drawer's
              unconfirmed button: it says what stays up before the tap. */}
          <Show when={canDetach()}>
            <button
              type="button"
              class="shell-chrome-btn rail-action rail-action-detach"
              aria-label="detach from cicchetto"
              data-testid="detach-btn"
              onClick={() => {
                confirmDetach(toLogin);
                close();
              }}
            >
              <span class="rail-action-icon" aria-hidden="true">
                {"\u{1F50C}"}
              </span>
              <span class="rail-action-label">detach</span>
            </button>
          </Show>

          {/* #986 — quit: close cic AND tear the live session down.
              Universal, and the ONE entry whose consequence is genuinely
              different per subject — a user parks and comes back, an anon
              visitor is deleted. `confirmQuit` picks the sentence that is
              true for whoever is looking at it. */}
          <button
            type="button"
            class="shell-chrome-btn rail-action rail-action-quit"
            aria-label="quit IRC"
            data-testid="quit-irc-btn"
            onClick={() => {
              confirmQuit(toLogin);
              close();
            }}
          >
            <span class="rail-action-icon" aria-hidden="true">
              {"\u{1F6AA}"}
            </span>
            <span class="rail-action-label">quit</span>
          </button>
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
