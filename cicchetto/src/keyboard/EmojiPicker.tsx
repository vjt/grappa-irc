import { type Component, createMemo, createSignal, For } from "solid-js";
import { addRecent, categoriesWithRecents, loadRecents, saveRecents } from "./emoji";

export interface EmojiPickerProps {
  onInsert: (emoji: string) => void;
  onReturn: () => void;
}

const EmojiPicker: Component<EmojiPickerProps> = (props) => {
  const [recents, setRecents] = createSignal<string[]>(loadRecents());
  const cats = createMemo(() => categoriesWithRecents(recents()));

  const tap = (emoji: string) => {
    const next = addRecent(recents(), emoji);
    setRecents(next);
    saveRecents(next);
    props.onInsert(emoji);
  };

  return (
    <div class="kbd-emoji">
      <div class="kbd-emoji-grid">
        <For each={cats()}>
          {(cat) => (
            <div class="kbd-emoji-cat" data-cat={cat.id}>
              <For each={cat.emojis}>
                {(e) => (
                  <button
                    type="button"
                    class="kbd-emoji-cell"
                    onPointerDown={(ev) => ev.preventDefault()}
                    onClick={() => tap(e)}
                  >
                    {e}
                  </button>
                )}
              </For>
            </div>
          )}
        </For>
      </div>
      <div class="kbd-emoji-bar">
        <button
          type="button"
          class="kbd-emoji-abc"
          aria-label="back to letters"
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => props.onReturn()}
        >
          ABC
        </button>
        <For each={cats()}>
          {(cat) => (
            <a
              class="kbd-emoji-tab"
              href={`#kbd-cat-${cat.id}`}
              onClick={(e) => e.preventDefault()}
            >
              {cat.emojis[0] ?? ""}
            </a>
          )}
        </For>
      </div>
    </div>
  );
};

export default EmojiPicker;
