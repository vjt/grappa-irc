#!/usr/bin/env bats
# test/scripts/ratchet_gate_test.bats — issue 2690.
#
# scripts/ratchet-gate.sh is the git half of the ratchet: a commit that RAISES
# a value in priv/ratchet/ratchet.pin must add a docs/DESIGN_NOTES.md line
# naming that key in backticks, in the SAME commit. `mix grappa.ratchet
# --check` decides whether the pin agrees with the code; this decides whether
# each raise was explained. Each test builds a scratch repo, so the verdicts
# below are the gate's own, not a reading of its source.

load ../bats_helpers

setup() {
    GATE_SRC="$BATS_TEST_DIRNAME/../../scripts/ratchet-gate.sh"
}

pin() {
    # pin "key value" ... → rewrite the record with those lines
    mkdir -p priv/ratchet
    {
        printf '# GENERATED header line\n#\n'
        for kv in "$@"; do
            printf '%s = %s\n' "${kv% *}" "${kv#* }"
        done
    } > priv/ratchet/ratchet.pin
}

note() {
    printf '\n%s\n' "$1" >> docs/DESIGN_NOTES.md
}

# A repo whose main carries a seeded pin, and a `feat` branch off it.
scratch() {
    REPO="$BATS_TEST_TMPDIR/repo"
    rm -rf "$REPO"
    mkdir -p "$REPO/docs" "$REPO/scripts"
    cp "$GATE_SRC" "$REPO/scripts/ratchet-gate.sh"
    chmod 0755 "$REPO/scripts/ratchet-gate.sh"
    cd "$REPO"
    git -c init.defaultBranch=main init -q .
    git config user.email bats@example.invalid
    git config user.name bats
    printf 'INTRO\n' > docs/DESIGN_NOTES.md
    pin "deps:Grappa.Session 28" "deps:Grappa.Accounts 3" "state_keys:Grappa.Session.Server 101"
    git add -A
    git commit -qm base
    git checkout -qb feat
}

@test "a raise with no DESIGN_NOTES line in its commit is RED, naming commit and key" {
    scratch
    pin "deps:Grappa.Session 29" "deps:Grappa.Accounts 3" "state_keys:Grappa.Session.Server 101"
    git commit -qam 'grow Session'
    run scripts/ratchet-gate.sh main
    [ "$status" -eq 1 ]
    [[ "$output" == *"deps:Grappa.Session"* ]]
    [[ "$output" == *"28 -> 29"* ]]
    [[ "$output" == *"grow Session"* ]]
}

@test "a raise whose commit adds a DESIGN_NOTES line naming the key in backticks is GREEN" {
    scratch
    pin "deps:Grappa.Session 29" "deps:Grappa.Accounts 3" "state_keys:Grappa.Session.Server 101"
    note 'Session now needs `deps:Grappa.Session` to reach Foo, because…'
    git commit -qam 'grow Session, explained'
    run scripts/ratchet-gate.sh main
    [ "$status" -eq 0 ]
    [[ "$output" == *"1 raise"* ]]
}

@test "the DESIGN_NOTES line must be in the SAME commit — a later one does not pair" {
    scratch
    pin "deps:Grappa.Session 29" "deps:Grappa.Accounts 3" "state_keys:Grappa.Session.Server 101"
    git commit -qam 'grow Session'
    note 'Session now needs `deps:Grappa.Session` for Foo.'
    git commit -qam 'explain it afterwards'
    run scripts/ratchet-gate.sh main
    [ "$status" -eq 1 ]
    [[ "$output" == *"grow Session"* ]]
}

@test "a longer key does not pair a shorter one: \`deps:Grappa.Accounts.User\` is not \`deps:Grappa.Accounts\`" {
    scratch
    pin "deps:Grappa.Session 28" "deps:Grappa.Accounts 4" "state_keys:Grappa.Session.Server 101"
    note 'unrelated: `deps:Grappa.Accounts.User` moved'
    git commit -qam 'grow Accounts'
    run scripts/ratchet-gate.sh main
    [ "$status" -eq 1 ]
    [[ "$output" == *"deps:Grappa.Accounts"* ]]
}

@test "the key named without backticks does not pair" {
    scratch
    pin "deps:Grappa.Session 28" "deps:Grappa.Accounts 3" "state_keys:Grappa.Session.Server 102"
    note 'state_keys:Grappa.Session.Server grew by one'
    git commit -qam 'grow state'
    run scripts/ratchet-gate.sh main
    [ "$status" -eq 1 ]
}

@test "lowering a value needs no DESIGN_NOTES line" {
    scratch
    pin "deps:Grappa.Session 27" "deps:Grappa.Accounts 3" "state_keys:Grappa.Session.Server 101"
    git commit -qam 'shrink Session'
    run scripts/ratchet-gate.sh main
    [ "$status" -eq 0 ]
}

@test "a NEW key (a new boundary) needs no DESIGN_NOTES line" {
    scratch
    pin "deps:Grappa.Session 28" "deps:Grappa.Accounts 3" "deps:Grappa.Fresh 4" "state_keys:Grappa.Session.Server 101"
    git commit -qam 'new boundary'
    run scripts/ratchet-gate.sh main
    [ "$status" -eq 0 ]
}

@test "the seed commit, which creates the pin, is exempt" {
    REPO="$BATS_TEST_TMPDIR/repo"
    rm -rf "$REPO"
    mkdir -p "$REPO/docs" "$REPO/scripts"
    cp "$GATE_SRC" "$REPO/scripts/ratchet-gate.sh"
    cd "$REPO"
    git -c init.defaultBranch=main init -q .
    git config user.email bats@example.invalid
    git config user.name bats
    printf 'INTRO\n' > docs/DESIGN_NOTES.md
    git add -A
    git commit -qm base
    git checkout -qb feat
    pin "deps:Grappa.Session 28"
    git add -A
    git commit -qm seed
    run scripts/ratchet-gate.sh main
    [ "$status" -eq 0 ]
}

@test "a branch that never touches the pin passes and says what it saw" {
    scratch
    note 'just prose'
    git commit -qam 'prose only'
    run scripts/ratchet-gate.sh main
    [ "$status" -eq 0 ]
    [[ "$output" == *"1 commit"* ]]
    [[ "$output" == *"0 raise"* ]]
}

@test "an unresolvable base ref FAILS — the gate never passes vacuously" {
    scratch
    run scripts/ratchet-gate.sh no-such-ref
    [ "$status" -eq 1 ]
    [[ "$output" == *"no-such-ref"* ]]
}
