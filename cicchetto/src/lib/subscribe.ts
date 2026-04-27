import { createEffect, createRoot, on, untrack } from "solid-js";
import type { ChannelEvent } from "./api";
import { token } from "./auth";
import { type ChannelKey, channelKey } from "./channelKey";
import { channelsBySlug, user } from "./networks";
import { appendToScrollback } from "./scrollback";
import { bumpUnread, selectedChannel } from "./selection";
import { joinChannel } from "./socket";

// WS subscription installer. Reactive side-effect module: imports for
// effect, exports nothing public. The app entry (`main.tsx`) imports
// this so the join-effect createRoot evaluates at boot.
//
// Lifted out of the original `networks.ts` god-module per A4. Owns:
//   * `joined` Set — guards double-joins. Phoenix is idempotent on
//     `socket.channel(topic)` (returns the existing handle), but the
//     Set keeps the handler-install step explicit and lets future
//     Phase-5 PART logic mirror with a `leave + delete`.
//   * The createEffect that fires once `user()` + `channelsBySlug()`
//     resolve, fans out `joinChannel(...)` per channel, installs an
//     `"event"` handler that ingests messages into `scrollback` and
//     bumps `selection.unreadCounts` when the channel is not the
//     currently-selected one. Selection is read with `untrack` so the
//     join effect itself isn't reactive to selection changes
//     (joining is one-shot per channel; selection is high-frequency).
//
// Identity-scoped cleanup mirrors the on(token) arms in `scrollback.ts`
// and `selection.ts`: logout/rotation clears `joined`. Module-import
// order — subscribe imports scrollback + selection + networks — means
// each peer module's createRoot evaluates first and registers its
// cleanup before this one. On a token flush: scrollback cleanup →
// selection cleanup → networks cleanup → subscribe cleanup → the join
// effect re-runs against fresh state once the resources resolve under
// the new bearer.

createRoot(() => {
  const joined = new Set<ChannelKey>();

  createEffect(
    on(token, (t, prev) => {
      if (prev != null && t !== prev) {
        joined.clear();
      }
    }),
  );

  createEffect(() => {
    const u = user();
    const cbs = channelsBySlug();
    if (!u || !cbs) return;
    for (const [slug, list] of Object.entries(cbs)) {
      for (const ch of list) {
        const key = channelKey(slug, ch.name);
        if (joined.has(key)) continue;
        const phx = joinChannel(u.name, slug, ch.name);
        phx.on("event", (payload: ChannelEvent) => {
          if (payload.kind !== "message") return;
          appendToScrollback(key, payload.message);
          const sel = untrack(selectedChannel);
          if (sel && sel.networkSlug === slug && sel.channelName === ch.name) return;
          bumpUnread(key);
        });
        joined.add(key);
      }
    }
  });
});
