// Docked audio mini-player state — audio uploads (GH #115).
//
// Module-scope signal store, same pattern as `mediaViewer.ts`: the open
// trigger lives deep inside ScrollbackPane's module-scope renderRun, far
// from any component that could thread a callback down — a lib store is
// the established cic shape for that. `AudioMiniPlayer.tsx` (mounted at
// Shell root) renders the state; `lib/mediaLink.ts` decides which links
// route here (kind: "audio") vs to `openMediaViewer` (image/video).
//
// Distinct from `mediaViewer.ts` by design (CLAUDE.md "IRC stays text
// only"): audio must NOT open the image/video modal. The mini-player is
// non-modal — scrollback stays scrollable + readable while it plays —
// and persistent: switching the active channel doesn't kill playback,
// clicking a new audio link swaps the source. ONE player instance, not N.
//
// identityScopedStore (same reason as mediaViewer.ts): token rotation /
// logout must stop playback — otherwise the previous identity's audio
// keeps playing on top of the new identity's shell.

import { createSignal } from "solid-js";
import { identityScopedStore } from "./identityScopedStore";

export type AudioPlayerState = { href: string };

const exports_ = identityScopedStore((onIdentityChange) => {
  const [activeAudio, setActiveAudio] = createSignal<AudioPlayerState | null>(null);

  onIdentityChange(() => setActiveAudio(null));

  return {
    activeAudio,
    // Start (or swap to) the audio at `href`. One instance: a second
    // click replaces the source rather than stacking a new player.
    playAudio(href: string): void {
      setActiveAudio({ href });
    },
    closeAudio(): void {
      setActiveAudio(null);
    },
  };
});

export const { activeAudio, playAudio, closeAudio } = exports_;
