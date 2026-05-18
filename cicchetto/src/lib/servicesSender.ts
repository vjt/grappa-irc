// UX-4 bucket G — IRC services-sender classifier (cic side).
//
// Mirrors `Grappa.IRC.Identifier.services_sender?/1` in the server
// (lib/grappa/irc/identifier.ex). The server is the source of truth
// for routing — services-sender PRIVMSG/NOTICE arrivals persist on
// the `$server` synthetic channel — but the COMPOSE path needs the
// same predicate locally so `/msg nickserv ...` doesn't optimistically
// open a query window (the response will never arrive there).
//
// Closed allowlist (NOT a regex). Pre-bucket-G the server's NOTICE
// arm used `~r/Serv$/i` which matched ops nicks like `Conserv` /
// `Dataserv` / `Reserv` (bucket H/S4 burned us on the same class for
// outbound PRIVMSG). The allowlist keeps the classifier scoped to
// the well-known IRC services suite; future *serv variants need an
// explicit add here AND on the server in lockstep.
//
// Channel-sigil targets (`#`, `&`, `+`, `!`) are by definition not
// services (PRIVMSG to a channel goes to the room, not a bot) — they
// short-circuit to `false` before the allowlist scan.

const SERVICES = new Set([
  "nickserv",
  "chanserv",
  "memoserv",
  "operserv",
  "botserv",
  "hostserv",
  "helpserv",
]);

export function isServicesSender(s: string): boolean {
  if (s.length === 0) return false;
  const first = s[0];
  if (first === "#" || first === "&" || first === "+" || first === "!") return false;
  return SERVICES.has(s.toLowerCase());
}
