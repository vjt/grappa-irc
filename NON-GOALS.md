# Non-goals

grappa is a text IRC bouncer and client. Some features are **explicitly out of
scope** — not "later", not "PRs welcome", but never. They are tracked as issues
under the [`never`](https://github.com/vjt/grappa-irc/labels/never) label.

The through-line: **an IRC client is an IRC client.** grappa stays small,
text-first, greppable, and usable over low bandwidth and in a terminal. Anything
that turns the log into a feed, or bolts a second product onto the client,
belongs elsewhere — in a bot on the network, or behind a plain link.

## The list

- **No built-in `/AI` command** — #313. No in-client LLM prompt, no "press Tab to
  autocomplete a reply in your style". If you want AI on IRC, run a bot: a
  visible, accountable participant that sits on the network, opt-in per channel.
- **No voice messages** — #314. No recording, attaching, or playing back audio
  clips in channels or DMs. Link to audio hosted elsewhere if you must.
- **No inline image display** — #315. Image URLs stay URLs; the client renders
  text. Uploading and sharing a link is fine — embedding and rendering media in
  the scrollback is not.
- **No DCC SEND from grappa, and no DCC CHAT** — #167, narrowed by issue 2089
  (vjt, 2026-09-13). grappa does not OFFER files over DCC: the upload store
  already hands out an HTTPS URL, so re-offering the same bytes over a second
  transport buys nothing, and offering means LISTENING — accepting inbound P2P
  connections from arbitrary IRC nicks, which is the thing an always-on
  multi-user bouncer must not do. DCC CHAT is out for the same reason.
  **Receiving is no longer a non-goal.** A peer's `DCC SEND` has grappa
  connect OUT, which the listening objection never covered; the bytes land in
  an authenticated DCC inbox rather than the public upload route, and passive
  (reverse) DCC — where the roles invert and the RECEIVER listens — is refused
  exactly so the objection keeps holding. See `DESIGN_NOTES` entry #2089.

## Why keep a list of things we won't build

So the answer to "can grappa do X?" is written down once, and every future "have
you considered adding…" gets a link instead of a re-litigation.
