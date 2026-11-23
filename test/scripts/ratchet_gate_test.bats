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
    [[ "$output" == *"(no record there)"* ]]
}

@test "a pin deleted, then re-created higher, is judged against the base: the raise is RED" {
    scratch
    git rm -q priv/ratchet/ratchet.pin
    git commit -qm 'drop the record'
    pin "deps:Grappa.Session 29" "deps:Grappa.Accounts 3" "state_keys:Grappa.Session.Server 101"
    git add -A
    git commit -qm 'recreate the record higher'
    run scripts/ratchet-gate.sh main
    [ "$status" -eq 1 ]
    [[ "$output" == *"UNPAIRED"*"recreate the record higher"*"deps:Grappa.Session"*"28 -> 29"* ]]
    [[ "$output" == *"; 1 raise(s)"* ]]
}

@test "a key dropped, then re-added higher, is judged against the base: the raise is RED" {
    scratch
    pin "deps:Grappa.Accounts 3" "state_keys:Grappa.Session.Server 101"
    git commit -qam 'drop the Session key'
    pin "deps:Grappa.Session 29" "deps:Grappa.Accounts 3" "state_keys:Grappa.Session.Server 101"
    git commit -qam 're-add it higher'
    run scripts/ratchet-gate.sh main
    [ "$status" -eq 1 ]
    [[ "$output" == *"UNPAIRED"*"re-add it higher"*"deps:Grappa.Session"*"28 -> 29"* ]]
}

@test "a re-created pin whose raise is paired in its own commit is GREEN" {
    scratch
    git rm -q priv/ratchet/ratchet.pin
    git commit -qm 'drop the record'
    pin "deps:Grappa.Session 29" "deps:Grappa.Accounts 3" "state_keys:Grappa.Session.Server 101"
    note 'Session now needs `deps:Grappa.Session` for Foo.'
    git add -A
    git commit -qm 'recreate the record higher, explained'
    run scripts/ratchet-gate.sh main
    [ "$status" -eq 0 ]
    [[ "$output" == *"; 1 raise(s)"* ]]
}

@test "the push run: judged from the tip it pushed over, an unpaired raise on main is RED" {
    scratch
    git checkout -q main
    pin "deps:Grappa.Session 29" "deps:Grappa.Accounts 3" "state_keys:Grappa.Session.Server 101"
    git commit -qam 'grow Session on main'
    run scripts/ratchet-gate.sh "$(git rev-parse HEAD~1)"
    [ "$status" -eq 1 ]
    [[ "$output" == *"grow Session on main"* ]]
    [[ "$output" == *"1 commit(s)"* ]]
}

# The cases below run the ratchet step's own `run:` block (ci_run_block,
# test/bats_helpers.bash).

@test "ci.yml's push arm passes the push's before SHA, so the pushed commit is judged" {
    grep -qF 'PUSH_BEFORE: ${{ github.event.before }}' "$BATS_TEST_DIRNAME/../../.github/workflows/ci.yml"
    block="$(ci_run_block "Ratchet raises paired")"
    [[ "$block" == *"ratchet-gate.sh"* ]]
    scratch
    git checkout -q main
    pin "deps:Grappa.Session 29" "deps:Grappa.Accounts 3" "state_keys:Grappa.Session.Server 101"
    git commit -qam 'grow Session on main'
    # On a push, origin/main IS the pushed tip.
    git update-ref refs/remotes/origin/main "$(git rev-parse HEAD)"
    run env EVENT_NAME=push PUSH_BEFORE="$(git rev-parse HEAD~1)" bash -ec "$block"
    [ "$status" -eq 1 ]
    [[ "$output" == *"UNPAIRED"*"grow Session on main"* ]]
}

@test "ci.yml's pull_request arm judges the branch against origin/main" {
    block="$(ci_run_block "Ratchet raises paired")"
    scratch
    git update-ref refs/remotes/origin/main "$(git rev-parse main)"
    pin "deps:Grappa.Session 29" "deps:Grappa.Accounts 3" "state_keys:Grappa.Session.Server 101"
    git commit -qam 'grow Session on the branch'
    run env EVENT_NAME=pull_request PUSH_BEFORE= bash -ec "$block"
    [ "$status" -eq 1 ]
    [[ "$output" == *"UNPAIRED"*"grow Session on the branch"* ]]
}

@test "an empty range passes and SAYS it judged 0 commits" {
    scratch
    git checkout -q main
    pin "deps:Grappa.Session 29" "deps:Grappa.Accounts 3" "state_keys:Grappa.Session.Server 101"
    git commit -qam 'grow Session on main'
    run scripts/ratchet-gate.sh main
    [ "$status" -eq 0 ]
    [[ "$output" == *"0 commit(s)"* ]]
}

@test "the all-zeros SHA (a push that CREATED the ref) FAILS: the gate cannot reach a base" {
    scratch
    run scripts/ratchet-gate.sh 0000000000000000000000000000000000000000
    [ "$status" -eq 1 ]
    [[ "$output" == *"cannot reach"*"all-zeros"* ]]
}

@test "an EMPTY base ref FAILS instead of falling back to origin/main" {
    scratch
    # An origin/main that resolves, so a fallback would pass instead of failing.
    git update-ref refs/remotes/origin/main "$(git rev-parse main)"
    run scripts/ratchet-gate.sh ""
    [ "$status" -eq 1 ]
    [[ "$output" == *"cannot reach"*"EMPTY"* ]]
}

@test "a branch that never touches the pin passes and says what it saw" {
    scratch
    note 'just prose'
    git commit -qam 'prose only'
    run scripts/ratchet-gate.sh main
    [ "$status" -eq 0 ]
    [[ "$output" == *"1 commit"* ]]
    [[ "$output" == *"(the record there)"* ]]
    [[ "$output" == *"0 raise"* ]]
}

@test "an unresolvable base ref FAILS — the gate never passes vacuously" {
    scratch
    run scripts/ratchet-gate.sh no-such-ref
    [ "$status" -eq 1 ]
    [[ "$output" == *"cannot reach"*"no-such-ref"* ]]
}
