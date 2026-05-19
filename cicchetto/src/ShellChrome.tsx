import { type Component, Show } from "solid-js";
import { setArchiveModalNetwork } from "./lib/archive";
import { selectedChannel } from "./lib/selection";

// UX-4 bucket L (2026-05-19) — sticky chrome bar at the top of
// `.shell-main`. Always rendered, regardless of selected window kind
// (channel / query / server / home / mentions / admin / empty). This is
// the cluster-wide rule from the b2f9815 plan-doc extension: the
// settings cog MUST be reachable from every window kind, INCLUDING
// the server window.
//
// Pre-bucket the cog lived inside TopicBar (rendered only for
// `sel.kind === "channel"`) + Shell.tsx's empty-toolbar fallbacks
// (pre-select only). Operator on a query / server / home / mentions
// window had NO way to open settings — only by switching to a channel
// window first.
//
// Slots (left → right):
//   * Hamburger (☰) — toggles the sidebar drawer on mobile. Desktop
//     hides it via CSS. `onToggleSidebar` is optional — when omitted,
//     the slot collapses.
//   * Spacer — pushes the right group to the far right.
//   * Archive button (📂) — opens ArchiveModal for the currently-
//     selected window's network. Hidden when no network context
//     (home / mentions / pre-select). Mirrors the bucket-L plan-doc
//     "move from bottom bar to top-right (next to cog or settings
//     group)" requirement; BottomBar's per-network archive chips are
//     dropped in lockstep.
//   * Settings cog (⚙) — opens SettingsDrawer. Always visible.
//
// Hamburger + cog size parity: both use the `.shell-chrome-btn` base
// class with identical width/height/font-size. The `.shell-chrome-cog`
// modifier exists for theme-level colour tweaks if a future theme
// wants to disambiguate; the geometry is shared.

export type Props = {
  /**
   * Mobile-only sidebar toggle. Omit for branches that don't need
   * sidebar access (mobile non-channel windows have no sidebar nor
   * members surface). Caller decides what the toggle does —
   * Shell.tsx wires it to `setSidebarOpen` on desktop and
   * `setMembersOpen` on mobile (channel kind only).
   */
  onToggleSidebar?: () => void;
  /**
   * aria-label for the hamburger button. Mirrors what the toggle
   * actually opens: "open channel sidebar" on desktop (since the
   * sidebar lists channels), "open members sidebar" on mobile
   * (since the toggle opens the members drawer there). Caller
   * decides per branch.
   */
  hamburgerLabel?: string;
  /**
   * Opens the SettingsDrawer. Required — the cog is always rendered.
   */
  onOpenSettings: () => void;
};

const ShellChrome: Component<Props> = (props) => {
  // Archive button visibility: only when the selected window has a
  // network context (channel / query / server kinds carry
  // networkSlug; home / mentions / admin / empty do not). Resolved per
  // render via `selectedChannel`; no parallel state.
  const archiveSlug = (): string | null => {
    const sel = selectedChannel();
    if (sel === null) return null;
    if (sel.kind === "home" || sel.kind === "mentions" || sel.kind === "admin") return null;
    return sel.networkSlug;
  };

  return (
    <header class="shell-chrome" data-testid="shell-chrome">
      <Show when={props.onToggleSidebar}>
        {(toggle) => (
          <button
            type="button"
            class="shell-chrome-btn shell-chrome-hamburger"
            aria-label={props.hamburgerLabel ?? "open channel sidebar"}
            onClick={() => toggle()()}
          >
            ☰
          </button>
        )}
      </Show>
      <span class="shell-chrome-spacer" />
      <Show when={archiveSlug()}>
        {(slug) => (
          <button
            type="button"
            class="shell-chrome-btn shell-chrome-archive"
            aria-label="open archive"
            data-testid="shell-chrome-archive"
            onClick={() => setArchiveModalNetwork(slug())}
          >
            {"\u{1F4C2}"}
          </button>
        )}
      </Show>
      <button
        type="button"
        class="shell-chrome-btn shell-chrome-cog"
        aria-label="open settings"
        data-testid="shell-chrome-cog"
        onClick={props.onOpenSettings}
      >
        ⚙
      </button>
    </header>
  );
};

export default ShellChrome;
