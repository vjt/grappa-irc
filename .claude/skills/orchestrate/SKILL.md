---
name: orchestrate
description: Babysit a sibling Claude Code session in another tmux pane through a long-running plan. On every idle, ask the session if /clear is useful; if yes, sibling Writes its self-contained next-prompt body to /tmp/orchestrate-next.txt, orchestrator runs /clear and tells sibling to Read+execute that file (no paste-buffer). Halt on design questions or unexpected deviations. Resumes after /clear by re-reading the per-pane state file — user can /clear freely to save tokens.
---

# Orchestrate

Drive a sibling Claude Code session in another tmux pane through a long-running plan with hands-off context refresh. The user `/clear`s the orchestrator freely to save tokens; the per-pane state file on `/tmp` survives `/clear` so orchestration resumes automatically.

## Why /clear, not /compact

Earlier versions of this skill used `/compact <prompt-body>`. Switched to `/clear` because:

- The sibling's prompt bodies (the "first action after clear" paragraphs) are exhaustive — file paths, commit SHAs, full state, ordered next steps. The auto-summary `/compact` adds is mostly redundant.
- `/compact` keeps the entire prior conversation as a summary on top of the prompt body. Tokens add up across many sub-tasks.
- `/clear` wipes everything → sibling re-loads CLAUDE.md + active CP + plan from scratch, then acts on the prompt body. Lighter, cleaner restarts.

Tradeoff: no auto-summary safety net. The prompt body MUST be fully self-contained (file paths, commit SHAs, exact next-step). Tell the sibling that explicitly when asking for the prompt.

## Architecture: bg-bash + per-event wakeup

The original design used a persistent polling loop launched via a per-line streaming long-running tool. This harness doesn't expose that surface — the deferred-tool list has `Task*`, `Cron*`, `ScheduleWakeup`, plus `Bash` (with `run_in_background: true` for fire-and-forget shells whose only notification is at completion).

`Cron*` looked usable (1-min ticks) but cron-fired prompts in this harness fail upstream with HTTP 500 on most fires (direct user-typed prompts from the same session work fine — it's a cron-path-specific issue). `ScheduleWakeup` is gated to `/loop` dynamic mode only.

The viable shape exploits the per-completion notification of `Bash run_in_background: true`:

- **`lib/wakeup-tick.sh <PANE>`** is the one-shot tick: captures the pane, computes the busy/idle state and ctx %, diffs against the previous tick's state stored in `/tmp/orchestrate-state-<pane>.json`, and prints exactly one event line:
  - `BOOT state=<idle|busy> ctx=NN%` — first tick after STALE/FRESH state.
  - `IDLE ctx=NN%` — busy → idle transition.
  - `BUSY ctx=NN%` — idle → busy transition.
  - `CTX-BUMP NN% state=<...>` — entered a new ≥10%-bucket at ≥30%.
  - `HEARTBEAT state=<...> ctx=NN%` — no event in ≥1800s.
  - `SAME state=<...> ctx=NN%` — no transition; orchestrator may ignore.
  - `PANE-MISSING` — the tmux pane is gone.

- **`lib/wait-for-event.sh <PANE>`** loops `wakeup-tick.sh` every 60s internally, swallowing SAME events, and exits 0 on the first interesting event line. Run via `Bash run_in_background: true, timeout: 3600000` — the harness fires a task-completion notification when it exits, giving per-event wakeup with no polling on the orchestrator side.

The state file IS the durable handoff between wakeups and across orchestrator `/clear`s — there is no long-lived process, only the file.

## Setup

### Step 1 — check for existing state (resume case)

```bash
.claude/skills/orchestrate/lib/resume-check.sh <SIBLING_PANE_ID>
# → "RESUMING age=NNs"   (state file exists, last_emit < 600s ago)
# → "STALE   age=NNs"    (state file exists but ≥600s old — treat as fresh)
# → "FRESH"              (no state file → first invocation)
```

If `RESUMING`:
- **Do not** wipe the state file.
- **Do not** clear or interrupt the sibling pane.
- Re-read the active plan + active checkpoint so you know what "as planned" means.
- Schedule the next tick (Step 2.4) and wait — the next wake will pick up the in-flight session.

If `STALE` or `FRESH`, fall through to Step 2.

### Step 2 — first invocation

1. Identify panes:
   ```bash
   tmux list-panes -F '#{pane_index} #{pane_id} #{pane_active} #{pane_current_command}'
   ```
   The OTHER pane (not the one this session runs in) is the target. Note its `%id`.

2. Read the active plan: invoke `/start` to get the workflow context, then read the relevant `docs/plans/*.md` so you know the sub-task order. Read `docs/checkpoints/*.md` with `status: active` for current state.

3. If `STALE`, wipe the old state file: `rm -f /tmp/orchestrate-state-<id>.json`. (The leading `%` from the pane id is stripped in the filename.)

4. Fire the first tick — it emits `BOOT` and seeds the state file:
   ```bash
   .claude/skills/orchestrate/lib/wakeup-tick.sh <SIBLING_PANE_ID>
   ```
   Read the emitted event line and apply the decision tree below.

5. Arm the next-event wait:
   ```
   Bash(
     command: "/Users/mbarnaba/code/grappa/.claude/skills/orchestrate/lib/wait-for-event.sh <SIBLING_PANE_ID>",
     run_in_background: true,
     timeout: 3600000,
     description: "wait for next event from pane <SIBLING_PANE_ID>"
   )
   ```

   When the script exits (on first non-SAME event), the harness fires a task-completion notification. Read the task output via `TaskOutput` (block: false) to get the event line, apply the decision tree, then re-arm another `wait-for-event.sh` in the background. One arm = one event = one wakeup.

### Busy detector (in `lib/wakeup-tick.sh`)

A line in the last 15 must carry `… (` (the spinner shape: ellipsis + space + open-paren that introduces the parenthesized status — `(NNs · ...)` once the timer arms, `(thinking)` / `(almost done ...)` in the pre-timer phase) — OR an explicit `Press up to edit` / `esc to interrupt` prompt. Bare `…` is NOT enough: truncated task descriptions (`tok…`, `… +N completed`, `… +N pending`) used to produce false-busy events for ~30 minutes during CP10 S6.

Idle debounce: a single idle read after a busy read can be a transient tool-call gap. The tick script re-captures after 5s and only classifies as IDLE if still idle on the second read.

## Decision tree per event

When a tick prints an event line, branch on it:

| Event | Action |
|-------|--------|
| `BOOT state=idle` | Capture pane (`tail -50`), orient on what just landed, then schedule next tick |
| `BOOT state=busy` | Sibling is mid-work; schedule next tick, no intervention |
| `IDLE ctx=NN%` | Run the IDLE decision tree below |
| `BUSY ctx=NN%` | Sibling started new work; schedule next tick |
| `CTX-BUMP NN%` at ≥70% | Proactively suggest clear-cycle (don't wait for IDLE) |
| `HEARTBEAT state=busy` | Long-running task. Capture pane to confirm legit progress; schedule next tick |
| `HEARTBEAT state=idle` | Sibling stuck waiting for input? Capture and decide |
| `SAME state=*` | No-op, just reschedule |
| `PANE-MISSING` | Halt + ping user. Don't reschedule |

On IDLE event:

1. Capture: `tmux capture-pane -t <PANE_ID> -p | tail -50`
2. Inspect last assistant message. Categorize:

   | Pane state | Action |
   |------------|--------|
   | Step landed cleanly + offers next step from plan order | Ask clear |
   | Session asks design question (X vs Y, which approach?) | **Halt + ping user** |
   | Plan deviation (sub-task skipped or reordered without OK) | **Halt + ping user** |
   | Codebase review gate fires (per CLAUDE.md threshold) | **Halt + ping user** |
   | Background agents still running (e.g. parallel review agents) | False idle — ignore, reschedule |
   | User typed in pane directly | Watching only — don't intervene |

   Live deploys / pushes / shared-infra writes default to halt; if the user has explicitly authorized autopilot for the run, treat them as plan-aligned and let sibling proceed.

3. **Ask clear** path: send to pane:
   ```
   orchestrator: same drill before <next step>. /clear or no? if yes WRITE the full prompt body (fully self-contained for /clear, no auto-summary safety net — explicit file paths + commit SHAs + first action) to /tmp/orchestrate-next.txt and reply with literally "CLEAR". if no reply with literally "NO CLEAR". do NOT print the body inline in chat.
   ```

   **Why file handoff, not pane scrape:** the prompt body is large + can be many KB. Going through tmux scrollback (sibling prints body → orchestrator captures → reconstructs from line-wrap → loads into paste-buffer → pastes back) is fragile (line-wrap concat ambiguity, ANSI artifacts, `<system-reminder>` bleed) and bloats both sessions' context. File handoff: sibling Writes once, orchestrator instructs sibling to Read it post-clear. Zero paste-buffer, zero scraping.

4. On reply (next IDLE event — the 60s tick may MISS the busy window for fast replies, see Pitfalls):
   - Reply contains literal `NO CLEAR` → send `go on with <next step> per plan.`
   - Reply contains literal `CLEAR` → run `/clear`, then send a short directive: `read /tmp/orchestrate-next.txt and execute it.` Sibling Reads + acts. No paste-buffer.

5. Always re-arm the next tick before returning.

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
- Do not reschedule the next tick — wait for user direction. (Decide explicitly: if you want passive monitoring to continue while you halt, schedule the next tick and just don't act on its events until the user replies.)

After user direction:
- Translate into the appropriate send-keys sequence to the sibling pane.
- Resume normal tick-event handling (re-arm ScheduleWakeup if you stopped).

## Resume after /clear (orchestrator side)

The state file at `/tmp/orchestrate-state-<pane>.json` survives orchestrator `/clear`. The user clears the orchestrator session freely to save tokens. On `/orchestrate` invocation post-`/clear`:

1. Run `lib/resume-check.sh <PANE_ID>`. If `RESUMING`, you're picking up a live session.
2. Re-read the active plan + active CP so you have the "as planned" frame again.
3. Capture the current pane state once: `tmux capture-pane -t <PANE_ID> -p | tail -30` — orient yourself on which sub-task is in flight or just landed.
4. Re-arm the ScheduleWakeup tick (it's not durable across `/clear` — only the state file is).
5. Wait for the next tick to fire.

If the ScheduleWakeup chain was broken (orchestrator `/exit`'d, harness restarted), the state file may show `RESUMING` but no tick is scheduled — re-arming in step 4 covers this. If `STALE`, treat as fresh (Step 2 of Setup).

## Pitfalls (learned in S29 of CP07 + CP08/CP09 Phase 2/3 + CP10 S6)

- **Don't interrupt the session mid-generation.** If the sibling is still writing the prompt body and you ask another question, you destroy the prompt. Wait for full IDLE.
- **Spinner words vary wildly.** Cooked, Crunched, Sautéed, Churned, Baked, Cogitated, Worked, Whipped, Brewing, Stewed, Boondoggling, Mulling, Quantumizing, Forging, Spinning, Befuddling, Undulating, Zigzagging, Proofing, Osmosing, Transfiguring, Crystallizing, Reticulating, Billowing, Calculating, Discombobulating, Imagining, Hullaballooing, Pouncing, Channeling, Spelunking, Thundering, Smooshing — don't match words; match the spinner shape `… (` paired with parenthesized status.
- **Bare `…` is NOT a busy signal.** Truncated task descriptions (`tok…`, `M3, H11, M2, M12 — already organic…`), task-list compaction (`… +N completed`, `… +N pending`), and sibling-printed punctuation all carry `…` while the session is fully idle. The fixed regex requires `… (` (ellipsis + space + open-paren) on the same line. The earlier "match `…` ellipsis, not specific words" rule (CP08-era) was too loose — fixed CP10 S6 after a stalled sibling reported BUSY for ~30 min while truly idle.
- **`paste again to expand` is just a hint**, not an error. (Legacy paste-buffer path only — file handoff avoids the warning entirely.)
- **`/clear` confirmed by `🧠 TBD` in status line** (fresh conversation, no tokens). After the sibling Reads the prompt file and starts working, ctx jumps to a small % (e.g. 5–10%), confirming turn 1 landed in a clean session. If you still see the pre-clear ctx %, `/clear` didn't fire — re-run the sequence.
- **60s tick can MISS fast NO-CLEAR / CLEAR replies.** When sibling answers in <60s the busy→idle transition completes inside one tick window; no IDLE event fires because `prev_state` was never updated to `busy`. After sending a clear-ask, peek the pane proactively after ~2 min instead of waiting for events.
- **Background agents leave the spinner gone but work continues.** If pane shows `N local agents` or task list with `◻`/`◼` items, it's a false idle even if no spinner is up. Don't propose clear, wait. With the new busy detector this is mostly handled (no spurious BUSY) but the IDLE event after the agents finish IS the right signal — just don't act if you see active agent rows.
- **Halt at human-required steps** even on autopilot. iPhone/device tests, explicit user-tagged tasks (`◼ HALT for ...`), real-credential operations the user hasn't pre-authorized.
- **Self-contained prompt files only.** With `/compact` an auto-summary covers gaps. With `/clear`, the prompt body in `/tmp/orchestrate-next.txt` is the ENTIRE context the sibling has after wipe. Sibling MUST bake in: every sub-task SHA so far, file paths, exact first action, all carried-forward state from any "deferred to next sub-task" notes. Tell sibling that explicitly when asking for the file.
- **ScheduleWakeup chains break on `/exit`.** The state file persists but the wake-up timer is in-session-only. After a hard restart, re-arm ScheduleWakeup or the orchestrator will go silent forever. Resume-check returning `RESUMING` does NOT mean a tick is queued — only that the state file is fresh.
- **State files survive everything.** A stale `/tmp/orchestrate-state-<pane>.json` from yesterday's session will trigger `RESUMING` if you re-orchestrate within 10 min of the last_emit. The 600s freshness window in resume-check.sh is conservative; if you suspect false-resume, `rm -f /tmp/orchestrate-state-<pane>.json` and start fresh.
