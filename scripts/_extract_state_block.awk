# scripts/_extract_state_block.awk
#
# Extracts the `@type t :: %{...}` AND `defstruct ...` blocks from an
# Elixir source file on stdin, normalizes whitespace, and writes the
# result to stdout. Called by `scripts/deploy.sh` preflight Class 3
# (B6.5 HIGH-27 / `feedback_deploy_sh_preflight_field_addition_gap`)
# to detect field-additions INSIDE these blocks — the marker-line
# regex above only catches the `@type t :: %{` / `defstruct` line
# itself being added or removed, missing the more common case where
# a field is appended inside an existing block.
#
# Brace-matching is done in awk because regex can't match balanced
# delimiters — and HIGH-27's whole point is that regex is exactly the
# bug class. We track three nesting depths because Elixir embeds maps
# inside types: `@type t :: %{members: %{String.t() => list}, ...}`.
#   - paren_depth: ( ) for function-shaped types like `String.t()`
#   - brace_depth: { } for tuple types or struct shapes
#   - map_depth:   %{ } for map types — the one we actually care about
#
# The block starts when we see `@type t ::` OR `defstruct` and ends
# when ALL balanced delimiters return to zero AND we hit a newline
# (end of statement).
#
# Output normalization: collapse runs of whitespace (incl. newlines)
# to single spaces. This means cosmetic re-indentation doesn't
# trigger a false-positive COLD — only actual field-set changes do.
#
# Used by: scripts/deploy.sh preflight Class 3 (no-silent-drops B6.5).

BEGIN {
    in_type = 0
    in_defstruct = 0
    paren = 0
    brace = 0
    map = 0
    buffer = ""
    output = ""
}

# Strip line comments (Elixir #) — keeps strings intact since shell-
# level invocation feeds source-as-text and we only care about the
# structural tokens. A `#` inside a string would be a false-strip
# but the resulting noise still differs the same way before+after,
# so the comparison stays sound.
function strip_comment(line,    i, c, in_str) {
    in_str = 0
    for (i = 1; i <= length(line); i++) {
        c = substr(line, i, 1)
        if (c == "\"" && substr(line, i-1, 1) != "\\") in_str = !in_str
        if (c == "#" && !in_str) return substr(line, 1, i - 1)
    }
    return line
}

function track_delims(line,    i, c) {
    for (i = 1; i <= length(line); i++) {
        c = substr(line, i, 1)
        if (c == "(") paren++
        else if (c == ")") paren--
        else if (c == "{") {
            # `%{` is a map open; bare `{` is a tuple/brace open.
            if (i > 1 && substr(line, i-1, 1) == "%") map++
            else brace++
        }
        else if (c == "}") {
            # We can't tell from the closing brace alone whether it
            # closed a map or a brace; pop the deeper of the two
            # (Elixir source is always well-formed so prefer map first).
            if (map > 0) map--
            else if (brace > 0) brace--
        }
    }
}

{
    line = strip_comment($0)

    if (!in_type && !in_defstruct) {
        if (line ~ /@type[ \t]+t[ \t]*::/) {
            in_type = 1
            buffer = line
            track_delims(line)
            if (paren == 0 && brace == 0 && map == 0) {
                output = output " " buffer
                buffer = ""
                in_type = 0
            }
            next
        }
        if (line ~ /^[ \t]*defstruct[ \t]/) {
            in_defstruct = 1
            buffer = line
            track_delims(line)
            # defstruct doesn't always open a delimiter (e.g.
            # `defstruct [:a, :b]` opens `[` which we don't track).
            # Use a simpler heuristic: defstruct ends at the next
            # blank line or at any line that doesn't continue the
            # list (starts with non-space + non-comma).
            if (line !~ /,[ \t]*$/ && line !~ /\[[^\]]*$/) {
                output = output " " buffer
                buffer = ""
                in_defstruct = 0
            }
            next
        }
    }

    if (in_type) {
        buffer = buffer " " line
        track_delims(line)
        if (paren == 0 && brace == 0 && map == 0) {
            output = output " " buffer
            buffer = ""
            in_type = 0
        }
        next
    }

    if (in_defstruct) {
        buffer = buffer " " line
        if (line !~ /,[ \t]*$/ && line ~ /\]/) {
            output = output " " buffer
            buffer = ""
            in_defstruct = 0
        } else if (line ~ /^[ \t]*$/) {
            # Blank line ends a multi-line defstruct list (defensive).
            output = output " " buffer
            buffer = ""
            in_defstruct = 0
        }
        next
    }
}

END {
    # Collapse runs of whitespace (incl. tabs/newlines) to single
    # spaces so cosmetic reformat doesn't trigger COLD.
    gsub(/[ \t\n]+/, " ", output)
    sub(/^[ \t]+/, "", output)
    sub(/[ \t]+$/, "", output)
    print output
}
