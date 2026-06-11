import { type Component, createEffect, Match, onCleanup, Show, Switch } from "solid-js";
import { closeMediaViewer, mediaViewerState } from "./lib/mediaViewer";
import { createOverlayLock } from "./lib/overlayScrollLock";

// In-app media viewer modal — media-link cluster (2026-06-11).
//
// Why: own upload URLs are same-origin and therefore in-PWA-scope; iOS
// standalone navigates in-scope links IN PLACE (raw media document,
// zero browser chrome, no back control; returning reloads cic). The
// modal keeps the operator inside cic. On-CLICK only — no on-arrival
// rendering, per the CLAUDE.md "IRC stays text only" rule (vjt-approved
// spec 2026-06-10; the spec bans lightbox-on-arrival, not click-to-view).
//
// Driven entirely by `mediaViewerState()` (lib/mediaViewer.ts);
// ScrollbackPane's renderRun calls `openMediaViewer` for links that
// `classifyMediaLink` accepts. Mounted at Shell root in both branches
// (PrivacyModal pattern).
//
// "Open in browser" is a plain anchor (target=_blank): on desktop and
// Android it opens a real tab; on iOS standalone it deliberately
// leaves the PWA — an explicit user choice, unlike the bug where a
// plain click did so. The media element needs no CSP change:
// `img-src 'self' data:` / `media-src 'self' blob:` already cover
// same-origin sources, and the classifier never admits cross-origin
// URLs.
//
// Escape uses a document-level keydown listener (UserContextMenu
// pattern) — focus stays wherever the operator clicked (scrollback,
// compose box), so a dialog-scoped onKeyDown would never fire.
// Backdrop is a <button> (UserContextMenu pattern) so close-on-outside
// needs no a11y lint suppressions.

const MediaViewerModal: Component = () => {
  // UX-6 bucket A — refcounted overlay scroll-lock (shared
  // createOverlayLock wiring, extracted from the ArchiveModal/
  // PrivacyModal copies during this cluster's review).
  createOverlayLock(() => mediaViewerState() !== null, ".media-viewer-modal");

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") closeMediaViewer();
  };

  // Document-level Escape, registered ONLY while the viewer is open.
  // This component is permanently mounted at Shell root (unlike
  // UserContextMenu, which mounts per-open), so an unconditional
  // listener would run on every keystroke app-wide forever; tracking
  // the open signal scopes the listener to the viewer's visible
  // lifetime. Document-level (not dialog onKeyDown) because focus
  // stays wherever the operator clicked — scrollback, compose box.
  createEffect(() => {
    if (mediaViewerState() === null) return;
    document.addEventListener("keydown", onKeyDown);
    onCleanup(() => document.removeEventListener("keydown", onKeyDown));
  });

  return (
    <Show when={mediaViewerState()} keyed>
      {(state) => (
        <>
          <button
            type="button"
            class="media-viewer-backdrop"
            aria-label="Close media viewer backdrop"
            onClick={closeMediaViewer}
          />
          <div role="dialog" aria-modal="true" aria-label="Media viewer" class="media-viewer-modal">
            <div class="media-viewer-header">
              <a
                href={state.href}
                target="_blank"
                rel="noopener noreferrer"
                class="media-viewer-open-external"
              >
                open in browser
              </a>
              <button
                type="button"
                class="media-viewer-close"
                aria-label="Close media viewer"
                onClick={closeMediaViewer}
              >
                ✕
              </button>
            </div>
            <div class="media-viewer-body">
              <Switch>
                <Match when={state.kind === "image"}>
                  <img class="media-viewer-media" src={state.href} alt={state.href} />
                </Match>
                <Match when={state.kind === "video"}>
                  {/* playsinline: without it iOS hands the element to the
                      native fullscreen player, defeating the in-app
                      viewer. preload=metadata: show duration without
                      pulling the whole file. */}
                  {/* biome-ignore lint/a11y/useMediaCaption: user-uploaded IRC media — no caption track exists or can be authored for it */}
                  <video
                    class="media-viewer-media"
                    src={state.href}
                    controls
                    playsinline
                    preload="metadata"
                  />
                </Match>
                <Match when={state.kind === "audio"}>
                  {/* biome-ignore lint/a11y/useMediaCaption: user-uploaded IRC media — no caption track exists or can be authored for it */}
                  <audio class="media-viewer-media" src={state.href} controls preload="metadata" />
                </Match>
              </Switch>
            </div>
          </div>
        </>
      )}
    </Show>
  );
};

export default MediaViewerModal;
