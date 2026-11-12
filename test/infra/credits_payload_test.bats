#!/usr/bin/env bats
#
# infra/packaging/credits.sh — the build's git credits payload (#1773).
#
# The credits modal needs three facts the browser cannot have: the commit sha,
# its date, and the contributor list with per-author commit counts. They are
# git facts, and the cic build runs in containers that mount ONLY ./cicchetto
# (cicchetto/vite.config.ts:30-39), so the repo root is out of reach there.
# The payload is therefore derived OUTSIDE the container by the same wrappers
# that already derive GRAPPA_VERSION, and handed in on an env var.
#
# What these cases pin, and why each one exists:
#
#   1. the PAYLOAD is exact — a wrong count or a dropped author is a lie the
#      modal would render as fact, so the assertion is a byte-for-byte compare
#      against a sandbox repo whose history this file wrote;
#   2. merges are EXCLUDED — `--no-merges`, so a merge-heavy branch does not
#      credit the merger for other people's work;
#   3. a name carrying `"` or `\` stays PARSEABLE — the payload is JSON that
#      vite parses at build time, and one unescaped quote turns the whole roll
#      into a build failure (or, worse, a truncated roll);
#   4. NO GIT is not an error — the AUR recipe builds from a release tarball
#      and Dockerfile.release .dockerignore's `.git`, so on the two RELEASE
#      substrates there is no repo to read. The script must exit 0 with an
#      honestly empty payload there, exactly as `Grappa.Version` reports the
#      bare base on its no-git path. Failing loud here would break precisely
#      the two builds that ship;
#   5. ONE LINE of output — every wrapper captures it with `$(...)` into an
#      env var, and a multi-line payload would arrive mangled;
#   6. one person gets ONE credit — `.mailmap` collapses the identities a
#      contributor has committed under, and the roll must show the collapsed
#      list rather than the same person two or three times (#1808);
#   7. the NICK is looked up, and its absence is NOT a fault — the roll reads
#      `nick (Name)`, the mapping lives in the static table
#      `infra/packaging/contributors`, and a contributor missing from it (or a
#      missing table entirely, which is every tree built before it shipped)
#      degrades to `nick:null` rather than to a broken build (#1927);
#   8. bot identities are dropped where the list is BORN — `dependabot[bot]`
#      outranked half the humans by commit count, and filtering it in the
#      renderer instead would still ship it inside the bundle (#1927).
#
# The sandbox repos are built here rather than measured against this checkout:
# the real history changes every commit, so a case reading it could only
# assert a shape, and a shape assertion cannot tell a correct roll from an
# empty one.

load ../bats_helpers

setup() {
    SCRIPT="$BATS_TEST_DIRNAME/../../infra/packaging/credits.sh"

    # The checkout this suite runs in. The #1808 cases below read the REAL
    # `.mailmap` through it: unlike the history, that file is a committed
    # artefact this repo owns, so an exact assertion against it is stable and
    # dies on the one edit that matters — a removed or reshaped mapping.
    REAL_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"

    REPO="$BATS_TEST_TMPDIR/repo"
    # `credits.sh` derives the repo root as SCRIPT_DIR/../.. (the layout
    # version.sh already expects), so the sandbox gets its own copy at the
    # same relative depth and reads the sandbox, not this checkout.
    mkdir -p "$REPO/infra/packaging"
    cp "$SCRIPT" "$REPO/infra/packaging/credits.sh"
    chmod +x "$REPO/infra/packaging/credits.sh"
    SANDBOX_SCRIPT="$REPO/infra/packaging/credits.sh"

    seq=0
}

# Commit as a named author, touching a file nobody else touches — the merge
# case needs two branches that can actually merge without a conflict.
commit_as() {
    local name="$1" email="$2" message="$3"
    seq=$((seq + 1))
    printf '%s\n' "$message" > "$REPO/file-$seq.txt"
    git -C "$REPO" add "file-$seq.txt"
    GIT_AUTHOR_NAME="$name" GIT_AUTHOR_EMAIL="$email" \
        GIT_COMMITTER_NAME="$name" GIT_COMMITTER_EMAIL="$email" \
        git -C "$REPO" commit -q -m "$message"
}

init_repo() {
    git -C "$REPO" init -q -b main
    git -C "$REPO" config user.name "sandbox"
    git -C "$REPO" config user.email "sandbox@example.invalid"
    # No mailmap unless a case writes one: `git shortlog` therefore groups by
    # the author name verbatim and the expected counts below are the literal
    # ones. The #1808 case that needs a mailmap adds it after this.
}

@test "the payload names every contributor with the count of their non-merge commits" {
    init_repo
    commit_as "Ada Lovelace" "ada@example.invalid" "one"
    commit_as "Ada Lovelace" "ada@example.invalid" "two"
    commit_as "Ada Lovelace" "ada@example.invalid" "three"
    commit_as "Grace Hopper" "grace@example.invalid" "four"

    run "$SANDBOX_SCRIPT"

    [ "$status" -eq 0 ]
    # Descending by count, which is what `shortlog -sn` orders by and what a
    # credit roll wants — the exact string, so a re-ordering fails too.
    [[ "$output" == *'"contributors":[{"name":"Ada Lovelace","nick":null,"commits":3},{"name":"Grace Hopper","nick":null,"commits":1}]'* ]]
}

@test "the sha and the date are the ones HEAD actually carries, the sha nine hex wide (issue 2642)" {
    init_repo
    commit_as "Ada Lovelace" "ada@example.invalid" "one"

    local sha date auto
    sha="$(git -C "$REPO" rev-parse HEAD)"
    sha="${sha:0:9}"
    date="$(git -C "$REPO" log -1 --format=%cI)"

    # A bare `--short` is sized from the clone's object count: 7 hex in this
    # sandbox, 9 in today's full clone, 10 from 2^18 objects on. The sha is
    # baked into the bundle, so that width would make the attested bytes
    # depend on how much history the building clone holds. Pre-state: this
    # repo is one where the auto width is NOT nine, or the case proves nothing.
    auto="$(git -C "$REPO" rev-parse --short HEAD)"
    [ "${#auto}" -ne 9 ]

    run "$SANDBOX_SCRIPT"

    [ "$status" -eq 0 ]
    [[ "$output" == "{\"sha\":\"$sha\",\"date\":\"$date\","* ]]
}

@test "a merge commit credits nobody — the roll counts authored work" {
    init_repo
    commit_as "Ada Lovelace" "ada@example.invalid" "base"
    git -C "$REPO" checkout -q -b side
    commit_as "Grace Hopper" "grace@example.invalid" "side work"
    git -C "$REPO" checkout -q main
    commit_as "Ada Lovelace" "ada@example.invalid" "main work"
    # --no-ff forces a merge COMMIT, which is the thing under test; the merger
    # is a third name, so a leak shows up as that name appearing at all.
    GIT_AUTHOR_NAME="Mergebot" GIT_AUTHOR_EMAIL="bot@example.invalid" \
        GIT_COMMITTER_NAME="Mergebot" GIT_COMMITTER_EMAIL="bot@example.invalid" \
        git -C "$REPO" merge -q --no-ff -m "merge side" side

    run "$SANDBOX_SCRIPT"

    [ "$status" -eq 0 ]
    refute grep -q 'Mergebot' <<< "$output"
    [[ "$output" == *'{"name":"Ada Lovelace","nick":null,"commits":2}'* ]]
    [[ "$output" == *'{"name":"Grace Hopper","nick":null,"commits":1}'* ]]
}

@test "a name carrying a quote or a backslash is escaped, not emitted raw" {
    init_repo
    # Both JSON metacharacters in one name: raw, the quote closes the string
    # early and the rest of the payload becomes syntax. vite PARSES this
    # payload at build time, so an unescaped name is a broken build — or, if
    # it happens to stay parseable, a truncated roll.
    #
    # The name must not END on a metacharacter: git's own ident parser strips
    # trailing "crud" (`"`, `'`, `.`, `,`, `:`, `;`, `<`, `>`) when it reads an
    # author line back, so `… "Quoted"` reaches shortlog as `… "Quoted` and the
    # case would then be measuring git's stripping instead of this escaper.
    commit_as 'A "B" C\D' "odd@example.invalid" "one"

    run "$SANDBOX_SCRIPT"

    [ "$status" -eq 0 ]
    # Single-quoted pattern: bash takes every character literally, so this is
    # the payload's exact bytes — two escaped quotes, one escaped backslash.
    [[ "$output" == *'{"name":"A \"B\" C\\D","nick":null,"commits":1}'* ]]
}

@test "no git is an honest empty payload, not a failure (AUR tarball, Dockerfile.release)" {
    # No `git init` at all: the shape both RELEASE substrates present.
    run "$SANDBOX_SCRIPT"

    [ "$status" -eq 0 ]
    [ "$output" = '{"sha":null,"date":null,"contributors":[]}' ]
}

@test "the payload is a single line, so a wrapper can carry it in one env var" {
    init_repo
    commit_as "Ada Lovelace" "ada@example.invalid" "one"
    commit_as "Grace Hopper" "grace@example.invalid" "two"

    run "$SANDBOX_SCRIPT"

    [ "$status" -eq 0 ]
    [ "${#lines[@]}" -eq 1 ]
}

# ── #1808 — one person, one credit ──────────────────────────────────────────
#
# The roll used to split people across the identities they had committed
# under, because nothing had ever de-duplicated them. The cure is a root
# `.mailmap`: `git shortlog` resolves author identity through it before
# grouping, so the collapse costs no history rewrite and no change to
# credits.sh.
#
# Three cases, dying of three different causes:
#
#   * the first is a SANDBOX case and pins the CHANNEL — that credits.sh
#     still reaches the mailmap-resolved name. It goes red on `--no-mailmap`,
#     or on a reimplementation over `%an` (raw) instead of `%aN` (resolved);
#   * the second reads THIS checkout and pins the MAPPINGS — it goes red when
#     a line is removed from `.mailmap`;
#   * the third reads THIS checkout and pins the one NON-collapse: an identity
#     that merely shares an address with a mapped one must stay its own. That
#     is what a mechanical dedup gets wrong, and it is invisible once done.

@test "#1808 — a .mailmap collapses one person's identities into a single credit" {
    init_repo
    # Ada under two addresses AND two names, with a namesake-free second
    # person to prove the collapse is not "everything became one row".
    commit_as "Ada Lovelace" "ada@example.invalid" "one"
    commit_as "Ada Lovelace" "ada@work.invalid" "two"
    commit_as "ada" "ada@example.invalid" "three"
    commit_as "Grace Hopper" "grace@example.invalid" "four"

    printf '%s\n' \
        'Ada Lovelace <ada@example.invalid> Ada Lovelace <ada@work.invalid>' \
        'Ada Lovelace <ada@example.invalid> ada <ada@example.invalid>' \
        > "$REPO/.mailmap"

    run "$SANDBOX_SCRIPT"

    [ "$status" -eq 0 ]
    # Three commits on ONE row. The exact string, like the case at the top of
    # this file: a partial collapse (two rows for Ada) is as wrong as none.
    [[ "$output" == *'"contributors":[{"name":"Ada Lovelace","nick":null,"commits":3},{"name":"Grace Hopper","nick":null,"commits":1}]'* ]]
}

@test "#1808 — every alias this repo's .mailmap collapses resolves to one identity" {
    # `check-mailmap` reads the FILE, not the log, so this asserts exact
    # strings without depending on a history that grows every commit.
    run git -C "$REAL_ROOT" check-mailmap \
        'vjt <vjt@openssl.it>' \
        'Marcello Barnaba <mbarnaba@meta.com>' \
        'Marcello Barnaba <marcello.barnaba@gmail.com>' \
        'Alessio Bonforti <38355294+abonforti@users.noreply.github.com>' \
        'gabrielemarrone <131861953+gabrielemarrone@users.noreply.github.com>' \
        'claude <claude@sonic88.org>' \
        'Your Name <you@example.com>'

    [ "$status" -eq 0 ]
    [ "${lines[0]}" = 'Marcello Barnaba <vjt@openssl.it>' ]
    [ "${lines[1]}" = 'Marcello Barnaba <vjt@openssl.it>' ]
    [ "${lines[2]}" = 'Marcello Barnaba <vjt@openssl.it>' ]
    [ "${lines[3]}" = 'Alessio Bonforti <info@alessiobonforti.com>' ]
    [ "${lines[4]}" = 'Gabriele Marrone <gabriele.marrone@gmail.com>' ]
    # The Claude session identities are ONE credit under `vjt-claude` — a
    # ruling, not a dedup (#1808). Its canonical address is the one shared
    # with Marcello, and it does NOT chain on into him: a mailmap lookup is
    # a single resolution, not a transitive one.
    [ "${lines[5]}" = 'vjt-claude <marcello.barnaba@gmail.com>' ]
    # The git default nobody configured, attributed on a human's word rather
    # than on the (strong) inference the history supports — also a ruling.
    [ "${lines[6]}" = 'Stefy Lanza <stefy@nexlab.net>' ]

    # And the PAYLOAD this checkout actually produces carries the collapse:
    # an alias is only ever VISIBLE in the roll when it differs by NAME
    # (`shortlog -sn` groups by name, so the same-name address splits above
    # never reached it), and none of the four is there now.
    run "$SCRIPT"
    [ "$status" -eq 0 ]

    # Anti-hollow-green: a checkout with no readable git yields the honest
    # empty payload, against which every `refute` below holds vacuously. The
    # canonical names must be PRESENT before their aliases may be absent.
    [[ "$output" == *'{"name":"Marcello Barnaba","nick":"vjt","commits":'* ]]
    [[ "$output" == *'{"name":"Gabriele Marrone","nick":"peluche","commits":'* ]]
    [[ "$output" == *'{"name":"vjt-claude","nick":"vjt-claude","commits":'* ]]
    [[ "$output" == *'{"name":"Stefy Lanza","nick":"nextime","commits":'* ]]
    refute grep -q '"name":"vjt"' <<< "$output"
    refute grep -q '"name":"gabrielemarrone"' <<< "$output"
    refute grep -q '"name":"claude"' <<< "$output"
    refute grep -q '"name":"Your Name"' <<< "$output"
}

@test "#1808 — a shared address does not drag one identity into another" {
    # `vjt-claude` is the canonical name the Claude session identities were
    # ruled into, and it commits under `marcello.barnaba@gmail.com` — the
    # SAME address as one of the aliases collapsed in the case above. A
    # mapping written `Proper <new> <old>` keys on the commit ADDRESS ALONE,
    # so that spelling folds `vjt-claude` into Marcello and quietly overrules
    # the ruling. The four-field `Proper <new> Commit Name <old>` spelling
    # keys on the pair; measured both ways before the file was written.
    #
    # So this asserts a NON-collapse, and it is the only case that does. It is
    # the one line of defence against a future tidy-up shortening the entries:
    # the wrong spelling breaks nothing loudly, it just silently reassigns
    # eight commits to somebody who did not write them.
    run git -C "$REAL_ROOT" check-mailmap 'vjt-claude <marcello.barnaba@gmail.com>'

    [ "$status" -eq 0 ]
    [ "$output" = 'vjt-claude <marcello.barnaba@gmail.com>' ]
}

# ── #1927 — nick (Name), and no bots in a roll of people ────────────────────
#
# The roll credits people by the handle the project knows them by, with the
# real name as an italic parenthetical. A git commit carries no handle, and
# resolving one through the GitHub API is out of reach here by design (this
# script runs in a FreeBSD jail and from a release tarball, with no network),
# so the mapping is static data at `infra/packaging/contributors` — read by
# the same awk run that builds the payload.
#
# Every case below is about the DEGRADE as much as the lookup: an unmapped
# contributor, a malformed line and a missing table must each cost one nick,
# never the build. The sandbox has no table unless a case writes one, which is
# why every assertion further up this file reads `"nick":null`.

write_nicks() {
    printf '%s\n' "$@" > "$REPO/infra/packaging/contributors"
}

@test "#1927 — the table maps an author name to the handle the roll credits" {
    init_repo
    commit_as "Ada Lovelace" "ada@example.invalid" "one"
    commit_as "Ada Lovelace" "ada@example.invalid" "two"
    commit_as "Grace Hopper" "grace@example.invalid" "three"
    write_nicks "$(printf 'Ada Lovelace\tada')" "$(printf 'Grace Hopper\tamazing_grace')"

    run "$SANDBOX_SCRIPT"

    [ "$status" -eq 0 ]
    [[ "$output" == *'"contributors":[{"name":"Ada Lovelace","nick":"ada","commits":2},{"name":"Grace Hopper","nick":"amazing_grace","commits":1}]'* ]]
}

@test "#1927 — a contributor absent from the table keeps the credit, loses the nick" {
    # The everyday case: someone lands in the history before anyone edits the
    # table. Dropping them, or failing, would make the table a gate on
    # contributing.
    init_repo
    commit_as "Ada Lovelace" "ada@example.invalid" "one"
    commit_as "Grace Hopper" "grace@example.invalid" "two"
    write_nicks "$(printf 'Ada Lovelace\tada')"

    run "$SANDBOX_SCRIPT"

    [ "$status" -eq 0 ]
    [[ "$output" == *'{"name":"Ada Lovelace","nick":"ada","commits":1}'* ]]
    [[ "$output" == *'{"name":"Grace Hopper","nick":null,"commits":1}'* ]]
}

@test "#1927 — comments, blanks and a tabless line cost one mapping, not the payload" {
    init_repo
    commit_as "Ada Lovelace" "ada@example.invalid" "one"
    commit_as "Grace Hopper" "grace@example.invalid" "two"
    # A comment, an indented comment, a blank line, and the typo that matters:
    # a row written with SPACES where the format wants a tab. It is dropped
    # rather than guessed at — guessing would map "Grace" to "Hopper amazing".
    write_nicks \
        '# the header this file really carries' \
        '   # indented, still a comment' \
        '' \
        'Grace Hopper amazing_grace' \
        "$(printf 'Ada Lovelace\tada')"

    run "$SANDBOX_SCRIPT"

    [ "$status" -eq 0 ]
    [[ "$output" == *'{"name":"Ada Lovelace","nick":"ada","commits":1}'* ]]
    [[ "$output" == *'{"name":"Grace Hopper","nick":null,"commits":1}'* ]]
}

@test "#1927 — trailing blanks in the table are not part of the nick" {
    # An invisible edit that would otherwise ship a handle nobody can match
    # against anything on screen.
    init_repo
    commit_as "Ada Lovelace" "ada@example.invalid" "one"
    write_nicks "$(printf 'Ada Lovelace \t ada \t')"

    run "$SANDBOX_SCRIPT"

    [ "$status" -eq 0 ]
    [[ "$output" == *'{"name":"Ada Lovelace","nick":"ada","commits":1}'* ]]
}

@test "#1927 — an EMPTY table is not read as the shortlog it precedes" {
    # The `NR == FNR` idiom would take the FIRST stdin line as a table row here
    # — an empty first file makes the two indistinguishable — and the roll
    # would silently lose its top contributor. The `pass=` assignments between
    # the operands are what keeps them apart; this case dies if they go.
    init_repo
    commit_as "Ada Lovelace" "ada@example.invalid" "one"
    commit_as "Ada Lovelace" "ada@example.invalid" "two"
    commit_as "Grace Hopper" "grace@example.invalid" "three"
    : > "$REPO/infra/packaging/contributors"

    run "$SANDBOX_SCRIPT"

    [ "$status" -eq 0 ]
    [[ "$output" == *'"contributors":[{"name":"Ada Lovelace","nick":null,"commits":2},{"name":"Grace Hopper","nick":null,"commits":1}]'* ]]
}

@test "#1927 — a nick carrying a JSON metacharacter is escaped like a name" {
    # The table is hand-edited data reaching the same payload the names do, so
    # it goes through the same escaper. Raw, one quote here is a broken build.
    init_repo
    commit_as "Ada Lovelace" "ada@example.invalid" "one"
    write_nicks "$(printf 'Ada Lovelace\tA "B" C\\D')"

    run "$SANDBOX_SCRIPT"

    [ "$status" -eq 0 ]
    [[ "$output" == *'{"name":"Ada Lovelace","nick":"A \"B\" C\\D","commits":1}'* ]]
}

@test "#1927 — a [bot] identity never reaches the payload" {
    init_repo
    commit_as "Ada Lovelace" "ada@example.invalid" "one"
    commit_as "dependabot[bot]" "49699333+dependabot[bot]@users.noreply.github.com" "bump"
    commit_as "dependabot[bot]" "49699333+dependabot[bot]@users.noreply.github.com" "bump again"

    run "$SANDBOX_SCRIPT"

    [ "$status" -eq 0 ]
    # Gone entirely — not present with a null nick, not present last. The
    # anti-hollow-green half: the human it outranked is still there, so this
    # cannot pass on an empty payload.
    [[ "$output" == *'{"name":"Ada Lovelace","nick":null,"commits":1}'* ]]
    refute grep -q 'dependabot' <<< "$output"
}

@test "#1927 — a name that merely CONTAINS [bot] is a contributor, not a bot" {
    # The filter keys on the trailing `[bot]` GitHub appends to App identities.
    # A substring match would eat a human, and silently.
    init_repo
    commit_as "Bot[bot]tomley" "human@example.invalid" "one"
    commit_as "[bot]" "short@example.invalid" "two"

    run "$SANDBOX_SCRIPT"

    [ "$status" -eq 0 ]
    [[ "$output" == *'{"name":"Bot[bot]tomley","nick":null,"commits":1}'* ]]
    # Exactly `[bot]` and nothing else is five characters: too short to be an
    # App identity (`<app>[bot]`), so it is a name and it stays.
    [[ "$output" == *'{"name":"[bot]","nick":null,"commits":1}'* ]]
}

@test "#1927 — this checkout's own table names every contributor in its roll" {
    # Reads THIS repo, like the #1808 mapping case: the table is a committed
    # artefact, so it can be asserted exactly. A contributor who lands without
    # a table entry shows up here as a null nick — that is the reminder to add
    # the line, and it is deliberately louder than the silent bare-name render.
    run "$SCRIPT"

    [ "$status" -eq 0 ]
    # Anti-hollow-green: a checkout with no readable git yields the empty
    # payload, against which the refute below holds vacuously.
    [[ "$output" == *'{"name":"Marcello Barnaba","nick":"vjt","commits":'* ]]
    refute grep -q '"nick":null' <<< "$output"
}

@test "issue 1773 — a SHALLOW repo yields no contributor list, because it cannot have one" {
    # The defect this case exists for: a shallow checkout has a real HEAD and a
    # real date, so two of the three probes answer correctly, and `shortlog`
    # answers CONFIDENTLY WRONG — it credits the whole project to whoever
    # authored the one commit that was fetched. Measured on CI: every green
    # `integration` run baked `[{"name":"Marcello Barnaba","commits":1}]` for a
    # repository where that author has 5667. Nothing was red, because a wrong
    # roll and a right one have the same shape.
    #
    # So shallowness is NOT the no-git case and is not treated as one: sha and
    # date stay, because a shallow repo knows them exactly. Only the aggregate
    # over history is withheld, because that is the only fact the truncation
    # destroys.
    init_repo
    commit_as "Ada Lovelace" "ada@example.invalid" "one"
    commit_as "Ada Lovelace" "ada@example.invalid" "two"
    commit_as "Grace Hopper" "grace@example.invalid" "three"

    local shallow="$BATS_TEST_TMPDIR/shallow"
    # `file://` is load-bearing, not decoration: `git clone --depth=1 <path>`
    # IGNORES the depth for a local clone and hands back the full history, with
    # only a warning. This case would then assert the shallow behaviour against
    # a complete repo and pass whatever the script does — the control below is
    # what makes the fixture's shallowness a measured fact rather than a hope.
    git clone -q --depth=1 "file://$REPO" "$shallow"
    mkdir -p "$shallow/infra/packaging"
    cp "$SCRIPT" "$shallow/infra/packaging/credits.sh"
    chmod +x "$shallow/infra/packaging/credits.sh"

    # POSITIVE CONTROL — the fixture is really shallow and really truncated.
    [ "$(git -C "$shallow" rev-parse --is-shallow-repository)" = "true" ]
    [ "$(git -C "$shallow" rev-list --count HEAD)" -eq 1 ]

    run "$shallow/infra/packaging/credits.sh"

    [ "$status" -eq 0 ]
    [[ "$output" == *'"contributors":[]'* ]]
    # The two facts a truncated history still holds are NOT withheld with it.
    [[ "$output" != *'"sha":null'* ]]
    [[ "$output" != *'"date":null'* ]]
    # The wrong answer, named, so this case fails if the refusal ever decays
    # back into a confident one-commit roll.
    [[ "$output" != *'"commits":1'* ]]

    # NEGATIVE CONTROL — the same fixture, unshallowed, DOES produce the roll.
    # Without this the emptiness above could equally mean "the script broke",
    # and a refusal that is really a breakage is not a cure.
    git -C "$shallow" fetch -q --unshallow
    [ "$(git -C "$shallow" rev-parse --is-shallow-repository)" = "false" ]
    run "$shallow/infra/packaging/credits.sh"
    [ "$status" -eq 0 ]
    [[ "$output" == *'{"name":"Ada Lovelace","nick":null,"commits":2}'* ]]
    [[ "$output" == *'{"name":"Grace Hopper","nick":null,"commits":1}'* ]]
}
