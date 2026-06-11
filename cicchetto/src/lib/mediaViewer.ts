// Media-viewer modal state — media-link cluster (2026-06-11).
//
// Module-scope signal store (same pattern as `archive.ts`'s
// `archiveModalNetwork`): the open trigger lives deep inside
// ScrollbackPane's module-scope renderRun, far from any component that
// could thread a callback down — a lib store is the established cic
// shape for that. `MediaViewerModal.tsx` (mounted at Shell root in
// both branches) renders the state; `lib/mediaLink.ts` decides which
// links call `openMediaViewer`.

import { createSignal } from "solid-js";
import type { MediaKind } from "./mediaLink";

export type MediaViewerState = { href: string; kind: MediaKind };

const [mediaViewerState, setMediaViewerState] = createSignal<MediaViewerState | null>(null);

export { mediaViewerState };

export function openMediaViewer(href: string, kind: MediaKind): void {
  setMediaViewerState({ href, kind });
}

export function closeMediaViewer(): void {
  setMediaViewerState(null);
}
