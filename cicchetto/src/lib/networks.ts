import { createEffect, createResource, createRoot, on, untrack } from "solid-js";
import {
  type ChannelEntry,
  type ChannelEvent,
  listChannels,
  listNetworks,
  type MeResponse,
  me,
  type Network,
} from "./api";
import { token } from "./auth";
import { type ChannelKey, channelKey } from "./channelKey";
import { appendToScrollback } from "./scrollback";
import { bumpUnread, selectedChannel } from "./selection";
import { joinChannel } from "./socket";

// Network/channel tree resources + the WS join-effect that fans out
// per-channel topic subscriptions. Module-singleton — every consumer
// reads the same fine-grained signals; no provider boilerplate.
//
// Resources:
//   * `networks` — `GET /networks` keyed on the bearer signal.
//   * `user` — `GET /me`, gated on the bearer; the user_name builds
//     per-channel topic strings (`grappa:user:{name}/...`).
//   * `channelsBySlug` — fans out one `GET /networks/:slug/channels`
//     per network the user is on. Slug is the topic-vocabulary
//     identifier; the integer id is REST-internal only.
//
// WS join effect (the eventual subscribe.ts in step 4): once both
// `user()` and `channelsBySlug()` resolve, joins the per-channel
// Phoenix.Channel topic for every channel and installs an `"event"`
// handler that (a) appends the new message to scrollback via
// `appendToScrollback`, (b) bumps the unread count via `bumpUnread`
// when the channel is not the currently-selected one. Selection is
// read with `untrack` so the join effect itself isn't reactive to
// selection changes (joining is one-shot per channel; selection is
// high-frequency).
//
// `joined` is a Set guarding double-joins. Phoenix is idempotent on
// `socket.channel(topic)` returning the existing handle, but tracking
// the join here keeps the handler-install step explicit and lets
// future Phase-5 PART logic mirror with a `leave + delete`. Identity-
// scoped (cleared on logout/rotation) — same shape as the on(token)
// arms in `scrollback.ts` and `selection.ts`.

const exports = createRoot(() => {
  const joined = new Set<ChannelKey>();

  const [networks] = createResource<Network[], string | null>(token, async (t) => {
    if (!t) return [];
    return listNetworks(t);
  });

  const [user] = createResource<MeResponse | null, string | null>(token, async (t) => {
    if (!t) return null;
    return me(t);
  });

  const [channelsBySlug] = createResource<Record<string, ChannelEntry[]>, Network[]>(
    networks,
    async (nets) => {
      if (!nets || nets.length === 0) return {};
      const t = token();
      if (!t) return {};
      const entries = await Promise.all(
        nets.map(async (n) => [n.slug, await listChannels(t, n.slug)] as const),
      );
      return Object.fromEntries(entries);
    },
  );

  // Identity-transition cleanup for the `joined` Set. Peer cleanup
  // arms in `scrollback.ts` and `selection.ts` clear THEIR state on
  // the same flush; module-import order (scrollback → selection →
  // networks) means scrollback fires first, selection second, this
  // last — by the time the join effect re-runs under the new bearer,
  // every store has been reset.
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

  return { networks, user, channelsBySlug };
});

export const networks = exports.networks;
export const user = exports.user;
export const channelsBySlug = exports.channelsBySlug;
