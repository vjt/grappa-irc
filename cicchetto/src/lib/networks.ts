import { batch, createEffect, createMemo, createResource, createRoot, on } from "solid-js";
import {
  type ChannelEntry,
  listChannels,
  listNetworks,
  type MeResponse,
  me,
  type Network,
  type RawNetwork,
  tagNetwork,
} from "./api";
import { token } from "./auth";
import { setBadge } from "./badge";
import { applyMeEnvelope } from "./readCursor";

// Network/channel tree resources. Module-singleton — every consumer
// reads the same fine-grained signals; no provider boilerplate.
//
// Resources:
//   * `networks` — `GET /networks` keyed on the bearer signal. Solid's
//     createResource handles the bearer-keyed re-fetch automatically
//     on token rotation.
//   * `user` — `GET /me`, gated on the bearer; the user_name builds
//     per-channel topic strings (`grappa:user:{name}/...`).
//   * `channelsBySlug` — fans out one `GET /networks/:slug/channels`
//     per network the user is on. Slug is the topic-vocabulary
//     identifier; the integer id is REST-internal only.
//
// Per-channel verbs (scrollback, selection, subscribe) live in their
// own modules — see the D3/A4 verb-keyed split. This module owns only
// the network/user resources; the schemas (`Network`, `ChannelEntry`,
// `MeResponse`) live in `api.ts`.
//
// The `createRoot` wrapper anchors the resources' internal memos to
// an owner so Solid doesn't warn about computations created outside
// a root. Mirror of the same shape used by `scrollback.ts`,
// `selection.ts`, `subscribe.ts`.
//
// #281 — identity-change purge. These resources re-fetch on rotation,
// but re-fetch is NOT the same as clear: Solid 1.9's createResource
// `load()` RETAINS the last resolved value whenever the source signal
// goes falsy (`if (lookup == null || lookup === false) loadEnd(pr,
// untrack(value))`). So on detach (`token: tokA → null`) `user` /
// `networks` / `channelsBySlug` keep the PREVIOUS account's data, and
// on re-login as a different account (`null → tokB`) the token-tracking
// effects in `subscribe.ts` (channels / query / dm-listener / server
// loops) + the HomePane featured fetch replay that STALE list under the
// new bearer — a burst of `GET /networks/<prev-net>/…/messages` +
// `/featured`, all 404, which trips the host `http-404` fail2ban jail
// and firewall-bans the client IP. So this module MUST reset like every
// sibling identity-scoped store: the `on(token)` arm below purges all
// three resources on identity change so no previous-identity network /
// channel state survives the switch. (An earlier moduledoc claimed "no
// on(token) cleanup needed" — that was the #281 bug's origin.)
//
// BUG1-FIX: `mutateNetworks` is exported so `userTopic.ts` can patch
// a single network's `nick` field in-place when the server broadcasts
// `own_nick_changed` — no REST round-trip needed, and the reactive
// consumers (subscribe.ts DM-listener loop, query-window own-nick skip)
// see the updated nick immediately.

const exports = createRoot(() => {
  const [user, { mutate: mutateUserResource, refetch: refetchUserResource }] = createResource<
    MeResponse | null,
    string | null
  >(token, async (t) => {
    if (!t) return null;
    const m = await me(t);
    // CP29 R-4: hydrate the readCursor signal map from the bulk envelope
    // BEFORE downstream consumers (subscribe.ts join effects, etc.)
    // observe `user()` and start joining channel topics. The join-reply
    // arm (`applyJoinReply`) layers per-channel refreshes on top later;
    // this is the cold-load primer. Default to `{}` if the server omits
    // the field (older test mocks predating the field landing in
    // `MeResponse`) — production /me always emits it.
    applyMeEnvelope(m.read_cursors ?? {});
    // PWA icon badge door #2 (2026-06-21): seed the badge signal from the
    // `/me` notify-worthy unread total so the home-screen icon /
    // document.title reflect the count before any push or read_cursor_set
    // arrives. `badge.ts` has no networks/selection imports, so seeding
    // here (unlike `unread_counts`) closes no import cycle. Default 0 for
    // older test mocks / pre-field servers.
    setBadge(m.badge_count ?? 0);
    // Bucket C (2026-06-01) — the parallel `unread_counts` cold-load
    // primer for `selection.ts`'s `serverSeedCounts` lives inside
    // selection.ts itself (an `on(user)` effect there reads
    // `m.unread_counts` and calls `applySeedEnvelope`). Routing the
    // call back through networks.ts would close a networks ↔ selection
    // import cycle that breaks under vitest module re-entry: the named
    // binding `applySeedEnvelope` resolves to `undefined` because
    // selection.ts is still mid-eval when networks.ts captures it.
    // selection.ts already imports `user` from this module for its
    // existing selection-clear arm, so the new effect is one extra
    // line in a module that already lives downstream.
    return m;
  });

  // Networks resource is keyed on `user` (not raw token) so the
  // boundary tagger reads the explicit server-set `kind` discriminator
  // off each row (no-silent-drops B6.9a HIGH-24). Pre-fix the server
  // emitted two implicit shapes (visitor: bare; user: nick +
  // connection_state fields) and cic joined against `me().kind` to
  // tag — correct but added a silent dependency on /me being fetched
  // first, AND a discriminator drift between the server's me-render
  // and the network shape would mis-tag every row. Server now sets
  // `kind: "user" | "visitor"` so cic reads the discriminator AT the
  // source. tagNetwork drops rows that fail the user-subject contract
  // (missing nick or connection_state) — the missing-nick branch was
  // the cic H3 silent root cause; H4 closed it at the boundary so it
  // can't leak into the typed store.
  const [networks, { mutate: mutateNetworksResource, refetch: refetchNetworksResource }] =
    createResource<Network[], MeResponse | null>(user, async (currentMe) => {
      if (!currentMe) return [];
      const t = token();
      if (!t) return [];
      const raw: RawNetwork[] = await listNetworks(t);
      const tagged: Network[] = [];
      for (const r of raw) {
        const n = tagNetwork(r);
        if (n !== null) tagged.push(n);
      }
      return tagged;
    });

  const [channelsBySlug, { mutate: mutateChannelsResource, refetch: refetchChannelsResource }] =
    createResource<Record<string, ChannelEntry[]>, Network[]>(networks, async (nets) => {
      if (!nets || nets.length === 0) return {};
      const t = token();
      if (!t) return {};
      const entries = await Promise.all(
        nets.map(async (n) => [n.slug, await listChannels(t, n.slug)] as const),
      );
      return Object.fromEntries(entries);
    });

  // #281 — identity-change purge. createResource does NOT clear its
  // value when its source signal goes falsy (see moduledoc); on detach
  // (token: tokA → null) user/networks/channelsBySlug keep the previous
  // account's data, and on re-login as a different account the
  // token-tracking effects in subscribe.ts + the HomePane featured fetch
  // replay that stale list under the new bearer → the 404 self-ban
  // burst. Mirror the on(token) reset arms in scrollback.ts /
  // selection.ts / subscribe.ts: `prev != null && t !== prev` fires on
  // the real identity transitions (logout tokA→null, rotation tokA→tokB)
  // and masks the initial registration (prev===undefined) + cold login
  // (prev===null). `batch` so the three mutations land as one atomic
  // update — no dependent computed observes a half-purged (new-token,
  // stale-networks) state that could re-fire a fetch. Clearing
  // `networks` alone stops the burst (every replay loop is gated on a
  // matching entry in networks()), but purge all three so no consumer
  // (isAdmin, ownNick / socketUserName readers) ever observes the
  // previous identity after the switch.
  createEffect(
    on(token, (t, prev) => {
      if (prev != null && t !== prev) {
        batch(() => {
          mutateUserResource(null);
          mutateNetworksResource([]);
          mutateChannelsResource({});
        });
      }
    }),
  );

  const refetchChannels = (): void => {
    void refetchChannelsResource();
  };

  // Codebase review 2026-05-08 cross-infra H1: pre-fix the
  // `connection_state_changed` event was emitted via raw
  // `Phoenix.PubSub.broadcast/3` and never reached cic over WS. cic
  // worked around by REST refetch on PATCH return — but other tabs /
  // clients on the same account didn't see the state flip until they
  // re-rendered. The fix routes the event through `broadcast_event/2`
  // on the user-level topic; this exposes a refetch hook so
  // `userTopic.ts` can pull the updated `Credential.connection_state`
  // / reason / changed_at fields without duplicating wire shape into
  // the client.
  const refetchNetworks = (): void => {
    void refetchNetworksResource();
  };

  // #126 — re-fetch GET /me after a visitor disconnect/reconnect so the
  // whereis-derived `connected` flag updates → the SettingsDrawer flips
  // its disconnect ⇄ reconnect toggle. Visitors have no
  // `connection_state_changed` broadcast (that's a user-topic event),
  // so the verb handler refetches explicitly rather than waiting on a
  // push.
  const refetchUser = (): void => {
    void refetchUserResource();
  };

  // Patch the nick for one network in the in-memory networks list.
  // Called by userTopic.ts when `own_nick_changed` arrives so the
  // DM-listener and query-window loops see the correct own-nick
  // without waiting for the next GET /networks refetch.
  //
  // Bucket F H4: only `UserNetwork` rows carry a `nick` field. A
  // visitor row with the matching id is left untouched — visitors
  // can't issue NICK upstream (the visitor IS the nick) so the
  // `own_nick_changed` event for a visitor's network is a server
  // contract violation we tolerate by no-op'ing.
  const mutateNetworkNick = (networkId: number, nick: string): void => {
    mutateNetworksResource((prev) => {
      if (!prev) return prev;
      return prev.map((n) => (n.id === networkId && n.kind === "user" ? { ...n, nick } : n));
    });
  };

  // bnd-A2: canonical slug→Network lookup. Pre-fix compose.ts repeated
  // `networks()?.find((n) => n.slug === slug)?.id` 14× across slash-
  // command handlers. The memo invalidates whenever `networks()`
  // updates (post-/connect, post-/disconnect, bearer rotation), so
  // callers see new entries without manual cache management.
  const networksBySlug = createMemo(() => {
    const list = networks();
    if (!list) return new Map<string, Network>();
    return new Map(list.map((n) => [n.slug, n]));
  });

  const networkBySlug = (slug: string): Network | undefined => networksBySlug().get(slug);

  const networkIdBySlug = (slug: string): number | undefined => networkBySlug(slug)?.id;

  // UX-4 bucket N — admin predicate hoisted here from Shell.tsx +
  // SettingsDrawer.tsx + Sidebar.tsx (three callsites, rule-of-three
  // threshold). Single source of truth for the M-cluster M-7 admin
  // gate (drawer entry, AdminPane mount, demote-mid-session
  // auto-close, sidebar admin row visibility). Narrows the
  // `MeResponse` discriminated union so the user-only `is_admin`
  // field is reachable; visitor + null both collapse to false.
  const isAdmin = (): boolean => {
    const u = user();
    return u?.kind === "user" && u.is_admin === true;
  };

  return {
    networks,
    user,
    channelsBySlug,
    refetchChannels,
    refetchNetworks,
    refetchUser,
    mutateNetworkNick,
    networkBySlug,
    networkIdBySlug,
    isAdmin,
  };
});

export const networks = exports.networks;
export const user = exports.user;
export const channelsBySlug = exports.channelsBySlug;
export const refetchChannels = exports.refetchChannels;
export const refetchNetworks = exports.refetchNetworks;
export const refetchUser = exports.refetchUser;
export const mutateNetworkNick = exports.mutateNetworkNick;
export const networkBySlug = exports.networkBySlug;
export const networkIdBySlug = exports.networkIdBySlug;
export const isAdmin = exports.isAdmin;
