import { type Component, createSignal, For, Show } from "solid-js";
import { ownNickForNetwork } from "./lib/api";
import { channelKey } from "./lib/channelKey";
import {
  type AvailableMode,
  availableModes,
  editorSigils,
  sanitizeModeParam,
} from "./lib/channelModes";
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
// uses (one feature, one code path): toggling an ACTIVE flag mode off
// sends `-<letter>`, an inactive one on sends `+<letter>`.
//
// #240 — param modes (type B key `+k`, type C limit `+l`) render a value
// INPUT instead of a bare toggle: an op types the key/limit and hits Set
// to send `+<letter> <value>`, or Remove to unset. Type B keeps its arg
// on unset (`-k <key>`, bahamut requires it); type C unsets bare (`-l`).
// The `params` arg on the same `mode` WS verb already carried this — the
// #216 MVP just never surfaced the input (was read-only). A non-op still
// sees the current value read-only.
//
// Overlay: registers `createOverlayLock` so the covered ScrollbackPane
// freezes its scroll position while the modal is up — the
// new-covering-modal-must-push-overlay-refcount contract (#219-general).

// A single param-taking mode row (#240). Local `draft` signal holds the
// operator's in-progress value; Set sanitises it (single non-empty wire
// token) and fires `onSet`, Remove fires `onUnset`. Reactive props are
// accessors so the row reflects WS-driven mode/param changes live.
const ParamModeRow: Component<{
  mode: AvailableMode;
  active: () => boolean;
  paramValue: () => string | null;
  canEdit: () => boolean;
  onSet: (value: string) => void;
  onUnset: () => void;
}> = (props) => {
  const [draft, setDraft] = createSignal("");

  const submit = (): void => {
    const value = sanitizeModeParam(draft());
    if (value === null) return; // empty / whitespace — nothing to send.
    props.onSet(value);
    setDraft("");
  };

  return (
    <div class="mode-modal-param-row" classList={{ "mode-modal-param-row-active": props.active() }}>
      <span class="mode-modal-toggle-flag">+{props.mode.letter}</span>
      <span class="mode-modal-toggle-label">{props.mode.label}</span>
      <Show when={props.active() && props.paramValue() !== null}>
        <span class="mode-modal-toggle-param">{props.paramValue()}</span>
      </Show>
      <span class="mode-modal-toggle-desc">{props.mode.desc}</span>
      <Show when={props.canEdit()}>
        <div class="mode-modal-param-controls">
          <input
            type="text"
            class="mode-modal-param-input"
            data-testid={`mode-param-input-${props.mode.letter}`}
            aria-label={`${props.mode.label} value`}
            placeholder={props.active() ? "new value" : props.mode.label}
            value={draft()}
            onInput={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
          <button
            type="button"
            class="mode-modal-param-btn"
            data-testid={`mode-param-set-${props.mode.letter}`}
            onClick={submit}
          >
            Set
          </button>
          <Show when={props.active()}>
            <button
              type="button"
              class="mode-modal-param-btn"
              data-testid={`mode-param-remove-${props.mode.letter}`}
              onClick={() => props.onUnset()}
            >
              Remove
            </button>
          </Show>
        </div>
      </Show>
    </div>
  );
};

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
    const id = networkId();
    if (!t || !k || id === undefined) return false;
    const net = networkBySlug(t.networkSlug);
    const me = user();
    if (!net || !me) return false;
    const nick = ownNickForNetwork(net, me);
    if (!nick) return false;
    const entry = (membersByChannel()[k] ?? []).find((m) => nickEquals(m.nick, nick));
    const modes = entry?.modes ?? [];
    // Edit gate = op-or-higher (+ halfop), derived from the network's
    // ISUPPORT PREFIX ranking so founder/admin sigils on PREFIX-rich
    // networks aren't wrongly locked out (see editorSigils/1).
    const editors = editorSigils(isupportForNetwork(id));
    return modes.some((m) => editors.has(m));
  };

  const isActive = (letter: string): boolean => currentModes().includes(letter);

  const onToggle = (m: AvailableMode): void => {
    if (!canEdit()) return;
    const id = networkId();
    const t = target();
    if (id === undefined || !t) return;
    const sign = isActive(m.letter) ? "-" : "+";
    void pushChannelMode(id, t.channel, `${sign}${m.letter}`, []);
  };

  // #240 — set a param mode to a value: `+<letter> <value>`.
  const onSetParam = (m: AvailableMode, value: string): void => {
    if (!canEdit()) return;
    const id = networkId();
    const t = target();
    if (id === undefined || !t) return;
    void pushChannelMode(id, t.channel, `+${m.letter}`, [value]);
  };

  // #240 — unset a param mode. Type B (key) keeps its arg (`-k <key>`,
  // bahamut requires it); type C (limit) unsets bare (`-l`).
  const onUnsetParam = (m: AvailableMode): void => {
    if (!canEdit()) return;
    const id = networkId();
    const t = target();
    if (id === undefined || !t) return;
    const current = currentParams()[m.letter] ?? null;
    const params = m.paramOnUnset && current !== null ? [current] : [];
    void pushChannelMode(id, t.channel, `-${m.letter}`, params);
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
                {(m) => (
                  <Show
                    when={m.takesParam}
                    fallback={
                      <button
                        type="button"
                        class="mode-modal-toggle"
                        classList={{ "mode-modal-toggle-active": isActive(m.letter) }}
                        aria-pressed={isActive(m.letter)}
                        aria-disabled={!canEdit()}
                        aria-label={`${m.label} (+${m.letter})`}
                        onClick={() => onToggle(m)}
                      >
                        <span class="mode-modal-toggle-flag">+{m.letter}</span>
                        <span class="mode-modal-toggle-label">{m.label}</span>
                        <span class="mode-modal-toggle-desc">{m.desc}</span>
                      </button>
                    }
                  >
                    <ParamModeRow
                      mode={m}
                      active={() => isActive(m.letter)}
                      paramValue={() => currentParams()[m.letter] ?? null}
                      canEdit={canEdit}
                      onSet={(value) => onSetParam(m, value)}
                      onUnset={() => onUnsetParam(m)}
                    />
                  </Show>
                )}
              </For>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
};

export default ModeModal;
