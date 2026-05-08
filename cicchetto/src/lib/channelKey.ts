// Composite key for the (network, channel) pair, used as the index
// into per-channel signal stores (`scrollback.ts`, `selection.ts`,
// `subscribe.ts`). Shared infrastructure — no behaviour, no state —
// lifted out of the original `networks.ts` god-module so every per-
// channel store can import the brand without depending on each other.
//
// Composite key shape: `${networkSlug} ${channelName}`. Space is forbidden
// in IRC channel names (RFC 2812 chanstring excludes 0x20) so it can't
// collide with payload bytes. NUL would also work; space wins because
// it's readable in debugger output and operator log lines.
//
// Opaque-branded type. The `unique symbol` brand makes `ChannelKey`
// distinct from `string` at the type level — a bare network slug or
// channel name passed where a ChannelKey is expected is a compile
// error. The brand is declaration-only (no runtime representation), so
// a ChannelKey is just a string at runtime; only `channelKey(slug, name)`
// builds one. The earlier `${string} ${string}` template-literal form
// looked like a constraint but actually erased to `string` in the type
// system — both ends were unconstrained.

declare const channelKeyBrand: unique symbol;
export type ChannelKey = string & { readonly [channelKeyBrand]: true };

export const channelKey = (slug: string, name: string): ChannelKey =>
  `${slug} ${name}` as ChannelKey;

// Codebase audit cic M4 — paired decoder for the composite key. Pre-
// fix, `Sidebar.pseudoChannelsForNetwork` and the `subscribe.ts`
// pending-channel pre-subscribe loop both open-coded the parsing
// (`key.startsWith(prefix) + key.slice(prefix.length)` /
// `key.indexOf(" ") + slice` respectively). Two open-coded sites = if
// the key shape ever changes (NUL separator, JSON tuple, branded
// struct), three places update independently. The encoder is the
// single source of truth for shape; the decoder MUST be paired with
// it. Future shape change → both sites update via this decoder only.
//
// Returns `null` if the input doesn't look like a valid composite key
// (no separator). Callers (Sidebar / subscribe.ts loop) treat null as
// "skip this entry" — windowStateByChannel keys SHOULD always be
// well-formed because they originated via `channelKey(...)`, but the
// guard keeps the decoder pure and lets the type system shrug.
export function decodeChannelKey(key: ChannelKey): { slug: string; name: string } | null {
  const sepIdx = key.indexOf(" ");
  if (sepIdx < 0) return null;
  return { slug: key.slice(0, sepIdx), name: key.slice(sepIdx + 1) };
}
