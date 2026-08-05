import { token } from "./auth";

// THE identity predicate: the identity that started this continuation is not
// the identity that will receive its result.
//
// `t` is the bearer a verb captured at entry — its identity, not merely its
// credential. Any `await` can span an identity transition, and nothing cancels
// a request already on the wire, so a continuation that outlived its identity
// must do NOTHING further: not one request, not one write. Re-read `token()`
// after the await and compare.
//
// Both halves of "nothing further" are load-bearing, which is why the check
// belongs AFTER the await rather than in front of the request:
//
//   * the WIRE half — a request carrying a retired bearer 401s at best; aimed
//     at a resource the NEW identity cannot see it 404s, and the host's
//     `http-404` fail2ban jail bans the client IP at the firewall. A routine
//     account switch self-bans the operator (#281's harm class).
//   * the STORE half — the same continuation without touching the network: the
//     result it already fetched lands in state the rotation just purged, so the
//     new identity renders (or persists, or paints) the old one's data.
//
// Deliberately NOT part of `identityScopedStore`: that factory owns the
// identity TRANSITION (fire the resets), while this owns a verb's OWN captured
// identity, which the factory never sees. The two are complements — the resets
// clear state, this refuses the write that arrives after the clear.
//
// Deliberately NOT in `auth.ts` either, though that module owns `token`: a
// stub of `../auth` in a test would then stub the guard away with it, and the
// rule under test would silently stop existing. Importing `token` from here
// keeps the predicate real while still resolving through any token mock.
//
// #837 collapsed four inlined copies into this one. Adopters:
//   * `scrollback.ts`   (#788) — eleven awaits, refusing a stale REQUEST;
//   * `networks.ts`     (#818) — the `/me` hydrate side-effects;
//   * `displayPrefs.ts`         — the login-reconcile apply + seed-up PUT;
//   * `customTheme.ts`          — the active-theme paint + boot-cache write.
// A fifth await site that captures the token adopts it unchanged; a site that
// needs a VARIANT of the comparison has found a domain boundary, and that is
// worth saying out loud rather than parameterising this.
export function identityMoved(t: string): boolean {
  return token() !== t;
}
