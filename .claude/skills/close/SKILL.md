---
name: close
description: End-of-session protocol — push, checkpoint, docs, story episode
---

Session closing skill. Invoke with `/close` at end of session.

## Steps

### 1. Push unpushed commits

```bash
git log --oneline origin/main..HEAD
```

If commits exist, push:
```bash
git push
```

### 2. Flush checkpoint

Find the active checkpoint (`status: active` in `docs/checkpoints/`).
Add a new session section (`## Sn — YYYY-MM-DD — descriptive title`).

Content per session:
- What was built/fixed (grouped by topic, not chronologically)
- Key technical decisions and why
- Bug fixes with root cause
- Stats: test count, Dialyzer warnings, commit range
- Pending items for next session

Use existing checkpoint sections as format reference. Concise but
complete — the checkpoint is the permanent record.

### 3. Update todo.md

- **DELETE completed items** — just the line, nothing else. No
  strikethroughs, no "RESOLVED" annotations. Completions go in the
  checkpoint, not todo.
- **Keep all context on pending items** — design doc pointers, function
  names, scope details. Never strip context from pending work.
- **Fix stale references** — renamed modules, schemas, contexts.
- Add new items discovered during the session.
- Update wording of in-progress items if scope changed.

### 4. Check if checkpoint needs rotating

Count session headers (`## S`) and total lines in active checkpoint.

Rotate if ANY of:
- Active checkpoint has ≥ 8 sessions
- Active checkpoint exceeds ~200 lines
- The human asks to rotate

**Rotation procedure:**
1. Change `status: active` → `status: done` in frontmatter
2. Determine next CP number (increment from current)
3. Create new checkpoint file: `docs/checkpoints/YYYY-MM-DD-cpNN.md`
   with `status: active`, `# CPNN`, and a `Previous:` line summarising
   the closed checkpoint
4. Add `## State at checkpoint creation` with current stats
5. Commit: `docs: close CPxx, create CPyy`

### 5. Update living docs (if needed)

Check whether this session's work affects:

- `README.md` — spec changes (rare; usually only at phase boundaries)
- `docs/DESIGN_NOTES.md` — every architectural decision MUST land here
  with date + rationale + apply-rule
- `CLAUDE.md` — new patterns or rules that should outlive the session
- `docs/project-evolution.md` — header stats, phase status — update
  EVERY session, not "if significant"
- `docs/todo.md` — already handled in step 3

Skip docs that weren't affected. Don't touch docs for cosmetic reasons.

**Staleness check:** grep the living docs for references to renamed/
removed modules, schemas, contexts, or changed patterns from this
session. Fix any stale references found. Don't touch archived docs —
they're historical records.

### 6. Project story episode (MANDATORY)

**Every session gets an episode in `docs/project-story.md`.** There is
always something to say — a design decision, a debugging rabbit hole,
a production surprise, a moment where the plan met reality. Even
"routine" sessions have a story: why was this the priority, what was
the tradeoff, what did we learn. The project story is the narrative
history. Gaps in the story are gaps in institutional memory.

Find the angle. Some sessions have obvious drama (production crashes,
reverts, architectural pivots). Others need you to look harder — the
small surprise that changed the approach, the assumption that turned
out wrong, the thing that was harder (or easier) than expected. If
nothing went wrong, write about what went *right* and why.

When writing:
- Read the last 2-3 episodes for voice and tone
- Update the header stats in `docs/project-evolution.md` (commits,
  sessions, test count). This is mandatory every session, not "if
  significant."
- Optional: extract a one-line **Law:** if a generalisable principle
  emerged. Laws need the narrative to give them weight; episodes
  without laws are fine, laws without episodes are not.

### 7. Final commit and push

Commit all doc changes:
```
docs: close session — CP update + [whatever else changed]
```

Push to origin.

### 8. Report

Tell the human:
- Commits pushed (count + range)
- Checkpoint status (flushed / rotated + new created)
- Docs updated (list)
- Story episode (one-line summary)
- Any pending work for next session
