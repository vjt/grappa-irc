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
   not go through GitHub. This project publishes no PGP key; if you want an
   encrypted channel, ask for one in a first message that carries no details.

## Scope

**Test against an instance you run yourself.** The repository carries
everything needed to stand one up, and a finding reproduced on your own
deployment is worth exactly as much here as one reproduced anywhere else —
while costing nobody else's uptime, data or attention.

In scope, on an instance you run yourself:

- **the server** — `lib/grappa/**` and everything it exposes: the REST API,
  the WebSocket (Phoenix Channels) surface, authentication and session
  handling, the upstream IRC client, scrollback storage.
- **the client** — `cicchetto/**`, the browser PWA.

Out of scope:

- **The live instance.** [irc.sindro.me](https://irc.sindro.me) is not a test
  target. Do not probe it, scan it or attack it — **not even against your own
  account and your own data**. Stand up your own instance and demonstrate the
  finding there instead.
- **Denial of service, load testing and traffic flooding.** Report the
  weakness; do not exercise it. A resource-exhaustion bug is a good report
  when you can describe the mechanism, and never a good demonstration. This
  holds wherever you would run it, your own instance included when it is
  pointed at a real IRC network — that traffic lands on somebody else's
  servers.
- **Other people's accounts, messages or scrollback.** On your own instance,
  create the second account yourself. If a bug reaches data that is not
  yours, stop at the proof that it does and do not collect it.
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

## No warranty

grappa-irc is free software, provided **as is** under the
[MIT License](LICENSE), which disclaims every warranty — express or implied —
and all liability. That file is the binding text on both, and nothing on this
page softens it. Running this software, self-hosted or otherwise, is at your
own risk.

Reporting a vulnerability earns no entitlement either: not to a fix, not to a
fix by any date, not to a reply, and not to compensation. *What to expect*
above says what this project intends to do. It is an intention, not a debt.
