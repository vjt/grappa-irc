#!/usr/bin/env bats
#
# Bats suite for infra/freebsd/bin/grappa-source-alias — the sudoers-scoped
# ifconfig wrapper (#543 / #609). `ifconfig` is stubbed via PATH so no real
# alias is touched; the test asserts the load-bearing properties:
#
#   * the interface (lo0) + mask (/128) are hard-coded — argv never lets the
#     caller pick them;
#   * the prefix is read from a ROOT-OWNED config file — NO compiled-in literal
#     (#609) — and the wrapper FAILS CLOSED (exit 66) when that file is missing
#     / unreadable / malformed, never a wildcard fallback;
#   * an address OUTSIDE the configured prefix is REFUSED without ever running
#     ifconfig (the privilege-scope invariant a bare `sudo ifconfig` violates);
#   * `probe` proves REAL aliasing capability — add-then-delete a canary, exit
#     0 on success, 69 when the substrate refuses the alias (non-VNET jail),
#     65 when the canary is outside the config-file prefix (DB↔substrate drift);
#   * the GRAPPA_SOURCE_ALIAS_PREFIX env override still works for a root/test
#     invocation (it is NEVER env_keep'd through sudoers);
#   * unknown subcommands / bad argc are usage errors (64).

load ../bats_helpers

setup() {
	WRAP="$BATS_TEST_DIRNAME/../../infra/freebsd/bin/grappa-source-alias"

	FAKE_DIR="$BATS_TEST_TMPDIR/fake"
	mkdir -p "$FAKE_DIR"
	IFCONFIG_LOG="$BATS_TEST_TMPDIR/ifconfig.log"
	: >"$IFCONFIG_LOG"
	export IFCONFIG_LOG

	# Stub ifconfig: log every invocation; fail (exit 1) only when
	# IFCONFIG_FAIL is set, to model a non-VNET jail refusing the alias.
	cat >"$FAKE_DIR/ifconfig" <<'EOF'
#!/bin/sh
printf 'ifconfig %s\n' "$*" >> "$IFCONFIG_LOG"
[ -n "${IFCONFIG_FAIL:-}" ] && exit 1
exit 0
EOF
	chmod +x "$FAKE_DIR/ifconfig"
	export PATH="$FAKE_DIR:$PATH"

	# Root-owned config file the wrapper reads its prefix from (#609). The real
	# path is /usr/local/etc/grappa/source-alias.conf; the test points
	# GRAPPA_SOURCE_ALIAS_CONF at a temp file.
	CONF="$BATS_TEST_TMPDIR/source-alias.conf"
	printf 'PREFIX=2a03:4000:20:2d3:cb::/80\n' >"$CONF"
	export GRAPPA_SOURCE_ALIAS_CONF="$CONF"

	# A GRAPPA_SOURCE_ALIAS_PREFIX leaking from the runner env would shadow the
	# config-file path under test — clear it except where a case sets it.
	unset GRAPPA_SOURCE_ALIAS_PREFIX
}

@test "add reads the prefix from the config file and aliases an in-prefix address" {
	run "$WRAP" add 2a03:4000:20:2d3:cb::1
	[ "$status" -eq 0 ]
	grep -q "ifconfig lo0 inet6 2a03:4000:20:2d3:cb::1/128 alias" "$IFCONFIG_LOG"
}

@test "del runs ifconfig lo0 inet6 <addr>/128 -alias" {
	run "$WRAP" del 2a03:4000:20:2d3:cb::dead
	[ "$status" -eq 0 ]
	grep -q "ifconfig lo0 inet6 2a03:4000:20:2d3:cb::dead/128 -alias" "$IFCONFIG_LOG"
}

@test "probe adds then deletes an in-prefix canary and exits 0" {
	run "$WRAP" probe 2a03:4000:20:2d3:cb::
	[ "$status" -eq 0 ]
	grep -q "ifconfig lo0 inet6 2a03:4000:20:2d3:cb::/128 alias" "$IFCONFIG_LOG"
	grep -q "ifconfig lo0 inet6 2a03:4000:20:2d3:cb::/128 -alias" "$IFCONFIG_LOG"
}

@test "probe exits 69 when the substrate refuses the alias (non-VNET jail)" {
	IFCONFIG_FAIL=1 run "$WRAP" probe 2a03:4000:20:2d3:cb::
	[ "$status" -eq 69 ]
	# the add was attempted; the delete must NOT run (nothing was added)
	grep -q "ifconfig lo0 inet6 2a03:4000:20:2d3:cb::/128 alias" "$IFCONFIG_LOG"
	refute grep -q -- "-alias" "$IFCONFIG_LOG"
}

@test "probe REFUSES a canary outside the config-file prefix (drift, 65)" {
	run "$WRAP" probe 2a03:4000:20:2d3:ffff::
	[ "$status" -eq 65 ]
	[ ! -s "$IFCONFIG_LOG" ]
	[[ "$output" == *"not inside"* ]]
}

@test "add REFUSES an address outside the prefix without running ifconfig (65)" {
	run "$WRAP" add 2a03:4000:20:2d3:ffff::1
	[ "$status" -eq 65 ]
	[ ! -s "$IFCONFIG_LOG" ]
	[[ "$output" == *"not inside"* ]]
}

@test "add REFUSES a non-IPv6 / unparseable address (65)" {
	run "$WRAP" add not-an-address
	[ "$status" -eq 65 ]
	[ ! -s "$IFCONFIG_LOG" ]
}

@test "add REFUSES an IPv4 address (v6-only block, 65)" {
	run "$WRAP" add 192.0.2.1
	[ "$status" -eq 65 ]
	[ ! -s "$IFCONFIG_LOG" ]
}

@test "a MISSING config file fails closed (66) without touching ifconfig" {
	export GRAPPA_SOURCE_ALIAS_CONF="$BATS_TEST_TMPDIR/nonexistent.conf"
	run "$WRAP" add 2a03:4000:20:2d3:cb::1
	[ "$status" -eq 66 ]
	[ ! -s "$IFCONFIG_LOG" ]
}

@test "a config file with no PREFIX= line fails closed (66)" {
	printf '# nothing here\n' >"$CONF"
	run "$WRAP" add 2a03:4000:20:2d3:cb::1
	[ "$status" -eq 66 ]
	[ ! -s "$IFCONFIG_LOG" ]
}

@test "a config file with a malformed PREFIX fails closed (66)" {
	printf 'PREFIX=not-a-cidr\n' >"$CONF"
	run "$WRAP" add 2a03:4000:20:2d3:cb::1
	[ "$status" -eq 66 ]
	[ ! -s "$IFCONFIG_LOG" ]
}

@test "the GRAPPA_SOURCE_ALIAS_PREFIX env override beats the config file (root/test)" {
	# config says cb::/80; env widens to a different block — env wins for a
	# root/test invocation (it is NEVER env_keep'd through sudoers).
	GRAPPA_SOURCE_ALIAS_PREFIX="2001:db8:abcd::/48" run "$WRAP" add 2001:db8:abcd:1::9
	[ "$status" -eq 0 ]
	grep -q "ifconfig lo0 inet6 2001:db8:abcd:1::9/128 alias" "$IFCONFIG_LOG"
}

@test "the env override works even when the config file is absent" {
	export GRAPPA_SOURCE_ALIAS_CONF="$BATS_TEST_TMPDIR/nonexistent.conf"
	GRAPPA_SOURCE_ALIAS_PREFIX="2001:db8:abcd::/48" run "$WRAP" add 2001:db8:abcd:1::9
	[ "$status" -eq 0 ]
	grep -q "ifconfig lo0 inet6 2001:db8:abcd:1::9/128 alias" "$IFCONFIG_LOG"
}

@test "unknown subcommand is a usage error (64)" {
	run "$WRAP" frobnicate 2a03:4000:20:2d3:cb::1
	[ "$status" -eq 64 ]
	[ ! -s "$IFCONFIG_LOG" ]
}

@test "add with no address is a usage error (64)" {
	run "$WRAP" add
	[ "$status" -eq 64 ]
	[ ! -s "$IFCONFIG_LOG" ]
}

@test "probe with no address is a usage error (64)" {
	run "$WRAP" probe
	[ "$status" -eq 64 ]
	[ ! -s "$IFCONFIG_LOG" ]
}

@test "no subcommand is a usage error (64)" {
	run "$WRAP"
	[ "$status" -eq 64 ]
}
