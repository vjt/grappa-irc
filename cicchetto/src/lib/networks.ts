import { createEffect, createResource, createRoot, createSignal, on, untrack } from "solid-js";
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
import { appendToScrollback, loadInitialScrollback } from "./scrollback";
import { joinChannel } from "./socket";

// Domain store for the network → channel tree + per-channel unread,
// scrollback, and compose state. Mirror of the auth.ts pattern: module-
// singleton signals, one fine-grained subscription per consumer, no
// provider boilerplate.
//
// Sources:
//   * `networks` — `GET /networks` keyed on the bearer signal.
//   * `user` — `GET /me`, gated on the bearer; we need the user_name to
//     build per-channel topic strings (`grappa:user:{name}/...`).
//   * `channelsBySlug` — fans out one `GET /networks/:slug/channels`
//     per network the user is on. Slug is the topic-vocabulary
//     identifier; the integer id is REST-internal only.
//
// Side-effects:
//   * Once both `user()` and `channelsBySlug()` resolve, we join the
//     per-channel Phoenix.Channel topic for every channel and install
//     an `"event"` handler that (a) appends the new message to the
//     channel's scrollback list and (b) increments the unread count
//     when the channel is not the currently-selected one. Selection is
//     read with `untrack` inside the handler so the join effect itself
//     isn't reactive to selection changes (joining is one-shot per
//     channel, selection is high-frequency).
//   * Selecting a channel clears that channel's unread count AND, on
//     first selection, fires `loadInitialScrollback` to backfill
//     history from REST. The `loadedChannels` Set guards against re-
//     loading on re-selection — once history is loaded, subsequent
//     visits read the existing signal.
//
// `joined` is a Set guarding double-joins. Phoenix is idempotent on
// `socket.channel(topic)` returning the existing handle, but tracking
// the join here keeps the handler-install step explicit and lets
// future Phase-5 PART logic mirror with a `leave + delete`. Lives
// inside `createRoot` alongside the signal store so its lifecycle is
// coupled to the same identity-transition cleanup arm — see the
// `on(token, ...)` effect below.

export type SelectedChannel = { networkSlug: string; channelName: string } | null;

const exports = createRoot(() => {
  // Identity-scoped state: the Set below guards the join-effect.
  // Scoped to the *current* bearer; a logout or rotation MUST clear
  // it so the join effect re-evaluates under the new identity
  // (otherwise the new user's joinChannel calls are skipped and live
  // messages silently drop). Key shape `${slug} ${name}` is user-
  // agnostic, so persisting across identity changes is a cross-tenant
  // state leak.
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

  const [unreadCounts, setUnreadCounts] = createSignal<Record<ChannelKey, number>>({});
  const [selectedChannel, setSelectedChannel] = createSignal<SelectedChannel>(null);

  // Identity-transition cleanup. `prev != null` filters BOTH the
  // initial run (prev === undefined) and the cold-start login
  // (prev === null) via the loose-equality `!= null` idiom — both
  // are no-ops for cleanup. The two transitions that DO need cleanup:
  //   - logout: prev = "tokA", t = null
  //   - rotation: prev = "tokA", t = "tokB" (both non-null, distinct)
  //
  // Registered BEFORE the join effect so the Set is cleared first;
  // the join effect then runs against fresh state once `me`/
  // `channelsBySlug` resolve under the new bearer. Order matters
  // because Solid evaluates effects in registration order on the
  // same flush. The peer cleanup in `scrollback.ts` runs first
  // because that module is imported at the top of this file (its
  // createRoot evaluates before this one).
  createEffect(
    on(token, (t, prev) => {
      if (prev != null && t !== prev) {
        joined.clear();
        setUnreadCounts({});
        setSelectedChannel(null);
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
          setUnreadCounts((prev) => ({ ...prev, [key]: (prev[key] ?? 0) + 1 }));
        });
        joined.add(key);
      }
    }
  });

  createEffect(
    on(selectedChannel, (sel) => {
      if (!sel) return;
      const key = channelKey(sel.networkSlug, sel.channelName);
      setUnreadCounts((prev) => {
        if (!(key in prev) || prev[key] === 0) return prev;
        const { [key]: _drop, ...rest } = prev;
        return rest;
      });
      // Fire-and-forget: the action guards itself via loadedChannels.
      void loadInitialScrollback(sel.networkSlug, sel.channelName);
    }),
  );

  return {
    networks,
    user,
    channelsBySlug,
    unreadCounts,
    selectedChannel,
    setSelectedChannel,
  };
});

export const networks = exports.networks;
export const user = exports.user;
export const channelsBySlug = exports.channelsBySlug;
export const unreadCounts = exports.unreadCounts;
export const selectedChannel = exports.selectedChannel;
export const setSelectedChannel = exports.setSelectedChannel;
