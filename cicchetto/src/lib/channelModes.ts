import type { IsupportEntry } from "./isupport";

// #216 — static channel-mode description table + the ISUPPORT→display
// derivation for the /mode modal.
//
// ISUPPORT (CHANMODES + PREFIX) tells cic WHICH mode letters exist on a
// network and their param arity — but NOT what they mean. The human copy
// (a short label + the verbatim HelpServ CMODE help text) is UI text and
// MUST live in cic, never on the wire (CLAUDE.md "no localized strings
// server-side"). This
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

// #667 — reconciled with the letters the ircd (azzurra/bahamut) actually
// advertises in its 005 (src/s_misc.c:1275):
//   CHANMODES=bz,k,l,BcdijmMnOprRsStuU
// ⇒ type B `k`, type C `l`, type D `B c d i j m M n O p r R s S t u U`
//   (type A `b z` list modes + PREFIX `o h v` are excluded — see above).
//
// Every `desc` is VERBATIM from the network's HelpServ CMODE helpfile
// (`azzurra/services` → run/data/helpfiles/us/helpserv/cmode), NOT
// paraphrased from the ircd C source — with EXACTLY ONE exception, `+B`
// (MODE_HIDEBANS): it is advertised but ABSENT from the helpfile, so it
// carries authored copy (approved in-channel; see its inline note at the top
// of the table). That verbatim text is what users are already told, so cic
// must MATCH it — and paraphrasing the C source is exactly how `+d` was once
// mislabelled "delayed" (it is MODE_NONICKCHG: no nick change) and `+u` a
// "spam filter" (it blocks PART/QUIT). The `label` is cic's own short UI tag:
// concise but truthful to the `desc`.
//
// Not here, on purpose:
//   `+D` — DELETED: the ircd has no such mode (no `case 'D'`, not in
//        CHANMODES); a phantom entry is what made a reader assume `+d` was
//        its lowercase sibling. Delete, don't rewrite.
//   `+C` (MODE_NOCTCP) — a real ircd mode with helpfile copy but NOT in the
//        advertised CHANMODES, so `availableModes/1` never offers it; kept
//        (harmless, unreachable) and aligned to the helpfile.
//
// Ordered as the helpfile lists them (case-insensitive) for easy audit.
const MODE_DESCRIPTIONS: Record<string, ModeInfo> = {
  // #667 — the SOLE non-verbatim entry. MODE_HIDEBANS (`+B`) is advertised
  // (type D) but ABSENT from the HelpServ CMODE helpfile, so it has no
  // verbatim text to match; this copy is authored, approved by vjt in-channel
  // (2026-08-02). It is faithful to the ircd behaviour: the ban list is
  // withheld from non-privileged users (bahamut src/channel.c:1559) and
  // MODE +b/-b are routed to channel operators only (src/channel.c:3609,
  // 3634). Every OTHER entry below is verbatim from the helpfile.
  B: {
    label: "hide bans",
    desc: "Hides the channel ban list and ban changes from users who are not channel operators.",
  },
  c: {
    label: "no colors",
    desc: "Blocks all messages containing colors sent to the channel.",
  },
  C: { label: "no CTCP", desc: "Blocks all CTCPs sent to the channel." },
  d: {
    label: "no nick change",
    desc: "Only channel operators and voices can change nick while in channel.",
  },
  i: { label: "invite only", desc: "Sets the channel invite only." },
  j: {
    label: "identified only",
    desc: "Only users identified to a registered nick can join the channel.",
  },
  k: { label: "key", desc: "Sets a key to the channel." },
  l: {
    label: "limit",
    desc: "Sets the maximum number of users allowed in the channel.",
  },
  m: {
    label: "moderated",
    desc: "Sets channel moderation; only operators, half-operators and voices can talk.",
  },
  M: {
    label: "moderated (reg'd)",
    desc: "Sets channel moderation; only users with a registered nick can talk.",
  },
  n: { label: "no external", desc: "Blocks all outside messages to channel." },
  O: {
    label: "opers only",
    desc: "(IRCop Only) Only IRC Operators can join the channel.",
  },
  p: {
    label: "private",
    desc: "Channel is private (does not show in /WHOIS, topic is hidden in /LIST ).",
  },
  r: {
    label: "registered",
    desc: "(Services Only) Channel is registered with ChanServ.",
  },
  R: {
    label: "reg'd only",
    desc: "Only users with registered nicks can join the channel.",
  },
  s: {
    label: "secret",
    desc: "Channel is secret (does not show in /WHOIS or /LIST ).",
  },
  S: { label: "SSL only", desc: "Only SSL client can join the channel." },
  t: {
    label: "topic lock",
    desc: "Only channel operators can change the topic.",
  },
  u: {
    label: "no part/quit",
    desc: "Blocks PART/QUIT messages sent to the channel.",
  },
  U: {
    label: "allow unreg'd",
    desc: "Allow users without a registered nick on .US and .EU robins to join the channel.",
  },
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
