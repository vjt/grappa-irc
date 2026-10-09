# Threat model

grappa is an always-on IRC bouncer: one supervised Elixir/OTP process per
(user, network) holds the upstream IRC connection, scrollback lives in SQLite,
and a REST API plus Phoenix Channels (WebSocket) serve a browser PWA,
`cicchetto/`. It is multi-user and self-hosted, and one maintainer-run
instance has real users. `README.md` is the spec, `CLAUDE.md` holds the
invariants, `docs/DESIGN_NOTES.md` plus `docs/design_notes/` are the decision
log, and `SECURITY.md` is the disclosure policy.

## What this project does and where untrusted input enters

Treat all of the following as attacker-controlled:

- **Upstream IRC bytes.** Anything an IRC server or any user on a network can
  make it send: lines, numerics, CTCP, nicks, channel names, NAMES/WHO/WHOIS
  replies, DCC offers. The other users on a network are untrusted, and the
  server may be hostile too (an operator can point grappa at any server).
  Framing is parsed by ONE parser, `lib/grappa/irc/parser.ex`, and routed by
  `lib/grappa/session/event_router.ex`.
- **The REST API and the WebSocket surface** (`lib/grappa_web/`), from
  authenticated users, from **visitors** (anonymous, time-limited subjects,
  see `lib/grappa/visitors/`), and from the unauthenticated public.
- **Uploads** (`lib/grappa/uploads/`): user-supplied files, metadata-stripped
  through exiftool / ffmpeg before they are served.
- **DCC receive** (`lib/grappa/dcc/`): bytes a stranger on IRC pushes at a
  user who accepted the offer. A separate trust domain from uploads.
- **identd** (`lib/grappa/identd/`): an optional RFC 1413 listener, off by
  default; when enabled, any host that can reach it.
- **Peer avatars and other server-side fetches** made on behalf of users.

## Components that matter most / least

Most:

- **Authentication and authorization**: bearer sessions, WebAuthn, TOTP,
  password login (`lib/grappa/accounts/`, `lib/grappa/auth/`, the plugs in
  `lib/grappa_web/`). Cross-subject isolation matters above all: one user or
  visitor must never read or act on another subject's networks, scrollback,
  read state, uploads or settings. The PubSub topic layout is user-rooted
  for exactly this reason (`Grappa.PubSub.Topic`).
- **The admin surfaces**: `/admin/*` routes behind the `:admin_authn`
  pipeline, and the loopback-only operational routes behind
  `Plugs.LoopbackOnly`, which trusts the client IP that `RemoteIpFromProxy`
  derives. There is no proxy-level allowlist: these BEAM-side gates are the
  only gates.
- **The IRC parser and the event router**: binary pattern matching over
  hostile bytes, run inside each user's session process.
- **Outbound IRC construction**: anything that turns user input into a line
  sent upstream (CR/LF/NUL injection, command smuggling).
- **Credentials at rest**: SASL and NickServ passwords are Cloak-encrypted in
  SQLite (`Grappa.Vault`); upstream TLS verifies peers by default
  (`Grappa.IRC.Client.tls_connect_opts/2`), with a deliberate per-server
  opt-out documented in `CLAUDE.md`.
- **Uploads and the DCC spool**: path handling, content-type, the served
  headers, and the metadata-strip step.
- **cicchetto**: it renders untrusted IRC text, so XSS through message
  bodies, nicks, topics or URLs is in scope.

Least:

- `infra/`, `scripts/`, `bin/` and the packaging: operator tooling run by the
  host's own administrator.
- Dev and test support code under `test/`.

## How to exercise it

- `mix test` runs the ExUnit suite (`MIX_ENV=test`, SQLite under `runtime/`).
  `test/support/` has `Grappa.IRCServer`, an in-process fake IRC server that
  drives a real session end to end; `test/grappa/irc/parser_test.exs` and
  `parser_property_test.exs` cover the parser.
- `cd cicchetto && bun run test` runs the PWA's vitest suite.
- The image built by `.oss-scanner/Dockerfile` has every dependency fetched
  and both env builds compiled, so these run offline.

## How you rate severity

These are our proposals, and judgment wins over the table:

- **Critical**: unauthenticated or visitor-level access to another subject's
  data or session, authentication bypass, admin-pipeline bypass, remote code
  execution, or disclosure of stored credentials.
- **High**: an authenticated user reaching another user's data or actions;
  stored XSS in cicchetto reachable from IRC traffic or from another user;
  IRC line injection that sends attacker-chosen commands on a victim's
  connection; a hostile IRC server or peer crashing sessions other than the
  one it is connected to.
- **Medium**: a hostile server or peer crashing or wedging the ONE session
  connected to it; information leaks that do not cross subjects; issues that
  need an unusual operator configuration.
- **Low**: hardening gaps with no demonstrated impact.
- Denial of service is medium at most unless it crosses users or takes the
  whole node down, in which case it is high. Describe the mechanism; do not
  exercise it against anything you do not own.

## Anything to leave alone

Out of scope, as in `SECURITY.md`:

- the live instance, and any instance you do not run yourself;
- upstream IRC networks (Azzurra, Libera, OFTC, …): report those to their
  staff;
- third-party dependencies, unless the way grappa uses one makes the impact
  worse than upstream's own advisory;
- denial of service demonstrated by load or flooding;
- findings with no demonstrated impact.

Also not bugs, because they are documented decisions in `CLAUDE.md` /
`docs/DESIGN_NOTES.md`:

- a server configured with `tls_verify` off connects without certificate
  verification: it is an explicit, per-server operator choice, logged at
  warning level on every connect;
- a nick change does not migrate stored DM history, read cursors or mutes to
  the new nick (issue 1365);
- `mix hex.audit` advisories on cowboy/cowlib: both are test-only
  dependencies and never ship in a release.

Please send a reproducer and, where you can, a patch against `main`.
