#!/usr/bin/env bash
# Run a mix task inside the grappa container.
#
# Usage:
#   scripts/mix.sh deps.get                    # auto-detect MIX_ENV from container
#   scripts/mix.sh --env=dev credo --strict    # explicit env override
#   scripts/mix.sh --env=prod ecto.migrate     # explicit env override
#   scripts/mix.sh --env=test test             # explicit env override
#
# Auto-detect probes `printenv MIX_ENV` inside the live container; if
# no container is up (oneshot path), defaults to dev. Sibling scripts
# that depend on dev-only deps (credo, dialyzer, format, sobelow) MUST
# pass `--env=dev` explicitly because dev-only deps aren't compiled
# into prod images — auto-detect would crash on those.
#
# The --env=<env> flag is recognised only as the FIRST positional arg;
# anywhere else it's passed through verbatim to mix (which will likely
# reject it). Predictable parse path > flexible parse path.

. "$(dirname "$0")/_lib.sh"

cd "$REPO_ROOT"

env=""
if [[ "${1:-}" =~ ^--env=(dev|prod|test)$ ]]; then
    env="${BASH_REMATCH[1]}"
    shift
fi

if [ -z "$env" ]; then
    env="$(detect_mix_env)"
    if [ -z "$env" ]; then
        # Honest log — `feedback_no_silent_drops_closed`. Operator on a
        # prod box who EXPECTED prod must see they got dev. No silent
        # default.
        printf 'scripts/mix.sh: container not running, defaulting MIX_ENV=dev\n' >&2
        env="dev"
    fi
fi

# DATABASE_PATH is injected here (not left to compose.yaml's host-MIX_ENV
# interpolation) so the DB file always matches the env this script
# resolved — otherwise `--env=prod` on a dev host migrates/reads the DEV
# db (#364 docker S5). db_path_for_env is the shell-side SoT for the path
# shape; it must stay identical to compose.yaml's DATABASE_PATH.
in_container_or_oneshot env MIX_ENV="$env" DATABASE_PATH="$(db_path_for_env "$env")" mix "$@"
