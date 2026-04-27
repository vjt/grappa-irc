import { createEffect, createResource, createRoot, createSignal, on, untrack } from "solid-js";
import {
  sendMessage as apiSendMessage,
  type ChannelEntry,
  type ChannelEvent,
  listChannels,
  listMessages,
  listNetworks,
  type MeResponse,
  me,
  type Network,
  type ScrollbackMessage,
} from "./api";
import { token } from "./auth";
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
// Composite key: `${networkSlug} ${channelName}`. Space is forbidden
// in IRC channel names (RFC 2812 chanstring excludes 0x20) so it can't
// collide with payload bytes. NUL would also work; space wins because
// it's readable in debugger output and operator log lines.
//
// `joined` is a Set guarding double-joins. Phoenix is idempotent on
// `socket.channel(topic)` returning the existing handle, but tracking
// the join here keeps the handler-install step explicit and lets
// future Phase-5 PART logic mirror with a `leave + delete`. Lives
// inside `createRoot` alongside the signal store so its lifecycle is
// coupled to the same identity-transition cleanup arm — see the
// `on(token, ...)` effect below.
//
// Scrollback ordering: stored ASCENDING by server_time so render is
// natural top-to-bottom and `<For>` keys (message id) stay stable.
// REST returns DESC; we reverse on ingestion. WS appends arrive newest-
// last and append to the tail. Dedupe by `id` because the REST
// initial-load and the WS broadcast for a recently-sent message can
// overlap in a small race window — the same row would otherwise appear
// twice. `id` is monotonic per the schema's auto-increment column.

// Opaque-branded composite key. The `unique symbol` brand makes
// `ChannelKey` distinct from `string` at the type level — a bare
// network slug or channel name passed where a ChannelKey is expected
// is a compile error. The brand is declaration-only (no runtime
// representation), so a ChannelKey is just a string at runtime; only
// `channelKey(slug, name)` builds one. The earlier `${string} ${string}`
// template-literal form looked like a constraint but actually erased
// to `string` in the type system — both ends were unconstrained.
declare const channelKeyBrand: unique symbol;
export type ChannelKey = string & { readonly [channelKeyBrand]: true };

export const channelKey = (slug: string, name: string): ChannelKey =>
  `${slug} ${name}` as ChannelKey;

export type SelectedChannel = { networkSlug: string; channelName: string } | null;

const exports = createRoot(() => {
  // Identity-scoped state: the two Sets below guard the join-effect
  // and the load-once REST gate. Both are scoped to the *current*
  // bearer; a logout or rotation MUST clear them so the join effect
  // re-evaluates under the new identity (otherwise the new user's
  // joinChannel calls are skipped and live messages silently drop).
  // Key shape `${slug} ${name}` is user-agnostic, so persisting them
  // across identity changes is a cross-tenant state leak.
  const joined = new Set<ChannelKey>();
  const loadedChannels = new Set<ChannelKey>();
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
  const [scrollbackByChannel, setScrollbackByChannel] = createSignal<
    Record<ChannelKey, ScrollbackMessage[]>
  >({});

  // Identity-transition cleanup. `prev != null` filters BOTH the
  // initial run (prev === undefined) and the cold-start login
  // (prev === null) via the loose-equality `!= null` idiom — both
  // are no-ops for cleanup. The two transitions that DO need cleanup:
  //   - logout: prev = "tokA", t = null
  //   - rotation: prev = "tokA", t = "tokB" (both non-null, distinct)
  // Solid's signal equality dedupes a no-op `setToken(same)`, so
  // `t !== prev` is satisfied on every emitted change.
  //
  // Registered BEFORE the join effect so the Sets are cleared first;
  // the join effect then runs against fresh state once `me`/
  // `channelsBySlug` resolve under the new bearer. Order matters
  // because Solid evaluates effects in registration order on the
  // same flush.
  createEffect(
    on(token, (t, prev) => {
      if (prev != null && t !== prev) {
        joined.clear();
        loadedChannels.clear();
        setScrollbackByChannel({});
        setUnreadCounts({});
        setSelectedChannel(null);
      }
    }),
  );

  // Insert an incoming message into the per-channel ascending list,
  // deduping by id. REST + WS can overlap: the row inserted by POST
  // arrives both as the HTTP 201 body (we ignore that body) and as a
  // WS push from the per-channel PubSub broadcast. Both paths route
  // through here; whichever lands first wins, the second is dropped.
  const appendToScrollback = (key: ChannelKey, msg: ScrollbackMessage) => {
    setScrollbackByChannel((prev) => {
      const existing = prev[key];
      if (existing?.some((m) => m.id === msg.id)) return prev;
      const next = existing ? [...existing, msg] : [msg];
      return { ...prev, [key]: next };
    });
  };

  // Merge a freshly-fetched REST page into the per-channel list. Server
  // returns DESC; we reverse to ASC then dedupe + sort. Used by both
  // initial-load (replaces the empty seed) and load-more (prepends
  // older history to the head).
  const mergeIntoScrollback = (key: ChannelKey, page: ScrollbackMessage[]) => {
    setScrollbackByChannel((prev) => {
      const existing = prev[key] ?? [];
      const ids = new Set(existing.map((m) => m.id));
      const fresh = page.filter((m) => !ids.has(m.id));
      if (fresh.length === 0) return prev;
      const merged = [...existing, ...fresh].sort((a, b) => a.server_time - b.server_time);
      return { ...prev, [key]: merged };
    });
  };

  const loadInitialScrollback = async (slug: string, name: string): Promise<void> => {
    const t = token();
    if (!t) return;
    const key = channelKey(slug, name);
    if (loadedChannels.has(key)) return;
    loadedChannels.add(key);
    // Seed an empty list so the pane renders immediately while the
    // REST page is in flight; WS events arriving in the meantime
    // append to this seed via `appendToScrollback`.
    setScrollbackByChannel((prev) => (key in prev ? prev : { ...prev, [key]: [] }));
    try {
      const page = await listMessages(t, slug, name);
      mergeIntoScrollback(key, page);
    } catch {
      // First-load failure leaves the empty seed in place; the pane
      // shows "no messages yet". A retry mechanism is Phase 5+.
      loadedChannels.delete(key);
    }
  };

  const loadMore = async (slug: string, name: string): Promise<void> => {
    const t = token();
    if (!t) return;
    const key = channelKey(slug, name);
    const current = scrollbackByChannel()[key];
    if (!current || current.length === 0) return;
    const oldest = current[0];
    if (!oldest) return;
    try {
      const page = await listMessages(t, slug, name, oldest.server_time);
      mergeIntoScrollback(key, page);
    } catch {
      // No-op for walking skeleton; user can retry by scrolling again.
    }
  };

  const sendMessage = async (slug: string, name: string, body: string): Promise<void> => {
    const t = token();
    if (!t) return;
    // Server persists+broadcasts atomically — the WS push will deliver
    // the same row to this socket and `appendToScrollback` will display
    // it. We don't read the 201 body to avoid double-rendering on the
    // race where WS lands first.
    await apiSendMessage(t, slug, name, body);
  };

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
    scrollbackByChannel,
    loadInitialScrollback,
    loadMore,
    sendMessage,
  };
});

export const networks = exports.networks;
export const user = exports.user;
export const channelsBySlug = exports.channelsBySlug;
export const unreadCounts = exports.unreadCounts;
export const selectedChannel = exports.selectedChannel;
export const setSelectedChannel = exports.setSelectedChannel;
export const scrollbackByChannel = exports.scrollbackByChannel;
export const loadInitialScrollback = exports.loadInitialScrollback;
export const loadMore = exports.loadMore;
export const sendMessage = exports.sendMessage;
