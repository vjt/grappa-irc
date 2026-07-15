# Issue Pipeline — users → ircbot → orchestrator → worker

The standing operating model for the always-on grappa development loop (vjt,
2026-06-29). Replaces the earlier fixed "issue pack" framing: issues now arrive
as a **continuous stream**, triaged and executed continuously.

## Roles

- **Users** — on IRC (#grappa et al.) report bugs/requests.
- **ircbot** ("vjt-claude", live on azzurra) — receives user issues, **triages**
  them, **creates the GitHub issue** (`vjt/grappa-irc`), and **enqueues it by
  setting the `status:queued` label** — that label IS the build queue. The ircbot
  does NOT implement. It **no longer hands issues over by pinging the
  orchestrator**: setting `status:queued` is the handover — the orchestrator
  self-serves from that label set (see below). vjt may enqueue an issue the same
  way. (Exception: a genuine drop-everything emergency may still be flagged to the
  orchestrator explicitly — but normal work flows through the label, not a ping.)
- **orchestrator** ("grappa-orch") — at the **end of each round** (worker free,
  nothing in flight) **pulls the open `status:queued` set directly from GitHub**,
  picks the next issue per the placement rules below, moves it
  `status:queued → status:cooking`, and drives the worker through it end-to-end
  (ship + announce + close, removing the `status:*` label on close). Does NOT
  implement. The `status:queued` set IS the queue — there is no separate
  hand-managed list, so the grappa.chat WIP board and the queue are one artifact.
- **worker** ("grappa-worker") — the sibling Claude that implements ONE issue at
  a time in a git worktree, under the orchestrator's direction.

## Picking the next issue (orchestrator, at end of round — no need to ask per issue)

At the end of each round the orchestrator reads the open `status:queued` issues
(`gh issue list --state open --label status:queued --json number,title,labels`)
and picks ONE to dispatch:

1. **Critical bug → first, but never preempt.** A `P0` bug in the queued set is
   dispatched next — but it **never interrupts work already in flight**. The
   in-flight issue always finishes first.
2. **Similarity → group.** Prefer a queued issue that touches the same surface as
   what just shipped / is adjacent in flight, so related changes reuse context.
3. **Otherwise → oldest first (FIFO).** Absent a P0 or a similarity match, take the
   lowest-numbered queued issue.
4. The orchestrator applies these itself. It escalates to vjt only for genuine
   ambiguity / design forks / scope questions — not for routine placement. When the
   `status:queued` set is **empty**, it goes idle / asks vjt "what next?" rather
   than inventing work.

On dispatch it moves the chosen issue `status:queued → status:cooking`; the label
transitions ARE the queue's state, so the WIP board always reflects the real queue.

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
creates + **enqueues (`status:queued`)**; the orchestrator **pulls the queued set
each round** + executes + ships. The label is the sole handover — no ping. Both
read this file (absolute path `/srv/grappa/docs/ISSUE_PIPELINE.md`).
