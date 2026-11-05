import { type Component, createSignal, Show } from "solid-js";
import { copyText } from "./lib/clipboard";

// The encrypted chats' copy button: the rail's "copy your key". (Issue 2537
// gave "add a device" one for its pairing link; issue 2549 took the link, and
// the button with it.) A refused or insecure-context write says why under the
// button and leaves the text on screen, to copy by hand.
// Disabled while there is nothing to copy.
const E2eCopyButton: Component<{ text: string | undefined; label: string; testId: string }> = (
  props,
) => {
  const [error, setError] = createSignal<string | null>(null);
  const copy = async () => {
    const text = props.text;
    if (text === undefined) return;
    setError(null);
    try {
      await copyText(text);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <>
      <button
        type="button"
        class="e2e-copy"
        data-testid={props.testId}
        disabled={props.text === undefined}
        onClick={() => void copy()}
      >
        {props.label}
      </button>
      <Show when={error()}>
        {(message) => (
          <div class="e2e-error" data-testid={`${props.testId}-error`}>
            {message()}
          </div>
        )}
      </Show>
    </>
  );
};

export default E2eCopyButton;
