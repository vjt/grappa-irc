---
name: orchestrate
description: Babysit a sibling Claude Code session in another tmux pane through a long-running plan. On every idle, ask the session if /clear is useful; if yes, sibling Writes its self-contained next-prompt body to /tmp/orchestrate-next.txt, orchestrator runs /clear and tells sibling to Read+execute that file (no paste-buffer). Halt on design questions or unexpected deviations. Resumes after /clear by reusing the existing Monitor task — user can /clear freely to save tokens.
---

# Orchestrate

Drive a sibling Claude Code session in another tmux pane through a long-running plan with hands-off context refresh. The user `/clear`s the orchestrator freely to save tokens; the Monitor process survives `/clear` so orchestration resumes automatically.

## Why /clear, not /compact

Earlier versions of this skill used `/compact <prompt-body>`. Switched to `/clear` because:

- The sibling's prompt bodies (the "first action after clear" paragraphs) are exhaustive — file paths, commit SHAs, full state, ordered next steps. The auto-summary `/compact` adds is mostly redundant.
- `/compact` keeps the entire prior conversation as a summary on top of the prompt body. Tokens add up across many sub-tasks.
- `/clear` wipes everything → sibling re-loads CLAUDE.md + active CP + plan from scratch, then acts on the prompt body. Lighter, cleaner restarts.

Tradeoff: no auto-summary safety net. The prompt body MUST be fully self-contained (file paths, commit SHAs, exact next-step). Tell the sibling that explicitly when asking for the prompt.

## Setup

### Step 1 — check for existing Monitor (resume case)

**Don't trust TaskList alone.** It has a blind spot for Monitor tasks that survived a prior `/clear` — they keep running but disappear from `TaskList`. `ps` and the status-line counter see them just fine, so the resume check is OS-level:

```bash
.claude/skills/orchestrate/lib/resume-check.sh <SIBLING_PANE_ID>
# → "RESUMING pid=NNN"   (a monitor for this sibling is already running)
# → "FRESH"              (no monitor → arm one via Step 2)
```

The script greps `pgrep -f` for `lib/monitor.sh <SIBLING_PANE_ID>` — both pieces are literal in `/proc/<pid>/cmdline` because the Monitor tool starts the script directly, so detection is a one-shot, no eval-quoting hazards.

If the script prints `RESUMING pid=...`:
- **Do not** re-arm the Monitor.
- **Do not** clear or interrupt the sibling pane.
- `TaskList` may be empty here — harness blind spot, not a missing monitor.
- Re-read the active plan + active checkpoint so you know what "as planned" means.
- Wait for the next event from the surviving Monitor — it'll deliver to this fresh session as soon as one fires.

If it prints `FRESH`, no Monitor exists → fall through to Step 2 (first-invocation setup).

### Step 2 — first invocation only

If no Monitor exists:

1. Identify panes:
   ```bash
   tmux list-panes -F '#{pane_index} #{pane_id} #{pane_active} #{pane_current_command}'
   ```
   The OTHER pane (not the one this session runs in) is the target. Note its `%id`.

2. Read the active plan: invoke `/start` to get the workflow context, then read the relevant `docs/plans/*.md` so you know the sub-task order. Read `docs/checkpoints/*.md` with `status: active` for current state.

3. Arm the Monitor (persistent, 60s poll). Emits BOOT, BUSY, IDLE, CTX-BUMP (≥70%), and HEARTBEAT (every 30 min). The polling logic lives in `lib/monitor.sh` (busy detection, ctx parsing, event emission — all in one place, easy to iterate on without re-pasting heredoc walls of bash):

   Use the `Monitor` tool with:
   - `command`: `/srv/grappa/.claude/skills/orchestrate/lib/monitor.sh <SIBLING_PANE_ID>`
   - `persistent`: `true`
   - `timeout_ms`: `3600000`
   - `description`: `grappa pane %<id> idle/ctx watch`

   The stable cmdline (`bash lib/monitor.sh %NNN`) is what makes `resume-check.sh` reliable — see Step 1.

   Busy detection (in `lib/monitor.sh`): a line in the last 15 must carry `…` AND a spinner timer `(NNs` / `(Nm Ms`, OR an explicit `Press up to edit` / `esc to interrupt` prompt. Bare `…` is NOT enough: truncated task descriptions (`tok…`, `… +N completed`, `… +N pending`) used to produce false-busy events for ~30 minutes during CP10 S6.

## Decision tree per idle event

When IDLE event fires:

1. Capture: `tmux capture-pane -t <PANE_ID> -p | tail -50`
2. Inspect last assistant message. Categorize:

   | Pane state | Action |
   |------------|--------|
   | Step landed cleanly + offers next step from plan order | Ask clear |
   | Session asks design question (X vs Y, which approach?) | **Halt + ping user** |
   | Plan deviation (sub-task skipped or reordered without OK) | **Halt + ping user** |
   | Codebase review gate fires (per CLAUDE.md threshold) | **Halt + ping user** |
   | Background agents still running (e.g. parallel review agents) | False idle — ignore, wait for next event |
   | User typed in pane directly | Watching only — don't intervene |

   Live deploys / pushes / shared-infra writes default to halt; if the user has explicitly authorized autopilot for the run, treat them as plan-aligned and let sibling proceed.

3. **Ask clear** path: send to pane:
   ```
   orchestrator: same drill before <next step>. /clear or no? if yes WRITE the full prompt body (fully self-contained for /clear, no auto-summary safety net — explicit file paths + commit SHAs + first action) to /tmp/orchestrate-next.txt and reply with literally "CLEAR". if no reply with literally "NO CLEAR". do NOT print the body inline in chat.
   ```

   **Why file handoff, not pane scrape:** the prompt body is large + can be many KB. Going through tmux scrollback (sibling prints body → orchestrator captures → reconstructs from line-wrap → loads into paste-buffer → pastes back) is fragile (line-wrap concat ambiguity, ANSI artifacts, `<system-reminder>` bleed) and bloats both sessions' context. File handoff: sibling Writes once, orchestrator instructs sibling to Read it post-clear. Zero paste-buffer, zero scraping.

4. On reply (next idle event — Monitor may MISS the busy window for fast replies, see Pitfalls):
   - Reply contains literal `NO CLEAR` → send `go on with <next step> per plan.`
   - Reply contains literal `CLEAR` → run `/clear`, then send a short directive: `read /tmp/orchestrate-next.txt and execute it.` Sibling Reads + acts. No paste-buffer.

## Sending text to the sibling pane

Submit a normal message:
```bash
tmux send-keys -t <PANE_ID> '<text>' Enter
sleep 1
tmux send-keys -t <PANE_ID> Enter   # second Enter — sometimes needed to actually submit
```

The first send-keys often leaves the text queued without submitting; the second `Enter` flushes. Verify with `tmux capture-pane | tail -5` showing a spinner appearing.

## Running /clear with a fresh prompt

`/clear` is a slash command — the `/` MUST be TYPED, not pasted. `/clear` takes no argument: it wipes the conversation, then the next sent message is the new turn-1 user prompt.

After sibling has Written the body to `/tmp/orchestrate-next.txt` (and replied `CLEAR`), the orchestrator's job is just three short sends — no paste-buffer, no scraping:

```bash
# 1. Clear any leftover input
tmux send-keys -t <PANE_ID> C-u
sleep 1

# 2. TYPE /clear + Enter (wipes the conversation)
tmux send-keys -t <PANE_ID> '/clear' Enter
sleep 3

# 3. Verify clear landed: status line should show `🧠 TBD` (fresh, no tokens).
tmux capture-pane -t <PANE_ID> -p -S -25 | grep -E "🧠 TBD|🧠 [0-9]+%" | tail -2

# 4. One short directive — sibling reads the file and executes.
tmux send-keys -t <PANE_ID> 'read /tmp/orchestrate-next.txt and execute it.' Enter
sleep 1
tmux send-keys -t <PANE_ID> Enter   # second Enter — sometimes needed to actually submit
```

After sibling Reads and starts working, ctx jumps from `TBD` to a small % (Read of a few KB) and the spinner appears, confirming turn 1 of the clean session is underway.

**Why this is safer than paste-buffer:** the prompt body never traverses the tmux paste buffer or pane scrollback. No line-wrap reconstruction, no ANSI/`<system-reminder>` bleed, no quoting hazards. The orchestrator never needs to read the body — only the sibling does, and Read gives it a clean, file-rooted view.

If you ever fall back to the legacy paste-buffer path (sibling printed the body inline by mistake), see git history of this skill before 2026-04-27 for the scrape-and-paste-buffer recipe — it was retired because file handoff is strictly better.

## Halt protocol

When you halt:
- One-line summary to user: what landed, what's pending, what the Q is.
- Do not send anything to the sibling pane.
- Do not run /clear.
- Wait for user direction.

After user direction:
- Translate into the appropriate send-keys sequence to the sibling pane.
- Resume normal idle-event handling.

## Resume after /clear (orchestrator side)

The Monitor process survives `/clear`. The user clears the orchestrator session freely to save tokens. On `/orchestrate` invocation post-`/clear`:

1. **Run the Step-1 resume check** (ps + status-line, NOT just TaskList — see Setup Step 1). If a monitor is found, you're resuming. Skip Monitor setup entirely.
2. Re-read the active plan + active CP so you have the "as planned" frame again.
3. Capture the current pane state once: `tmux capture-pane -t <PANE_ID> -p | tail -30` — orient yourself on which sub-task is in flight or just landed.
4. Wait for the next event from the existing Monitor. No re-arming, no interruption.

If `/exit` was used instead of `/clear`, the Monitor is gone — re-arm via Step 2 of Setup.

## Pitfalls (learned in S29 of CP07 + CP08/CP09 Phase 2/3 + CP10 S6)

- **Don't interrupt the session mid-generation.** If the sibling is still writing the prompt body and you ask another question, you destroy the prompt. Wait for full IDLE.
- **Spinner words vary wildly.** Cooked, Crunched, Sautéed, Churned, Baked, Cogitated, Worked, Whipped, Brewing, Stewed, Boondoggling, Mulling, Quantumizing, Forging, Spinning, Befuddling, Undulating, Zigzagging, Proofing, Osmosing, Transfiguring, Crystallizing, Reticulating, Billowing, Calculating, Discombobulating, Imagining, Hullaballooing, Pouncing, Channeling, Spelunking, Thundering, Smooshing — don't match words; match the timer signature `\([0-9]+[ms]` paired with `…` on the same line.
- **Bare `…` is NOT a busy signal.** Truncated task descriptions (`tok…`, `M3, H11, M2, M12 — already organic…`), task-list compaction (`… +N completed`, `… +N pending`), and sibling-printed punctuation all carry `…` while the session is fully idle. The fixed regex requires the timer signature on the same line. The earlier "match `…` ellipsis, not specific words" rule (CP08-era) was too loose — fixed CP10 S6 after a stalled sibling reported BUSY for ~30 min while truly idle.
- **`paste again to expand` is just a hint**, not an error. (Legacy paste-buffer path only — file handoff avoids the warning entirely.)
- **`/clear` confirmed by `🧠 TBD` in status line** (fresh conversation, no tokens). After the sibling Reads the prompt file and starts working, ctx jumps to a small % (e.g. 5–10%), confirming turn 1 landed in a clean session. If you still see the pre-clear ctx %, `/clear` didn't fire — re-run the sequence.
- **Monitor's 60s poll misses fast NO-CLEAR / CLEAR replies.** When sibling answers in <60s the busy→idle transition completes inside one polling window; no IDLE event fires because `prev_state` was never `busy`. After sending a clear-ask, peek the pane proactively after ~2 min instead of waiting for events.
- **Background agents leave the spinner gone but work continues.** If pane shows `N local agents` or task list with `◻`/`◼` items, it's a false idle even if no spinner is up. Don't propose clear, wait. With the new busy detector this is mostly handled (no spurious BUSY) but the IDLE event after the agents finish IS the right signal — just don't act if you see active agent rows.
- **Halt at human-required steps** even on autopilot. iPhone/device tests, explicit user-tagged tasks (`◼ HALT for ...`), real-credential operations the user hasn't pre-authorized.
- **Self-contained prompt files only.** With `/compact` an auto-summary covers gaps. With `/clear`, the prompt body in `/tmp/orchestrate-next.txt` is the ENTIRE context the sibling has after wipe. Sibling MUST bake in: every sub-task SHA so far, file paths, exact first action, all carried-forward state from any "deferred to next sub-task" notes. Tell sibling that explicitly when asking for the file.
- **Stale Monitor processes survive the orchestrator's `/clear`.** TaskList may not surface them but the `N monitors` status-line counter exposes them, and `lib/resume-check.sh` finds them by script path. To kill an orphan: `pgrep -f "lib/monitor.sh %<SIBLING_ID>" | xargs -r kill`. The harness surfaces a `failed` notification with the orphan's task ID, confirming the kill.
