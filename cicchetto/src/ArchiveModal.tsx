import { type Component, createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import InlineConfirmButton from "./InlineConfirmButton";
import { deleteArchiveEntry } from "./lib/api";
import {
  archiveModalNetwork,
  setArchiveModalNetwork,
  visibleArchiveForNetwork,
} from "./lib/archive";
import { token } from "./lib/auth";
import { networks } from "./lib/networks";
import { popOverlay, pushOverlay } from "./lib/overlayScrollLock";
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

  // UX-6 bucket A — refcounted overlay scroll-lock. Tracks
  // `archiveModalNetwork()` (the "is the modal open?" signal — null
  // when closed, slug when open). Edge-triggered push/pop via
  // wasOpen closure so re-renders with the same value don't double-
  // push. onCleanup pops if still open on unmount (defensive — the
  // ArchiveModal component lives at Shell root so unmount only on
  // route nav-away, where the leak would persist across sessions).
  //
  // v4: scroll-lock targets the .archive-modal element (the actual
  // scroller). Since .archive-modal is rendered inside `<Show keyed>`
  // (mounts when open, unmounts when closed), we look it up via
  // querySelector in queueMicrotask to let SolidJS commit the render
  // before we hand the element to body-scroll-lock-upgrade.
  let wasOpen = false;
  let lockedEl: HTMLElement | null = null;
  createEffect(() => {
    const open = archiveModalNetwork() !== null;
    if (open && !wasOpen) {
      wasOpen = true;
      queueMicrotask(() => {
        lockedEl = document.querySelector<HTMLElement>(".archive-modal");
        pushOverlay(lockedEl);
      });
    } else if (!open && wasOpen) {
      wasOpen = false;
      popOverlay(lockedEl);
      lockedEl = null;
    }
  });
  onCleanup(() => {
    if (wasOpen) {
      wasOpen = false;
      popOverlay(lockedEl);
      lockedEl = null;
    }
  });

  const close = () => {
    setArchiveModalNetwork(null);
    setArmedKey(null);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };

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
          // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop close-on-outside; Esc handled by dialog onKeyDown
          // biome-ignore lint/a11y/noStaticElementInteractions: backdrop is non-interactive scrim
          <div class="archive-modal-backdrop" onClick={close}>
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="archive-modal-title"
              class="archive-modal"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={onKeyDown}
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
