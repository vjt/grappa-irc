#!/usr/bin/env bash
# Attach observer_cli to the LIVE grappa node.
#
# observer_cli is a TUI-based runtime introspection tool. From here you can
# see every supervised process, mailbox depth, memory, scheduler load, etc.
# of the RUNNING system. It's the BEAM equivalent of htop+strace+tokio-
# console combined.
#
# Usage:
#   scripts/observer.sh
#
# #364 docker S2: this used to run `in_container iex -S mix run -e
# ':observer_cli.start()'`, which was doubly broken —
#   (1) `iex -S mix` boots a SECOND full Grappa.Application (duplicate
#       Session.Servers + upstream IRC connections, sqlite WAL contention),
#       and observer_cli then introspected THAT freshly-booted node, not
#       the live one — defeating its whole purpose;
#   (2) `in_container` = `docker compose exec -T` gave the TUI no TTY.
#
# The fix: a THROWAWAY local node (obs-$$) that runs observer_cli AGAINST
# the live node over Erlang distribution. `mix run --no-start --no-compile`
# loads the project + deps code path (so `:observer_cli` resolves — it is
# an `only: [:dev]` dep, compiled into the dev container's _build) WITHOUT
# starting Grappa.Application, so no second app boots and no sqlite handle
# is opened. observer_cli.start/1 then connects to grappa@grappa and
# renders the LIVE supervision tree on this (interactive, TTY-full)
# terminal. RELEASE_COOKIE + the node name are expanded INSIDE the
# container's `sh -c`, matching bin/grappa remote-shell.
#
# Requires the dev image (MIX_ENV=dev): observer_cli is `only: [:dev]`, so
# this does not work against a prod-profile container.

. "$(dirname "$0")/_lib.sh"

cd "$REPO_ROOT"

exec docker compose "${COMPOSE_ARGS[@]}" exec grappa sh -c \
    'exec iex --sname "obs-$$" --cookie "$RELEASE_COOKIE" -S mix run --no-start --no-compile -e "$1"' \
    -- ':observer_cli.start(:"grappa@grappa")'
