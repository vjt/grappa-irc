// #386 — pure ban-mask builder, shared by `/kb` and the BanlistModal's add UI
// (one code path for mask construction).
//
// cic has NO per-member host: the members map (`memberTypes.ts`) is
// `{nick, modes}` only, and scrollback rows carry no prefix. The user+host
// components come from the SERVER's `userhost_cache` via `resolveUserhost`
// (socket.ts → `resolve_userhost` channel verb → `Session.lookup_userhost`).
// This module is the pure form-construction step that runs AFTER that lookup.
//
// Forms (issue #386 "easy mask builder"):
//   - "nick"      → `<nick>!*@*`      (nick-ban; always buildable from the nick)
//   - "host"      → `*!*@<host>`      (host-ban; needs host)
//   - "user_host" → `*!<user>@<host>` (ident+host; needs user AND host)
//
// The host is used VERBATIM (vjt decision #1): a hostname, an Azzurra cloak,
// or an IPv4/IPv6 literal are all masked exactly as the ircd reported them —
// NO domain wildcard, NO octet wildcard. `*!*@host` smuggles no width.
//
// FAIL-CLOSED (vjt decision #1): when a form needs a component that is
// unknown (host or user is null), return `null` — DO NOT guess a wider mask.
// `/kb`'s form is the subject's ban-type setting (issue 2347, default "host");
// a null there surfaces the failure to the operator ("run /whois first")
// rather than banning something wider than intended.

// The closed set, spelled once. issue 2347 stores the subject's default form
// server-side (`GET`/`PUT /me/settings/ban-mask-form`), and a value read off
// the wire is narrowed against this list before anything builds a mask.
export const BAN_MASK_FORMS = ["nick", "host", "user_host"] as const;

export type BanMaskForm = (typeof BAN_MASK_FORMS)[number];

export function isBanMaskForm(v: unknown): v is BanMaskForm {
  return typeof v === "string" && (BAN_MASK_FORMS as readonly string[]).includes(v);
}

export type UserhostParts = {
  nick: string;
  user: string | null;
  host: string | null;
};

/**
 * Build the IRC ban mask for `form` from the resolved userhost `parts`.
 * Returns the mask string, or `null` when the chosen form needs a component
 * that is unknown (fail-closed — never a wider guess).
 */
export function buildBanMask(form: "nick", parts: UserhostParts): string;
export function buildBanMask(form: BanMaskForm, parts: UserhostParts): string | null;
export function buildBanMask(form: BanMaskForm, parts: UserhostParts): string | null {
  switch (form) {
    case "nick":
      return `${parts.nick}!*@*`;
    case "host":
      return parts.host ? `*!*@${parts.host}` : null;
    case "user_host":
      return parts.user && parts.host ? `*!${parts.user}@${parts.host}` : null;
    default: {
      const _exhaustive: never = form;
      void _exhaustive;
      return null;
    }
  }
}
