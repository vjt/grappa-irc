#!/usr/bin/env bats
#
# .claude/skills/orchestrate/lib/auto-clear-watch.sh — finding the pane by
# its tmux `@role` user option, on every tick.
#
# Two bindings came before this one, and each typed into, or ignored, the
# wrong pane on one axis:
#
#   - the TITLE (re-grepped per tick): Claude Code renames its pane to the
#     conversation topic, so the watch went silently dead (#1761);
#   - the pane ID (pinned at start, #1761's cure): ids are reused by the
#     next tmux server. On 2026-11-27 the Pi's tmux restarted, `%6` came back
#     as an unrelated Claude session, and the watch typed RESUME TICKs into it.
#
# So these cases are about WHERE KEYS GO and WHAT THE WATCH SAYS:
#
#   1. keys go only to the one pane carrying the role — never to a pane that
#      merely holds an old id, never to a neighbour, never to one of several;
#   2. every state in which the watchdog CANNOT SEE is recorded as a
#      TRANSITION (in and out), not as one line per tick;
#   3. `status` names the pane and DERIVES, live, whether it can read it;
#   4. the number it reads is the pane's OWN (issue 2214).
#
# tmux is stubbed on PATH: the pane table lives in $PANES (TAB-separated
# `%id<TAB>role`, role empty when unset) and each pane's screen in
# $STATE/cap-<n>. The stub records every list-panes format it is asked for,
# so a regression back to reading titles is visible.
#
# The suite never uses the real "grappa-orch" role: PIDFILE/LOGFILE are
# derived from it under /tmp, and a case that used it would clobber the
# operator's live watchdog state.

load ../bats_helpers

setup() {
    WATCH="$BATS_TEST_DIRNAME/../../.claude/skills/orchestrate/lib/auto-clear-watch.sh"

    ROLE="bats-role-${BATS_SUITE_TEST_NUMBER}"
    SLUG="$(printf '%s' "$ROLE" | tr -c 'a-zA-Z0-9' '-')"
    PIDFILE="/tmp/orchestrate-autoclear-${SLUG}.pid"
    LOGFILE="/tmp/orchestrate-autoclear-${SLUG}.log"
    rm -f "/tmp/orchestrate-autoclear-${SLUG}."*

    STATE="$BATS_TEST_TMPDIR/state"
    mkdir -p "$STATE"
    export STATE
    PANES="$STATE/panes"
    : > "$PANES"
    export PANES
    KEYS="$STATE/keys.log"
    : > "$KEYS"

    FAKE_DIR="$BATS_TEST_TMPDIR/fake"
    mkdir -p "$FAKE_DIR"

    # list-panes answers ONLY the role format; anything else is a loud
    # failure. capture-pane FAILS for a pane not in the table — that non-zero
    # is how the real thing reports "can't find pane".
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
    printf '%s\n' "$fmt" >> "$STATE/formats.log"
    [ "$fmt" = '#{pane_id} #{@role}' ] || { echo "fake tmux: unexpected format '$fmt'" >&2; exit 3; }
    awk -F'\t' 'NF {printf "%s %s\n", $1, $2}' "$PANES"
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

    export AUTOCLEAR_TICK=1
    # High enough that no case reaches the /clear path: firing is not what
    # this suite is about.
    export AUTOCLEAR_IDLE_TICKS=99
    export AUTOCLEAR_THRESHOLD=40
}

teardown() {
    if [ -f "$PIDFILE" ]; then
        kill "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null || true
    fi
    rm -f "/tmp/orchestrate-autoclear-${SLUG}."*
}

# --- helpers -----------------------------------------------------------------

# add_pane %id [role]
add_pane() { printf '%s\t%s\n' "$1" "${2:-}" >> "$PANES"; }

set_role() {
    local id="$1" role="$2" tmp="$PANES.tmp"
    awk -F'\t' -v id="$id" -v role="$role" \
        'NF { if ($1 == id) printf "%s\t%s\n", $1, role; else print }' "$PANES" > "$tmp"
    mv "$tmp" "$PANES"
}

kill_pane() {
    local id="$1" tmp="$PANES.tmp"
    awk -F'\t' -v id="$id" 'NF && $1 != id' "$PANES" > "$tmp"
    mv "$tmp" "$PANES"
}

# An idle Claude pane rendering a context percentage.
render_idle_at() {
    printf 'some scrollback\n🧠 %s%% context left\n❯ \n' "$2" > "$STATE/cap-$(printf '%s' "$1" | tr -d '%')"
}

# The same, with OTHER panes' status lines in the scrollback above it (issue
# 2214) — the orchestrator pane's ordinary shape, since it samples its
# workers by capturing their panes. Measured 2026-09-15: the watch reported
# a foreign 7% while the pane read 39%. A CLEAN scrollback cannot measure
# this: it is the case in which the broken parse is right by accident.
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
keys_to() { grep -c -- "-t $1 " "$KEYS" 2>/dev/null || true; }

# Ticks are 1s; give the loop room for a few without racing a slow box.
wait_ticks() { sleep "$1"; }

# Resume nudges after 2s idle, so a case can see where keys would go.
nudge_fast() {
    export AUTOCLEAR_RESUME_IDLE=2
    export AUTOCLEAR_RESUME_COOLDOWN=1
}

# --- where the keys go -------------------------------------------------------

@test "start names the pane carrying the role" {
    add_pane '%3' "$ROLE"
    render_idle_at '%3' 55

    run "$WATCH" start "$ROLE"

    [ "$status" -eq 0 ]
    [[ "$output" == *"pane=%3"* ]]
}

@test "after a tmux restart the old id belongs to a stranger: nothing is typed (2026-11-27)" {
    nudge_fast
    # The incident: the id the orchestrator used to have is now another
    # Claude session, idle, and nobody has set the role on the new server.
    add_pane '%6'
    render_idle_at '%6' 18

    run "$WATCH" start "$ROLE"
    [ "$status" -eq 0 ]
    [[ "$output" == *"BLIND"* ]]
    [[ "$output" == *"no pane carries @role=$ROLE"* ]]
    wait_ticks 5

    [ "$(keys_to '%6')" -eq 0 ]
    [ ! -s "$KEYS" ]
    grep -q 'no pane carries' "$LOGFILE"
}

@test "the nudge goes to the pane carrying the role, never to a neighbour" {
    nudge_fast
    add_pane '%6'
    render_idle_at '%6' 18
    add_pane '%5' "$ROLE"
    render_idle_at '%5' 18

    "$WATCH" start "$ROLE"
    wait_ticks 5

    [ "$(keys_to '%5')" -ge 1 ]
    [ "$(keys_to '%6')" -eq 0 ]
}

@test "when the role moves to another pane, the watch follows and says so" {
    add_pane '%6' "$ROLE"
    render_idle_at '%6' 55
    add_pane '%5'
    render_idle_at '%5' 55

    "$WATCH" start "$ROLE"
    wait_ticks 2
    grep -q 'BOUND to pane %6' "$LOGFILE"

    set_role '%6' ''
    set_role '%5' "$ROLE"
    wait_ticks 3

    grep -q 'BOUND to pane %5 (@role=.*), was %6' "$LOGFILE"
}

@test "several panes carrying the role is BLIND: it never picks one" {
    nudge_fast
    add_pane '%3' "$ROLE"
    render_idle_at '%3' 18
    add_pane '%5' "$ROLE"
    render_idle_at '%5' 18

    "$WATCH" start "$ROLE"
    wait_ticks 5

    [ ! -s "$KEYS" ]
    [ "$(count_in_log 'AMBIGUOUS')" -eq 1 ]
    grep 'AMBIGUOUS' "$LOGFILE" | grep -q '%3'
    grep 'AMBIGUOUS' "$LOGFILE" | grep -q '%5'
}

@test "the watch never reads pane titles" {
    add_pane '%3' "$ROLE"
    render_idle_at '%3' 55

    "$WATCH" start "$ROLE"
    wait_ticks 2
    run "$WATCH" status "$ROLE"

    # Claude Code rewrites titles mid-session; a title in the lookup is the
    # #1761 failure coming back.
    refute grep -q 'pane_title' "$STATE/formats.log"
}

# --- the blind states, as transitions -----------------------------------------

@test "a role that DISAPPEARS is logged — once, on the transition" {
    add_pane '%3' "$ROLE"
    render_idle_at '%3' 55

    "$WATCH" start "$ROLE"
    wait_ticks 2

    kill_pane '%3'
    wait_ticks 5

    [ "$(count_in_log 'BLIND')" -eq 1 ]
    grep -q 'no pane carries' "$LOGFILE"
}

@test "a pane that renders no context marker is logged, not silently skipped" {
    add_pane '%3' "$ROLE"
    printf 'total 0\ndrwxr-xr-x  mbarnaba  staff\n❯ \n' > "$STATE/cap-3"

    "$WATCH" start "$ROLE"
    wait_ticks 4

    [ "$(count_in_log 'BLIND')" -eq 1 ]
    grep -q 'context marker' "$LOGFILE"
}

@test "coming back from blind is logged too, so tail -4 is not stale" {
    add_pane '%3' "$ROLE"
    render_idle_at '%3' 55

    "$WATCH" start "$ROLE"
    wait_ticks 2
    kill_pane '%3'
    wait_ticks 3

    [ "$(count_in_log 'BLIND')" -eq 1 ]
    [ "$(count_in_log 'RECOVERED')" -eq 0 ]

    add_pane '%4' "$ROLE"
    render_idle_at '%4' 55
    wait_ticks 3

    [ "$(count_in_log 'RECOVERED')" -eq 1 ]
}

# --- a FOREIGN status line in the scrollback (issue 2214) ---------------------

@test "the loop reads the pane's own context, not a foreign one above it" {
    add_pane '%3' "$ROLE"
    render_idle_at_below_foreign '%3' 55

    "$WATCH" start "$ROLE"
    wait_ticks 3

    [ "$(count_in_log 'ctx=55%')" -ge 1 ]
    # 90% is ABOVE the threshold, so a parse that picked either foreign
    # marker would have logged it: these arms cannot pass by silence.
    [ "$(count_in_log 'ctx=90%')" -eq 0 ]
    [ "$(count_in_log 'ctx=7%')" -eq 0 ]
}

@test "status reports the pane's own context, not a foreign one above it" {
    add_pane '%3' "$ROLE"
    render_idle_at_below_foreign '%3' 55

    "$WATCH" start "$ROLE"

    run "$WATCH" status "$ROLE"

    [ "$status" -eq 0 ]
    # `watching (ctx=NN%)` is printed by status ALONE; a bare `ctx=55%` would
    # also match the log tail status appends.
    [[ "$output" == *"watching (ctx=55%)"* ]]
    refute grep -qF 'watching (ctx=7%)' <<<"$output"
    refute grep -qF 'watching (ctx=90%)' <<<"$output"
}

# --- status ------------------------------------------------------------------

@test "status names the pane it is watching" {
    add_pane '%3' "$ROLE"
    render_idle_at '%3' 55

    "$WATCH" start "$ROLE"

    run "$WATCH" status "$ROLE"

    [ "$status" -eq 0 ]
    [[ "$output" == *"running"* ]]
    [[ "$output" == *"pane=%3"* ]]
}

@test "status says BLIND when no pane carries the role, rather than just running" {
    add_pane '%3' "$ROLE"
    render_idle_at '%3' 55

    "$WATCH" start "$ROLE"
    set_role '%3' ''

    run "$WATCH" status "$ROLE"

    [[ "$output" == *"BLIND"* ]]
    [[ "$output" == *"no pane carries"* ]]
}

@test "status DERIVES blindness live, it does not report a remembered state" {
    add_pane '%3' "$ROLE"
    render_idle_at '%3' 55

    "$WATCH" start "$ROLE"

    # The pane still carries the role, so a lookup alone would call this
    # healthy. It stopped being a Claude pane.
    printf 'total 0\ndrwxr-xr-x  mbarnaba  staff\n❯ \n' > "$STATE/cap-3"

    run "$WATCH" status "$ROLE"

    [[ "$output" == *"%3"* ]]
    [[ "$output" == *"BLIND"* ]]
    [[ "$output" == *"context marker"* ]]
}
