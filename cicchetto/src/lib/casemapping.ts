// #1861 — the slug-keyed door to the network's advertised CASEMAPPING.
//
// `isupport.ts` owns the fact and keys it by network ID, like every other
// 005 fact. Most of cic, however, is keyed by network SLUG (ChannelKey,
// the selection, the per-slug caches), so the fold resolution needs the
// `slug → id → casemapping` hop. That hop was open-coded once already for
// CHANTYPES= (`compose.sigilsFor`); a nick fold is needed in a dozen
// modules, so it lives here instead of a dozen private copies.
//
// It is its OWN module rather than a function in `isupport.ts` because
// this is the only edge that needs `networks.ts`: keeping it out of
// `isupport.ts` leaves that store a leaf (chantypes + moduleRoot +
// wireTypes) and keeps the pure fold in `nickEquals.ts` free of the
// solid-js resource graph.

import {
  type Casemapping,
  casemappingForNetwork,
  chantypesForNetwork,
  prefixForNetwork,
  sigilRankForNetwork,
} from "./isupport";
import { networkIdBySlug } from "./networks";

/**
 * How the network behind `slug` folds identifiers, or `"ascii"` when the
 * slug names no known network (boot before the networks resource lands, a
 * stale selection, a pseudo-window).
 *
 * `"ascii"` is the safe fallback in both directions: it is the pre-005
 * default the server itself uses, and it is the NARROWER fold, so a wrong
 * guess never merges two identities the ircd keeps apart.
 */
export const casemappingForSlug = (slug: string): Casemapping =>
  casemappingForNetwork(networkIdBySlug(slug) ?? null);

/**
 * #1255 — the channel sigils the network behind `slug` advertised (005
 * CHANTYPES), falling back to the RFC 2812 class for a network with no live
 * session or one that omits the token. Was `compose.sigilsFor` until issue
 * 2375 gave the completion engine a second door that needs the same hop.
 */
export const chantypesForSlug = (slug: string): readonly string[] =>
  chantypesForNetwork(networkIdBySlug(slug) ?? null);

/**
 * The membership sigils the network behind `slug` advertised, highest rank
 * first (issue 1999), or the bahamut/Azzurra run when the slug names no
 * known network.
 *
 * Lives here for exactly the reason `casemappingForSlug` does: `isupport.ts`
 * keys 005 facts by network ID, most of cic is keyed by slug, and this is
 * the module that already owns the `slug → id` hop. Putting it in
 * `isupport.ts` would drag `networks.ts` into that store and cost it its
 * leaf status.
 */
export const sigilRankForSlug = (slug: string): string[] =>
  sigilRankForNetwork(networkIdBySlug(slug) ?? null);

/**
 * The membership letter→sigil map the network behind `slug` advertised, or
 * the bahamut/Azzurra default. The third resident of this slug→id hop.
 *
 * Safe for lookups in either direction (that is what NamesModal's section
 * labels need: sigil → letter, to name the level). NOT safe as an order —
 * use `sigilRankForSlug` for that. `prefixForNetwork` says why.
 */
export const prefixForSlug = (slug: string): Record<string, string> =>
  prefixForNetwork(networkIdBySlug(slug) ?? null);
