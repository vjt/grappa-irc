#!/usr/bin/env bash
# Open an IEx shell inside the running grappa container.
#
# Usage:
#   scripts/iex.sh                # iex -S mix (loads project)
#
# Post-CP23 the image is single-stage `mix phx.server` everywhere, so
# `iex -S mix` is the only attach path — `bin/grappa remote` is gone
# along with `mix release`.

. "$(dirname "$0")/_lib.sh"

cd "$REPO_ROOT"

docker compose "${COMPOSE_ARGS[@]}" exec grappa iex -S mix
