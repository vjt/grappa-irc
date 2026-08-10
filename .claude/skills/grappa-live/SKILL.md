---
name: grappa-live
description: Report progress to the #grappa-live IRC channel from a coding agent (w1, w2, orch). Use while working — say what you are doing now, what you found, what you shipped, what blocks you. Posting goes through tools/grappa-post.py over the grappa REST API; the agent holds no IRC socket.
---

# grappa-live — progress reporting into IRC

`#grappa-live` is a **human-facing observability channel**. A person watching it
should be able to follow, line by line, what the fleet is doing without opening a
terminal. **vjt's standing order (2026-08-11): be chatty — keep him updated on
what you are working on**, not only on the milestones. It is still not a log sink
and not an inter-agent bus: nothing reads your messages back to you, so a line
nobody could follow is noise, but silence while you work is now the worse failure.

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

Post on **state changes**, always:

- a task is picked up (issue number + one clause on what it is)
- a PR is opened, and again when it merges
- CI goes red, or a gate is blocked (Docker down, a dependency missing)
- you are **blocked on a ruling** — say what you need decided, not the whole analysis
- a task is abandoned or handed back

And post **while you work**, so the channel reads as a running commentary:

- what you are on right now, when you switch to something else
- what you found that changed your plan — a wrong assumption, a second bug, a
  file that turned out to be the real culprit
- the shape of the fix you settled on, before you spend an hour writing it
- a long-running step you are waiting on (a full test run, a build, a deploy)
  and the verdict when it lands

Rough cadence: **a line every few minutes of real work**, and one whenever
something you'd tell a colleague over your shoulder happens. If nothing changed
since your last line, say nothing — repeating yourself is the one kind of chatty
that helps nobody.

Do **not** post: file-by-file diffs, test-by-test output, your reasoning at
length, or the same state twice.

## How to write it

- **One line. Max 40 words.** Links do not count toward the 40.
- Lead with the issue or PR number — it is the only handle the reader has.
- State the fact, not the journey. `#1208 parser was fine, the router drops the
  reason — fixing there` beats a paragraph on how you got there.
- No blasphemy, no jokes: this channel is read by people who are not in on them.
- English or Italian, match the thread; do not switch mid-task.
- One message per event, and one event per message. Three things to say means
  three lines spread over the work, not one paragraph now.

## What never goes in the channel

Tokens, passwords, config paths, database rows, customer data, full stack
traces, `/os` or `/rs` output. If a reader could use it to get in somewhere,
it does not belong in an IRC channel. Summarise and link to the issue instead.
