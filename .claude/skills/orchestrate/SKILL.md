---
name: orchestrate
description: Babysit a sibling Claude Code session in another tmux pane through a long-running plan. On every idle, ask the session if /clear is useful; if yes, sibling Writes its self-contained next-prompt body to /tmp/orchestrate-next.txt, orchestrator runs /clear and tells sibling to Read+execute that file (no paste-buffer). Halt on design questions or unexpected deviations. On every /orchestrate invocation it FIRST reads the handoff doc /tmp/orchestrator-resume.md (the persistent brain) then reconciles against the per-pane daemon state — so /orchestrate alone resumes with zero extra instruction; user can /clear freely to save tokens.
---

# Orchestrate

Drive a sibling Claude Code session in another tmux pane through a long-running plan with hands-off context refresh. The user `/clear`s the orchestrator freely to save tokens; the per-pane state file on `/tmp` survives `/clear` so orchestration resumes automatically.

## Why /clear, not /compact

Earlier versions of this skill used `/compact <prompt-body>`. Switched to `/clear` because:

- The sibling's prompt bodies (the "first action after clear" paragraphs) are exhaustive — file paths, commit SHAs, full state, ordered next steps. The auto-summary `/compact` adds is mostly redundant.
- `/compact` keeps the entire prior conversation as a summary on top of the prompt body. Tokens add up across many sub-tasks.
- `/clear` wipes everything → sibling re-loads CLAUDE.md + active CP + plan from scratch, then acts on the prompt body. Lighter, cleaner restarts.

Tradeoff: no auto-summary safety net. The prompt body MUST be fully self-contained (file paths, commit SHAs, exact next-step). Tell the sibling that explicitly when asking for the prompt.

## Architecture (v2 — daemon + log + cursor-tail)

v1 used a single-shot wait-for-event chain: orchestrator armed one bg-bash, harness fired a notification when it exited, orchestrator re-armed. **This was brittle**: forgetting to re-arm = silent stall (happened twice in the visitor-parity cluster). 60s tick missed fast clear-ask replies. Permission prompts and design pickers all looked like "IDLE" so orchestrator tried to clear sibling mid-prompt.

v2 separates concerns:

- **`lib/daemon.sh start|stop|status|log <PANE>`** — long-running detached ticker (forked via `nohup … &` + `disown`; macOS has no `setsid`). Calls `wakeup-tick.sh` every **5s** (was 20s, was 60s) and appends events to `/tmp/orchestrate-events-<pane>.log`. Single-instance per pane via pid file at `/tmp/orchestrate-daemon-<pane>.pid`. Survives orchestrator `/clear`, `/exit`, harness restarts. **The orchestrator can't break the chain by forgetting to re-arm anything.**

- **`lib/wakeup-tick.sh <PANE>`** — the one-shot pane sample. Reads pane via `tmux capture-pane`, classifies state, emits zero-or-more event lines. State persisted at `/tmp/orchestrate-state-<pane>.json` for transition diffs across ticks.

- **`lib/wait-for-event.sh <PANE>`** — cursor-tracking log tailer. Reads byte offset from `/tmp/orchestrate-cursor-<pane>`, waits until log size > cursor, dumps all new events to stdout, advances cursor, exits. Invoked via `Bash run_in_background: true` for the per-event wakeup notification. **Multiple events queued during a no-waiter window are emitted together** — no event is ever lost.

- **`lib/state.sh <PANE>`** — query current state without consuming events. Use when orchestrator wakes via user message and needs ground truth.

- **`lib/resume-check.sh <PANE>`** — returns `FRESH | STALE age=Ns | RESUMING age=Ns daemon=running|stopped`.

### Event vocabulary (v2 expanded)

| Event | Meaning |
|-------|---------|
| `BOOT state=<idle\|busy\|prompt\|picker> ctx=NN%` | First tick after FRESH/STALE |
| `IDLE ctx=NN%` | busy → idle (real idle, no prompt/picker pending) |
| `BUSY ctx=NN%` | idle → busy |
| `PROMPT-PENDING ctx=NN%` | Sibling on a permission/dialog prompt (`Do you want to proceed?` + `1. Yes`) — **DON'T act** |
| `PROMPT-CLEARED ctx=NN%` | User clicked through the prompt — sibling unblocked |
| `PICKER ctx=NN%` | Sibling popped a design-Q picker (`↑/↓ to navigate`, `Tab/Arrow keys`) — **HALT, ping vjt** |
| `PICKER-CLEARED ctx=NN%` | Picker resolved |
| `USER-TYPED ctx=NN%` | vjt typed in pane directly (md5-deduped) — **observe only** |
| `CTX-BUMP NN% state=<...>` | Entered new ≥10%-bucket at ≥30% |
| `CTX-CRITICAL NN% state=<...>` | Entered ≥80% — last-chance clear before auto-compact |
| `STALL state=<...> ctx=NN% duration=Ns` | Same state ≥300s, possible deadlock — investigate |
| `HEARTBEAT state=<...> ctx=NN%` | No event in ≥600s (was 1800) — keepalive |
| `PANE-MISSING` | tmux pane gone (2 consecutive misses) — daemon exits |

`SAME` events are swallowed by the daemon, never written to log.

### State file fields

`/tmp/orchestrate-state-<pane>.json` (key=value, not real JSON):

- `state` — `idle | busy | prompt | picker`
- `ctx` — `NN` or `TBD`
- `bucket` — `NN` (10s)
- `prompt_active` — `0|1`
- `picker_active` — `0|1`
- `last_user_typed_hash` — md5 of last `❯ <text>` line (USER-TYPED dedup)
- `last_emit` — unix ts of last emitted event
- `last_state_change` — unix ts of last state transition (STALL gate)

## Setup

### Step 0 — read the handoff doc FIRST (always, before anything else)

On EVERY `/orchestrate` invocation the FIRST action — before `tmux`, before resume-check, before any tool — is:

```
Read /tmp/orchestrator-resume.md
```

This is the orchestrator's persistent brain across `/clear`. It holds: the active plan / issue pack, what's shipped, any pending decision or open halt, the sibling pane id (`%NN`), the daemon pid, the per-run standing rules (autopilot scope, the #it-opers escalation/ping config, clear-cycle policy), and an `## IMMEDIATE NEXT STEP` line. Reading it top-to-bottom means **`/orchestrate` alone fully restores context — the user should never have to say "read the handoff and resume."** If the file is absent, this is a first-ever run for this machine — skip to Step 1.

**Keeping it current is the orchestrator's job, not optional.** Update `/tmp/orchestrator-resume.md` at every ship, dispatch, halt, design decision, and standing-rule change — it is the ONLY thing that survives the orchestrator's own `/clear`. A stale handoff is the highest-severity bug: it makes the post-clear orchestrator act on wrong state. The `## IMMEDIATE NEXT STEP` line must always name the very next concrete action (e.g. "re-arm waiter on %58, monitoring #131 build → on ship announce + close pack").

After reading the handoff, proceed to Step 1 (resume-check) to reconcile it against live daemon/pane state.

### Step 1 — check for existing state (resume case)

```bash
.claude/skills/orchestrate/lib/resume-check.sh <SIBLING_PANE_ID>
# → "RESUMING age=NNs daemon=running"   (state file fresh + daemon up — pick up live)
# → "RESUMING age=NNs daemon=stopped"   (state file fresh but daemon died — restart needed)
# → "STALE   age=NNs"                    (state file ≥600s old — treat as fresh)
# → "FRESH"                              (no state file → first invocation)
```

If `RESUMING daemon=running`:
- **Do not** wipe the state file or stop the daemon.
- **Do not** clear or interrupt the sibling pane.
- Re-read the active plan + active checkpoint so you know what "as planned" means.
- Query current sibling state: `lib/state.sh <PANE>`.
- Arm `wait-for-event.sh` (Step 2.4) and resume the decision tree.

If `RESUMING daemon=stopped`:
- Restart daemon: `lib/daemon.sh start <PANE>`. Cursor + state file preserved.
- Re-arm `wait-for-event.sh`.

If `STALE` or `FRESH`, fall through to Step 2.

### Step 2 — first invocation

1. Identify panes:
   ```bash
   tmux list-panes -F '#{pane_index} #{pane_id} #{pane_active} #{pane_current_command}'
   ```
   The OTHER pane (not the one this session runs in) is the target. Note its `%id`.

2. Read the active plan: invoke `/start` to get the workflow context, then read the relevant GitHub issue(s) for the task (`gh issue view <n>`) — plus the feature's ephemeral plan file under `docs/plans/` if one exists this session — so you know the sub-task order. Read `docs/checkpoints/*.md` with `status: active` for current state. **`gh issue view <n>` plain is BROKEN by the classic-projects deprecation — always pass `--json`: `gh issue view <n> --json number,state,title,body,labels -q ...`. Same for closing: `gh issue close <n> -c "<note>"`.**

3. If `STALE`, wipe stale files: `rm -f /tmp/orchestrate-state-<id>.json /tmp/orchestrate-cursor-<id> /tmp/orchestrate-events-<id>.log /tmp/orchestrate-daemon-<id>.pid`. (The leading `%` from the pane id is stripped in the filenames.)

4. Start the daemon — it ticks every 5s and emits a `BOOT` event on first tick:
   ```bash
   .claude/skills/orchestrate/lib/daemon.sh start <SIBLING_PANE_ID>
   ```
   Wait ~3s, then verify: `.claude/skills/orchestrate/lib/daemon.sh status <SIBLING_PANE_ID>` should report `last_event: BOOT state=...`.

5. Arm the next-event consumer:
   ```
   Bash(
     command: "/Users/mbarnaba/code/grappa/.claude/skills/orchestrate/lib/wait-for-event.sh <SIBLING_PANE_ID>",
     run_in_background: true,
     timeout: 3600000,
     description: "wait for next event from pane <SIBLING_PANE_ID>"
   )
   ```

   When the script exits (on the next event delivered by the daemon), the harness fires a task-completion notification. Read the task output via `TaskOutput` (block: false), apply the decision tree, then re-arm another `wait-for-event.sh` in the background. **One arm = one batch of events**: if the daemon queued multiple events while no waiter was armed (orchestrator was clearing, busy with user, crashed and restarted), they're all dumped in one shot — handle each one.

   **Forgetting to re-arm is no longer fatal**: the daemon keeps ticking + appending. Next `wait-for-event.sh` call resumes from the cursor with all queued events.

### Detector internals (in `lib/wakeup-tick.sh`)

**Busy detector**: a line in the last 30 (was 15 in v1 — permission modals push the spinner offscreen) must carry `… (` (the spinner shape: ellipsis + space + open-paren that introduces the parenthesized status — `(NNs · ...)` once the timer arms, `(thinking)` / `(almost done ...)` in the pre-timer phase) — OR an explicit `Press up to edit` / `esc to interrupt` prompt. Bare `…` is NOT enough: truncated task descriptions (`tok…`, `… +N completed`, `… +N pending`) used to produce false-busy events for ~30 minutes during CP10 S6.

**Prompt detector**: `Do you want to proceed?` AND a `1. Yes` numbered list. Emits `PROMPT-PENDING` instead of `IDLE` so the orchestrator doesn't try to clear sibling mid-prompt. (v1 lesson: visitor-parity cluster wasted ~10 turns trying to clear sibling that was waiting on a CDP `cp` permission click.)

**Picker detector**: `↑/↓ to navigate` OR `Tab/Arrow keys to navigate` OR `Enter to select` (the design-Q multi-choice modal Claude Code pops). Emits `PICKER` — orchestrator MUST halt + ping vjt.

**USER-TYPED detector**: hashes the last `❯ <text>` line; if it changes vs prior tick (md5), emits `USER-TYPED` so orchestrator knows vjt typed in pane directly. Observe-only — don't intervene.

**ctx parse**: tries `🧠 NN%`, falls back to `TBD` (post-`/clear` empty). v1 emitted `ctx=%` (broken parse) when status line wrapped offscreen; v2 always returns a valid value.

**Idle debounce**: a single idle read after a busy read can be a transient tool-call gap (between Read/Bash result rendering and the next spinner line). The tick re-captures after 5s and only classifies as idle/prompt/picker/busy on the second read.

## Decision tree per event

A `wait-for-event.sh` exit may emit MULTIPLE event lines (events queued during a no-waiter window). Process each in turn:

| Event | Action |
|-------|--------|
| `BOOT state=idle` | Capture pane (`tail -50`), orient on what just landed, then re-arm |
| `BOOT state=busy` | Sibling mid-work; re-arm, no intervention |
| `BOOT state=prompt` | Sibling on a permission prompt — **halt + ping** |
| `BOOT state=picker` | Sibling on a design-Q picker — **halt + ping** |
| `IDLE ctx=NN%` | Run the IDLE decision tree below |
| `BUSY ctx=NN%` | Sibling started new work; re-arm |
| `PROMPT-PENDING ctx=NN%` | Sibling needs vjt's permission click — **halt + ping**. Do NOT send keys, do NOT clear, do NOT investigate the prompt content (it's typically a `cp` script approval — vjt clicks 1 or 2). Wait for `PROMPT-CLEARED`. |
| `PROMPT-CLEARED ctx=NN%` | Sibling unblocked, re-arm |
| `PICKER ctx=NN%` | Sibling popped a design-Q multi-choice — **halt + ping vjt with the choice options**. Capture pane, identify the question + choices, present them concisely. Optionally include your recommended pick + 1-line reasoning, but the call is vjt's. |
| `PICKER-CLEARED ctx=NN%` | vjt picked, sibling processing — re-arm |
| `USER-TYPED ctx=NN%` | vjt typed in pane directly. Capture, note what they said, re-arm. **Do not respond on vjt's behalf** — sibling will. |
| `CTX-BUMP NN%` at ≥30% | Proactively suggest clear-cycle (don't wait for IDLE). At ≥30% the next chunk of work likely won't fit before auto-compact. |
| `CTX-CRITICAL NN%` at ≥80% | **Aggressive clear posture** — ask sibling to flush + clear at next safe checkpoint, even mid-bucket if needed. Auto-compact lurks. |
| `STALL state=busy duration=Ns` | Long-running busy state. Capture pane to confirm legit progress (long doc-write, large compile, multi-step subagent). If pane shows real progress → re-arm, false alarm. If genuinely stuck → halt + ping. |
| `STALL state=idle duration=Ns` | **Orchestrator is the bottleneck**, not sibling. Sibling has been waiting on you. Capture pane: (a) if sibling self-issued `CLEAR` and staged `/tmp/orchestrate-next.txt` → auto-dispatch immediately (do NOT ping vjt — autopilot mandate), (b) if sibling left a free-form question or design choice → ping vjt with the question, (c) if sibling looks done with nothing pending → ping vjt to ask "next?". Don't just re-arm and wait — STALL idle MEANS act now. |
| `HEARTBEAT state=<...>` | Long quiet period (≥600s no event). Capture pane to confirm legit progress vs invisible deadlock; re-arm |
| `PANE-MISSING` | Halt + ping user. Daemon has exited — manual restart needed. |

On IDLE event:

1. Capture: `tmux capture-pane -t <PANE_ID> -p | tail -50`
2. Inspect last assistant message. Categorize:

   | Pane state | Action |
   |------------|--------|
   | Step landed cleanly + offers next step from plan order | Ask clear |
   | Sibling already self-issued `CLEAR` + staged `/tmp/orchestrate-next.txt` | Skip the ask, go straight to clear-and-dispatch |
   | Session asks design question (X vs Y, which approach?) | **Halt + ping user** (note: should have been caught by `PICKER` event; if a free-form ask shows up post-IDLE the picker detector missed it — investigate) |
   | Plan deviation (sub-task skipped or reordered without OK) | **Halt + ping user** |
   | Codebase review gate fires (per CLAUDE.md threshold) | **Halt + ping user** |
   | Background agents still running (e.g. parallel review agents — `general-purpose` / `Plan` row visible) | False idle — ignore, re-arm |
   | User typed in pane directly | Watching only — don't intervene |

   Live deploys / pushes / shared-infra writes default to halt; if the user has explicitly authorized autopilot for the run, treat them as plan-aligned and let sibling proceed.

3. **Ask clear** path: send to pane:
   ```
   orchestrator: same drill before <next step>. /clear or no? if yes WRITE the full prompt body (fully self-contained for /clear, no auto-summary safety net — explicit file paths + commit SHAs + first action) to /tmp/orchestrate-next.txt and reply with literally "CLEAR". if no reply with literally "NO CLEAR". do NOT print the body inline in chat.
   ```

   **Why file handoff, not pane scrape:** the prompt body is large + can be many KB. Going through tmux scrollback (sibling prints body → orchestrator captures → reconstructs from line-wrap → loads into paste-buffer → pastes back) is fragile (line-wrap concat ambiguity, ANSI artifacts, `<system-reminder>` bleed) and bloats both sessions' context. File handoff: sibling Writes once, orchestrator instructs sibling to Read it post-clear. Zero paste-buffer, zero scraping.

4. On reply:
   - Reply contains literal `NO CLEAR` → send `go on with <next step> per plan.`
   - Reply contains literal `CLEAR` → run `/clear`, then send a short directive: `read /tmp/orchestrate-next.txt and execute it.` Sibling Reads + acts. No paste-buffer.

   The 5s tick (was 20s, was 60s in v1) catches fast NO-CLEAR / CLEAR replies near-instantly — you'll get the IDLE event within ~10s of the sibling answering.

5. Always re-arm `wait-for-event.sh` before returning. (Fail-soft: even if you forget, the daemon keeps ticking; next call to `wait-for-event.sh` resumes from cursor with all queued events.)

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

The daemon at `/tmp/orchestrate-daemon-<pane>.pid` runs independently of the orchestrator's Claude session. State + cursor + event log persist in `/tmp`. The user clears the orchestrator session freely to save tokens. On `/orchestrate` invocation post-`/clear`:

1. Run `lib/resume-check.sh <PANE_ID>`. Branch on output:
   - `RESUMING daemon=running` → daemon kept ticking. Skip to step 4.
   - `RESUMING daemon=stopped` → state file fresh but daemon died. Restart: `lib/daemon.sh start <PANE>`. Cursor preserved.
   - `STALE` → daemon is gone or never ran. Treat as fresh: Setup Step 2.
   - `FRESH` → first invocation: Setup Step 2.
2. Re-read the active plan + active CP so you have the "as planned" frame again.
3. Query current state: `lib/state.sh <PANE>` — gives you ground truth (state, ctx, last_state_change age, etc.) without consuming events.
4. Capture pane once for orientation: `tmux capture-pane -t <PANE_ID> -p | tail -40`.
5. Arm `wait-for-event.sh`. **Any events queued during the no-orchestrator window will all be dumped on first call** (cursor-tracked). Process each in order.

The daemon-survives-clear design eliminates the v1 silent-stall failure mode: if the orchestrator forgets to re-arm `wait-for-event.sh`, events still accumulate; next call picks them up.

## Pitfalls (learned in S29 of CP07 + CP08/CP09 Phase 2/3 + CP10 S6 + visitor-parity cluster v2 rewrite)

- **Don't interrupt the session mid-generation.** If the sibling is still writing the prompt body and you ask another question, you destroy the prompt. Wait for full IDLE.
- **Spinner words vary wildly.** Cooked, Crunched, Sautéed, Churned, Baked, Cogitated, Worked, Whipped, Brewing, Stewed, Boondoggling, Mulling, Quantumizing, Forging, Spinning, Befuddling, Undulating, Zigzagging, Proofing, Osmosing, Transfiguring, Crystallizing, Reticulating, Billowing, Calculating, Discombobulating, Imagining, Hullaballooing, Pouncing, Channeling, Spelunking, Thundering, Smooshing — don't match words; match the spinner shape `… (` paired with parenthesized status.
- **Bare `…` is NOT a busy signal.** Truncated task descriptions (`tok…`, `M3, H11, M2, M12 — already organic…`), task-list compaction (`… +N completed`, `… +N pending`), and sibling-printed punctuation all carry `…` while the session is fully idle. The fixed regex requires `… (` (ellipsis + space + open-paren) on the same line. The earlier "match `…` ellipsis, not specific words" rule (CP08-era) was too loose — fixed CP10 S6 after a stalled sibling reported BUSY for ~30 min while truly idle.
- **Permission prompts and design pickers are NOT idle states.** v1 conflated them with IDLE → orchestrator would try to clear sibling mid-prompt or send keys to dismiss the modal. v2 detects them as `PROMPT-PENDING` / `PICKER` events with their own halt semantics. If you ever add a new modal class to Claude Code (multi-step wizard, inline diff confirm, etc.), extend `wakeup-tick.sh` to detect it.
- **`paste again to expand` is just a hint**, not an error. (Legacy paste-buffer path only — file handoff avoids the warning entirely.)
- **`/clear` confirmed by `🧠 TBD` in status line** (fresh conversation, no tokens). After the sibling Reads the prompt file and starts working, ctx jumps to a small % (e.g. 5–10%), confirming turn 1 landed in a clean session. If you still see the pre-clear ctx %, `/clear` didn't fire — re-run the sequence.
- **Background agents leave the spinner gone but work continues.** If pane shows `N local agents` or task list with `◻`/`◼` items, it's a false idle even if no spinner is up. Don't propose clear, wait. With the v2 busy detector this is mostly handled (no spurious BUSY) but the IDLE event after the agents finish IS the right signal — just don't act if you see active agent rows.
- **Halt at human-required steps** even on autopilot. iPhone/device tests, explicit user-tagged tasks (`◼ HALT for ...`), real-credential operations the user hasn't pre-authorized.
- **Self-contained prompt files only.** With `/compact` an auto-summary covers gaps. With `/clear`, the prompt body in `/tmp/orchestrate-next.txt` is the ENTIRE context the sibling has after wipe. Sibling MUST bake in: every sub-task SHA so far, file paths, exact first action, all carried-forward state from any "deferred to next sub-task" notes. Tell sibling that explicitly when asking for the file.
- **Daemon survives orchestrator restarts but NOT host reboots.** State + log + pid file in `/tmp` — fine across `/clear` + `/exit` + harness restart. If the box reboots, `/tmp` may be wiped (depends on OS); resume-check returns FRESH and you start over. Not a bug, just a constraint.
- **Sibling can stash YOUR working-tree changes during its own deploy.** Visitor-parity V9 cluster: orchestrator was rewriting `lib/orchestrate/*` while sibling was prepping V9 deploy from a clean tree; sibling correctly stashed orchestrator's changes as `orchestrator-infra-pre-v9-deploy`. Untracked new files were lost (default `git stash` skips untracked — use `-u` if you care). Fix: stage + commit infra changes onto a separate branch BEFORE letting sibling deploy, OR pause infra work during sibling's deploy windows.
- **Stale task IDs surface back as notifications.** The harness sometimes re-fires completion events for old `task-id`s. Don't treat them as new events — verify the cursor advanced before processing. v2 cursor-tracking makes this safe (re-reading the same byte range yields nothing).
- **Recurring same-triplet flake = real regression**, not flake (per `feedback_recurring_e2e_not_flake`). The visitor-parity cluster failed CI on the SAME 2 specs (network-circuit-ets-leak + push-server-fires-30s) for 6+ buckets in a row. Each bucket "documented as pre-existing flake and proceeded" — this is exactly the retry-mask pattern the rule warns against. Halt + investigate after the SECOND consecutive recurrence, not the sixth.
- **`STALL state=idle` means YOU forgot to dispatch.** Don't ping vjt with "sibling stalled" — sibling is waiting on you. If the pane shows sibling's `CLEAR` + a staged `/tmp/orchestrate-next.txt`, auto-dispatch immediately under the autopilot mandate. Origin: visitor-parity cluster CLOSE → Images dispatch — orchestrator pinged vjt twice asking "Images dispatch a/b/c?" while sibling sat idle for 600+ seconds. The autopilot rule from cluster open already covered "dispatch staged next-cluster prompts without asking" — STALL idle is the signal that you missed the cue.
