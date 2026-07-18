// #229 — static USER-mode (umode) description table + the display
// derivation for the /mode <nick> (umode) modal.
//
// As of #249 the AVAILABLE set is driven by the SERVER-advertised umode set
// (004 RPL_MYINFO, parsed server-side into a `supported_umodes_changed` wire
// event), exactly as #216 drives the channel-mode modal from server CHANMODES.
// This static table is now the FALLBACK: its descriptions ARE the UI copy for
// the known bahamut/Azzurra umodes, and its KEYS supply the available set only
// when the server has not advertised one (a network that omits 004 umodes, or
// a pre-snapshot session — see `availableUmodes`). Descriptions are UI copy and
// MUST live in cic, never on the wire (CLAUDE.md "no localized strings
// server-side").
//
// `settable` marks umodes a normal user may flip themselves. Server-managed
// umodes (o oper, r registered, a/A services/admin), IRCop snomask receive
// flags (#301: b c d e f g k K m n y …), and connection-property flags (S SSL)
// are shown read-only —
// the operator SEES they hold +r but can't unset it via the modal (the ircd
// is the real authority and rejects an unauthorized change anyway; this is
// the umode twin of #216's param-modes-read-only decision). Toggling a
// settable umode pushes the same `umode` WS verb `/umode +x` uses.

export type UmodeInfo = { label: string; desc: string; settable: boolean };

// The bahamut/Azzurra user-mode set. Keys are single mode letters.
// Descriptions read "<label> · <what it does>" in the modal toggle.
//
// AUTHORITY (#301): Azzurra's own `helpserv umode` helpfile is the source of
// truth for what each letter means on Azzurra/bahamut — NOT generic-ircd
// (charybdis/Unreal) convention. Several letters that look familiar from other
// ircds mean something else here (+d is DEBUG receive, not "deaf"; +g is
// GLOBOPS receive, not "caller ID"; +S is an SSL connection flag, not a
// services role). The IRCop snomask-style RECEIVE flags and the
// server/services-managed flags are read-only: a normal user cannot flip them,
// so `settable:false` — the same conservative default an unknown letter gets
// (cic can't grant itself an oper/services capability).
const UMODE_DESCRIPTIONS: Record<string, UmodeInfo> = {
  // User-settable — a normal user may flip these themselves.
  i: { label: "invisible", desc: "hidden from WHO / global nick lists", settable: true },
  w: { label: "wallops", desc: "receive network WALLOPS broadcasts", settable: true },
  s: { label: "server notices", desc: "receive server notice broadcasts", settable: true },
  x: { label: "masked host", desc: "cloak your hostname from other users", settable: true },
  R: { label: "reg'd only", desc: "only registered nicks may /msg you", settable: true },
  // IRCop snomask-style RECEIVE flags — the ircd grants these to opers; a
  // normal user cannot set them → read-only in the modal.
  b: { label: "chatops", desc: "IRCop: receive CHATOPS messages", settable: false },
  c: { label: "client notices", desc: "IRCop: server connect/disconnect notices", settable: false },
  d: { label: "debug notices", desc: "IRCop: receive DEBUG messages", settable: false },
  e: { label: "invalid DCC", desc: "IRCop: receive invalid-DCC notices", settable: false },
  f: { label: "flood notices", desc: "IRCop: receive FLOOD messages", settable: false },
  g: { label: "globops", desc: "IRCop: receive GLOBOPS messages", settable: false },
  k: { label: "kill notices", desc: "IRCop: receive KILL (non-U:Line)", settable: false },
  K: { label: "U:Line kills", desc: "IRCop: receive KILL (U:Lined)", settable: false },
  m: { label: "spam notices", desc: "IRCop: receive SPAM messages", settable: false },
  n: { label: "routing notices", desc: "IRCop: receive ROUTING messages", settable: false },
  y: { label: "command notices", desc: "IRCop: notify on /ADMIN /LINKS /WHOIS …", settable: false },
  // Other IRCop / connection-property flags — server-managed, read-only.
  F: { label: "flood immune", desc: "IRCop: immune from flood limits", settable: false },
  I: { label: "hide idle", desc: "IRCop: hide idle time in WHOIS", settable: false },
  j: { label: "java user", desc: "chatting from the web via Java", settable: false },
  S: { label: "SSL", desc: "connected to the server via SSL", settable: false },
  // Server/services-managed — read-only in the modal (the ircd sets these).
  o: { label: "operator", desc: "IRC operator (server-granted)", settable: false },
  O: { label: "local op", desc: "local IRC operator (server-granted)", settable: false },
  r: { label: "registered", desc: "identified to NickServ (services-set)", settable: false },
  a: { label: "services admin", desc: "services administrator (services-set)", settable: false },
  A: { label: "server admin", desc: "server administrator (server-set)", settable: false },
  h: { label: "help operator", desc: "services: Help Operator", settable: false },
  z: { label: "services agent", desc: "services: Services Agent", settable: false },
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
 * The umodes the modal renders. When the server advertised a supported set
 * (004 RPL_MYINFO, #249), the available letters are that set unioned with any
 * currently-active letter — an active umode always renders even if the server
 * omitted it from the advertisement (defensive: never hide the operator's own
 * active state). When `serverSet` is empty (a network that never advertised,
 * or a pre-snapshot session), fall back to the KNOWN static table unioned with
 * active letters — the pre-#249 behavior. This mirrors #216's `availableModes`
 * folding server-advertised CHANMODES for channel modes; the server drives the
 * WHICH-letters, cic owns the description copy. Known letters keep their
 * description + settable arity; an advertised-but-unknown vendor letter gets
 * the generic non-settable copy. Sorted by label for a stable modal layout.
 *
 * REPLACE (not union-with-static) when `serverSet` is non-empty is deliberate:
 * 004 RPL_MYINFO is the ircd's AUTHORITATIVE supported-umode list — a
 * well-behaved bahamut/solanum lists every supported letter (Azzurra's real 004
 * carries the full settable set i/w/s/x/R), so honoring it faithfully is the
 * whole point of #249. A hypothetical PARTIAL 004 would drop an omitted-but-
 * settable letter from the modal; that degradation is accepted (the operator
 * can still `/umode +x` by hand) rather than re-unioning the static guess this
 * feature removes and offering toggles the server may reject.
 */
export function availableUmodes(activeModes: string[], serverSet: string[]): AvailableUmode[] {
  const base = serverSet.length > 0 ? serverSet : Object.keys(UMODE_DESCRIPTIONS);
  const letters = new Set<string>([...base, ...activeModes]);

  return [...letters]
    .map((letter) => {
      const info = umodeDescription(letter);
      return { letter, label: info.label, desc: info.desc, settable: info.settable };
    })
    .sort((x, y) => x.label.localeCompare(y.label));
}
