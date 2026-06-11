import {
  type Component,
  createEffect,
  createSignal,
  Match,
  onCleanup,
  Show,
  Switch,
} from "solid-js";
import { closeMediaViewer, type MediaViewerState, mediaViewerState } from "./lib/mediaViewer";
import { createOverlayLock } from "./lib/overlayScrollLock";
import { isIos, isStandalonePwa, safariEscapeHref } from "./lib/platform";

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
// "Open in browser" is an anchor whose href depends on the platform.
// Desktop, Android, and iOS browser tabs get the plain URL with
// target=_blank — a real new tab. iOS STANDALONE cannot leave the PWA
// via a same-origin anchor at all (in-scope navigation ignores target —
// the same root cause this modal exists for; dogfood caught the first
// shipped version navigating the PWA), so there the href is rewritten
// to the x-safari-https:// scheme, which hands the URL to real Safari
// (iOS 17+; inert tap on iOS 16 — acceptable degrade). The media
// element needs no CSP change: `img-src 'self' data:` /
// `media-src 'self' blob:` already cover same-origin sources, and the
// classifier never admits cross-origin URLs.
//
// Escape uses a document-level keydown listener (UserContextMenu
// pattern) — focus stays wherever the operator clicked (scrollback,
// compose box), so a dialog-scoped onKeyDown would never fire.
// Backdrop is a <button> (UserContextMenu pattern) so close-on-outside
// needs no a11y lint suppressions.

type MediaLoadStatus = "loading" | "ready" | "failed";

// Body subcomponent so the load status resets per open: the keyed
// <Show> remounts it for every new viewer state, giving each open a
// fresh signal — no manual reset effect to keep in sync. Spinner until
// the element reports readiness (img: load; video/audio:
// loadedmetadata — enough for duration/controls; loadeddata never
// fires under preload=metadata), explicit failure text on error so a
// 404 can't spin forever. The failed media element is unmounted —
// a broken <img> would render its alt text (the raw URL) under the
// failure line.
const MediaViewerBody: Component<{ state: MediaViewerState }> = (props) => {
  const [status, setStatus] = createSignal<MediaLoadStatus>("loading");
  const ready = (): void => {
    setStatus("ready");
  };
  const failed = (): void => {
    setStatus("failed");
  };

  return (
    <div class="media-viewer-body">
      <Show when={status() === "loading"}>
        <div role="status" aria-label="Loading media" class="media-viewer-spinner" />
      </Show>
      <Show when={status() === "failed"}>
        <p class="media-viewer-error">failed to load — try "open in browser"</p>
      </Show>
      <Show when={status() !== "failed"}>
        <Switch>
          <Match when={props.state.kind === "image"}>
            <img
              class="media-viewer-media"
              src={props.state.href}
              alt={props.state.href}
              onLoad={ready}
              onError={failed}
            />
          </Match>
          <Match when={props.state.kind === "video"}>
            {/* playsinline: without it iOS hands the element to the
                native fullscreen player, defeating the in-app
                viewer. preload=metadata: show duration without
                pulling the whole file. */}
            {/* biome-ignore lint/a11y/useMediaCaption: user-uploaded IRC media — no caption track exists or can be authored for it */}
            <video
              class="media-viewer-media"
              src={props.state.href}
              controls
              playsinline
              preload="metadata"
              onLoadedMetadata={ready}
              onError={failed}
            />
          </Match>
          <Match when={props.state.kind === "audio"}>
            {/* biome-ignore lint/a11y/useMediaCaption: user-uploaded IRC media — no caption track exists or can be authored for it */}
            <audio
              class="media-viewer-media"
              src={props.state.href}
              controls
              preload="metadata"
              onLoadedMetadata={ready}
              onError={failed}
            />
          </Match>
        </Switch>
      </Show>
    </div>
  );
};

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

  // Evaluated per open (keyed Show re-runs the callback). Platform
  // can't change mid-session, but per-open evaluation keeps the gates
  // stub-friendly in tests and costs nothing.
  const externalHref = (href: string): string =>
    isIos() && isStandalonePwa() ? safariEscapeHref(href) : href;

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
                href={externalHref(state.href)}
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
            <MediaViewerBody state={state} />
          </div>
        </>
      )}
    </Show>
  );
};

export default MediaViewerModal;
