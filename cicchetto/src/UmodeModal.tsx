import { type Component, For, Show } from "solid-js";
import { networkIdBySlug } from "./lib/networks";
import { createOverlayLock } from "./lib/overlayScrollLock";
import { pushChannelUmode } from "./lib/socket";
import { closeUmodeModal, umodeModalState } from "./lib/umodeModal";
import { type AvailableUmode, availableUmodes } from "./lib/umodeModes";
import { umodesForNetwork } from "./lib/umodes";

// #229 — /mode <nick> (umode) viewer/editor modal. Opened by compose.ts
// (bare `/umode` / `/mode <ownnick>`) and by tapping the umode indicator in
// the sidebar/bottom-bar network header. Shows the operator's own umodes as
// chunky retro toggle buttons (the same `.mode-modal-*` CSS as #216's
// channel-mode modal — reuse the verb, not the noun), each carrying a short
// description; a settable umode can be toggled ON/OFF, a server/services-
// managed one (o/r/a/A/S) is shown read-only.
//
// Data sources (all server-owned, cic mirrors — no client state
// origination):
//   * available toggles ← the static `umodeModes` table unioned with any
//     active-but-unknown vendor letter (availableUmodes/1).
//   * active umodes     ← `umodesForNetwork(networkId)` (from 221 / self-MODE
//     echoes, seeded via the umode_changed wire event).
//
// Editing pushes the same `umode` WS verb the `/umode +x` command uses (one
// feature, one code path): toggling an ACTIVE umode off sends `-<letter>`,
// an inactive one on sends `+<letter>`. No edit-gate (you always own your
// own umodes) and no params (umodes are flag-only) — the two structural
// simplifications over #216's channel-mode modal.
//
// Overlay: registers `createOverlayLock` so the covered ScrollbackPane
// freezes its scroll position while the modal is up — the
// new-covering-modal-must-push-overlay-refcount contract (#219-general).

const UmodeModal: Component = () => {
  const target = () => umodeModalState();

  const networkId = (): number | undefined => {
    const t = target();
    if (!t) return undefined;
    return networkIdBySlug(t.networkSlug);
  };

  const activeModes = (): string[] => {
    const id = networkId();
    return id === undefined ? [] : umodesForNetwork(id);
  };

  const toggles = (): AvailableUmode[] => availableUmodes(activeModes());

  const isActive = (letter: string): boolean => activeModes().includes(letter);

  const onToggle = (m: AvailableUmode): void => {
    // Server/services-managed umodes are read-only in the modal — the ircd
    // sets them and would reject a change anyway.
    if (!m.settable) return;
    const id = networkId();
    if (id === undefined) return;
    const sign = isActive(m.letter) ? "-" : "+";
    void pushChannelUmode(id, `${sign}${m.letter}`);
  };

  // Overlay refcount so ScrollbackPane freezes while the modal covers it +
  // #232 shared Esc-to-close (topmost-first, focus-independent).
  createOverlayLock(() => umodeModalState() !== null, ".umode-modal", closeUmodeModal);

  return (
    <Show when={target()} keyed>
      {(t) => (
        // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop close-on-outside; Esc via the shared overlay stack (keybindings → runTopmostOverlayEscape)
        // biome-ignore lint/a11y/noStaticElementInteractions: backdrop is non-interactive scrim
        <div class="mode-modal-backdrop" onClick={closeUmodeModal}>
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: inner dialog onClick only stops backdrop-click propagation; Esc closes via the shared overlay stack */}
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="umode-modal-title"
            class="mode-modal umode-modal"
            data-testid="umode-modal"
            onClick={(e) => e.stopPropagation()}
            tabIndex={-1}
          >
            <header class="mode-modal-header">
              <h2 id="umode-modal-title">User modes: {t.networkSlug}</h2>
              <button
                type="button"
                class="mode-modal-close"
                aria-label="close user modes"
                onClick={closeUmodeModal}
              >
                ×
              </button>
            </header>
            <div class="mode-modal-body">
              <For each={toggles()}>
                {(m) => {
                  const active = () => isActive(m.letter);
                  return (
                    <button
                      type="button"
                      class="mode-modal-toggle"
                      classList={{ "mode-modal-toggle-active": active() }}
                      aria-pressed={active()}
                      aria-disabled={!m.settable}
                      aria-label={`${m.label} (+${m.letter})`}
                      onClick={() => onToggle(m)}
                    >
                      <span class="mode-modal-toggle-flag">+{m.letter}</span>
                      <span class="mode-modal-toggle-label">{m.label}</span>
                      <span class="mode-modal-toggle-desc">{m.desc}</span>
                      <Show when={!m.settable}>
                        <span class="mode-modal-toggle-param">server-set</span>
                      </Show>
                    </button>
                  );
                }}
              </For>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
};

export default UmodeModal;
