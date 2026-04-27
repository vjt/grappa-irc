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
