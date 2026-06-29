# Issue Pipeline — users → ircbot → orchestrator → worker

The standing operating model for the always-on grappa development loop (vjt,
2026-06-29). Replaces the earlier fixed "issue pack" framing: issues now arrive
as a **continuous stream**, triaged and executed continuously.

## Roles

- **Users** — on IRC (#grappa et al.) report bugs/requests.
- **ircbot** ("vjt-claude", live on azzurra) — receives user issues, **triages**
  them, **creates the GitHub issue** (`vjt/grappa-irc`), and **passes it to the
  orchestrator** for execution. The ircbot does NOT implement and does NOT place
  things in the execution queue — it hands the issue over.
- **orchestrator** ("grappa-orch") — owns the execution **queue**, decides
  **where** each new issue goes (see rules below), and drives the worker through
  each issue end-to-end (ship + announce + close). Does NOT implement.
- **worker** ("grappa-worker") — the sibling Claude that implements ONE issue at
  a time in a git worktree, under the orchestrator's direction.

## Queue placement (the orchestrator decides — no need to ask per issue)

1. **Default → TAIL.** A new issue is appended to the end of the queue.
2. **Similarity → group.** If a new issue touches the same parts/surface as
   something already in the queue, place it adjacent to that related work instead
   of the tail (so related changes ship together / reuse the same context).
3. **Critical bug → HEAD, but never preempt.** A critical bug jumps to the FRONT
   of the queue so it's the *next* dispatch — but it **never interrupts work
   already in flight**. The in-flight issue always finishes first.
4. The orchestrator applies these rules itself. It escalates to vjt only for
   genuine ambiguity / design forks / scope questions — not for routine placement.

## Per-issue execution flow (NO pull request)

```
worktree (branch off local main)
  → implement  (TDD: failing test first; a REAL e2e asserting the visible outcome)
  → gates green (ONE check.sh — never concurrent runs; if waiting on a bg run use a
                 log-pattern Monitor WITH a timeout, never a self-matching pgrep loop)
  → rebase onto main → merge to main → push origin main
  → deploy m42 (auto hot/cold; add --cic when cic was touched)
  → announce #grappa (fire-and-forget via the ircbot — brief once, move on)
  → gh issue close
```

- **No PRs.** Worktree + merge + push + deploy. ("No commit *directly* to master"
  is satisfied by the worktree branch; the branch still merges to master — there is
  just no PR step.)
- **Feature boundary → full clear-cycle** of the worker (fresh session per issue;
  self-contained brief staged to `/tmp/orchestrate-next.txt`).
- **A red `integration`/e2e CI job BLOCKS** — never ship on red.
- **Announces are fire-and-forget** — brief the ircbot once; do not poll/verify.

## Why this doc

So the orchestrator and the ircbot share one clear contract: the ircbot triages +
creates + hands over; the orchestrator places + executes + ships. Both read this
file (absolute path `/srv/grappa/docs/ISSUE_PIPELINE.md`).
