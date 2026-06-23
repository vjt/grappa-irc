// Media-viewer modal state — media-link cluster (2026-06-11).
//
// Module-scope signal store (same pattern as `archive.ts`'s
// `archiveModalNetwork`): the open trigger lives deep inside
// ScrollbackPane's module-scope renderRun, far from any component that
// could thread a callback down — a lib store is the established cic
// shape for that. `MediaViewerModal.tsx` (mounted at Shell root in
// both branches) renders the state; `lib/mediaLink.ts` decides which
// links call `openMediaViewer` (and supplies the page-origin-rooted
// href).
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
      setMediaViewerState({ href, kind });
    },
    closeMediaViewer(): void {
      setMediaViewerState(null);
    },
  };
});

export const { mediaViewerState, openMediaViewer, closeMediaViewer } = exports_;
