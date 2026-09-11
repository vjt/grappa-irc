# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for a security bug.** grappa-irc runs a
live instance with real users ([irc.sindro.me](https://irc.sindro.me)) and is
self-hosted by others. A public issue publishes the bug to everyone in the
same instant it reaches the maintainer, which is the one outcome this file
exists to avoid.

Report privately, through either channel:

1. **GitHub private vulnerability reporting** — the preferred route. Use the
   *Report a vulnerability* button on this repository's **Security** tab. It
   opens a thread visible only to you and the maintainer.
2. **Email** — `vjt@openssl.it`, the maintainer. Use this if you would rather
   not go through GitHub, or if the button above is not there.

This project publishes no PGP key. If you want an encrypted channel, ask for
one in a first message that carries no details.

## Scope

In scope:

- **the server** — `lib/grappa/**` and everything it exposes: the REST API,
  the WebSocket (Phoenix Channels) surface, authentication and session
  handling, the upstream IRC client, scrollback storage.
- **the client** — `cicchetto/**`, the browser PWA.
- **the live instance** — [irc.sindro.me](https://irc.sindro.me), for
  findings you can demonstrate **against your own account and your own
  data**.

Out of scope:

- **Denial of service, load testing, and traffic flooding** against the live
  instance or its upstream networks. Do not run these; report the weakness
  instead of exercising it.
- **Other people's accounts, messages, or scrollback** on the live instance.
  If a bug lets you reach them, stop at the proof that it does — do not
  collect the data.
- **Upstream IRC networks** (Azzurra, Libera, OFTC, …). They are not ours;
  report those to the network's own staff.
- **Third-party dependencies**, which belong upstream — though do tell us if
  the way grappa uses one makes the impact worse than upstream's own advisory
  describes.
- **Automated scanner output with no demonstrated impact.**

## What to expect

- **Acknowledgement is best effort.** This is a spare-time project with one
  maintainer and a handful of contributors. There is no on-call rotation and
  no guaranteed response time. Any specific number of hours or days written
  here would be a number this project cannot keep, and a policy that
  over-promises is worse than no policy.
- **Fix first, disclose after.** We will work the fix privately, then
  publish, and we will agree the timing of that publication with you rather
  than deciding it alone.
- **Credit if you want it.** Named in the release notes and the decision log,
  or left anonymous — your call.
- **No bug bounty.** There is no reward programme, no money and no swag.

## Supported versions

Only the current release — the newest `v*` tag, which is the number in the
repository's `VERSION` file — and the tip of `main` are supported. Older tags
receive no backports; there are no maintenance branches. Self-hosters should
track the latest release.
