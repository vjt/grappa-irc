import { type BanMaskForm, buildBanMask, type UserhostParts } from "./banMask";
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

type BanOutcome = { kind: "banned" } | { kind: "parts_unknown" } | { kind: "failed"; e: unknown };

async function banByForm(
  networkId: number,
  channel: string,
  nick: string,
  form: BanMaskForm,
  knownHost: string | null,
): Promise<BanOutcome> {
  try {
    let parts: UserhostParts = { nick, user: null, host: knownHost };
    // A nick ban needs nothing but the nick, so it asks the server nothing. A
    // known host is `banHost`'s, which only ever builds the host form.
    if (form !== "nick" && knownHost === null) {
      const uh = await resolveUserhost(networkId, nick);
      parts = { nick, user: uh?.user ?? null, host: uh?.host ?? null };
    }
    // Fail-closed (#386, vjt decision #1): a missing component, no mask —
    // never a wider guess.
    const mask = buildBanMask(form, parts);
    if (mask === null) return { kind: "parts_unknown" };
    await pushChannelBan(networkId, channel, mask);
    return { kind: "banned" };
  } catch (e) {
    return { kind: "failed", e };
  }
}

// Names the component the form needed, so the operator knows what /whois
// would fill in. Only the host and user_host forms can miss.
function partsUnknown(label: string, nick: string, form: BanMaskForm): string {
  const what = form === "user_host" ? "user@host" : "host";
  return `${label}: ${what} unknown for ${nick} — ban not set (run /whois ${nick} first)`;
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
  const outcome = await banByForm(p.networkId, p.channel, p.nick, "host", p.knownHost);
  switch (outcome.kind) {
    case "banned":
      return null;
    case "parts_unknown":
      return partsUnknown(p.label, p.nick, "host");
    case "failed":
      return `${p.label}: ban failed — ${friendlyError(outcome.e)}`;
  }
}

export type KickbanParams = {
  networkId: number;
  channel: string;
  nick: string;
  reason: string;
  /** The subject's ban type (issue 2347) — `banMaskFormValue()` at the call
   *  site, never read in here, so the verb stays a function of its inputs. */
  form: BanMaskForm;
  label: string;
};

/**
 * #386 — kickban. Takes NO known host, unlike `banHost`: the kick lands on
 * whoever holds the nick NOW, so the ban must be on that person's host too.
 * A row's host names whoever held the nick when the row was written — on a
 * recycled Guest nick, a different person (issue 2346 review). Ban FIRST
 * (no rejoin window), in the subject's chosen form (issue 2347), THEN kick —
 * two frames, attempt BOTH regardless (vjt decision #4). A form whose
 * component is unknown sends no ban, but the kick still fires (getting the
 * person out is the intent) and the ban error is what comes back. Both
 * failing → the ban error, the primary one.
 */
export async function kickban(p: KickbanParams): Promise<string | null> {
  const outcome = await banByForm(p.networkId, p.channel, p.nick, p.form, null);
  let banError: string | null = null;
  if (outcome.kind === "parts_unknown")
    banError = `${partsUnknown(p.label, p.nick, p.form)}; kicking anyway`;
  if (outcome.kind === "failed") banError = `${p.label}: ban failed — ${friendlyError(outcome.e)}`;

  try {
    await pushChannelKick(p.networkId, p.channel, p.nick, p.reason);
  } catch (kickErr) {
    return banError ?? `${p.label}: kick failed — ${friendlyError(kickErr)}`;
  }
  return banError;
}
