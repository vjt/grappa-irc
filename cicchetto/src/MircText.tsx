import { type Component, For, type JSX } from "solid-js";
import { playAudio } from "./lib/audioPlayer";
import { linkify } from "./lib/linkify";
import { classifyMediaLink, sameHostHref } from "./lib/mediaLink";
import { openMediaViewer } from "./lib/mediaViewer";
import { parseMircFormat, type Run } from "./lib/mircFormat";
import { maybeEscapePwaClick } from "./lib/platform";

// Shared mIRC-formatting renderer. Extracted from ScrollbackPane (#125) so
// the channel-directory topic reuses the SAME typed-formatting render path
// as scrollback message bodies — the one-parser invariant (cic never parses
// IRC framing itself; `parseMircFormat` expands the server-supplied wire
// bytes into typed runs, this module styles them). The single module that
// styles `parseMircFormat` runs for display, consumed by ScrollbackPane
// (message bodies, wallops, globops, server errors, actions) and
// DirectoryPane (topics).

// CP13 S10: render an IRC body string with mIRC formatting expanded into
// per-run <span> elements. Plain text (no control chars) collapses into a
// single Run and renders as one <span>; the no-formatting fast path is
// the common case so this stays cheap. Each Run gets a class for each
// active toggle attribute + inline style for fg/bg colors (the palette is
// 16 fixed values — we don't generate per-color CSS classes).
const renderRun = (run: Run): JSX.Element => {
  const style: Record<string, string> = {};
  // Reverse swaps fg/bg. mIRC reverses the rendered colors AND falls back
  // to the terminal default when fg/bg aren't set, but in a web context
  // we don't have a "terminal default" — fall back to plain text colors
  // and let the .scrollback-mirc-reverse class style the swap (CSS owns
  // the visual). Inline style still applies the explicit fg/bg if set.
  // fg/bg are already resolved CSS color strings (the parser owns palette +
  // \x04 hex resolution — no lookup leaks here). Reverse swaps which slot
  // each color lands in.
  if (run.fg !== undefined) {
    style[run.reverse ? "background-color" : "color"] = run.fg;
  }
  if (run.bg !== undefined) {
    style[run.reverse ? "color" : "background-color"] = run.bg;
  }
  // No-silent-drops bucket 4 (2026-05-14): linkify the run text so URLs
  // render as <a href target="_blank" rel="noopener noreferrer">. Done
  // INSIDE the formatting <span> so URL links inherit the run's bold /
  // color / etc. attributes (mIRC formatting + linkification compose
  // cleanly). Plain-text runs go through linkify too -- the cost is
  // one regex scan per run; if no URL matches the result is a single
  // text segment which renders identically to the pre-linkify path.
  const segments = linkify(run.text);
  return (
    <span
      classList={{
        "scrollback-mirc-bold": run.bold,
        "scrollback-mirc-italic": run.italic,
        "scrollback-mirc-underline": run.underline,
        "scrollback-mirc-strikethrough": run.strikethrough,
        "scrollback-mirc-monospace": run.monospace,
        "scrollback-mirc-reverse": run.reverse && run.fg === undefined && run.bg === undefined,
      }}
      style={style}
    >
      <For each={segments}>
        {(seg, i) => {
          if (seg.type !== "url") return seg.value;
          // Media-link cluster (2026-06-11): same-origin media URLs get
          // a click intercept → in-app viewer modal (lib/mediaViewer),
          // because in-PWA-scope links navigate the iOS standalone
          // window IN PLACE (raw media doc, no chrome, return reloads
          // cic). The preceding text segment carries the 📸/🎬 type
          // signal for own upload URLs (slug has no extension). The
          // anchor + href stay — copy-link / middle-click / long-press
          // keep working; only plain click is intercepted.
          //
          // Review fix (2026-06-11): the navigate-in-place bug class
          // covers EVERY same-host link, not just modal-viewable media
          // — 📄 docs (classifyMediaLink deliberately rejects them; the
          // modal can't render PDFs) and emoji-split-run fallbacks.
          // Those plain clicks delegate to the shared
          // maybeEscapePwaClick handler (x-safari handoff on iOS
          // standalone, no-op everywhere else). Cross-host links stay
          // untouched: out-of-scope already opens correctly in the iOS
          // Safari view.
          const prev = segments[i() - 1];
          const media = classifyMediaLink(
            seg.href,
            prev?.type === "text" ? prev.value : "",
            window.location.origin,
          );
          const escapeHref = media === null ? sameHostHref(seg.href, window.location.origin) : null;
          return (
            <a
              href={seg.href}
              target="_blank"
              rel="noopener noreferrer"
              class="scrollback-link"
              classList={{ "scrollback-media-link": media !== null }}
              onClick={
                media !== null
                  ? (e) => {
                      // Modifier/aux clicks keep browser-native
                      // semantics (new tab / new window) — only the
                      // plain primary click opens the viewer.
                      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) {
                        return;
                      }
                      e.preventDefault();
                      // media.href is re-rooted on the page origin —
                      // historical prod bodies carry http:// hrefs
                      // (mixed content if loaded as-is on https).
                      //
                      // Audio routes to the docked, non-modal mini-player
                      // (GH #115) so scrollback stays readable while it
                      // plays; image/video keep the full-screen viewer.
                      if (media.kind === "audio") {
                        playAudio(media.href);
                      } else {
                        openMediaViewer(media.href, media.kind);
                      }
                    }
                  : escapeHref !== null
                    ? (e) => {
                        // escapeHref is origin-rooted for the same
                        // mixed-content reason as media.href.
                        maybeEscapePwaClick(e, escapeHref);
                      }
                    : undefined
              }
            >
              {seg.value}
            </a>
          );
        }}
      </For>
    </span>
  );
};

export const MircBody: Component<{ body: string }> = (props) => {
  const runs = (): Run[] => parseMircFormat(props.body);
  return <For each={runs()}>{renderRun}</For>;
};
