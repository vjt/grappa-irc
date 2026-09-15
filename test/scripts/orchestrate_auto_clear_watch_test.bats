#!/usr/bin/env bats
#
# .claude/skills/orchestrate/lib/auto-clear-watch.sh — the pane binding (#1761).
#
# The watchdog used to re-grep the pane TITLE on every tick and, when the
# grep came back empty, `continue` with no log line at all. Claude Code
# renames a pane to the conversation's topic while the session runs, so
# the moment the topic changed the watch stopped watching — while `status`
# still said `running` with a live pid. Observed twice; once bound to an
# unrelated pane (`%5`), which is worse than dead because it lies.
#
# So these cases are about OBSERVABILITY, not about resolution:
#
#   1. a rename under the watch must not blind it (the id is pinned at
#      start, and a title is not ours to rely on);
#   2. every state in which the watchdog CANNOT SEE must be recorded —
#      there are three of them, and all three used to be a bare
#      `continue`. Recorded as a TRANSITION (in and out), not as one line
#      per tick: a line every 15s buries the transition it is supposed to
#      announce;
#   3. `status` must name the pane it is bound to and DERIVE, live,
#      whether it can still read it. `running` without a pane id is
#      exactly how the `%5` misbinding survived, and a status that
#      reported a remembered state would be one more thing that can go
#      stale.
#
# ...and, since issue 2214, a fourth: the number it reads must be the
# BOUND PANE'S OWN. A watch can be alive, bound to the right pane and
# reading it fine, and still act on somebody else's percentage — which
# is the same failure dressed differently, because it too ends in a live
# pid that never fires.
#
# tmux is stubbed on PATH: the pane table lives in $PANES (TAB-separated
# `%id<TAB>title`) and each pane's screen in $STATE/cap-<n>, so a case can
# rename a pane, delete it, or change the rendered context percentage
# while the watchdog is mid-flight. A real tmux server is not available on
# a worker host anyway (measured: the pane is on the ssh client side).
#
# The suite never uses the real "grappa-orch" title: PIDFILE/LOGFILE/
# PANEFILE are derived from it under /tmp, and a case that used it would
# clobber the operator's live watchdog state.

load ../bats_helpers

setup() {
    WATCH="$BATS_TEST_DIRNAME/../../.claude/skills/orchestrate/lib/auto-clear-watch.sh"

    # Unique per test file+case so a stray /tmp file cannot leak between
    # cases, and the real watchdog's slug can never be hit.
    TITLE="bats-1761-${BATS_SUITE_TEST_NUMBER}"
    SLUG="$(printf '%s' "$TITLE" | tr -c 'a-zA-Z0-9' '-')"
    PIDFILE="/tmp/orchestrate-autoclear-${SLUG}.pid"
    LOGFILE="/tmp/orchestrate-autoclear-${SLUG}.log"
    rm -f "$PIDFILE" "$LOGFILE" "/tmp/orchestrate-autoclear-${SLUG}."*

    STATE="$BATS_TEST_TMPDIR/state"
    mkdir -p "$STATE"
    export STATE
    PANES="$STATE/panes"
    : > "$PANES"
    export PANES

    FAKE_DIR="$BATS_TEST_TMPDIR/fake"
    mkdir -p "$FAKE_DIR"

    # A tmux that answers from $PANES and $STATE/cap-<n>. capture-pane
    # FAILS for a pane that is not in the table — that non-zero is how the
    # real thing reports "can't find pane", and the watchdog reads it.
    cat > "$FAKE_DIR/tmux" <<'EOF'
#!/bin/sh
sub="$1"; shift
case "$sub" in
list-panes)
    fmt=""
    while [ $# -gt 0 ]; do
        case "$1" in
        -F) fmt="$2"; shift 2 ;;
        *)  shift ;;
        esac
    done
    if [ "$fmt" = '#{pane_id}' ]; then
        awk -F'\t' 'NF {print $1}' "$PANES"
    else
        awk -F'\t' 'NF {printf "%s %s\n", $1, $2}' "$PANES"
    fi
    ;;
capture-pane)
    target=""
    while [ $# -gt 0 ]; do
        case "$1" in
        -t) target="$2"; shift 2 ;;
        *)  shift ;;
        esac
    done
    awk -F'\t' -v want="$target" 'NF && $1 == want {found=1} END {exit !found}' "$PANES" \
        || { echo "can't find pane: $target" >&2; exit 1; }
    capfile="$STATE/cap-$(printf '%s' "$target" | tr -d '%')"
    [ -f "$capfile" ] && cat "$capfile"
    ;;
send-keys)
    printf 'send-keys %s\n' "$*" >> "$STATE/keys.log"
    ;;
esac
exit 0
EOF
    chmod +x "$FAKE_DIR/tmux"
    export PATH="$FAKE_DIR:$PATH"

    # tmux is inherited by the forked watchdog, so the knobs must be too.
    export AUTOCLEAR_TICK=1
    # High enough that no case ever reaches the send-keys/clear path: this
    # suite is about what the loop OBSERVES, not about firing.
    export AUTOCLEAR_IDLE_TICKS=99
    export AUTOCLEAR_THRESHOLD=40

    # $TMUX_PANE is NOT set in a Claude Bash-tool environment (measured on
    # the worker harness), so no case may inherit one from the runner.
    unset TMUX_PANE
}

teardown() {
    if [ -f "$PIDFILE" ]; then
        kill "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null || true
    fi
    rm -f "/tmp/orchestrate-autoclear-${SLUG}."*
}

# --- helpers -----------------------------------------------------------------

add_pane() { printf '%s\t%s\n' "$1" "$2" >> "$PANES"; }

rename_pane() {
    local id="$1" new="$2" tmp="$PANES.tmp"
    awk -F'\t' -v id="$id" -v new="$new" \
        'NF { if ($1 == id) printf "%s\t%s\n", $1, new; else print }' "$PANES" > "$tmp"
    mv "$tmp" "$PANES"
}

kill_pane() {
    local id="$1" tmp="$PANES.tmp"
    awk -F'\t' -v id="$id" 'NF && $1 != id' "$PANES" > "$tmp"
    mv "$tmp" "$PANES"
}

# An idle Claude pane rendering a context percentage above the threshold:
# qualifying, so the loop logs a progress line on every tick.
render_idle_at() {
    printf 'some scrollback\n🧠 %s%% context left\n❯ \n' "$2" > "$STATE/cap-$(printf '%s' "$1" | tr -d '%')"
}

# The same, but with OTHER panes' status lines sitting in the scrollback
# above it (issue 2214).
#
# This is the orchestrator pane's ordinary shape, not a contrived one: it
# samples its workers by capturing THEIR panes, so their status lines land
# in ITS buffer as ordinary command output. They are scrollback, so they
# are ABOVE the live status block the UI keeps pinned at the bottom.
# Measured on 2026-09-15: eight foreign markers in 200 lines of the
# orchestrator pane, and the watch reported one of them (7%) while the
# pane itself read 39% — one point under its own firing threshold.
#
# A pane with a CLEAN scrollback does not measure this: it is exactly the
# case in which the broken parse is right by accident.
render_idle_at_below_foreign() {
    local capfile; capfile="$STATE/cap-$(printf '%s' "$1" | tr -d '%')"
    {
        printf '$ tmux capture-pane -t %%16 -p | tail -3\n'
        printf '🧠 7%% context left\n'
        printf '$ tmux capture-pane -t %%28 -p | tail -3\n'
        printf '🧠 90%% context left\n'
        printf 'some scrollback\n'
        printf '🧠 %s%% context left\n' "$2"
        printf '❯ \n'
    } > "$capfile"
}

count_in_log() { grep -c "$1" "$LOGFILE" 2>/dev/null || true; }

# Ticks are 1s; give the loop room for a few without racing a slow box.
wait_ticks() { sleep "$1"; }

# --- binding at start --------------------------------------------------------

@test "start names the pane it bound, so it can be checked against the real one" {
    add_pane '%3' "$TITLE — some topic"
    render_idle_at '%3' 55

    run "$WATCH" start "$TITLE"

    [ "$status" -eq 0 ]
    # WHICH pane, not just "started". The %5 misbinding survived precisely
    # because nothing ever printed the id.
    [[ "$output" == *"%3"* ]]
}

@test "start refuses, loudly, when no pane title matches" {
    add_pane '%3' 'unrelated shell'

    run "$WATCH" start "$TITLE"

    # Starting a watchdog that can never resolve is the silence itself.
    [ "$status" -ne 0 ]
    [[ "$output" == *"$TITLE"* ]]
    refute test -f "$PIDFILE"
}

@test "start refuses when the title is AMBIGUOUS instead of taking the first" {
    add_pane '%3' "$TITLE — orchestrator"
    add_pane '%5' "$TITLE — a second one"

    run "$WATCH" start "$TITLE"

    # `head -1` over two matches is an arbitrary binding presented as a
    # resolved one — the shape of the %5 report.
    [ "$status" -ne 0 ]
    [[ "$output" == *"%3"* ]]
    [[ "$output" == *"%5"* ]]
    refute test -f "$PIDFILE"
}

@test "--pane binds explicitly and does not consult the title at all" {
    add_pane '%7' 'a pane whose title says nothing about the watch'
    render_idle_at '%7' 55

    run "$WATCH" start "$TITLE" --pane '%7'

    [ "$status" -eq 0 ]
    [[ "$output" == *"%7"* ]]
}

@test "--pane naming a pane that does not exist is refused, not accepted" {
    add_pane '%3' "$TITLE"

    run "$WATCH" start "$TITLE" --pane '%99'

    [ "$status" -ne 0 ]
    [[ "$output" == *"%99"* ]]
    refute test -f "$PIDFILE"
}

# --- the defect: a rename under the watch ------------------------------------

@test "a RENAME under the watch does not blind it (#1761)" {
    add_pane '%3' "$TITLE — orchestrator"
    render_idle_at '%3' 55

    "$WATCH" start "$TITLE"
    wait_ticks 3

    local before; before="$(count_in_log 'idle+quiet')"
    [ "$before" -ge 1 ]

    # Claude Code renames the pane to the conversation topic mid-session.
    rename_pane '%3' 'reviewing the scrollback pagination bug'
    wait_ticks 3

    local after; after="$(count_in_log 'idle+quiet')"
    # The observation must CONTINUE. Before #1761 the title grep came back
    # empty here and the loop went quiet for good.
    [ "$after" -gt "$before" ]
}

# --- the reverse: a pinned pane that dies must not be a second silence -------

@test "a pane that DISAPPEARS is logged — once, on the transition (#1761)" {
    add_pane '%3' "$TITLE — orchestrator"
    render_idle_at '%3' 55

    "$WATCH" start "$TITLE"
    wait_ticks 2

    kill_pane '%3'
    wait_ticks 5

    # It must SAY it (the bare `continue` said nothing at all)...
    local blind; blind="$(count_in_log 'BLIND')"
    [ "$blind" -eq 1 ]
    grep -q 'GONE' "$LOGFILE"
    # ...and exactly once over five ticks. A line every tick buries the
    # transition and trains the reader to skip the file; `status` is the
    # surface that answers "still blind?" on demand.
}

@test "a pane that renders no context marker is logged, not silently skipped" {
    add_pane '%3' "$TITLE — orchestrator"
    # A pane that is not a Claude session at all — the %5 misbinding's
    # observable. No 🧠 marker anywhere.
    printf 'total 0\ndrwxr-xr-x  mbarnaba  staff\n❯ \n' > "$STATE/cap-3"

    "$WATCH" start "$TITLE"
    wait_ticks 4

    local blind; blind="$(count_in_log 'BLIND')"
    [ "$blind" -eq 1 ]
    grep -q 'context marker' "$LOGFILE"
}

@test "coming back from blind is logged too, so tail -4 is not stale" {
    add_pane '%3' "$TITLE — orchestrator"
    render_idle_at '%3' 55

    "$WATCH" start "$TITLE"
    wait_ticks 2
    kill_pane '%3'
    wait_ticks 3

    [ "$(count_in_log 'BLIND')" -eq 1 ]
    [ "$(count_in_log 'RECOVERED')" -eq 0 ]

    # Without the exit transition, a log whose last line is BLIND reads as
    # "still blind" forever after the watch has recovered.
    add_pane '%3' 'some entirely new topic'
    wait_ticks 3

    [ "$(count_in_log 'RECOVERED')" -eq 1 ]
}

# --- the defect: a FOREIGN status line in the scrollback (issue 2214) ---------

@test "the loop reads the BOUND pane's own context, not a foreign one above it" {
    add_pane '%3' "$TITLE — orchestrator"
    render_idle_at_below_foreign '%3' 55

    "$WATCH" start "$TITLE"
    wait_ticks 3

    # The defended assertion: the number the loop ACTS on is the pane's.
    # Reading the first marker in the buffer picks 7%, which is under the
    # threshold, so the loop goes quiet and logs nothing at all — a
    # watchdog that never fires is indistinguishable from a calm session.
    [ "$(count_in_log 'ctx=55%')" -ge 1 ]
    # 90% is ABOVE the threshold, so these two arms cannot be satisfied by
    # a loop that merely stayed silent: a parse that picked either foreign
    # marker would have logged it.
    [ "$(count_in_log 'ctx=90%')" -eq 0 ]
    [ "$(count_in_log 'ctx=7%')" -eq 0 ]
}

@test "status reports the BOUND pane's own context, not a foreign one above it" {
    add_pane '%3' "$TITLE — orchestrator"
    render_idle_at_below_foreign '%3' 55

    "$WATCH" start "$TITLE"

    run "$WATCH" status "$TITLE"

    [ "$status" -eq 0 ]
    # `watching (ctx=NN%)` is printed by status ALONE — matching a bare
    # `ctx=55%` would also be satisfied by the log tail status appends,
    # which is the loop's observation and not this one.
    [[ "$output" == *"watching (ctx=55%)"* ]]
    refute grep -qF 'watching (ctx=7%)' <<<"$output"
    refute grep -qF 'watching (ctx=90%)' <<<"$output"
}

# --- status ------------------------------------------------------------------

@test "status names the pane it is watching" {
    add_pane '%3' "$TITLE — orchestrator"
    render_idle_at '%3' 55

    "$WATCH" start "$TITLE"

    run "$WATCH" status "$TITLE"

    [ "$status" -eq 0 ]
    [[ "$output" == *"running"* ]]
    # Without this the operator cannot compare the binding with reality.
    [[ "$output" == *"%3"* ]]
}

@test "status says the bound pane is GONE rather than just running" {
    add_pane '%3' "$TITLE — orchestrator"
    render_idle_at '%3' 55

    "$WATCH" start "$TITLE"
    kill_pane '%3'

    run "$WATCH" status "$TITLE"

    # A live pid on a dead pane is the lie the issue was filed about.
    [[ "$output" == *"%3"* ]]
    [[ "$output" == *"GONE"* ]]
}

@test "status DERIVES blindness live, it does not report a remembered state" {
    add_pane '%3' "$TITLE — orchestrator"
    render_idle_at '%3' 55

    "$WATCH" start "$TITLE"

    # The pane still EXISTS, so an existence check alone would call this
    # healthy. It stopped being a Claude pane — the %5 shape exactly.
    printf 'total 0\ndrwxr-xr-x  mbarnaba  staff\n❯ \n' > "$STATE/cap-3"

    run "$WATCH" status "$TITLE"

    [[ "$output" == *"%3"* ]]
    [[ "$output" == *"BLIND"* ]]
    [[ "$output" == *"context marker"* ]]
}
