import { type Component, createEffect, createSignal, For, Show } from "solid-js";
import InlineConfirmButton from "./InlineConfirmButton";
import { deleteArchiveEntry } from "./lib/api";
import {
  archiveModalNetwork,
  loadArchive,
  setArchiveModalNetwork,
  visibleArchiveForNetwork,
} from "./lib/archive";
import { token } from "./lib/auth";
import { networks } from "./lib/networks";
import { createOverlayLock } from "./lib/overlayScrollLock";
import { openQueryWindowState } from "./lib/queryWindows";
import { setSelectedChannel } from "./lib/selection";
import NickText from "./NickText";

// UX-2 (2026-05-17) — Mobile archive surface.
//
// Mounted only inside the mobile branch of `Shell.tsx`. Opened by a
// per-network chip in `BottomBar.tsx` (`.bottom-bar-archive-chip`).
// Closed by tapping the backdrop, the × in the header, or selecting an
// entry (taps an archive row → focus that window + close modal so the
// operator lands on the scrollback).
//
// Reuses every UX-1 verb instead of re-implementing them:
//   - `visibleArchiveForNetwork` (lib/archive.ts) for the list.
//   - `InlineConfirmButton` for the two-step delete.
//   - `deleteArchiveEntry` (lib/api.ts) for the server call.
// On confirm, server broadcasts `archive_changed` and userTopic
// re-fetches `archivedBySlug` — the modal re-renders automatically.
//
// Singleton armed key — same shape as Sidebar's
// `<slug> <target>` composite key — mutexes the active confirm across
// rows. Disarms on row arming or modal close.
//
// Per `feedback_css_block_button_wraps_inline_prefix`: textContent of
// each row IS the load-bearing test signal. We assert on the row's
// rendered name in vitest and Playwright, not on a `::before` sigil.

const ArchiveModal: Component = () => {
  const [armedKey, setArmedKey] = createSignal<string | null>(null);
  const archiveKey = (slug: string, target: string) => `${slug} ${target}`;

  const close = () => {
    setArchiveModalNetwork(null);
    setArmedKey(null);
  };

  // UX-6 bucket A — refcounted overlay scroll-lock. Tracks
  // `archiveModalNetwork()` (the "is the modal open?" signal — null
  // when closed, slug when open). Shared createOverlayLock wiring —
  // extracted 2026-06-11 when MediaViewerModal would have been the
  // third verbatim copy of the edge-trigger + deferred-push block;
  // see overlayScrollLock.ts for the semantics, including the
  // same-task-close leak fix the copies lacked. #232 — the shared
  // Esc-to-close routes through the same lock (topmost-first, focus-independent).
  createOverlayLock(() => archiveModalNetwork() !== null, ".archive-modal", close);

  // BUGHUNT-1 B — seed the archive list on edge-trigger open. The
  // mobile chip (`BottomBar.tsx`'s `.bottom-bar-archive-chip`) calls
  // `setArchiveModalNetwork(slug)` to open the modal but does NOT
  // call `loadArchive(slug)` — mobile operators never expand the
  // Sidebar `<details>` that fires the load, so without this effect
  // the modal renders "no archived windows" until the user archives
  // something (which triggers an `archive_changed` event that re-
  // fetches). Mount-component-owns-state pattern: ArchiveModal seeds
  // itself rather than depending on every callsite to remember the
  // load step (future URL deep-link, push notification, etc.).
  //
  // `lastSeededSlug` guard prevents re-loading on every reactivity
  // tick — only edge-trigger open (null→slug, slug-A→slug-B).
  // Re-opening the same slug AFTER close re-fires the load (refresh
  // semantics per `archive.ts:18-20`: re-load is a deliberate refresh).
  let lastSeededSlug: string | null = null;
  createEffect(() => {
    const slug = archiveModalNetwork();
    if (slug === null) {
      lastSeededSlug = null;
    } else if (slug !== lastSeededSlug) {
      lastSeededSlug = slug;
      void loadArchive(slug);
    }
  });

  const handleConfirmDelete = async (slug: string, target: string) => {
    const t = token();
    if (!t) return;
    try {
      await deleteArchiveEntry(t, slug, target);
    } catch {
      // Server delete failed — InlineConfirmButton disarms below on
      // the finally. Operator retries. No toast — modal is dense + a
      // generic banner wouldn't be actionable.
    } finally {
      setArmedKey(null);
    }
  };

  const handleSelectEntry = (slug: string, target: string, kind: "channel" | "query") => {
    // UX-3 Z: query-shaped archive entries must also be re-opened as
    // live query windows. setSelectedChannel alone only switches the
    // UI; it does NOT subscribe cic to the per-channel Phoenix topic.
    // Without the subscribe, any new server broadcast for this target
    // (e.g. NOTICE 401 "No such nick/channel" when the operator sends
    // a PRIVMSG to the archived peer) drops on the floor and the
    // operator sees no feedback. `openQueryWindowState` POSTs to the
    // server which persists the query_windows row and broadcasts
    // `query_window_opened`; cic's subscribe loop re-arms and joins
    // the per-channel topic. Idempotent — no-op if already open.
    if (kind === "query") {
      const net = networks()?.find((n) => n.slug === slug);
      if (net) openQueryWindowState(net.id, target, new Date().toISOString());
    }
    setSelectedChannel({
      networkSlug: slug,
      channelName: target,
      kind,
    });
    close();
  };

  return (
    <Show when={archiveModalNetwork()} keyed>
      {(slug) => {
        const network = () => (networks() ?? []).find((n) => n.slug === slug);
        const entries = () => {
          const net = network();
          if (!net) return [];
          return visibleArchiveForNetwork(slug, net.id);
        };
        return (
          // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop close-on-outside; Esc via the shared overlay stack (keybindings → runTopmostOverlayEscape)
          // biome-ignore lint/a11y/noStaticElementInteractions: backdrop is non-interactive scrim
          <div class="archive-modal-backdrop" onClick={close}>
            {/* biome-ignore lint/a11y/useKeyWithClickEvents: inner dialog onClick only stops backdrop-click propagation; Esc closes via the shared overlay stack */}
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="archive-modal-title"
              class="archive-modal"
              onClick={(e) => e.stopPropagation()}
              tabIndex={-1}
            >
              <header class="archive-modal-header">
                <h2 id="archive-modal-title">Archive — {slug}</h2>
                <button
                  type="button"
                  class="archive-modal-close"
                  aria-label="close archive"
                  onClick={close}
                >
                  ×
                </button>
              </header>
              <Show
                when={entries().length > 0}
                fallback={<p class="archive-modal-empty muted">no archived windows</p>}
              >
                <ul class="archive-modal-list">
                  <For each={entries()}>
                    {(entry) => {
                      const key = archiveKey(slug, entry.target);
                      return (
                        <li class="archive-modal-row">
                          <button
                            type="button"
                            class="archive-modal-entry-btn"
                            onClick={() => handleSelectEntry(slug, entry.target, entry.kind)}
                          >
                            <span class="archive-modal-kind">{entry.kind}</span>
                            {entry.kind === "query" ? (
                              <NickText nick={entry.target} extraClass="archive-modal-target" />
                            ) : (
                              <span class="archive-modal-target">{entry.target}</span>
                            )}
                          </button>
                          <InlineConfirmButton
                            idleLabel="×"
                            confirmLabel="really delete?"
                            armed={armedKey() === key}
                            onArm={() => setArmedKey(key)}
                            onConfirm={() => handleConfirmDelete(slug, entry.target)}
                            testId={`archive-modal-delete-${slug}-${entry.target}`}
                            extraClass="archive-modal-delete"
                          />
                        </li>
                      );
                    }}
                  </For>
                </ul>
              </Show>
            </div>
          </div>
        );
      }}
    </Show>
  );
};

export default ArchiveModal;
