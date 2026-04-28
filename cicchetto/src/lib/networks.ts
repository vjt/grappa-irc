import { createResource, createRoot } from "solid-js";
import {
  type ChannelEntry,
  listChannels,
  listNetworks,
  type MeResponse,
  me,
  type Network,
} from "./api";
import { token } from "./auth";

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
// `selection.ts`, `subscribe.ts`. No on(token) cleanup needed —
// `createResource` already keys on the bearer signal and re-fetches
// automatically on rotation.

const exports = createRoot(() => {
  const [networks] = createResource<Network[], string | null>(token, async (t) => {
    if (!t) return [];
    return listNetworks(t);
  });

  const [user] = createResource<MeResponse | null, string | null>(token, async (t) => {
    if (!t) return null;
    return me(t);
  });

  const [channelsBySlug, { refetch: refetchChannelsResource }] = createResource<
    Record<string, ChannelEntry[]>,
    Network[]
  >(networks, async (nets) => {
    if (!nets || nets.length === 0) return {};
    const t = token();
    if (!t) return {};
    const entries = await Promise.all(
      nets.map(async (n) => [n.slug, await listChannels(t, n.slug)] as const),
    );
    return Object.fromEntries(entries);
  });

  const refetchChannels = (): void => {
    void refetchChannelsResource();
  };

  return { networks, user, channelsBySlug, refetchChannels };
});

export const networks = exports.networks;
export const user = exports.user;
export const channelsBySlug = exports.channelsBySlug;
export const refetchChannels = exports.refetchChannels;
