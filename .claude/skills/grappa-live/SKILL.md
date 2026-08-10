---
name: grappa-live
description: Report progress to the #grappa-live IRC channel from a coding agent (w1, w2, orch). Use when a task starts, ships, breaks, or blocks — never for narration. Posting goes through tools/grappa-post.py over the grappa REST API; the agent holds no IRC socket.
---

# grappa-live — progress reporting into IRC

`#grappa-live` is a **human-facing observability channel**. A person watching it
should be able to tell, at a glance, what the fleet is doing and whether anything
needs them. It is not a log sink and it is not an inter-agent bus: nothing reads
your messages back to you, so anything you post that nobody would act on is pure
noise.

## How to post

```sh
tools/grappa-post.py "1168: PR #1203 opened, CI running"
echo "1168: CI green, merged" | tools/grappa-post.py
```

Config lives at `~/.config/grappa/client.json` (or `$GRAPPA_CLIENT_CONFIG`),
mode 0600, one per agent. It carries the credential — **never** pass a token or
password on the command line, and never print the config.

Exit codes: `0` sent, `1` config/usage, `2` server refused, `3` transport. A
non-zero exit is not worth retrying in a loop: the message was optional, the
work is not. Log it and move on.

## When to post

Post on **state changes a human would want to know about**:

- a task is picked up (issue number + one clause on what it is)
- a PR is opened, and again when it merges
- CI goes red, or a gate is blocked (Docker down, a dependency missing)
- you are **blocked on a ruling** — say what you need decided, not the whole analysis
- a task is abandoned or handed back

Do **not** post: file-by-file progress, "starting work", "thinking about it",
test-by-test output, anything you would only say to fill silence.

## How to write it

- **One line. Max 40 words.** Links do not count toward the 40.
- Lead with the issue or PR number — it is the only handle the reader has.
- State the fact, not the journey. `#1208 merged, /part reason wired` beats a
  paragraph on how the parser was wrong.
- No blasphemy, no jokes: this channel is read by people who are not in on them.
- English or Italian, match the thread; do not switch mid-task.
- One message per event. If you have three things to say, you have one thing to
  say and two to drop.

## What never goes in the channel

Tokens, passwords, config paths, database rows, customer data, full stack
traces, `/os` or `/rs` output. If a reader could use it to get in somewhere,
it does not belong in an IRC channel. Summarise and link to the issue instead.
