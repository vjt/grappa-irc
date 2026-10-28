# shellcheck shell=sh
# infra/lib/bastille_jail.sh — the m42 production jail's bastille NAME (#2022).
#
# SOURCED, never executed. Strict POSIX sh like its siblings in this
# directory: it is read from inside the jail (/bin/sh) as well as from a
# workstation (bash), so no arrays, no `[[ ]]`, no `local`.
#
# ── The fact ────────────────────────────────────────────────────────
# The jail's NAME is `grappa`, and so is its host.hostname — two separate
# settings that happen to agree. They did not always: until 2026-10-28 the
# NAME was `grappa-new` with host.hostname `grappa`, measured on m42 from
# two independent sources (#2022) — `jls -h jid name host.hostname path`
# and `bastille list`. On 2026-10-28 the jail was renamed to `grappa` and
# moved to 14.5-RELEASE-p3 (#2481); host.hostname and the epair names
# (e0a_grappa / e0b_grappa) were already `grappa`.
#
# `bastille cmd`, `bastille restart`, `jexec` and the on-disk jail path all
# take the NAME. Handed the host.hostname instead, they addressed a jail
# that did not exist — which is what every deploy default said until this
# file. (Spelt out rather than quoted: a wrong spelling written here in
# argument position would trip the gate that reads this very constant.)
#
# ── Why a constant and not a derivation ─────────────────────────────
# #2022 suggested deriving the name from `bastille list` / `jls`, on the
# grounds that this was the second name the jail had had (#2481 gave it a
# third). Rejected, for three reasons that are about WHERE the name is
# needed, not about effort:
#
#   1. It is not derivable where it matters most. The sharp edge is the
#      restart hint `infra/freebsd/deploy.sh` prints when the daemon is
#      gone — and that script runs INSIDE the jail. Every `bastille`
#      spelling under infra/freebsd/ is a comment describing the HOST-side
#      invocation; not one of those rails invokes bastille, because bastille
#      is the host's tool for addressing jails from outside. From inside,
#      `hostname` answers the host.hostname — which since #2481 equals the
#      NAME, but answered `grappa` against a NAME of `grappa-new` for the
#      jail's whole earlier life: precisely the wrong token, and precisely
#      the confusion that produced #2022. A derivation that is right only
#      while two independent settings agree is a default in disguise.
#
#   2. Host-side, it only moves the hardcode. To pick this jail out of
#      `bastille list` a script needs a predicate, and the only candidates
#      are the NAME (circular) or the host.hostname — reading the Hostname
#      column is the misreading that opened #2022, and it reads right today
#      only because #2481 made the two columns agree.
#
#   3. Its failure mode is the one we are curing. A derivation that answers
#      nothing (ssh down, jail stopped) must either die or fall back, and a
#      fallback IS a default that can be silently wrong. Worse, the hint
#      printed when production is down would then depend on a query that is
#      likeliest to fail exactly then.
#
# What actually prevents the drift is that the name is written ONCE for
# every consumer that computes with it, and that
# `test/infra/bastille_jail_name_test.bats` proves every remaining literal
# spelling in the live tree — the usage comments, which cannot source a
# variable — agrees with this value. A rename is this line plus whatever
# that gate names; #2481 was exactly that.
#
# Overridable so a second jail (a staging clone, a rename in flight) can be
# addressed without editing the repo.
BASTILLE_JAIL="${BASTILLE_JAIL:-grappa}"
