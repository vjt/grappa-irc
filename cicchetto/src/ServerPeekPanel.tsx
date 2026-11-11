import { type Component, createEffect, For, type JSX, Show } from "solid-js";
import type { ScrollbackMessage } from "./lib/api";
import { closeServerPeek, serverPeekRows } from "./lib/serverPeek";

// issue 2625 — the `$server` peek card: on a phone, the `$server` lines that
// arrived after a command, over the window it was typed in (lib/serverPeek.ts
// says which lines and when). A member of the top-pinned card family
// (WHOIS / WHOWAS / LUSERS, ScrollbackPane's `.scrollback-overlay`): it floats
// over the scroll list without resizing it, so the reader keeps their place,
// and its ✕ wins the top-right corner over the mobile ☰ the way #1051 ruled
// for every card there.
//
// The lines are drawn by `line`, which the host supplies: ScrollbackPane hands
// over the one message-line renderer (issue 2498), so a `$server` line reads
// the same here as in its own window — nick buttons, numerics, colours. The
// card adds only its frame. Nothing here is a copy: dismissing it leaves every
// line where it was, in `$server`.

const ServerPeekPanel: Component<{
  networkSlug: string;
  line: (msg: ScrollbackMessage) => JSX.Element;
}> = (props) => {
  const rows = () => serverPeekRows(props.networkSlug);

  // The newest line is the one just asked for: keep the body pinned to it as
  // replies land (the services console's rule). jsdom has no layout, so this
  // is a no-op there.
  let bodyRef: HTMLDivElement | undefined;
  createEffect(() => {
    rows().length;
    if (bodyRef) bodyRef.scrollTop = bodyRef.scrollHeight;
  });

  return (
    <Show when={rows().length > 0}>
      <section
        class="server-peek selectable-text"
        data-testid="server-peek"
        aria-label={`${props.networkSlug} server messages`}
      >
        <div class="server-peek-header">
          <span class="server-peek-title">{props.networkSlug}</span>
          <button
            type="button"
            class="server-peek-close"
            aria-label="close"
            onClick={() => closeServerPeek()}
          >
            ×
          </button>
        </div>
        <div class="server-peek-body" ref={bodyRef}>
          <For each={rows()}>{(m) => props.line(m)}</For>
        </div>
      </section>
    </Show>
  );
};

export default ServerPeekPanel;
