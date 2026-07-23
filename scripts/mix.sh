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

# DATABASE_PATH is read ONLY by config/runtime.exs's prod branch —
# config/{dev,test}.exs hardcode the DB path and ignore the env var. So
# only prod needs an override here: compose.yaml interpolates
# DATABASE_PATH from the HOST's MIX_ENV, which diverges from the env this
# script resolved, and `--env=prod` on a dev host would otherwise
# migrate/read the DEV db (#364 docker S5). Inject the matching prod path
# via the db_path_for_env SoT; leave dev/test to their compile-time
# config (injecting there would be inert theater — and grappa_test.db
# doesn't even match config/test.exs's MIX_TEST_PARTITION suffix).
db_env=()
if [ "$env" = "prod" ]; then
    db_env=(DATABASE_PATH="$(db_path_for_env prod)")
fi
in_container_or_oneshot env MIX_ENV="$env" "${db_env[@]}" mix "$@"
