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
  takesParam: boolean;
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
  const letters = [...b, ...c, ...d];

  return letters
    .map((letter) => {
      const info = modeDescription(letter);
      return {
        letter,
        label: info.label,
        desc: info.desc,
        takesParam: paramModes.has(letter),
      };
    })
    .sort((x, y) => x.label.localeCompare(y.label));
}
