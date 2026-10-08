import { buildBanMask } from "./banMask";
import { friendlyError } from "./friendlyError";
import { pushChannelBan, pushChannelKick, resolveUserhost } from "./socket";

// issue 2346 — the host-mask ban and the kickban, lifted out of `/kb` (#386)
// so the nick menu and the join/part/quit row menu run the SAME verb instead
// of a second copy that could drift on mask width or ordering.
//
// One addition over `/kb`, on `banHost` only: `knownHost`. A presence row already carries the
// sender's host in its meta (the prefix the server lifted off the JOIN /
// PART / QUIT), and for a QUIT that is the only host there is — the nick is
// gone, so a USERHOST lookup has nothing to ask about. A known host is used
// verbatim; `null` falls back to `/kb`'s on-demand lookup.
//
// Both verbs return the operator-facing error string, or `null` on success,
// and never throw: the composer renders the string inline, the menus toast
// it, and neither has to remember a try/catch.

type BanOutcome = { kind: "banned" } | { kind: "host_unknown" } | { kind: "failed"; e: unknown };

async function banByHost(
  networkId: number,
  channel: string,
  nick: string,
  knownHost: string | null,
): Promise<BanOutcome> {
  try {
    let host = knownHost;
    if (host === null) host = (await resolveUserhost(networkId, nick))?.host ?? null;
    // Fail-closed (#386, vjt decision #1): no host, no mask — never a wider guess.
    const mask = buildBanMask("host", { nick, user: null, host });
    if (mask === null) return { kind: "host_unknown" };
    await pushChannelBan(networkId, channel, mask);
    return { kind: "banned" };
  } catch (e) {
    return { kind: "failed", e };
  }
}

function hostUnknown(label: string, nick: string): string {
  return `${label}: host unknown for ${nick} — ban not set (run /whois ${nick} first)`;
}

export type BanHostParams = {
  networkId: number;
  channel: string;
  nick: string;
  knownHost: string | null;
  label: string;
};

/** Ban `*!*@host`. Returns the error to show, or `null` once the ban is sent. */
export async function banHost(p: BanHostParams): Promise<string | null> {
  const outcome = await banByHost(p.networkId, p.channel, p.nick, p.knownHost);
  switch (outcome.kind) {
    case "banned":
      return null;
    case "host_unknown":
      return hostUnknown(p.label, p.nick);
    case "failed":
      return `${p.label}: ban failed — ${friendlyError(outcome.e)}`;
  }
}

export type KickbanParams = {
  networkId: number;
  channel: string;
  nick: string;
  reason: string;
  label: string;
};

/**
 * #386 — kickban. Takes NO known host, unlike `banHost`: the kick lands on
 * whoever holds the nick NOW, so the ban must be on that person's host too.
 * A row's host names whoever held the nick when the row was written — on a
 * recycled Guest nick, a different person (issue 2346 review). Ban FIRST (`*!*@host`, no rejoin window), THEN kick — two
 * frames, attempt BOTH regardless (vjt decision #4). An unknown host sends no
 * ban, but the kick still fires (getting the person out is the intent) and the
 * ban error is what comes back. Both failing → the ban error, the primary one.
 */
export async function kickban(p: KickbanParams): Promise<string | null> {
  const outcome = await banByHost(p.networkId, p.channel, p.nick, null);
  let banError: string | null = null;
  if (outcome.kind === "host_unknown") banError = `${hostUnknown(p.label, p.nick)}; kicking anyway`;
  if (outcome.kind === "failed") banError = `${p.label}: ban failed — ${friendlyError(outcome.e)}`;

  try {
    await pushChannelKick(p.networkId, p.channel, p.nick, p.reason);
  } catch (kickErr) {
    return banError ?? `${p.label}: kick failed — ${friendlyError(kickErr)}`;
  }
  return banError;
}
