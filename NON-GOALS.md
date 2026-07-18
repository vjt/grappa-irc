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

## Why keep a list of things we won't build

So the answer to "can grappa do X?" is written down once, and every future "have
you considered adding…" gets a link instead of a re-litigation.
