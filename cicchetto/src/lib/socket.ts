import { type Channel, Socket } from "phoenix";
import { createEffect, createRoot, on } from "solid-js";
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
// Token-driven lifecycle: phoenix.js evaluates the Socket's `params`
// callback only at WS-handshake time, so a live connection stays
// pinned to whatever bearer the handshake captured. Three transitions
// matter — login (null → t: connect), logout (t → null: disconnect),
// and rotation (a → b, both non-null and distinct: disconnect+connect
// to flush the new bearer onto the next handshake). Phase 5
// token-refresh and admin-driven re-issue both ride this path; without
// the rotation arm they would silently route under the stale identity.
// `on(token, fn)` gives us the prev value the rotation check needs;
// createRoot anchors the effect since module-level effects need an
// owner.
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
  createEffect(
    on(token, (t, prev) => {
      if (t === null) {
        if (_socket?.isConnected()) _socket.disconnect();
        return;
      }
      const s = getSocket();
      if (prev != null && prev !== t) {
        // Token rotation: live socket is pinned to `prev`; drop and
        // reconnect so the params callback returns `t` on the next
        // handshake.
        if (s.isConnected()) s.disconnect();
        s.connect();
        return;
      }
      if (!s.isConnected()) s.connect();
    }),
  );
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
