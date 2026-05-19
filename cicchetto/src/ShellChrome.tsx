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
//   * Spacer — pushes the right group to the far right.
//   * Archive button (📂) — opens ArchiveModal for the currently-
//     selected window's network. Hidden when no network context
//     (home / mentions / pre-select).
//   * Settings cog (⚙) — opens SettingsDrawer. Always visible.
//
// UX-5 bucket A (2026-05-19) — the left hamburger slot was dropped.
// The desktop sidebar is always visible (no toggle needed); the
// mobile members drawer is toggled by TopicBar's `.topic-bar-hamburger`
// (channel-window-only, CSS-hidden on desktop). Pre-bucket the chrome
// also rendered its own hamburger — duplicating the members-drawer
// toggle on mobile and adding a useless top-left button on desktop
// (the `sidebarOpen` signal it toggled had no DOM effect anywhere
// since UX-4 bucket L dropped the mobile sidebar branch and the
// desktop sidebar has no `.open` CSS rule). Removed end-to-end:
// `sidebarOpen` state is gone from Shell.tsx too.

export type Props = {
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
