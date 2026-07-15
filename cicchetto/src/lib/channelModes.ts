import type { IsupportEntry } from "./isupport";

// #216 — static channel-mode description table + the ISUPPORT→display
// derivation for the /mode modal.
//
// ISUPPORT (CHANMODES + PREFIX) tells cic WHICH mode letters exist on a
// network and their param arity — but NOT what they mean. The human copy
// ("secret · hidden from channel lists") is UI text and MUST live in cic,
// never on the wire (CLAUDE.md "no localized strings server-side"). This
// module is that copy table plus `availableModes/1`, which folds a
// network's ISUPPORT capability set into the toggle list the modal
// renders.
//
// Scope of the modal's toggles: SIMPLE boolean/param channel modes only —
// CHANMODES type B (key), type C (limit), and type D (flags). It
// deliberately EXCLUDES:
//   - membership modes (PREFIX: o/h/v) — those are per-user, set via
//     /op /voice etc. and the members pane, not a channel-wide toggle.
//   - type A list modes (b/e/I ban/except/invex) — managed as lists via
//     /ban /banlist, not a boolean the modal can meaningfully toggle.

export type ModeInfo = { label: string; desc: string };

// The bahamut/Azzurra channel-mode set. Keys are single mode letters.
// Descriptions are terse: "<label> · <what it does>" reads well in the
// modal's toggle button (label bold, desc muted).
const MODE_DESCRIPTIONS: Record<string, ModeInfo> = {
  n: { label: "no external", desc: "block messages from outside the channel" },
  t: { label: "topic lock", desc: "only ops can change the topic" },
  m: { label: "moderated", desc: "only voiced users and ops may speak" },
  s: { label: "secret", desc: "hidden from channel lists and WHOIS" },
  p: { label: "private", desc: "hidden from WHO / channel list" },
  i: { label: "invite only", desc: "join requires an invite" },
  k: { label: "key", desc: "join requires a password" },
  l: { label: "limit", desc: "cap the number of members" },
  r: { label: "registered", desc: "only registered (+r) nicks may join" },
  R: { label: "reg'd only", desc: "only registered nicks may join" },
  c: { label: "no colors", desc: "strip mIRC color codes from messages" },
  C: { label: "no CTCP", desc: "block CTCP to the channel" },
  D: { label: "delay join", desc: "hide joins until the user speaks" },
  d: { label: "delayed", desc: "delayed-join related" },
};

/**
 * Human copy for a mode letter. Unknown letters (a network advertises a
 * vendor mode cic doesn't know) get a generic label so the modal renders
 * them without crashing — the operator still sees the letter and can
 * toggle it.
 */
export function modeDescription(letter: string): ModeInfo {
  return (
    MODE_DESCRIPTIONS[letter] ?? {
      label: `mode +${letter}`,
      desc: "channel mode (no description available)",
    }
  );
}

export type AvailableMode = {
  letter: string;
  label: string;
  desc: string;
  /** Takes a parameter when SET (`+k <key>` / `+l <n>`): type B or C. */
  takesParam: boolean;
  /**
   * Takes a parameter when UNSET too (`-k <key>`): type B only. Type C
   * (`-l`) and type D flags unset bare. #240 — the modal sends the
   * current value as the `-` arg for type-B modes (bahamut requires it)
   * but a bare `-<letter>` for type C.
   */
  paramOnUnset: boolean;
};

/**
 * The list of togglable channel modes for a network, derived from its
 * ISUPPORT capability set. Includes CHANMODES type B (always-param),
 * type C (set-only-param), and type D (flags); EXCLUDES type A list
 * modes and PREFIX membership modes (see module doc). Each entry carries
 * the human copy + whether toggling it ON requires a parameter value.
 * Sorted by label for a stable modal layout.
 */
export function availableModes(isupport: IsupportEntry): AvailableMode[] {
  const { b, c, d } = isupport.chanmodes;
  const paramModes = new Set([...b, ...c]);
  const unsetParamModes = new Set(b); // type B keeps its arg on `-`.
  const letters = [...b, ...c, ...d];

  return letters
    .map((letter) => {
      const info = modeDescription(letter);
      return {
        letter,
        label: info.label,
        desc: info.desc,
        takesParam: paramModes.has(letter),
        paramOnUnset: unsetParamModes.has(letter),
      };
    })
    .sort((x, y) => x.label.localeCompare(y.label));
}

/**
 * Normalise a user-typed mode parameter (a channel key or member limit)
 * into a single wire token, or `null` when it is unusable. Trims
 * surrounding whitespace and rejects an empty result or one containing
 * internal whitespace — an IRC MODE parameter is ONE space-delimited
 * token, so an embedded space would split into two args and set garbage.
 * The ircd remains the authority on value validity (a non-numeric `+l`,
 * a too-long key); this guard only stops the obviously-malformed frame.
 */
export function sanitizeModeParam(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (/\s/.test(trimmed)) return null;
  return trimmed;
}

/**
 * The set of membership sigils that grant channel-mode EDITING on a
 * network, derived from its ISUPPORT PREFIX. Editing is allowed for
 * halfop (`%`) and everything that outranks op (`@`) — founder (`~`),
 * admin/protected (`&`), op — but NOT voice (`+`) or plain.
 *
 * PREFIX is advertised highest-rank-first (e.g. `(qaohv)~&@%+`), so the
 * editor set is every sigil at index ≤ the op sigil's index, PLUS the
 * halfop sigil. Deriving from the network's own order (instead of a
 * hardcoded `@`/`%`) means a founder/admin who does NOT also hold `@`
 * still gets an editable modal on networks that separate those roles —
 * the very PREFIX-rich networks this feature adds support for. The ircd
 * remains the real authority (it rejects an unauthorized MODE); a
 * slightly-permissive gate only avoids wrongly greying out a legit
 * founder.
 */
export function editorSigils(isupport: IsupportEntry): Set<string> {
  const sigils = Object.values(isupport.prefix);
  const opIdx = sigils.indexOf("@");
  const out = new Set<string>();
  if (opIdx === -1) {
    // No op sigil advertised (non-standard) — fall back to the classic
    // op/halfop pair so the gate never opens to everyone.
    out.add("@");
    out.add("%");
    return out;
  }
  // Everything at or above op rank (index ≤ opIdx in the high-first list).
  for (let i = 0; i <= opIdx; i++) {
    const s = sigils[i];
    if (s !== undefined) out.add(s);
  }
  // Halfop, if the network has one, also edits.
  if (isupport.prefix.h !== undefined) out.add(isupport.prefix.h);
  return out;
}
