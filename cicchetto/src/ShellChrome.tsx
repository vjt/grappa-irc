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
//
// UX-5 bucket BT (2026-05-19) — extracted `ChromeButtons` named
// export: same archive + cog with identical visibility rules, but
// WITHOUT the outer `<header class="shell-chrome">` wrapper. Shell.tsx
// mobile-channel branch passes <ChromeButtons /> through TopicBar's
// `inlineChromeSlot` prop so the chrome buttons render INSIDE the
// topic-bar row — dropping the standalone `.shell-chrome` row that
// wasted ~32px above the scrollback area on iPhone. Default export
// (`<header class="shell-chrome">` wrapper) stays the desktop +
// mobile-non-channel substrate.

export type Props = {
  /**
   * Opens the SettingsDrawer. Required — the cog is always rendered.
   */
  onOpenSettings: () => void;
};

// UX-5 bucket BT — inner buttons-only render. Reuses the same archive
// visibility rule and the same cog wiring as the wrapper default
// export. Caller hosts the layout (`<header class="shell-chrome">` for
// the standalone bar, or `.topic-bar` for the inline mobile-channel
// path). Exported separately so the wire-truth contract stays in ONE
// component — `archiveSlug()` resolution + onOpenSettings prop shape
// + data-testid markers ("shell-chrome-archive", "shell-chrome-cog")
// are not duplicated.
export const ChromeButtons: Component<Props> = (props) => {
  const archiveSlug = (): string | null => {
    const sel = selectedChannel();
    if (sel === null) return null;
    if (sel.kind === "home" || sel.kind === "mentions" || sel.kind === "admin") return null;
    return sel.networkSlug;
  };

  return (
    <>
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
    </>
  );
};

const ShellChrome: Component<Props> = (props) => {
  return (
    <header class="shell-chrome" data-testid="shell-chrome">
      <span class="shell-chrome-spacer" />
      <ChromeButtons onOpenSettings={props.onOpenSettings} />
    </header>
  );
};

export default ShellChrome;
