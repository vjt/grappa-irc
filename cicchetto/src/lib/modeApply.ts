import type { ChannelMembers } from "./memberTypes";

// Pure mode-string parser. Mirrors `Grappa.Session.EventRouter`'s
// `apply_mode_string/4`: applies a single MODE event's mode string +
// args to a channel's member list, returning a new list.
//
// Mode-prefix table: (ov)@+ — `o` grants/revokes `@` (op), `v` grants/
// revokes `+` (voiced). Hard-coded matches the server side. PREFIX
// ISUPPORT-driven negotiation deferred to Phase 5+ (server + client
// move together).
//
// Mode chars that aren't (ov) are channel-modes (e.g. `n`, `t`, `m`,
// `k`, `l`) — they have no per-user effect, so the parser ignores
// them. Unknown targets (in the args list) are also no-ops (defensive
// against an out-of-order MODE arriving before its target's JOIN).

const MODE_PREFIX_TABLE: Record<string, string> = {
  o: "@",
  v: "+",
};

export function applyModeString(
  members: ChannelMembers,
  modeStr: string,
  args: readonly string[],
): ChannelMembers {
  if (modeStr.length === 0) return members;

  // Walk the mode string with a sign cursor + an args index. `+o` grants,
  // `-o` revokes; `+ov alice bob` is two ops paired with the next two args.
  let sign: "+" | "-" = "+";
  let argIdx = 0;
  let working = members;

  for (const ch of modeStr) {
    if (ch === "+" || ch === "-") {
      sign = ch;
      continue;
    }

    const prefix = MODE_PREFIX_TABLE[ch];
    if (prefix === undefined) {
      // Channel-mode (n/t/m/k/l/...) — these consume an arg in some cases
      // (k=key, l=limit, b=ban) but never affect per-user member modes.
      // We don't track channel-modes here. The server-side EventRouter
      // pairs args correctly; the client-side mirror only consumes (ov)
      // args, so a mismatched arg consumption doesn't matter for this
      // function's contract.
      continue;
    }

    const target = args[argIdx];
    argIdx += 1;
    if (target === undefined) continue;

    working = working.map((entry) => {
      if (entry.nick !== target) return entry;
      const has = entry.modes.includes(prefix);
      if (sign === "+" && has) return entry;
      if (sign === "-" && !has) return entry;
      const modes =
        sign === "+" ? [...entry.modes, prefix] : entry.modes.filter((m) => m !== prefix);
      return { ...entry, modes };
    });
  }

  return working;
}
