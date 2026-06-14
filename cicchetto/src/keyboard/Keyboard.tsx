import { type Component, createSignal, For, lazy, Show, Suspense } from "solid-js";
import AcceleratorBar from "./AcceleratorBar";
import type { StripGeometry } from "./gesture";
import KeyCap from "./KeyCap";
import { LAYERS } from "./layouts";
import type { KeyboardLayer, KeyboardProps } from "./types";
import VariationStrip from "./VariationStrip";

// Lazy: the emoji picker drags in the full ~1900-entry emoji-data table.
// Code-split it so that table is NOT in the first-paint chunk — it loads
// only when the emoji layer is first opened (design spec §12: lazy dataset).
const EmojiPicker = lazy(() => import("./EmojiPicker"));

const Keyboard: Component<KeyboardProps> = (props) => {
  const [layer, setLayer] = createSignal<KeyboardLayer>("letters");
  const [shift, setShift] = createSignal(false);
  const [strip, setStrip] = createSignal<{
    variants: string[];
    geom: StripGeometry;
    highlight: () => number | null;
  } | null>(null);

  const charLayer = () =>
    layer() === "letters" ? "letters" : layer() === "numbers" ? "numbers" : "symbols";
  const cased = (s: string) => (shift() ? s.toUpperCase() : s);

  const commit = (text: string) => {
    props.onIntent({ kind: "insertText", text });
    if (shift()) setShift(false); // one-shot shift
    setStrip(null);
  };

  const ctrl = (label: string, aria: string, onClick: () => void, fnExtra = "") => (
    <button
      type="button"
      class={`kbd-key kbd-key--fn ${fnExtra}`}
      aria-label={aria}
      onPointerDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {label}
    </button>
  );

  return (
    <div class="kbd-root" classList={{ "kbd-hidden": !props.visible }}>
      <AcceleratorBar leftAccessories={props.leftAccessories} onIntent={props.onIntent} />

      <Show
        when={layer() !== "emoji"}
        fallback={
          <Suspense>
            <EmojiPicker
              onInsert={(e) => props.onIntent({ kind: "insertText", text: e })}
              onReturn={() => setLayer("letters")}
            />
          </Suspense>
        }
      >
        <div class="kbd-rows">
          <For each={LAYERS[charLayer()]}>
            {(row) => (
              <div class="kbd-row">
                <For each={row}>
                  {(k) => {
                    if (k.role === "char") {
                      return (
                        <KeyCap
                          label={charLayer() === "letters" ? cased(k.label) : k.label}
                          insertText={
                            charLayer() === "letters" ? cased(k.text ?? "") : (k.text ?? "")
                          }
                          onCommit={commit}
                          onOpenVariants={(args) => setStrip(args)}
                        />
                      );
                    }
                    if (k.role === "shift")
                      return ctrl(
                        "⇧",
                        "shift",
                        () => setShift((s) => !s),
                        shift() ? "kbd-key--active" : "",
                      );
                    if (k.role === "backspace")
                      return ctrl("⌫", "backspace", () =>
                        props.onIntent({ kind: "deleteBackward" }),
                      );
                    if (k.role === "layer")
                      return ctrl(k.label, `layer ${k.text}`, () =>
                        setLayer(k.text as KeyboardLayer),
                      );
                    return null;
                  }}
                </For>
              </div>
            )}
          </For>

          {/* bottom control row */}
          <div class="kbd-row">
            {ctrl(layer() === "letters" ? "123" : "ABC", "layer switch", () =>
              setLayer(layer() === "letters" ? "numbers" : "letters"),
            )}
            {ctrl("☺", "emoji", () => setLayer("emoji"))}
            <button
              type="button"
              class="kbd-key kbd-space"
              aria-label="space"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => props.onIntent({ kind: "insertText", text: " " })}
            />
            {ctrl("⏎", "return", () => props.onIntent({ kind: "submit" }))}
          </div>
        </div>
      </Show>

      <Show when={strip()}>
        {(s) => (
          <VariationStrip variants={s().variants} geom={s().geom} highlight={s().highlight()} />
        )}
      </Show>
    </div>
  );
};

export default Keyboard;
