#!/usr/bin/env bats
#
# GH #1029 — the nginx access log carries no duration and no correlation id,
# so a request-level diagnosis is blind. The #394 re-measurement counted 20
# client aborts over 45,135 requests and could not attribute ONE of them.
#
# The host half (m42's `/usr/local/etc/nginx/sites/irc.openssl.it`) is out of
# this repo and already live. This suite guards the IN-REPO half: the
# substrates must log the SAME shape, or a diagnosis rehearsed locally reads
# differently from the one run in production — which is the whole point of
# the parity ask, not a tidiness preference.
#
# The subject is the SHAPE OF THE LOG LINE an operator gets, and the failure
# mode being guarded is DRIFT: three substrates each growing their own
# slightly-different `log_format` until the logs stop being comparable. So
# every assertion here is derived from the tree rather than hardcoded —
# "every conf with an http block includes the one snippet", not "these two
# files contain this string". A NEW substrate added next year fails this
# suite until it joins the format, which a hardcoded list would not do.
#
# What this suite does NOT do: run `nginx -t`. That needs a real nginx, and
# the e2e stack already provides one — `cicchetto/e2e/nginx-test.conf` mounts
# the snippet and nginx-test refuses to start on a syntax error, taking every
# e2e spec down with it. Syntax is gated there; SHAPE is gated here.

REPO_ROOT="$BATS_TEST_DIRNAME/../.."
SNIPPET="infra/snippets/log-format.conf"

# Every nginx conf in the worktree, whatever its context — the search space
# for a stray second definition.
#
# `--cached --others --exclude-standard`, not plain `ls-files`: a conf that
# has been WRITTEN but not yet staged is exactly the moment this guard is
# most useful, and a tracked-only listing would wave it through while still
# reporting green. `--exclude-standard` keeps gitignored trees (node_modules,
# _build) out.
all_confs() {
    git -C "$REPO_ROOT" ls-files --cached --others --exclude-standard -- '*.conf' 2>/dev/null
}

# The confs that open an `http { }` block, i.e. the ones that can host a
# `log_format` (the directive is http-context only). Derived, so a new
# substrate is in scope the day it appears.
#
# This deliberately EXCLUDES infra/nginx-tls-frontend.example.conf: it is a
# server-context fragment dropped into an operator's own nginx, so it can
# neither define a format nor reference one this repo controls.
http_context_confs() {
    all_confs | while IFS= read -r f; do
        grep -q '^http {' "$REPO_ROOT/$f" && printf '%s\n' "$f"
    done || true
}

@test "log_format is defined exactly once, in the shared snippet (#1029)" {
    # `|| true` on the substitution, not inside: the loop's status is the LAST
    # grep's, so a final non-matching conf would abort the body under errexit
    # before the comparison ever runs.
    definers="$(all_confs | while IFS= read -r f; do
        grep -qE '^[[:space:]]*log_format[[:space:]]' "$REPO_ROOT/$f" && printf '%s\n' "$f"
    done || true)"

    [ "$definers" = "$SNIPPET" ] || {
        echo "expected exactly one log_format definition site ($SNIPPET), got:" >&2
        printf '%s\n' "${definers:-<none>}" >&2
        return 1
    }
}

@test "the shared format carries every field the #1029 diagnosis needs" {
    fmt="$REPO_ROOT/$SNIPPET"

    # $request_time answers five of the six questions in the issue on its own
    # (8s bootFetch ceiling vs teardown, the 60s edge ceiling wearing a 499,
    # aborts per second-in-flight, slow-server vs departed-client).
    grep -q 'rt=\$request_time' "$fmt" || { echo "missing rt=\$request_time" >&2; return 1; }

    # upstream_* separates "the BEAM was slow" from "the edge was slow", and
    # exposes a retry.
    grep -q 'urt=\$upstream_response_time' "$fmt" || { echo "missing urt=\$upstream_response_time" >&2; return 1; }
    grep -q 'us=\$upstream_status' "$fmt" || { echo "missing us=\$upstream_status" >&2; return 1; }

    # THE join key. Phoenix already emits x-request-id (Plug.RequestId) and
    # already logs request_id in its Logger metadata; without this field the
    # two logs cannot be joined at all, which is the single line this issue
    # is really about.
    grep -q 'rid=\$sent_http_x_request_id' "$fmt" || { echo "missing rid=\$sent_http_x_request_id" >&2; return 1; }

    # Millisecond resolution — with $time_local alone, one suspend event is
    # indistinguishable from N independent aborts in the same second.
    grep -q 'msec=\$msec' "$fmt" || { echo "missing msec=\$msec" >&2; return 1; }
}

@test "the appended fields come AFTER the user-agent, positionally (#1029)" {
    # Not cosmetic. These logs are shipped off m42 by syslog-ng into a
    # telegraf collector that parses `combined` POSITIONALLY: client IP
    # first, then the first quoted string is the request line, the next two
    # tokens are status and bytes, then referer and user-agent are the first
    # two quoted strings of the remainder. Anything INTERLEAVED silently
    # mis-assigns every downstream field; anything appended is ignored.
    # vjt verified this against VictoriaLogs when applying the host half.
    fmt="$REPO_ROOT/$SNIPPET"
    flat="$(tr -d " \n'" < "$fmt")"

    case "$flat" in
        *'"$http_user_agent""$http_x_forwarded_for"rt=$request_time'*) ;;
        *)
            echo "the rt=/urt=/us=/rid=/msec= tail must follow the user-agent and" >&2
            echo "x-forwarded-for pair verbatim — an interleaved field breaks the" >&2
            echo "positional collector parser on m42. Got:" >&2
            cat "$fmt" >&2
            return 1
            ;;
    esac
}

@test "the shared snippet USES the format it defines (#1029)" {
    # Defining a format nobody references changes not one byte of the log —
    # the hollow-green version of this whole change. The format NAME is read
    # back out of the definition rather than hardcoded, so renaming it in one
    # place and not the other still fails here.
    fmt="$REPO_ROOT/$SNIPPET"

    name="$(sed -nE 's/^[[:space:]]*log_format[[:space:]]+([A-Za-z0-9_]+).*/\1/p' "$fmt" | head -n1)"
    [ -n "$name" ] || { echo "could not read the log_format name out of $SNIPPET" >&2; return 1; }

    grep -qE "^[[:space:]]*access_log[[:space:]]+\S+[[:space:]]+${name}[[:space:]]*;" "$fmt" || {
        echo "no access_log references the '${name}' format in $SNIPPET:" >&2
        cat "$fmt" >&2
        return 1
    }
}

@test "every http-context nginx conf includes the shared snippet (#1029)" {
    confs="$(http_context_confs)"

    # Anti-vacuous: two substrates exist today (infra/linux, cicchetto/e2e).
    # A broken derivation returning nothing would otherwise pass loudly.
    count="$(printf '%s\n' "$confs" | grep -c . || true)"
    [ "$count" -ge 2 ] || {
        echo "expected >=2 http-context nginx confs, found $count — the derivation is wrong:" >&2
        printf '%s\n' "$confs" >&2
        return 1
    }

    violations="$(printf '%s\n' "$confs" | while IFS= read -r f; do
        grep -q 'include .*log-format\.conf;' "$REPO_ROOT/$f" || printf '%s\n' "$f"
    done)"

    [ -z "$violations" ] || {
        echo "nginx conf(s) with an http block that do NOT include $SNIPPET (#1029):" >&2
        printf '%s\n' "$violations" >&2
        return 1
    }
}

@test "install_nginx.sh installs every snippet the linux conf includes (#1029)" {
    # The native-host failure this closes: the conf includes a snippet the
    # installer never copies, so `nginx -t` fails at install time on a real
    # host — after the config has already been written to /etc/nginx.
    # Derived from the conf's own include lines, so the next snippet added is
    # covered without touching this test.
    conf="$REPO_ROOT/infra/linux/nginx.conf"
    installer="$REPO_ROOT/infra/linux/install_nginx.sh"

    includes="$(sed -nE 's@^[[:space:]]*include[[:space:]]+snippets/([A-Za-z0-9_.-]+);.*@\1@p' "$conf")"

    count="$(printf '%s\n' "$includes" | grep -c . || true)"
    [ "$count" -ge 2 ] || {
        echo "expected >=2 snippet includes in infra/linux/nginx.conf, found $count:" >&2
        printf '%s\n' "$includes" >&2
        return 1
    }

    violations="$(printf '%s\n' "$includes" | while IFS= read -r snip; do
        grep -q "snippets/${snip}" "$installer" || printf '%s\n' "$snip"
    done)"

    [ -z "$violations" ] || {
        echo "snippet(s) included by nginx.conf but never installed by install_nginx.sh:" >&2
        printf '%s\n' "$violations" >&2
        return 1
    }
}

@test "the e2e stack mounts the snippets directory into nginx-test (#1029)" {
    # The e2e includer resolves /etc/nginx/snippets/log-format.conf from a
    # bind mount of the whole infra/snippets dir. Drop the mount and nginx
    # dies at startup, taking the whole e2e run with it — a slow, confusing
    # red compared to this line.
    compose="$REPO_ROOT/cicchetto/e2e/compose.yaml"

    grep -qE '^\s*-\s*\.\./\.\./infra/snippets:/etc/nginx/snippets:ro\s*$' "$compose" || {
        echo "cicchetto/e2e/compose.yaml no longer mounts infra/snippets into nginx-test:" >&2
        grep -n 'snippets' "$compose" >&2
        return 1
    }
}
