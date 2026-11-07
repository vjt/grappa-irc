import { type Component, createMemo, createSignal, For, Show } from "solid-js";
import { getCommandMenuEnabled, getCommandMenuEntries } from "./lib/commandMenu";
import { rankCommands } from "./lib/commandUsage";
import type { CommandCycle } from "./lib/compose";
import { createOverlayEscape } from "./lib/overlayScrollLock";

// issue 2584 — the dropdown over the compose box that offers commands while
// the draft is a lone `/verb`: most used first (lib/commandUsage), filtered by
// what follows the `/`, as many entries as this device asks for
// (lib/commandMenu).
//
// It is a VIEW over state that already exists, never a second state machine:
// the draft and the compose door's Tab cycle (`commandCycle`) say what it
// shows. That is why it closes "by itself" on a space, on deleting the `/`,
// and on send — each of those changes the draft — and why Tab and swipe right
// need nothing from it: they walk the same ring the engine already keeps, and
// the menu marks the slot they are on. The arrow keys are not its either:
// they stay history recall while it is open (vjt's ruling), and a recalled
// line simply re-derives what it shows.
//
// The one state it owns is Escape's: closed until the draft changes. Escape
// arrives through the ONE ESC authority (#232, keybindings.ts →
// `runTopmostOverlayEscape`) via `createOverlayEscape`, the non-covering
// overlay door the inline cards and the context menu use (#1772): it does not
// freeze the scrollback, and the composer stays live under it.

type Props = {
  draft: string;
  cycle: CommandCycle | null;
  // #737/#904 — a composer that refuses writes offers nothing to write.
  readOnly: boolean;
  onPick: (verb: string) => void;
};

// The verb prefix of a draft that is a lone `/verb` and nothing else, or null.
// `/` must be the very first character, and `//` is the literal-text escape.
export const loneVerb = (draft: string): string | null =>
  /^\/(?!\/)\S*$/.test(draft) ? draft.slice(1) : null;

const CommandMenu: Component<Props> = (props) => {
  const [dismissedFor, setDismissedFor] = createSignal<string | null>(null);

  const view = createMemo((): { entries: string[]; active: number | null } | null => {
    if (!getCommandMenuEnabled() || props.readOnly) return null;
    if (dismissedFor() === props.draft) return null;
    const limit = getCommandMenuEntries();
    // A live command cycle: the draft holds the entry Tab put there (with its
    // space), so the list is the cycle's, and the slot past the last entry is
    // the typed word, which marks nothing.
    const cycle = props.cycle;
    if (cycle !== null) {
      const entries = rankCommands(cycle.prefix, limit);
      return entries.length === 0
        ? null
        : { entries, active: cycle.idx < entries.length ? cycle.idx : null };
    }
    const prefix = loneVerb(props.draft);
    if (prefix === null) return null;
    const entries = rankCommands(prefix, limit);
    return entries.length === 0 ? null : { entries, active: null };
  });

  createOverlayEscape(
    () => view() !== null,
    () => setDismissedFor(props.draft),
  );

  return (
    <Show when={view()}>
      {(v) => (
        <div class="command-menu" role="listbox" aria-label="commands" data-testid="command-menu">
          <For each={v().entries}>
            {(verb, i) => (
              <button
                type="button"
                class="command-menu-entry"
                role="option"
                aria-selected={i() === v().active}
                // The keyboard's way through the entries is Tab IN the
                // composer (the ring above); the entries are for a pointer.
                tabIndex={-1}
                // #59 — keep the composer focused, or the phone's keyboard
                // closes under the tap. The cancel rides `mousedown`, the
                // focus-shift carrier, NEVER `pointerdown` (lib/keepKeyboard).
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => props.onPick(verb)}
              >
                /{verb}
              </button>
            )}
          </For>
        </div>
      )}
    </Show>
  );
};

export default CommandMenu;
