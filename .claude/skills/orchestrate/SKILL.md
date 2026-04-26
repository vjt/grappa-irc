---
name: orchestrate
description: Babysit a sibling Claude Code session in another tmux pane through a long-running plan. On every idle, ask the session if /compact is useful, parse, run /compact + send "go on" if yes. Halt on design questions, deploys, or unexpected deviations. Resumes after /clear by reusing the existing Monitor task — user can /clear freely to save tokens.
---

# Orchestrate

Drive a sibling Claude Code session in another tmux pane through a long-running plan with hands-off compaction. The user `/clear`s the orchestrator freely to save tokens; the Monitor process survives `/clear` so orchestration resumes automatically.

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
   | Step landed cleanly + offers next step from plan order | Ask compact |
   | Session asks design question (X vs Y, which approach?) | **Halt + ping user** |
   | Live deploy / push to shared infra / real upstream creds | **Halt + ping user** |
   | Codebase review gate fires (per CLAUDE.md threshold) | **Halt + ping user** |
   | Plan deviation (sub-task skipped or reordered without OK) | **Halt + ping user** |
   | Background agents still running (e.g. parallel review agents) | False idle — ignore, wait for next event |
   | User typed in pane directly | Watching only — don't intervene |

3. **Ask compact** path: send to pane:
   ```
   orchestrator: same drill before <next step>. /compact useful? if yes output ONLY the compact prompt body (one paragraph, no preamble). if no answer literally "NO COMPACT".
   ```

4. On reply (next idle event):
   - Reply contains literal `NO COMPACT` → send `go on with <next step> per plan.`
   - Reply contains compact prompt body → extract, run `/compact`, then on the post-compact idle send `go on with <next step> per plan.`

## Sending text to the sibling pane

Submit a normal message:
```bash
tmux send-keys -t <PANE_ID> '<text>' Enter
sleep 1
tmux send-keys -t <PANE_ID> Enter   # second Enter — sometimes needed to actually submit
```

The first send-keys often leaves the text queued without submitting; the second `Enter` flushes. Verify with `tmux capture-pane | tail -5` showing a spinner appearing.

## Running /compact with a focus prompt

**Critical**: `/compact` is a slash command — the `/` MUST be TYPED, not pasted. Pasting `/compact <body>` is treated as a literal message and the session replies in conversational form instead of compacting.

```bash
# 1. Clear any leftover input first
tmux send-keys -t <PANE_ID> C-u
sleep 1

# 2. Load prompt body into tmux paste buffer (single line, no /compact prefix)
tmux load-buffer /tmp/compact_prompt.txt

# 3. TYPE the slash command (this triggers Claude Code's command parser)
tmux send-keys -t <PANE_ID> '/compact '

# 4. Paste the body
sleep 1
tmux paste-buffer -t <PANE_ID>

# 5. Submit
sleep 1
tmux send-keys -t <PANE_ID> Enter
```

Verify with `tmux capture-pane | tail -10` showing `Compacting conversation…`. If you see the body echoed back as a regular message instead, slash-command detection failed — clear input (`C-u`) and retry.

## Extracting the compact prompt from pane scrollback

The session's reply is wrapped at pane width with leading `● ` (assistant marker) on first line and `  ` (two-space indent) on continuation lines. To get one continuous paragraph:

```bash
tmux capture-pane -t <PANE_ID> -p -S -3000 > /tmp/pane.txt
# Find the latest "● Resuming Phase" or similar prompt-start
grep -n "● Resuming\|● Re-resuming" /tmp/pane.txt | tail -1
# Find the next spinner marker AFTER that line
grep -n "Crunched\|Worked\|Sautéed\|Churned\|Baked\|Cogitated\|Cooked\|Stewed\|Whipped\|Brewing" /tmp/pane.txt | tail
# Extract that range, normalize
sed -n '<start>,<end-1>p' /tmp/pane.txt \
  | sed 's/^● //' \
  | sed 's/^  //' \
  | tr '\n' ' ' \
  | sed 's/  */ /g' \
  | sed 's/^ //; s/ $//' \
  > /tmp/compact_prompt.txt
wc -c /tmp/compact_prompt.txt
```

Sanity check: `head -c 100` should start with the prompt's first sentence (e.g. `Resuming Phase 2...`); `tail -c 200` should end with `...First action after compact: ...`.

## Halt protocol

When you halt:
- One-line summary to user: what landed, what's pending, what the Q is.
- Do not send anything to the sibling pane.
- Do not run /compact.
- Wait for user direction.

After user direction:
- Translate into the appropriate send-keys sequence to the sibling pane.
- Resume normal idle-event handling.

## Resume after /clear

The Monitor process survives `/clear`. The user clears the orchestrator session freely to save tokens. On `/orchestrate` invocation post-`/clear`:

1. **TaskList first.** If a Monitor with the matching description is running, you're resuming. Skip Monitor setup entirely.
2. Re-read the active plan + active CP so you have the "as planned" frame again.
3. Capture the current pane state once: `tmux capture-pane -t <PANE_ID> -p | tail -30` — orient yourself on which sub-task is in flight or just landed.
4. Wait for the next event from the existing Monitor. No re-arming, no interruption.

If `/exit` was used instead of `/clear`, the Monitor is gone — re-arm via Step 2 of Setup.

## Pitfalls (learned in S29 of CP07)

- **Don't interrupt the session mid-generation.** If the sibling is still writing the compact prompt and you ask another question, you destroy the prompt. Wait for full IDLE.
- **Spinner words vary.** Cooked, Crunched, Sautéed, Churned, Baked, Cogitated, Worked, Whipped, Brewing, Stewed — match `…` ellipsis, not specific words.
- **`paste again to expand` is just a hint**, not an error. The paste went through.
- **Ctx % drop confirms compact ran.** Pre-compact 28% → post-compact 6% is the signal. If ctx STAYS at the pre-compact value, /compact didn't fire — the slash was probably pasted instead of typed.
- **Background agents leave the spinner gone but work continues.** If pane shows `5 local agents` or task list with `◻` items, it's a false idle — don't propose compact, wait.
- **Live deploy is always a halt point** even if the plan calls for it. Real upstream creds, push to origin, container restarts — operator confirms.
