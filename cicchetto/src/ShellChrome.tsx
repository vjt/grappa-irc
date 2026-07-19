import { type Component, Show } from "solid-js";
import { setArchiveModalNetwork } from "./lib/archive";
import { archiveSlugForSelection } from "./lib/archiveContext";
import { mentionsBundleBySlug } from "./lib/mentionsWindow";
import { setSelectedChannel } from "./lib/selection";
import { isMobile } from "./lib/theme";

// UX-4 bucket L (2026-05-19) — sticky chrome bar at the top of
// `.shell-main`. Always rendered, regardless of selected window kind
// (channel / query / server / home / mentions / admin / empty). This is
// a cluster-wide rule: the settings cog MUST be reachable from every
// window kind, INCLUDING the server window.
//
// Slots (left → right):
//   * Spacer — pushes the right group to the far right.
//   * Archive button (📂) — opens ArchiveModal for the currently-
//     selected window's network. MOBILE-ONLY: on desktop the
//     Sidebar already exposes the parked/archived rows inline via
//     `<details class="sidebar-archive">` (Sidebar.tsx ~L523),
//     making this button redundant noise. The ArchiveModal itself
//     remains for mobile where sidebar real estate is scarce.
//     Visibility-on-mobile predicate (no-network guard) lives in
//     `lib/archiveContext.ts` so the mobile members-drawer launcher
//     (Shell.tsx) uses the SAME rule.
//   * Settings cog (⚙) — opens SettingsDrawer. Always visible.
//
// UX-5 bucket A (2026-05-19) — the left hamburger slot was dropped.
//
// UX-5 bucket BT (2026-05-19) — a `ChromeButtons` named export
// briefly existed to let Shell.tsx mobile-channel branch render
// archive + cog inline inside TopicBar via an `inlineChromeSlot`
// prop, dropping the standalone `.shell-chrome` row on iPhone.
//
// UX-5 bucket BM (2026-05-20) — `ChromeButtons` named export DROPPED.
// BM moved the mobile-channel archive + cog into the members drawer
// footer as launchers (Shell.tsx mounts its own JSX, doesn't reuse
// chrome buttons). The wrapper default export is the only consumer
// of the archive/cog rendering today; folded back inline.

export type Props = {
  /**
   * Opens the SettingsDrawer. Required — the cog is always rendered.
   */
  onOpenSettings: () => void;
};

const ShellChrome: Component<Props> = (props) => {
  // #188 item 6 — which network's mentions bundle should the open button
  // consult? Derive the network from the current selection like the
  // archive button (`archiveSlugForSelection`), and render the button
  // ONLY when that network has a bundle — there's nothing to open
  // otherwise. Not mobile-gated: unlike the archive drawer, the mentions
  // panel has no desktop sidebar equivalent, so the button surfaces on
  // both. `archiveSlugForSelection` returns null while the mentions panel
  // itself is open, which correctly hides the (redundant) re-open button.
  const mentionsOpenSlug = (): string | null => {
    const slug = archiveSlugForSelection();
    if (slug === null) return null;
    return mentionsBundleBySlug()[slug] ? slug : null;
  };

  return (
    <header class="shell-chrome" data-testid="shell-chrome">
      <span class="shell-chrome-spacer" />
      <Show when={mentionsOpenSlug()}>
        {(slug) => (
          <button
            type="button"
            class="shell-chrome-btn shell-chrome-mentions"
            aria-label="open mentions"
            data-testid="shell-chrome-mentions"
            onClick={() =>
              setSelectedChannel({ networkSlug: slug(), channelName: "", kind: "mentions" })
            }
          >
            @
          </button>
        )}
      </Show>
      <Show when={isMobile() && archiveSlugForSelection()}>
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
        {"\u{2699}\u{FE0F}"}
      </button>
    </header>
  );
};

export default ShellChrome;
