// #229 — static USER-mode (umode) description table + the display
// derivation for the /mode <nick> (umode) modal.
//
// Unlike channel modes (#216), umodes have NO ISUPPORT availability source
// grappa parses (004 RPL_MYINFO carries the letters but is deliberately not
// parsed — it's connect-storm server metadata). So this static table IS the
// available set: the KNOWN bahamut/Azzurra umodes, plus any currently-active
// letter the operator holds that isn't in the table (a vendor umode still
// renders rather than vanishing). Descriptions are UI copy and MUST live in
// cic, never on the wire (CLAUDE.md "no localized strings server-side").
//
// `settable` marks umodes a normal user may flip themselves. Server-managed
// umodes (o oper, r registered, a/A/S services/admin) are shown read-only —
// the operator SEES they hold +r but can't unset it via the modal (the ircd
// is the real authority and rejects an unauthorized change anyway; this is
// the umode twin of #216's param-modes-read-only decision). Toggling a
// settable umode pushes the same `umode` WS verb `/umode +x` uses.

export type UmodeInfo = { label: string; desc: string; settable: boolean };

// The bahamut/Azzurra user-mode set. Keys are single mode letters.
// Descriptions read "<label> · <what it does>" in the modal toggle.
const UMODE_DESCRIPTIONS: Record<string, UmodeInfo> = {
  i: { label: "invisible", desc: "hidden from WHO / global nick lists", settable: true },
  w: { label: "wallops", desc: "receive network WALLOPS broadcasts", settable: true },
  s: { label: "server notices", desc: "receive server notice broadcasts", settable: true },
  d: { label: "deaf", desc: "ignore all channel messages", settable: true },
  g: { label: "caller ID", desc: "only accepted nicks may /msg you", settable: true },
  x: { label: "masked host", desc: "cloak your hostname from other users", settable: true },
  R: { label: "reg'd only", desc: "only registered nicks may /msg you", settable: true },
  // Server/services-managed — read-only in the modal (the ircd sets these).
  o: { label: "operator", desc: "IRC operator (server-granted)", settable: false },
  O: { label: "local op", desc: "local IRC operator (server-granted)", settable: false },
  r: { label: "registered", desc: "identified to NickServ (services-set)", settable: false },
  a: { label: "services admin", desc: "services administrator (services-set)", settable: false },
  A: { label: "server admin", desc: "server administrator (server-set)", settable: false },
  S: { label: "network service", desc: "network service (services-set)", settable: false },
};

/**
 * Human copy for a umode letter. Unknown letters (a network advertises a
 * vendor umode cic doesn't know) get a generic label so the modal renders
 * them without crashing — the operator still sees the letter. Unknown
 * letters default to NOT settable: cic can't know a vendor umode is safe
 * to toggle, so it shows the active state read-only (the operator can still
 * use `/umode -x` explicitly if they know better).
 */
export function umodeDescription(letter: string): UmodeInfo {
  return (
    UMODE_DESCRIPTIONS[letter] ?? {
      label: `mode +${letter}`,
      desc: "user mode (no description available)",
      settable: false,
    }
  );
}

export type AvailableUmode = {
  letter: string;
  label: string;
  desc: string;
  settable: boolean;
};

/**
 * The umodes the modal renders, given the operator's currently-active set.
 * The union of the KNOWN table letters and any active-but-unknown letter,
 * so a vendor umode the operator holds still shows (read-only). Each entry
 * carries the human copy + whether the user may toggle it. Sorted by label
 * for a stable modal layout.
 */
export function availableUmodes(activeModes: string[]): AvailableUmode[] {
  const letters = new Set<string>([...Object.keys(UMODE_DESCRIPTIONS), ...activeModes]);

  return [...letters]
    .map((letter) => {
      const info = umodeDescription(letter);
      return { letter, label: info.label, desc: info.desc, settable: info.settable };
    })
    .sort((x, y) => x.label.localeCompare(y.label));
}
