// Media-viewer modal state — media-link cluster (2026-06-11).
//
// Module-scope signal store (same pattern as `archive.ts`'s
// `archiveModalNetwork`): the open trigger lives deep inside a
// module-scope link renderer, far from any component that could thread
// a callback down — a lib store is the established cic shape for that.
// `MediaViewerModal.tsx` (mounted at Shell root in both branches)
// renders the state; `MircText.tsx`'s link handler is the ONLY caller
// of `openMediaViewer` (it was ScrollbackPane's `renderRun` until #125
// extracted `MircBody`), and `lib/mediaLink.ts` decides which links it
// calls for (and supplies the page-origin-rooted href).
//
// identityScopedStore (review fix, same reason as archive.ts:36-39):
// token rotation/logout must close an open viewer — otherwise the
// previous identity's media lingers on top of the new identity's
// shell, scroll-lock included.

import { createSignal } from "solid-js";
import { identityScopedStore } from "./identityScopedStore";
import type { MediaKind } from "./mediaLink";

export type MediaViewerState = { href: string; kind: MediaKind };

const exports_ = identityScopedStore((onIdentityChange) => {
  const [mediaViewerState, setMediaViewerState] = createSignal<MediaViewerState | null>(null);

  onIdentityChange(() => setMediaViewerState(null));

  return {
    mediaViewerState,
    openMediaViewer(href: string, kind: MediaKind): void {
      // #1124 — dismiss the mobile soft keyboard before the viewer opens.
      // `.media-viewer-modal` is capped at `var(--viewport-height)`, which
      // tracks the VISUAL viewport (viewportHeight.ts), so with the keyboard
      // up the media renders in roughly half the height it could use. Nothing
      // dismisses it on its own: `keepKeyboard.ts` preventDefaults the
      // mousedown focus-shift on a `.scrollback-link` tap precisely so the
      // keyboard survives it. That suppresses the IMPLICIT shift only — it
      // does not stand in the way of this deliberate blur.
      //
      // On the verb, not the call site: this is the single open door, so
      // there is no per-caller wiring to forget (the same "one owner"
      // argument keepKeyboard.ts makes for itself).
      //
      // Accepted trade-off (vjt, #1124): on close the keyboard does NOT come
      // back. Do NOT "fix" that by re-focusing the compose — a programmatic
      // focus re-raises the keyboard through the same visual-viewport resize
      // path the overlay freeze exists to survive (#196 / #219-general /
      // #1121). The draft itself is per-window compose state, untouched.
      const focused = document.activeElement;
      if (focused instanceof HTMLElement) focused.blur();
      setMediaViewerState({ href, kind });
    },
    closeMediaViewer(): void {
      setMediaViewerState(null);
    },
  };
});

export const { mediaViewerState, openMediaViewer, closeMediaViewer } = exports_;
