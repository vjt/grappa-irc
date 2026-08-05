#!/bin/sh
# version.sh — echo grappa's single canonical version to stdout.
#
# THE single source of truth for the version across every carrier is the
# repo-root `VERSION` file (#652, was mix.exs `@version` under #538).
# Everything else DERIVES from it — there is no second hand-edited copy:
#
#   * mix.exs + lib/grappa/version.ex read the SAME file at COMPILE time
#     (baked into the beam so a bump hot-reloads instead of forcing COLD);
#   * build.sh sources this to export GRAPPA_VERSION, which nfpm.yaml
#     interpolates into the .deb (and, once #438 lands, the .rpm);
#   * release.yml's Arch job + aur/regen.sh run this to fill PKGBUILD's
#     `@GRAPPA_VERSION@` pkgver sentinel before makepkg;
#   * every cic build entrypoint (scripts/bun.sh, the compose cicchetto-build
#     launchers, the Arch/FreeBSD/Linux prod builds) exports GRAPPA_VERSION
#     from this so vite bakes it into <meta cicchetto-version> — the container
#     builds mount only ./cicchetto and cannot read the repo root themselves.
#
# POSIX sh, NOT bash: the FreeBSD jail build (infra/freebsd/jail_cic_build.sh)
# runs /bin/sh with no bash/bun port and calls this to derive the version.
# Always EXECUTED (never sourced), so `$0` locates the script.
#
# Bump the version by editing the repo-root `VERSION` file — nothing else.
set -eu

# No `dirname --` / `cd --`: BSD dirname (the FreeBSD jail) doesn't accept the
# end-of-options `--`, and $0 is always an invoked path (never starts with -).
#
# `CDPATH= cd` is an env-prefixed command (clear CDPATH for this cd only), not
# a botched assignment — shellcheck's SC1007 heuristic cannot tell the two
# apart, and the prefix form is the portable way to keep a user's CDPATH from
# teleporting `cd` somewhere else and silently mis-rooting the repo.
# shellcheck disable=SC1007
SCRIPT_DIR="$(CDPATH= cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1007
REPO_ROOT="$(CDPATH= cd "${SCRIPT_DIR}/../.." && pwd)"

# `head -1` + `tr -d` strips any trailing newline / CR the file carries so the
# echoed value is a bare `X.Y.Z` (git-checked-out with LF, but be defensive).
version="$(head -1 "${REPO_ROOT}/VERSION" 2>/dev/null | tr -d '\r\n')"
if [ -z "${version}" ]; then
	printf 'version.sh: could not read version from %s/VERSION\n' "${REPO_ROOT}" >&2
	exit 1
fi
printf '%s\n' "${version}"
