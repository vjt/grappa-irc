// issue 2430 — the encrypted query window's two doors: opening it (the
// `/equery` verb, the nick menu's "encrypted query") focuses it, and its ×
// closes it. Whether it is open is the device's chat index's word
// (`encryptedChats.ts`); the window is named `$e2e:<nick>` (`windowKinds.ts`).
// Focus after a close is the selection close-watcher's, as for a query.
//
// The × asks first when the chat keeps rows (2430: "on closing an encrypted
// query: delete or keep the messages"). Delete is the affirmative, red like
// every destructive yes in cic, and deletes them here and in every tab; Keep
// is the third door (#816), the plain close that hides the chat and keeps
// its rows for `/equery`. Cancel is the default answer (#195). A chat with
// nothing in it closes without a question that has nothing to keep or delete.

import { requestConfirm } from "./confirmDialog";
import { fold } from "./e2e/wire";
import {
  closeEncryptedChat,
  deleteEncryptedChat,
  encryptedChatHasRows,
  openEncryptedChat,
} from "./encryptedChats";
import { selectedChannel, setSelectedChannel } from "./selection";
import { encryptedWindowName, encryptedWindowPeer } from "./windowKinds";

export async function openEncryptedWindow(networkSlug: string, nick: string): Promise<void> {
  // Open first: a chat the device could not open gets no window.
  await openEncryptedChat(networkSlug, nick);
  setSelectedChannel({ networkSlug, channelName: encryptedWindowName(nick), kind: "encrypted" });
}

// The doors fire from a click: a failure is said, never thrown at it.
function said(work: Promise<void>, what: string): void {
  void work.catch((err: unknown) => {
    console.warn(`[e2e] could not ${what}`, err);
  });
}

export function closeEncryptedWindow(networkSlug: string, nick: string): void {
  const close = () =>
    said(
      closeEncryptedChat(networkSlug, nick),
      `close the encrypted chat with ${nick} on ${networkSlug}`,
    );
  said(
    encryptedChatHasRows(networkSlug, nick).then((rows) => {
      if (!rows) return close();
      requestConfirm({
        title: "Close encrypted query",
        body:
          `Delete the messages with ${nick} on this device, or keep them? ` +
          `Deleted messages cannot be brought back: grappa never had them.`,
        confirmLabel: "Delete",
        onConfirm: () =>
          said(
            deleteEncryptedChat(networkSlug, nick),
            `delete the encrypted chat with ${nick} on ${networkSlug}`,
          ),
        alternative: { label: "Keep", onSelect: close },
        attachments: null,
        choice: null,
        toggle: null,
        defaultButton: "cancel",
      });
    }),
    `read the encrypted chat with ${nick} on ${networkSlug}`,
  );
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
