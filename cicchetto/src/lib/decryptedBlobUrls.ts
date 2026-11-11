// issue 2517 — WHO OWNS A DECRYPTED BLOB URL.
//
// The attachment card (`EncryptedChatPane`'s `FileTrailer`) mints a blob URL
// when it opens a decrypted file, and hands it to one of two surfaces: the
// media viewer, or the docked audio player. Neither of those is the card, and
// the card does not outlive them: any change to the chat's rows rebuilds every
// message object, the scrollback's `<For>` recreates every row, and the old
// card's `onCleanup` runs. A card that revoked its own URL there revoked the
// plaintext out from under an open viewer or a docked player — measured: open
// an image, then receive ONE message, and `blob:` was revoked while
// `mediaViewerState()` still pointed at it.
//
// So the URL is owned HERE, by the lifetime that actually matters: it lives
// exactly as long as one of the two surfaces names it, and not one tick longer.
// The card only REGISTERS what it minted; it never revokes.
//
// One store for both surfaces, not one per surface: a URL belongs to whichever
// surface names it, and moving between them (the same file opened again while
// the other is up) must not race two revokers against each other.
import { createEffect } from "solid-js";
import { activeAudio } from "./audioPlayer";
import { identityScopedStore } from "./identityScopedStore";
import { mediaViewerState } from "./mediaViewer";

const exports_ = identityScopedStore((onIdentityChange) => {
  const minted = new Set<string>();

  const revokeAll = (): void => {
    for (const url of minted) URL.revokeObjectURL(url);
    minted.clear();
  };

  // Reactive on both surfaces: whenever either one moves off a URL (viewer
  // closed or replaced, player stopped or re-tuned), every minted URL nobody
  // names any more goes. A URL minted for a surface that never came up — the
  // card unmounted between the mint and the hand-over — is collected by the
  // same pass on the next change, and by `revokeAll` on sign-out.
  createEffect(() => {
    const inUse = new Set<string>();
    const viewer = mediaViewerState();
    if (viewer !== null) inUse.add(viewer.href);
    const player = activeAudio();
    if (player !== null) inUse.add(player.href);
    for (const url of [...minted]) {
      if (inUse.has(url)) continue;
      URL.revokeObjectURL(url);
      minted.delete(url);
    }
  });

  // Sign-out / token rotation closes both surfaces (their own stores clear on
  // the same edge), so nothing is left naming these URLs. The plaintext must
  // not survive the identity that could decrypt it.
  onIdentityChange(revokeAll);

  return {
    /**
     * Register a URL this module now owns. Call it AFTER the surface that
     * names the URL has been set, so the effect above never sees a minted URL
     * with no owner for even one tick.
     */
    adoptDecryptedUrl(url: string): void {
      minted.add(url);
    },
  };
});

export const { adoptDecryptedUrl } = exports_;
