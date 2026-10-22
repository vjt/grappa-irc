// issue 2430 — the encrypted query window's two doors: opening it (the
// `/equery` verb, the nick menu's "encrypted query") focuses it, and its ×
// closes it. Whether it is open is the device's chat index's word
// (`encryptedChats.ts`); the window is named `$e2e:<nick>` (`windowKinds.ts`).
// Focus after a close is the selection close-watcher's, as for a query.

import { fold } from "./e2e/wire";
import { closeEncryptedChat, openEncryptedChat } from "./encryptedChats";
import { selectedChannel, setSelectedChannel } from "./selection";
import { encryptedWindowName, encryptedWindowPeer } from "./windowKinds";

export async function openEncryptedWindow(networkSlug: string, nick: string): Promise<void> {
  // Open first: a chat the device could not open gets no window.
  await openEncryptedChat(networkSlug, nick);
  setSelectedChannel({ networkSlug, channelName: encryptedWindowName(nick), kind: "encrypted" });
}

export function closeEncryptedWindow(networkSlug: string, nick: string): void {
  void closeEncryptedChat(networkSlug, nick).catch((err: unknown) => {
    console.warn(`[e2e] could not close the encrypted chat with ${nick} on ${networkSlug}`, err);
  });
}

/**
 * True when the focused window is the encrypted chat `key` (a folded nick)
 * on `networkSlug`: the nick in the window's name may be spelled as typed.
 */
export function encryptedWindowSelected(networkSlug: string, key: string): boolean {
  const sel = selectedChannel();
  if (sel?.kind !== "encrypted" || sel.networkSlug !== networkSlug) return false;
  const peer = encryptedWindowPeer(sel.channelName);
  return peer !== null && fold(peer) === key;
}
