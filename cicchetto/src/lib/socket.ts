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
// Rotation side-effect: dropping the socket fires `phx_close` on every
// joined channel; phoenix.js auto-rejoins on the next `connect()`, so
// the rotation triggers a clean tear-down + rejoin loop across all
// active topics. Any in-flight `ch.join()` whose handshake was mid-
// rotation either completes against the old socket then immediately
// tears down, or errors out and rejoins under the new bearer. Phase 5
// telemetry should observe the rejoin volume on rotation events.
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

// `joinUser` / `joinNetwork` were exported in an earlier walking-skeleton
// pass alongside `joinChannel` for the per-user and per-(user, network)
// topic shapes. Phase 3 only joins per-channel topics; the other two had
// zero call sites in `src/**`. Dropped per S49 — bring them back when a
// real consumer (presence on the per-network topic, MOTD on the
// per-user topic) needs them.
export function joinChannel(userName: string, networkSlug: string, channelName: string): Channel {
  const topic = `grappa:user:${userName}/network:${networkSlug}/channel:${channelName}`;
  const ch = getSocket().channel(topic);
  // Surface server-side join failures to the console + Phase 5
  // telemetry hook (the `unknown topic` and `forbidden` shapes the
  // server returns from `GrappaChannel.join/3` would otherwise vanish
  // silently). `timeout` is the phoenix.js retry-budget exhaustion
  // shape; logging it lets a stuck channel show up in operator
  // browser-console output during diagnosis.
  ch.join()
    .receive("error", (err: unknown) => {
      console.error("[grappa] channel join failed", topic, err);
    })
    .receive("timeout", () => {
      console.error("[grappa] channel join timed out", topic);
    });
  return ch;
}
