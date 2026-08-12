// #1251 — display names for the type-A (list) channel modes.
//
// This file holds LABELS ONLY. Which letters exist, and which of them can be
// queried, is server data: the network's 005 arrives as
// `isupport.listModesQueryable` (see `isupport.ts`), and cic renders exactly
// that set — it never derives it, because the reply-numeric table that makes
// a letter queryable lives on the server.
//
// A letter with no label here still renders (as `+x`), so a server that
// learns a new list mode needs no cic release to be usable.

const LABELS: Record<string, string> = {
  b: "Bans",
  e: "Exempts",
  I: "Invites",
  // bahamut/Azzurra: the restrict list (728/729 RPL_RESTRICTLIST).
  z: "Restricted",
  // solanum/Libera: the quiet list, same numerics, different letter.
  q: "Quiets",
};

/** Human label for a list mode: "Bans", or `+x` for a letter we have no name for. */
export function listModeLabel(mode: string): string {
  return LABELS[mode] ?? `+${mode}`;
}

/** Modal title for a list mode + channel, e.g. `Bans: #bofh`. */
export function listModeTitle(mode: string, channel: string): string {
  return `${listModeLabel(mode)}: ${channel}`;
}
