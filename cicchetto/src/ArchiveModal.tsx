import { type Component, createSignal, For, Show } from "solid-js";
import InlineConfirmButton from "./InlineConfirmButton";
import { deleteArchiveEntry } from "./lib/api";
import {
  archiveModalNetwork,
  setArchiveModalNetwork,
  visibleArchiveForNetwork,
} from "./lib/archive";
import { token } from "./lib/auth";
import { networks } from "./lib/networks";
import { setSelectedChannel } from "./lib/selection";

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
                            <span class="archive-modal-target">{entry.target}</span>
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
