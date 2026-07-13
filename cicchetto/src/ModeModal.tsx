import { type Component, For, Show } from "solid-js";
import { ownNickForNetwork } from "./lib/api";
import { channelKey } from "./lib/channelKey";
import { type AvailableMode, availableModes } from "./lib/channelModes";
import { modesByChannel } from "./lib/channelTopic";
import { isupportForNetwork } from "./lib/isupport";
import { membersByChannel } from "./lib/members";
import { closeModeModal, modeModalState } from "./lib/modeModal";
import { networkBySlug, networks, user } from "./lib/networks";
import { nickEquals } from "./lib/nickEquals";
import { createOverlayLock } from "./lib/overlayScrollLock";
import { pushChannelMode } from "./lib/socket";

// #216 — /mode viewer/editor modal. Opened by compose.ts (`/mode #chan`
// / bare `/mode`) and by tapping the `.topic-bar-modes` indicator in
// TopicBar. Shows the channel's current modes as chunky retro toggle
// buttons, each carrying a short description; a chanop (or halfop) can
// toggle a mode ON/OFF, a plain user sees them read-only.
//
// Data sources (all server-owned, cic mirrors — no client state
// origination):
//   * available toggles ← `isupportForNetwork(networkId)` fed into
//     `availableModes/1` (the network's CHANMODES B/C/D classes; PREFIX
//     membership + type-A list modes are excluded — see channelModes.ts).
//   * current modes     ← `modesByChannel[key]` (from 324 / MODE events).
//   * edit gate         ← own-nick's modes in `membersByChannel[key]`
//     (the exact `ownModes` derivation MembersPane uses for its ops
//     menu — no parallel state).
//
// Editing pushes the same `mode` WS verb the `/mode #chan +s` command
// uses (one feature, one code path): toggling an ACTIVE mode off sends
// `-<letter>`, an inactive one on sends `+<letter>`. Param modes (k/l)
// show their current value read-only in MVP — setting a keyed/limited
// mode value is a follow-up (the toggle covers the flag-mode majority
// the P1 is about; a param SET still works via the explicit
// `/mode #chan +k secret` command, which bypasses the modal).
//
// Overlay: registers `createOverlayLock` so the covered ScrollbackPane
// freezes its scroll position while the modal is up — the
// new-covering-modal-must-push-overlay-refcount contract (#219-general).

const ModeModal: Component = () => {
  const target = () => modeModalState();

  const key = () => {
    const t = target();
    return t ? channelKey(t.networkSlug, t.channel) : null;
  };

  const networkId = (): number | undefined => {
    const t = target();
    if (!t) return undefined;
    return networks()?.find((n) => n.slug === t.networkSlug)?.id;
  };

  // Current channel modes (letters + params) from the server-seeded cache.
  const currentModes = (): string[] => {
    const k = key();
    return k ? (modesByChannel()[k]?.modes ?? []) : [];
  };
  const currentParams = (): Record<string, string | null> => {
    const k = key();
    return k ? (modesByChannel()[k]?.params ?? {}) : {};
  };

  // The togglable modes for this network, derived from ISUPPORT.
  const toggles = (): AvailableMode[] => {
    const id = networkId();
    if (id === undefined) return [];
    return availableModes(isupportForNetwork(id));
  };

  // Own-nick's modes in this channel — the chanop edit gate. Same
  // derivation as MembersPane (own IRC nick via ownNickForNetwork, looked
  // up in membersByChannel; no parallel state). Editing is allowed for
  // op (@) or halfop (%).
  const canEdit = (): boolean => {
    const t = target();
    const k = key();
    if (!t || !k) return false;
    const net = networkBySlug(t.networkSlug);
    const me = user();
    if (!net || !me) return false;
    const nick = ownNickForNetwork(net, me);
    if (!nick) return false;
    const entry = (membersByChannel()[k] ?? []).find((m) => nickEquals(m.nick, nick));
    const modes = entry?.modes ?? [];
    return modes.includes("@") || modes.includes("%");
  };

  const isActive = (letter: string): boolean => currentModes().includes(letter);

  const onToggle = (m: AvailableMode): void => {
    if (!canEdit()) return;
    const id = networkId();
    const t = target();
    if (id === undefined || !t) return;
    // Param modes are read-only in the modal MVP — a value SET needs the
    // explicit `/mode #chan +k secret` command. Toggling a set param mode
    // OFF is safe (`-k` / `-l` take no arg), so allow that; block turning
    // one ON from the modal (no value to send).
    if (m.takesParam && !isActive(m.letter)) return;
    const sign = isActive(m.letter) ? "-" : "+";
    void pushChannelMode(id, t.channel, `${sign}${m.letter}`, []);
  };

  // Overlay refcount so ScrollbackPane freezes while the modal covers it.
  createOverlayLock(() => modeModalState() !== null, ".mode-modal");

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") closeModeModal();
  };

  return (
    <Show when={target()} keyed>
      {(t) => (
        // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop close-on-outside; Esc handled by dialog onKeyDown
        // biome-ignore lint/a11y/noStaticElementInteractions: backdrop is non-interactive scrim
        <div class="mode-modal-backdrop" onClick={closeModeModal}>
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="mode-modal-title"
            class="mode-modal"
            data-testid="mode-modal"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={onKeyDown}
            tabIndex={-1}
          >
            <header class="mode-modal-header">
              <h2 id="mode-modal-title">
                Channel modes: {t.channel}
                <Show when={!canEdit()}>
                  <span class="mode-modal-readonly"> (read-only)</span>
                </Show>
              </h2>
              <button
                type="button"
                class="mode-modal-close"
                aria-label="close modes"
                onClick={closeModeModal}
              >
                ×
              </button>
            </header>
            <div class="mode-modal-body">
              <For each={toggles()}>
                {(m) => {
                  const active = () => isActive(m.letter);
                  const paramValue = () => currentParams()[m.letter] ?? null;
                  return (
                    <button
                      type="button"
                      class="mode-modal-toggle"
                      classList={{ "mode-modal-toggle-active": active() }}
                      aria-pressed={active()}
                      aria-disabled={!canEdit()}
                      aria-label={`${m.label} (+${m.letter})`}
                      onClick={() => onToggle(m)}
                    >
                      <span class="mode-modal-toggle-flag">+{m.letter}</span>
                      <span class="mode-modal-toggle-label">{m.label}</span>
                      <span class="mode-modal-toggle-desc">{m.desc}</span>
                      <Show when={active() && m.takesParam && paramValue() !== null}>
                        <span class="mode-modal-toggle-param">{paramValue()}</span>
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

export default ModeModal;
