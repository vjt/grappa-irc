#!/usr/bin/env bash
# Attach an interactive IEx shell to the LIVE grappa node via Erlang
# distribution (remsh).
#
# Usage:
#   scripts/iex.sh                      # iex --remsh into the running node
#   scripts/iex.sh --batch -e '<expr>'  # eval one expr on the live node
#
# #364 docker S2: this used to run `iex -S mix`, which boots a WHOLE NEW
# Grappa.Application inside the container — Bootstrap re-reads the DB
# credentials and spawns a DUPLICATE Session.Server + upstream IRC
# connection per binding (nick collisions upstream), and the second node
# contends with the live one for the same sqlite WAL ("Database busy").
# The correct attach path already exists: `bin/grappa remote-shell` (T-2 —
# `iex --remsh grappa@grappa` gated by RELEASE_COOKIE) joins the LIVE
# node's shell WITHOUT starting a second application. This script is a thin
# alias so the familiar `scripts/iex.sh` entry point keeps working — one
# attach path, one code path (bin/grappa remote-shell).
#
# No worktree guard needed (unlike the old `iex -S mix` code-loading path):
# remsh always attaches to the LIVE node, which runs main's source, so
# there is no "am I poking main or my worktree" ambiguity to warn about.

exec "$(dirname "$0")/../bin/grappa" remote-shell "$@"
