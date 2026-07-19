import { type Component, For, type JSX } from "solid-js";
import { playAudio } from "./lib/audioPlayer";
import { linkify } from "./lib/linkify";
import { classifyMediaLink, sameHostHref } from "./lib/mediaLink";
import { openMediaViewer } from "./lib/mediaViewer";
import { parseMircFormat, type Run } from "./lib/mircFormat";
import { maybeEscapePwaClick } from "./lib/platform";
import { serverSettings } from "./lib/serverSettings";

// Shared mIRC-formatting renderer. Extracted from ScrollbackPane (#125) so
// the channel-directory topic reuses the SAME typed-formatting render path
// as scrollback message bodies — the one-parser invariant (cic never parses
// IRC framing itself; `parseMircFormat` expands the server-supplied wire
// bytes into typed runs, this module styles them). The single module that
// styles `parseMircFormat` runs for display, consumed by ScrollbackPane
// (message bodies, wallops, globops, server errors, actions) and
// DirectoryPane (topics).

// #220 — per-surface link-vs-surface event routing. A linkified anchor
// (real <a target=_blank>) that lives INSIDE a tappable surface would
// otherwise double-fire: the anchor click bubbles to the surface's
// onClick, so a single tap both browses the link AND performs the
// surface action. The two surfaces that wrap MircBody want OPPOSITE
// policies, so this is a closed-set knob on the shared renderer — the
// MECHANISM (anchor event routing) is shared, the POLICY is per-surface.
//
//  * "navigate"     — plain scrollback / cards (the overwhelming
//                     majority). The anchor navigates; the click is free
//                     to bubble. This is the pre-#220 behavior and the
//                     genuine config default (correct production behavior
//                     for every non-tappable-surface site — closed-set
//                     default precedent, cf. timeFormat.ts).
//  * "link-wins"    — /list directory rows. Tapping a LINK just browses;
//                     it must NOT trigger the row's join. The anchor
//                     stops propagation so the wrapping row handler never
//                     fires, then browses via the normal path.
//  * "surface-wins" — the topic bar. The bar ALWAYS opens the topic
//                     modal first; a tap NEVER navigates a link directly.
//                     The anchor suppresses its own navigation and lets
//                     the click bubble to the bar. Link handling is
//                     deferred to the modal (which renders MircBody at
//                     the default "navigate").
export type LinkPolicy = "navigate" | "link-wins" | "surface-wins";

// CP13 S10: render an IRC body string with mIRC formatting expanded into
// per-run <span> elements. Plain text (no control chars) collapses into a
// single Run and renders as one <span>; the no-formatting fast path is
// the common case so this stays cheap. Each Run gets a class for each
// active toggle attribute + inline style for fg/bg colors (the palette is
// 16 fixed values — we don't generate per-color CSS classes).
const renderRun = (run: Run, linkPolicy: LinkPolicy): JSX.Element => {
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
          // #324 — the deployment's server-provided HTTP host aliases:
          // an upload link on ANY of them opens the in-app viewer, not
          // just one on the page origin (aliases share the /uploads
          // store). Read from the reactive serverSettings() store; []
          // before the after-join snapshot (page origin only, pre-#324).
          // Injected into the classifier so mediaLink.ts stays pure +
          // table-testable (no store import there).
          const aliasHosts = serverSettings()?.httpHostAliases ?? [];
          const media = classifyMediaLink(
            seg.href,
            prev?.type === "text" ? prev.value : "",
            window.location.origin,
            aliasHosts,
          );
          const escapeHref =
            media === null ? sameHostHref(seg.href, window.location.origin, aliasHosts) : null;
          // #220 — compose the per-surface policy with the existing
          // media/escape in-app handling. The click handler is only
          // BUILT and attached when there's something to do; the pure
          // "navigate" plain-link case stays a bare anchor with no
          // listener and no closure allocated (pre-#220 behavior).
          const needsHandler = linkPolicy !== "navigate" || media !== null || escapeHref !== null;
          return (
            <a
              href={seg.href}
              target="_blank"
              rel="noopener noreferrer"
              class="scrollback-link"
              classList={{ "scrollback-media-link": media !== null }}
              onClick={
                needsHandler
                  ? (e) => {
                      // "surface-wins" (topic bar): the wrapping surface
                      // ALWAYS wins. Suppress the anchor's own navigation
                      // AND any in-app media/escape handling — links are
                      // deferred to the surface (the topic modal). Let the
                      // click bubble so the surface handler fires.
                      if (linkPolicy === "surface-wins") {
                        e.preventDefault();
                        return;
                      }
                      // Media / escape in-app handling (pre-#220) for the
                      // "navigate" and "link-wins" policies.
                      if (media !== null) {
                        // Modifier/aux clicks keep browser-native
                        // semantics (new tab / new window) — only the
                        // plain primary click opens the viewer.
                        if (!(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0)) {
                          e.preventDefault();
                          // media.href is re-rooted on the page origin —
                          // historical prod bodies carry http:// hrefs
                          // (mixed content if loaded as-is on https).
                          //
                          // Audio routes to the docked, non-modal
                          // mini-player (GH #115) so scrollback stays
                          // readable while it plays; image/video keep the
                          // full-screen viewer.
                          if (media.kind === "audio") {
                            playAudio(media.href);
                          } else {
                            openMediaViewer(media.href, media.kind);
                          }
                        }
                      } else if (escapeHref !== null) {
                        // escapeHref is origin-rooted for the same
                        // mixed-content reason as media.href.
                        maybeEscapePwaClick(e, escapeHref);
                      }
                      // "link-wins" (/list rows, mentions): the link
                      // browses but must NOT trigger the surface's action.
                      // Stop the click from reaching the wrapping handler
                      // — after the media/escape side effects, and
                      // regardless of modifier clicks (a cmd-click still
                      // opens a tab, still no surface action).
                      if (linkPolicy === "link-wins") {
                        e.stopPropagation();
                      }
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

export const MircBody: Component<{ body: string; linkPolicy?: LinkPolicy }> = (props) => {
  const runs = (): Run[] => parseMircFormat(props.body);
  // Default "navigate" is the genuine config default — correct
  // production behavior for every non-tappable-surface consumer.
  //
  // Constraint: `linkPolicy` is read inside the <For> child, which
  // re-maps only when runs() (i.e. props.body) changes — so a caller
  // must pass linkPolicy as a STABLE value (a literal, as all current
  // callers do), not a reactive signal that changes independently of
  // body. A per-surface policy is inherently static, so this is a
  // non-issue in practice; documented so a future reactive caller isn't
  // surprised by a stale policy.
  return <For each={runs()}>{(run) => renderRun(run, props.linkPolicy ?? "navigate")}</For>;
};
