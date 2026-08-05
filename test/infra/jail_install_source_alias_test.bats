#!/usr/bin/env bats
#
# Bats suite for infra/freebsd/jail_install_source_alias.sh — the #646
# installer the deploy now runs on every path.
#
# It exists because the artifacts it writes are the ones that took prod
# down: the wrapper itself, and the prefix scope RENDERED FROM THE DB
# (#609 — a hand-maintained scope that drifted from the DB made every
# acquire exit 65). Both are asserted here against a real sqlite file.
#
# Scope: pure shell. `install(1)` is stubbed because the real one needs
# root to chown root:wheel; ownership and the sudoers grant are jail
# properties this host cannot exercise.

load ../bats_helpers

setup() {
    SCRIPT="$BATS_TEST_DIRNAME/../../infra/freebsd/jail_install_source_alias.sh"

    export REPO_ROOT="$BATS_TEST_TMPDIR/repo"
    mkdir -p "$REPO_ROOT/infra/freebsd/bin"
    echo "#!/bin/sh" > "$REPO_ROOT/infra/freebsd/bin/grappa-source-alias"
    echo "echo new-wrapper" >> "$REPO_ROOT/infra/freebsd/bin/grappa-source-alias"

    export SA_DST="$BATS_TEST_TMPDIR/sbin/grappa-source-alias"
    export SA_CONF="$BATS_TEST_TMPDIR/etc/grappa/source-alias.conf"
    mkdir -p "$(dirname "$SA_DST")"

    DB="$BATS_TEST_TMPDIR/grappa.db"
    sqlite3 "$DB" "create table server_settings (key text primary key, value text);"

    export ENV_FILE="$BATS_TEST_TMPDIR/grappa.env"
    printf 'DATABASE_PATH=%s\n' "$DB" > "$ENV_FILE"

    # install(1) stub: the real one chowns root:wheel, which needs root.
    # Keep the copy semantics (last two argv words are src + dst) so the
    # assertions still observe a real file landing at the destination.
    FAKE_DIR="$BATS_TEST_TMPDIR/fake"
    mkdir -p "$FAKE_DIR"
    cat > "$FAKE_DIR/install" <<'EOF'
#!/bin/sh
for last in "$@"; do :; done
src=""
prev=""
for a in "$@"; do prev="$src"; src="$a"; done
cp "$prev" "$last"
EOF
    chmod +x "$FAKE_DIR/install"
    export PATH="$FAKE_DIR:$PATH"
}

@test "installs the repo's wrapper at the destination" {
    echo stale > "$SA_DST"

    run "$SCRIPT"
    [ "$status" -eq 0 ]
    grep -q "new-wrapper" "$SA_DST"
}

@test "renders the prefix scope from the DB, not from a hand-written file" {
    sqlite3 "$BATS_TEST_TMPDIR/grappa.db" \
        "insert into server_settings values ('addressing.static_mapping_prefix', '2a03:4000:20:2d3:cafe::/80');"
    mkdir -p "$(dirname "$SA_CONF")"
    printf 'PREFIX=2a03:4000:20:2d3:cb::/80\n' > "$SA_CONF"   # the #609 drift

    run "$SCRIPT"
    [ "$status" -eq 0 ]
    grep -q "^PREFIX=2a03:4000:20:2d3:cafe::/80$" "$SA_CONF"
    refute grep -q "cb::/80" "$SA_CONF"
}

@test "no prefix in the DB leaves an existing scope file untouched" {
    mkdir -p "$(dirname "$SA_CONF")"
    printf 'PREFIX=2a03:4000:20:2d3:cb::/80\n' > "$SA_CONF"

    run "$SCRIPT"
    [ "$status" -eq 0 ]
    grep -q "^PREFIX=2a03:4000:20:2d3:cb::/80$" "$SA_CONF"
    [[ "$output" == *"no static_mapping_prefix"* ]]
}

@test "a missing wrapper in the checkout fails the deploy loudly" {
    rm "$REPO_ROOT/infra/freebsd/bin/grappa-source-alias"

    run "$SCRIPT"
    [ "$status" -ne 0 ]
    # Loud AND inert: a checkout that cannot supply the wrapper must not
    # leave a half-installed destination behind either.
    refute test -f "$SA_DST"
}
