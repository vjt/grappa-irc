#!/bin/sh
# nfpm postinstall — the .deb postinst AND the .rpm %post scriptlet, embedded
# VERBATIM in both. The two managers pass DIFFERENT $1 conventions:
#   dpkg:  $1 = configure (install/upgrade) | abort-* (rollback)
#   rpm:   $1 = 1 (install) | 2 (upgrade)   [a NUMBER, never "configure"]
# So do NOT match on "configure": the body is idempotent (mkdir -p, chown,
# gen-secrets fills only REPLACE_ME, Ecto.Migrator applies only PENDING) and
# runs on every install/upgrade under EITHER manager, skipping only dpkg's
# abort-* rollback. What it does past the secrets is decided by the UNIT, not
# by $1 (issue 1112): a running service gets the upgrade applied to it by
# apply-upgrade.sh, which migrates after the code it serves, hot or in the
# restart's ExecStartPre; a stopped one is migrated here and left stopped.
# POSIX /bin/sh.
# Why: docs/OPERATIONS.md § "Packaging (infra/packaging/)".
set -e

case "${1:-configure}" in
abort-*)
	# dpkg rollback of a failed upgrade — leave the prior config untouched.
	;;
*)
	# configure (dpkg) OR a numeric rpm $1 (1 install / 2 upgrade) — apply.
	# ── State + config dirs ────────────────────────────────────────────
	# /var/lib/grappa carries the sqlite DB + uploads (writable by the
	# daemon); /etc/grappa carries the secrets env file (root:grappa 0750).
	mkdir -p /var/lib/grappa/uploads
	chown -R grappa:grappa /var/lib/grappa
	chmod 0750 /var/lib/grappa
	mkdir -p /etc/grappa
	chown root:grappa /etc/grappa
	chmod 0750 /etc/grappa

	# ── Env file: created on FIRST install only, never clobbered ────────
	if [ ! -f /etc/grappa/grappa.env ]; then
		cp /usr/share/grappa/grappa.env.example /etc/grappa/grappa.env
		chown root:grappa /etc/grappa/grappa.env
		chmod 0640 /etc/grappa/grappa.env
	fi

	# ── Secrets: openssl-only, idempotent (fills REPLACE_ME) ───────────
	/usr/share/grappa/gen-secrets.sh

	# ── A RUNNING service: apply the upgrade to it (issue 1112) ─────────
	# Nothing is migrated from here: the running node still serves the old
	# code, and migrating under it is what made "restart soon" necessary.
	# apply-upgrade.sh reloads hot when the release allows it (the reload
	# migrates in-process) and restarts otherwise (the unit migrates in
	# ExecStartPre), then seeds. FAIL LOUD, like a failed migrate below: it
	# fails only when a restart was needed and did not take.
	if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet grappa.service; then
		systemctl daemon-reload || true
		systemctl enable grappa.service || true
		if ! /usr/share/grappa/apply-upgrade.sh; then
			echo "grappa: the upgrade was NOT applied to the running service (see above)." >&2
			echo "        The package is installed. Fix the cause and retry with:" >&2
			echo "        sudo systemctl restart grappa" >&2
			exit 1
		fi
		exit 0
	fi

	# ── Migrate ────────────────────────────────────────────────────────
	# A stopped service from here on — first install, or an upgrade while it
	# was down (R5 of issue 1112: it stays down). Reaches Ecto.Migrator
	# through the release, no mix/toolchain; only PENDING migrations apply.
	# FAIL LOUD: a broken migrate must surface as a failed package
	# configuration, not a silently half-migrated install.
	if ! /usr/bin/grappa migrate; then
		echo "grappa: database migration FAILED (see error above)." >&2
		echo "        The package is installed but the schema is not applied." >&2
		echo "        Fix the cause and re-run: sudo grappa migrate" >&2
		exit 1
	fi

	# ── Built-in theme gallery ─────────────────────────────────────────
	# The curated palettes ship COMPILED into the release and their
	# wallpapers ship in the cic bundle, but the gallery reads the DB — so
	# without this step the package installs a bouncer with an empty theme
	# section (#1167). Idempotent upsert (system owner + name), which is
	# also how an upgrade picks up built-ins added since.
	# NON-FATAL, unlike migrate: the gallery is cosmetic and the upsert
	# converges, so failing a package transaction over it would cost the
	# operator a working install for a missing colour scheme. Loud, never
	# silent — same posture deploy_common holds on every substrate (#440).
	if ! /usr/bin/grappa seed-themes; then
		echo "grappa: built-in theme seeding FAILED (see error above)." >&2
		echo "        The install is complete and the schema is applied;" >&2
		echo "        the theme gallery may be empty or stale." >&2
		echo "        Retry with: sudo grappa seed-themes" >&2
	fi

	# ── systemd: enable, do NOT start ──────────────────────────────────
	# The operator must set a real PHX_HOST in /etc/grappa/grappa.env
	# before the service can boot, so we enable-on-boot but leave the
	# first start to them.
	if command -v systemctl >/dev/null 2>&1; then
		systemctl daemon-reload || true
		systemctl enable grappa.service || true
	fi

	cat <<'EOF'

grappa installed.

  1. Set the public hostname:
       sudoedit /etc/grappa/grappa.env      # set PHX_HOST=your.host
  2. Start it:
       sudo systemctl start grappa
  3. Create your first user (after it is running) — see the "First user"
     section of /usr/share/doc/grappa/README.md.

  Health:  curl http://127.0.0.1:4000/healthz
  Logs:    journalctl -u grappa -f

  Back up /etc/grappa/grappa.env's GRAPPA_ENCRYPTION_KEY now — it encrypts
  stored IRC credentials at rest; lose it and they are unrecoverable.

  nginx is recommended for TLS/static fronting but NOT required — the
  bouncer self-serves the cicchetto PWA on PORT (default 4000).
EOF
	;;
esac
