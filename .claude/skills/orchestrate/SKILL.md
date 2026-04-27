---
name: orchestrate
description: Babysit a sibling Claude Code session in another tmux pane through a long-running plan. On every idle, ask the session if /clear is useful, parse, run /clear + paste prompt body if yes. Halt on design questions or unexpected deviations. Resumes after /clear by reusing the existing Monitor task — user can /clear freely to save tokens.
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

Run `TaskList`. If a persistent Monitor task tagged `grappa pane %... idle/ctx watch` (or similar) is already running, you are RESUMING after `/clear`:
- **Do not** re-arm the Monitor.
- **Do not** clear or interrupt the sibling pane.
- Re-read the active plan + active checkpoint so you know what "as planned" means.
- Wait for the next event.

### Step 2 — first invocation only

If no Monitor exists:

1. Identify panes:
   ```bash
   tmux list-panes -F '#{pane_index} #{pane_id} #{pane_active} #{pane_current_command}'
   ```
   The OTHER pane (not the one this session runs in) is the target. Note its `%id`.

2. Read the active plan: invoke `/start` to get the workflow context, then read the relevant `docs/plans/*.md` so you know the sub-task order. Read `docs/checkpoints/*.md` with `status: active` for current state.

3. Arm the Monitor (persistent, 60–90s poll). Emits BOOT, BUSY, IDLE, CTX-BUMP (≥70%), and HEARTBEAT (every 30 min). Busy detection keys on `…` ellipsis (universal spinner char), `Press up to edit`, and `esc to interrupt`.

   ```bash
   prev_state=""
   prev_bucket=""
   last_emit=0
   while true; do
     out=$(tmux capture-pane -t <PANE_ID> -p 2>/dev/null)
     [ -z "$out" ] && { echo "PANE-MISSING"; break; }
     tail=$(echo "$out" | tail -15)
     if echo "$tail" | grep -qE "…|Press up to edit|esc to interrupt"; then
       state="busy"
     else
       state="idle"
     fi
     ctx=$(echo "$out" | grep -oE "🧠 [0-9]+%" | tail -1 | grep -oE "[0-9]+")
     bucket=""
     [ -n "$ctx" ] && bucket=$(( (ctx / 10) * 10 ))
     now=$(date +%s)
     if [ "$prev_state" = "" ]; then
       echo "BOOT state=${state} ctx=${ctx}%"
       last_emit=$now
     elif [ "$state" = "idle" ] && [ "$prev_state" = "busy" ]; then
       echo "IDLE ctx=${ctx}%"; last_emit=$now
     elif [ "$state" = "busy" ] && [ "$prev_state" = "idle" ]; then
       echo "BUSY ctx=${ctx}%"; last_emit=$now
     fi
     if [ -n "$ctx" ] && [ -n "$bucket" ] && [ "$bucket" -ge 70 ] && [ "$bucket" != "$prev_bucket" ]; then
       echo "CTX-BUMP ${ctx}% state=${state}"
       prev_bucket="$bucket"; last_emit=$now
     fi
     if [ $((now - last_emit)) -ge 1800 ]; then
       echo "HEARTBEAT state=${state} ctx=${ctx}%"; last_emit=$now
     fi
     prev_state="$state"
     sleep 60
   done
   ```

   Use `Monitor` tool with `persistent: true`, `timeout_ms: 3600000`. Description: `grappa pane %<id> idle/ctx watch`.

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
   orchestrator: same drill before <next step>. /clear or no? if yes output ONLY the prompt body (one paragraph, no preamble) — fully self-contained for /clear, no auto-summary safety net. include explicit file paths + commit SHAs + first action after clear. if no answer literally "NO CLEAR".
   ```

4. On reply (next idle event — note Monitor may MISS the busy window for fast replies, see Pitfalls):
   - Reply contains literal `NO CLEAR` → send `go on with <next step> per plan.`
   - Reply contains prompt body → extract, run `/clear`, paste body as fresh user message.

## Sending text to the sibling pane

Submit a normal message:
```bash
tmux send-keys -t <PANE_ID> '<text>' Enter
sleep 1
tmux send-keys -t <PANE_ID> Enter   # second Enter — sometimes needed to actually submit
```

The first send-keys often leaves the text queued without submitting; the second `Enter` flushes. Verify with `tmux capture-pane | tail -5` showing a spinner appearing.

## Running /clear with a fresh prompt

`/clear` is a slash command — the `/` MUST be TYPED, not pasted. Unlike `/compact`, `/clear` takes no argument: it wipes the conversation, then the next sent message is the new turn-1 user prompt. Two-step send.

```bash
# 1. Clear any leftover input first
tmux send-keys -t <PANE_ID> C-u
sleep 1

# 2. TYPE the slash command + Enter (wipes the conversation)
tmux send-keys -t <PANE_ID> '/clear' Enter
sleep 3

# 3. Load prompt body into tmux paste buffer (the entire body, NOT prefixed with /clear or /compact)
tmux load-buffer /tmp/clear_prompt.txt

# 4. Paste the body as the first message of the fresh conversation
tmux paste-buffer -t <PANE_ID>
sleep 1

# 5. Submit (second Enter often needed)
tmux send-keys -t <PANE_ID> Enter
sleep 1
tmux send-keys -t <PANE_ID> Enter
```

Verify with `tmux capture-pane | tail -10`. Right after `/clear` the status line shows ctx as `🧠 TBD` (fresh, no tokens yet) — that's the signal `/clear` fired. After paste + submit, sibling spinner appears and ctx jumps from 0 to a small percentage.

## Extracting the prompt body from pane scrollback

The session's reply is wrapped at pane width with leading `● ` (assistant marker) on first line and `  ` (two-space indent) on continuation lines. To get one continuous paragraph:

```bash
tmux capture-pane -t <PANE_ID> -p -S -3000 > /tmp/pane.txt
# Find first ● after the orchestrator question
awk '/orchestrator: same drill/{found=1} found && /^● /{print NR; exit}' /tmp/pane.txt
# Find the next spinner marker AFTER that line — spinner words vary; match the universal `… for Xm Ys` shape
grep -nE "Crunched|Worked|Sautéed|Churned|Baked|Cogitated|Cooked|Stewed|Whipped|Brewing|Boondoggling|Mulling|Quantumizing|Forging|Spinning|Befuddling|Undulating|Zigzagging|Proofing|Osmosing|Transfiguring|Crystallizing|Reticulating|Billowing|Calculating|Discombobulating|Imagining" /tmp/pane.txt | tail
# Extract the range between (start) and (spinner-1), normalize
sed -n '<start>,<end-1>p' /tmp/pane.txt \
  | sed 's/^● //' \
  | sed 's/^  //' \
  | tr '\n' ' ' \
  | sed 's/  */ /g' \
  | sed 's/^ //; s/ $//' \
  > /tmp/clear_prompt.txt
wc -c /tmp/clear_prompt.txt
```

Sanity check:
- `head -c 200` — should start with the prompt's first sentence (e.g. `Resume Phase 3 sub-task 5...`).
- `tail -c 250` — should end with the explicit "first action" instruction (e.g. `...read /srv/grappa/lib/grappa_web/router.ex, then ...`).

If the tail contains a `<system-reminder>` block, your `<end>` line was too generous — re-grep for the spinner and trim.

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

1. **TaskList first.** If a Monitor with the matching description is running, you're resuming. Skip Monitor setup entirely.
2. Re-read the active plan + active CP so you have the "as planned" frame again.
3. Capture the current pane state once: `tmux capture-pane -t <PANE_ID> -p | tail -30` — orient yourself on which sub-task is in flight or just landed.
4. Wait for the next event from the existing Monitor. No re-arming, no interruption.

If `/exit` was used instead of `/clear`, the Monitor is gone — re-arm via Step 2 of Setup.

## Pitfalls (learned in S29 of CP07 + CP08/CP09 Phase 2/3)

- **Don't interrupt the session mid-generation.** If the sibling is still writing the prompt body and you ask another question, you destroy the prompt. Wait for full IDLE.
- **Spinner words vary wildly.** Cooked, Crunched, Sautéed, Churned, Baked, Cogitated, Worked, Whipped, Brewing, Stewed, Boondoggling, Mulling, Quantumizing, Forging, Spinning, Befuddling, Undulating, Zigzagging, Proofing, Osmosing, Transfiguring, Crystallizing, Reticulating, Billowing, Calculating, Discombobulating, Imagining — match `…` ellipsis, not specific words.
- **`paste again to expand` is just a hint**, not an error. The paste went through.
- **`/clear` confirmed by `🧠 TBD` in status line** (fresh conversation, no tokens). After the prompt body submits, ctx jumps to a small % (e.g. 5–10%), confirming the body landed in turn 1 of a clean session. If you still see the pre-clear ctx %, `/clear` didn't fire — re-run the sequence.
- **Monitor's 60s poll misses fast NO-CLEAR replies.** When sibling answers in <60s the busy→idle transition completes inside one polling window; no IDLE event fires because `prev_state` was never `busy`. After sending a clear-ask, peek the pane proactively after ~2 min instead of waiting for events.
- **Background agents leave the spinner gone but work continues.** If pane shows `N local agents` or task list with `◻`/`◼` items including ellipses (`… +12 completed`), it's a false idle. Don't propose clear, wait. The `…` in `… +N completed` ALSO trips the busy regex sometimes — capture the pane and look at the actual state, don't trust transition events alone.
- **Halt at human-required steps** even on autopilot. iPhone/device tests, explicit user-tagged tasks (`◼ HALT for ...`), real-credential operations the user hasn't pre-authorized.
- **Self-contained prompts only.** With `/compact` an auto-summary covers gaps. With `/clear`, the prompt body is the ENTIRE context the sibling has after wipe. Bake in: every sub-task SHA so far, file paths, exact first action, all carried-forward state from any "deferred to next sub-task" notes.
