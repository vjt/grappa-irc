#!/usr/bin/env bash
# Open a sqlite3 shell against the active database.
#
# Usage:
#   scripts/db.sh                 # interactive sqlite3 shell
#   scripts/db.sh "SELECT * FROM messages LIMIT 5;"   # one-shot query
#
# Reads MIX_ENV from the running container to pick the right db file (dev when
# there is none). Prod DBs open read-only. Works from a worktree: the sqlite3
# invocation goes through in_container_or_oneshot, which falls back to a
# oneshot rather than dying (#1409).

# shellcheck source=scripts/_lib.sh
. "$(dirname "$0")/_lib.sh"

cd "$REPO_ROOT"

# `detect_mix_env` is the SoT for this probe (#1409 D-S11). The hand-rolled
# `in_container printenv MIX_ENV 2>/dev/null || echo dev` it replaces was
# broken two ways: it dropped the `tr -d '\r'` normalisation, so a `\r`
# produced a path nothing could open, and `in_container` DIES from a
# worktree — where, by rule, every code change happens. `die` is an
# `exit 1`, and an `exit` inside a command substitution kills the subshell,
# so the `|| echo dev` fallback never ran: the probe came back empty and
# `set -e` ended the script with no message at all, the `die` having gone
# into `2>/dev/null`.
env="$(detect_mix_env)"
# Empty means no container is up. dev is the documented default and is
# applied HERE, in the open, instead of riding a fallback that could not fire.
[ -n "$env" ] || env=dev

# Path shape via the _lib.sh SoT — never hardcode it, or it drifts from
# compose.yaml / scripts/mix.sh (#364).
DB="$(db_path_for_env "$env")"

# An ARRAY, not a quoted scalar: quoting an empty `$MODE_ARG` would hand
# sqlite3 "" as its first argument, which it reads as a filename. Empty
# array expands to nothing, exactly as the unquoted form did by accident.
mode_args=()
if [ "$env" = "prod" ]; then
    mode_args=(-readonly)
fi

# `in_container_or_oneshot`, so the tool CLAUDE.md calls first-resort works
# from the worktree it is meant to be used in.
if [ $# -eq 0 ]; then
    in_container_or_oneshot sqlite3 "${mode_args[@]}" "$DB"
else
    in_container_or_oneshot sqlite3 "${mode_args[@]}" "$DB" "$*"
fi
