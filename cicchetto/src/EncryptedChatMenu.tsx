import { type Component, createSignal, onCleanup, Show } from "solid-js";
import ContextMenu from "./ContextMenu";
import { encryptedWireView, toggleEncryptedWireView } from "./lib/encryptedChats";
import type { Point } from "./lib/swipe";

// issue 2513 — the menu of an encrypted window's row in the sidebar: its one
// item flips the chat between its plaintext and the payloads that crossed IRC
// (the issue puts the door in the sidebar, never in the top bar). A
// right-click opens it, and on a touch device a hold (`bindNickLongPress`,
// which delivers the same `contextmenu` where iOS sends none). The chrome is
// `ContextMenu`, shared with the nick and message menus.
//
// What is open is held here and not in the Sidebar, which keeps no state of
// its own: Shell remounts it on every swipe (#1041). The menu goes with the
// Sidebar that mounted it, so a remount never brings back a stale one.

type Target = { networkSlug: string; nick: string; at: Point };

const [target, setTarget] = createSignal<Target | null>(null);

export function openEncryptedChatMenu(next: Target): void {
  setTarget(next);
}

const EncryptedChatMenu: Component = () => {
  onCleanup(() => setTarget(null));
  return (
    <Show when={target()}>
      {(open) => (
        <ContextMenu
          items={[
            {
              label: encryptedWireView(open().networkSlug, open().nick)
                ? "Show plaintext"
                : "Show ciphertext",
              enabled: true,
              action: () => toggleEncryptedWireView(open().networkSlug, open().nick),
            },
          ]}
          position={open().at}
          onClose={() => setTarget(null)}
        />
      )}
    </Show>
  );
};

export default EncryptedChatMenu;
