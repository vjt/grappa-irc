// #606 — the peer whose query context the right rail shows: a plain query's
// partner or, since issue 2499, an encrypted window's peer (the same WHOIS
// card in both). The one answer to "which nick is the rail showing", read by
// RailContext, which asks for that nick's WHOIS while the rail is on screen
// (#782), and by userTopic, which refreshes the rail card from a user's own
// /whois for that nick. Null on any other window.

import { focusedEncryptedWindow } from "./encryptedWindow";
import { selectedChannel } from "./selection";

export function railPeer(): { networkSlug: string; nick: string } | null {
  const sel = selectedChannel();
  if (sel?.kind === "query") return { networkSlug: sel.networkSlug, nick: sel.channelName };
  return focusedEncryptedWindow();
}
