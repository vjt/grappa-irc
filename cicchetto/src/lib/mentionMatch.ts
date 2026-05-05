// Pure mention matcher. Case-insensitive word-boundary match against
// the operator's own nick. Used by:
//   - ScrollbackPane (.scrollback-mention class on rendered line)
//   - subscribe.ts (bumpMention dispatch on PRIVMSG)
//
// Same predicate, two consumers — extracted once here so a regex tweak
// (e.g. broader Unicode word-boundary support in M-cluster) lands in
// one place. RFC 2812 nick chars include `[`, `]`, `\` etc.; the regex
// metacharacter escape covers the cases that would otherwise blow up
// the RegExp constructor.

export const mentionsUser = (body: string | null, nick: string | null): boolean => {
  if (!body || !nick) return false;
  const escaped = nick.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(body);
};

// C7.7: watchlist match — same predicate as mentionsUser for the MVP
// where watchlist = own nick only. Named separately so the future
// /watch /highlight cluster (user_settings table + cross-network list)
// can extend this without touching mentionsUser's call sites.
export const matchesWatchlist = (body: string | null, nick: string | null): boolean =>
  mentionsUser(body, nick);
