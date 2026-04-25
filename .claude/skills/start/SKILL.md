---
name: start
description: Session start protocol — workflow gates, pending work, status report
---

Session start skill. Run the full workflow checklist and produce a
status report. This is the "what's pending" dashboard.

## Steps

### 1. Codebase review gate (the ONLY gate)

Count session headers (`## S`) in the active checkpoint. Check date
of last codebase review in `docs/reviews/codebase/`.

A review is **DUE** if:
- ≥ 12 sessions since last codebase review, OR
- > 2 weeks since last codebase review

**When due: must run before new feature work.** Bug fixes and deploy
fixes are exempt. This is enforced, not advisory.

### 2. Find active checkpoint

Find the checkpoint with `status: active` in `docs/checkpoints/`.
Report:
- CP number and how many sessions it has (count `## S` headers)
- Line count — warn if approaching 200 (time to rotate)
- Pending items listed at bottom of checkpoint

### 3. Read todo.md

Read `docs/todo.md` for the full backlog. Categorize by priority tier.

### 4. Check git + docker state

```bash
git status
git log --oneline -5
docker compose ps
```

Note any uncommitted changes, unpushed commits, active worktrees, and
whether the grappa container is running.

### 5. Quick environment sanity

```bash
scripts/healthcheck.sh    # only if container is running
```

If the container is up but `/healthz` fails, that's an immediate red
flag — surface it before anything else.

### 6. Produce the report

Format:

```
🔬 **Codebase Review**: not due (n sessions, last YYYY-MM-DD) / DUE — must run before features
📍 **Active Checkpoint**: CPnn (n sessions, ~nnn lines)
🌿 **Git State**: clean / uncommitted changes / unpushed commits (count)
🐳 **Container**: running (healthz ok) / running (healthz FAIL) / stopped / never built

## Pending (from checkpoint)
- item 1
- item 2

## Todo Highlights
**Immediate**: ...
**High**: ...
**Medium**: ...
**Observation**: ...

## What's Available
Given the gate status, here's what we can work on: ...
```

The "What's Available" section is the key output. If a codebase review
is due, say so and offer to run it. Otherwise, list the priority work
from todo + checkpoint pending.

### 7. Phase awareness

Surface the current Phase from `README.md` "Phases" section. If we're
mid-Phase, mention which Task in the relevant plan we're at based on
the last commit + the test/code state. Don't just pull from todo —
read the actual code.
