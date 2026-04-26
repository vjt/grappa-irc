import { type Channel, Socket } from "phoenix";
import { createEffect, createRoot } from "solid-js";
import { token } from "./auth";

// Phoenix Channels singleton. Mirrors `auth.ts`'s module-singleton shape:
// every component that needs the live event-push surface joins via the
// helpers here; one Socket per browser tab regardless of how many call
// sites subscribe.
//
// Lazy construction: `getSocket()` builds the Socket on first call (i.e.
// the first time something tries to join). Until then nothing connects
// — RequireAuth bounces unauthenticated visitors to /login before any
// channel-needing component renders, so the lazy path means we don't
// even try to open a WS without a bearer.
//
// Token-driven connect/disconnect: the Phoenix Socket reads its `params`
// callback on every (re)connect, so logout-then-login swaps the bearer
// without a manual token-rotation dance. The createEffect on `token()`
// disconnects on logout (signal goes null) and reconnects on the next
// non-null value — covers explicit logout and any 401-driven token
// clear by the same path. createRoot anchors the effect; module-level
// effects need an owner.
//
// Topic vocabulary mirrors `Grappa.PubSub.Topic` exactly. Don't
// reformat segment separators or re-encode identifiers — the server's
// `Topic.parse/1` is the authority and accepts these byte-for-byte.

let _socket: Socket | null = null;

function getSocket(): Socket {
  if (_socket === null) {
    _socket = new Socket("/socket", {
      params: () => ({ token: token() ?? "" }),
    });
  }
  return _socket;
}

createRoot(() => {
  createEffect(() => {
    const t = token();
    if (t === null) {
      if (_socket?.isConnected()) _socket.disconnect();
    } else {
      const s = getSocket();
      if (!s.isConnected()) s.connect();
    }
  });
});

export function joinUser(userName: string): Channel {
  const ch = getSocket().channel(`grappa:user:${userName}`);
  ch.join();
  return ch;
}

export function joinNetwork(userName: string, networkSlug: string): Channel {
  const ch = getSocket().channel(`grappa:user:${userName}/network:${networkSlug}`);
  ch.join();
  return ch;
}

export function joinChannel(userName: string, networkSlug: string, channelName: string): Channel {
  const ch = getSocket().channel(
    `grappa:user:${userName}/network:${networkSlug}/channel:${channelName}`,
  );
  ch.join();
  return ch;
}
