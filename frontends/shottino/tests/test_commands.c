/* test_commands — the command lists have to agree with the dispatcher.
 *
 * A slash command lives in three places in shottino.c: the dispatcher in
 * handle_input() that does the work, the `commands[]` table that makes it
 * tab-complete, and the show_command_help() chain that answers
 * `/help <verb>`. Nothing links them, so they drift — and they had: of the
 * 79 working verbs, 36 did not tab-complete and 32 had no help topic.
 *
 * Both gaps are invisible in use, and both read as "this command does not
 * exist" rather than as a bug in the client: Tab on a missing entry does
 * nothing, and /help on a missing topic says so in as many words. Neither
 * shows up as a warning or a crash, so this suite is the only thing that
 * notices.
 *
 * It asserts by SCANNING shottino.c for the dispatcher's own string
 * literals rather than by keeping a fourth list — a fourth list would be
 * one more thing to forget. The scan is deliberately dumb: it looks for the
 * exact shapes the dispatcher uses (`strcmp(line, "/verb"`,
 * `strncmp(line, "/verb "` and `verb_args(line, "/verb"`), so a NEW dispatch
 * shape reads as zero verbs and the floor assertion fails loudly instead of
 * passing vacuously.
 */
#define main shottino_main_unused
#include "../shottino.c"
#undef main

#include "test.h"

/* Verbs the dispatcher accepts but that are deliberately not offered for
 * completion. Empty today; an entry here needs its reason beside it. */
static const char *const completion_exempt[] = {NULL};

/* The oper verbs are dispatched from a TABLE rather than from an arm of
 * the else-if chain, so the scan below cannot see them — it looks for
 * the dispatcher's own string literals, and theirs live in
 * `oper_verbs[]`. They are added from the table itself (this suite
 * compiles shottino.c, so the table is right here), which keeps the
 * agreement the scan exists to enforce: whatever the table dispatches
 * must complete, and must explain itself. */
static bool is_oper_verb(const char *slashed) {
    for (size_t i = 0; i < sizeof(oper_verbs) / sizeof(oper_verbs[0]); i++)
        if (strcmp(oper_verbs[i].verb, slashed) == 0) return true;
    return false;
}

enum { MAX_VERBS = 256, VERB_MAX = 32, COMMAND_COUNT = sizeof(commands) / sizeof(commands[0]) };

static char verbs[MAX_VERBS][VERB_MAX];
static size_t verb_count;
static char *source;

static bool verb_known(const char *v) {
    for (size_t i = 0; i < verb_count; i++)
        if (strcmp(verbs[i], v) == 0) return true;
    return false;
}

static void verb_add(const char *v) {
    if (verb_known(v) || verb_count >= MAX_VERBS) return;
    snprintf(verbs[verb_count++], VERB_MAX, "%s", v);
}

static char *read_source(void) {
    /* `make check` runs from frontends/shottino; a hand-run from tests/
     * should work too rather than fail as if the lists were wrong. */
    const char *paths[] = {"shottino.c", "../shottino.c"};
    for (size_t i = 0; i < 2; i++) {
        FILE *f = fopen(paths[i], "rb");
        if (!f) continue;
        if (fseek(f, 0, SEEK_END) != 0) {
            fclose(f);
            continue;
        }
        long n = ftell(f);
        rewind(f);
        if (n <= 0) {
            fclose(f);
            continue;
        }
        char *buf = malloc((size_t)n + 1);
        size_t got = fread(buf, 1, (size_t)n, f);
        buf[got] = '\0';
        fclose(f);
        return buf;
    }
    return NULL;
}

/* Collect the verb from every `<needle>"/xxx"` occurrence, where the verb
 * ends at the closing quote or at the space before an argument. */
static void scan(const char *needle) {
    size_t nlen = strlen(needle);
    for (const char *p = source; (p = strstr(p, needle)) != NULL; p += nlen) {
        const char *q = p + nlen;
        if (*q != '"') continue;
        q++;
        if (*q != '/') continue;
        q++;
        /* Carries its own leading slash, so it is the same shape as a
         * commands[] entry and needs no second buffer to compare. */
        char verb[VERB_MAX] = "/";
        size_t n = 1;
        /* Lowercase and the hyphen: /preview-ascii is a verb, and a scan
         * that stopped at the '-' harvested "/preview" and then threw it
         * away for not ending at a quote — so the one verb missing from
         * the completion table was also the one verb this suite could
         * not see. Digits too, for the same reason: /e2e. */
        while (*q && (islower((unsigned char)*q) || isdigit((unsigned char)*q) || *q == '-') &&
               n + 1 < sizeof(verb))
            verb[n++] = *q++;
        verb[n] = '\0';
        /* A real verb ends at the quote, or at the space that separates it
         * from its arguments. Anything else was another literal's prefix. */
        if (n == 1) continue;
        if (*q != '"' && !(*q == ' ' && q[1] == '"')) continue;
        verb_add(verb);
    }
}

static bool in_completion_table(const char *slashed) {
    for (size_t i = 0; i < COMMAND_COUNT; i++)
        if (strcmp(commands[i], slashed) == 0) return true;
    return false;
}

static bool is_exempt(const char *slashed) {
    for (size_t i = 0; completion_exempt[i]; i++)
        if (strcmp(completion_exempt[i], slashed) == 0) return true;
    return false;
}

/* The scan found the dispatcher at all. Without this, a refactor that
 * changes the dispatch shape turns every assertion below into a vacuous
 * pass over an empty list. */
TEST(scan_finds_the_dispatcher) {
    CHECK(source != NULL);
    CHECK(verb_count > 60);
    CHECK(verb_known("/join"));
    CHECK(verb_known("/kick"));
    CHECK(verb_known("/media"));
}

TEST(every_dispatched_verb_completes) {
    for (size_t i = 0; i < verb_count; i++) {
        if (is_exempt(verbs[i])) continue;
        if (!in_completion_table(verbs[i]))
            fprintf(stderr, "  %s dispatches but is missing from commands[]\n", verbs[i]);
        CHECK(in_completion_table(verbs[i]));
    }
}

/* And the other direction: an entry left behind by a removed command
 * offers the user a verb that does nothing. */
TEST(every_completion_entry_dispatches) {
    for (size_t i = 0; i < COMMAND_COUNT; i++) {
        if (!verb_known(commands[i]))
            fprintf(stderr, "  %s completes but nothing dispatches it\n", commands[i]);
        CHECK(verb_known(commands[i]));
    }
}

/* Completion offers candidates in table order, so sorted is both the order
 * a user expects and the one that makes a missing entry visible when
 * reading the list. Strictly sorted, so it also rules out duplicates. */
TEST(completion_table_is_sorted) {
    for (size_t i = 1; i < COMMAND_COUNT; i++) {
        if (strcmp(commands[i - 1], commands[i]) >= 0)
            fprintf(stderr, "  commands[] out of order: %s before %s\n", commands[i - 1],
                    commands[i]);
        CHECK(strcmp(commands[i - 1], commands[i]) < 0);
    }
}

/* `/help <verb>` answers for every verb it accepts. The fallthrough prints
 * "no help for /x", which about a verb that works is worse than useless: it
 * says the command does not exist. show_command_help() matches the verb
 * without its slash, so that is the literal looked for here. */
TEST(every_dispatched_verb_has_a_help_topic) {
    /* The oper table carries its own usage string and show_command_help
     * consults it, so those verbs answer /help without an arm of their
     * own. That the strings are well-formed is asserted in
     * test_windows, next to the lines they build. */
    CHECK(strstr(source, "oper_verb_help(app, cmd)") != NULL);
    for (size_t i = 0; i < verb_count; i++) {
        if (is_oper_verb(verbs[i])) continue;
        char needle[VERB_MAX + 16];
        snprintf(needle, sizeof(needle), "strcmp(cmd, \"%s\")", verbs[i] + 1);
        if (!strstr(source, needle))
            fprintf(stderr, "  %s has no /help topic (add an arm to show_command_help)\n", verbs[i]);
        CHECK(strstr(source, needle) != NULL);
    }
}

/* The version is stated in five places — the sidebar, --version, the
 * --help banner, the --ircd numerics and every HTTP User-Agent — and
 * before version.h each of those spelled it itself. That is how a client
 * ends up announcing one version to the server and showing another to
 * the person using it. */
TEST(nothing_spells_its_own_version) {
    /* A literal `shottino/0.…` in the source is a User-Agent that has
     * escaped the one definition. */
    if (strstr(source, "shottino/0."))
        fprintf(stderr, "  a version literal is hardcoded; use SHOTTINO_USER_AGENT\n");
    CHECK(strstr(source, "shottino/0.") == NULL);
    CHECK(strstr(source, "SHOTTINO_USER_AGENT") != NULL);

    /* The wire string is BUILT from the number, so it cannot say
     * something else. */
    CHECK_STR(SHOTTINO_USER_AGENT, "shottino/" SHOTTINO_VERSION);

    /* And the number is a number: digits and dots, nothing else. A
     * version with a space in it would be a malformed User-Agent
     * header, which is a request the server may reject for reasons
     * nobody would think to look for here. */
    const char *v = SHOTTINO_VERSION;
    CHECK(v[0] != 0);
    for (size_t i = 0; v[i]; i++) CHECK((v[i] >= '0' && v[i] <= '9') || v[i] == '.');
}

/* The handshake DECLARES which protocol this client speaks.
 *
 * `client_proto` is the query parameter the server reads (CLIENT_PROTOCOL
 * §3b): below its floor it answers 426 rather than opening a socket that
 * would then drop frames on the floor. Omitting it is legal and means
 * "current", which is what shottino did — and "current" is a claim a
 * client that was last taught the wire at v21 cannot make. The URL is
 * built from ONE number so it cannot say something else, and that
 * number lives in wire.h beside the parsers it describes. `vsn` is
 * phoenix's transport serialiser version and is a different thing. */
TEST(the_handshake_declares_the_protocol_it_speaks) {
    char *req = ws_upgrade_request("grappa.example", "KEY==", "TOK");
    CHECK(req != NULL);
    if (!req) return;
    char want[64];
    snprintf(want, sizeof(want), "client_proto=%d", WIRE_PROTOCOL_VERSION);
    const char *line_end = strstr(req, "\r\n");
    CHECK(line_end != NULL);
    CHECK(strncmp(req, "GET /socket/websocket?", 22) == 0);
    CHECK(strstr(req, want) != NULL && strstr(req, want) < line_end);
    CHECK(strstr(req, "vsn=2.0.0") != NULL && strstr(req, "vsn=2.0.0") < line_end);
    /* Public, so it rides the URL; the bearer does not. */
    CHECK(strstr(req, "TOK") > line_end);
    CHECK(strstr(req, "Sec-WebSocket-Protocol: base64url.bearer.phx.TOK") != NULL);
    CHECK(strstr(req, "Host: grappa.example") != NULL);
    free(req);
}

/* At first contact the two numbers are compared and said in one line —
 * a newer server names what the user is missing and the repair, an
 * older one names the direction, so neither reads as "broken". */
TEST(a_protocol_gap_names_its_direction) {
    char line[256];
    protocol_report(30, 1, 30, line, sizeof(line));
    CHECK(strstr(line, "agree") != NULL);
    protocol_report(33, 1, 30, line, sizeof(line));
    CHECK(strstr(line, "v33") != NULL && strstr(line, "v30") != NULL);
    CHECK(strstr(line, "update shottino") != NULL);
    protocol_report(28, 1, 30, line, sizeof(line));
    CHECK(strstr(line, "v28") != NULL && strstr(line, "floor v1") != NULL);
    CHECK(strstr(line, "OLDER") != NULL);
}

/* Read a file from the repo, from either working directory the suites
 * run in. NULL when it is not there. Caller frees. */
static char *read_repo_file(const char *rel) {
    const char *prefixes[] = {"../../", "../../../"};
    for (size_t i = 0; i < 2; i++) {
        char path[512];
        snprintf(path, sizeof(path), "%s%s", prefixes[i], rel);
        FILE *f = fopen(path, "rb");
        if (!f) continue;
        fseek(f, 0, SEEK_END);
        long n = ftell(f);
        rewind(f);
        char *buf = n > 0 ? malloc((size_t)n + 1) : NULL;
        if (buf) {
            size_t got = fread(buf, 1, (size_t)n, f);
            buf[got] = 0;
        }
        fclose(f);
        if (buf) return buf;
    }
    return NULL;
}

/* The CLOSED SETS shottino mirrors are the server's, in the server's
 * order — pinned to the Elixir that declares them.
 *
 * The version pin below proves someone read `protocol.ex`; it does not
 * prove shottino learned what moved. It did not: the 2026-09-22
 * architecture review measured five drifts under a green pin, two of
 * them closed sets that made shottino DROP an event whole — `:failing`
 * (every connection_state_changed touching it) and `:admin` (every
 * /admin reply). Both are typed by hand in C because there is no
 * generated header; until there is, this is the gate that would have
 * caught them, and it fails on the next value the server adds rather
 * than on the next incident. */
TEST(the_closed_sets_are_the_servers_in_the_servers_order) {
    char *cred = read_repo_file("lib/grappa/networks/credential.ex");
    if (!cred) fprintf(stderr, "  credential.ex not found — run from the repo checkout\n");
    CHECK(cred != NULL);
    if (cred) {
        /* `@connection_states [:connected, :failing, :parked, :failed]` */
        const char *at = strstr(cred, "@connection_states [");
        CHECK(at != NULL);
        if (at) {
            for (size_t i = 0; i < wire_connection_state_count(); i++) {
                char want[64];
                snprintf(want, sizeof(want), ":%s", wire_connection_state_name((wire_connection_state)i));
                const char *found = strstr(at, want);
                /* Present, and in this position: the enum is ordinal,
                 * so a reordered server set renumbers every value. */
                CHECK(found != NULL);
                if (i) {
                    char prev[64];
                    snprintf(prev, sizeof(prev), ":%s",
                             wire_connection_state_name((wire_connection_state)(i - 1)));
                    CHECK(found > strstr(at, prev));
                }
            }
            /* And no value the server has that shottino lacks: count
             * the commas in the literal. */
            const char *close = strchr(at, ']');
            CHECK(close != NULL);
            size_t commas = 0;
            for (const char *q = at; q && close && q < close; q++)
                if (*q == ',') commas++;
            CHECK_LONG(commas + 1, wire_connection_state_count());
        }
        free(cred);
    }

    char *swire = read_repo_file("lib/grappa/session/wire.ex");
    CHECK(swire != NULL);
    if (swire) {
        /* `@server_reply_sources [:info, :version, :motd, :admin]` */
        const char *at = strstr(swire, "@server_reply_sources [");
        CHECK(at != NULL);
        const char *close = at ? strchr(at, ']') : NULL;
        CHECK(close != NULL);
        if (at && close) {
            static const char *const ours[] = {":info", ":version", ":motd", ":admin"};
            size_t n = sizeof(ours) / sizeof(ours[0]);
            const char *prev = at;
            for (size_t i = 0; i < n; i++) {
                const char *found = strstr(at, ours[i]);
                CHECK(found != NULL && found < close);
                if (found) { CHECK(found >= prev); prev = found; }
            }
            size_t commas = 0;
            for (const char *q = at; q < close; q++)
                if (*q == ',') commas++;
            /* REPLY_ADMIN is the fourth; a fifth source must land in
             * wire_reply_source and in the label that renders it. */
            CHECK_LONG(commas + 1, n);
        }
        free(swire);
    }
}

/* Every event kind cicchetto narrows is known to wire.c.
 *
 * The two clients read one contract, and the review found seven kinds
 * cic narrowed that shottino had never heard of — they reached the
 * unrecognised-kind arm and vanished. A kind shottino has no use for
 * (a peer's avatar, on a terminal) is still NARROWED and dropped
 * deliberately, so that arm keeps meaning "the server grew something
 * nobody here has looked at". */
TEST(every_kind_cicchetto_narrows_is_known_here) {
    char *cic = read_repo_file("cicchetto/src/lib/userTopic.ts");
    char *cic2 = read_repo_file("cicchetto/src/lib/wireNarrow.ts");
    if (!cic || !cic2) {
        /* A shottino-only checkout cannot run this; say so rather than
         * pass silently. */
        fprintf(stderr, "  cicchetto sources not found — kind parity not checked\n");
        free(cic);
        free(cic2);
        CHECK(cic != NULL && cic2 != NULL);
        return;
    }
    size_t checked = 0;
    for (int which = 0; which < 2; which++) {
        const char *src = which ? cic2 : cic;
        for (const char *p = src; (p = strstr(p, "case \"")) != NULL;) {
            p += 6;
            const char *end = strchr(p, '"');
            if (!end || end - p > 63) continue;
            char kind[64];
            size_t n = (size_t)(end - p);
            memcpy(kind, p, n);
            kind[n] = 0;
            /* Only the event-kind shape: lowercase, underscores, and the
             * digits of `e2e_*` — the shape once stopped at the digit, so
             * the nine E2E kinds slid past this test unread. A leading
             * digit is no kind. */
            bool plausible = n > 2 && kind[0] >= 'a' && kind[0] <= 'z';
            for (size_t i = 0; i < n; i++)
                if (!((kind[i] >= 'a' && kind[i] <= 'z') || (kind[i] >= '0' && kind[i] <= '9') ||
                      kind[i] == '_'))
                    plausible = false;
            if (!plausible) continue;
            if (!wire_kind_name_known(kind))
                fprintf(stderr, "  cicchetto narrows \"%s\"; wire.c does not know it\n", kind);
            CHECK(wire_kind_name_known(kind));
            checked++;
        }
    }
    /* A parity test that matched nothing would pass forever. */
    CHECK(checked > 20);
    free(cic);
    free(cic2);
}

/* The E2E closed sets are cicchetto's generated ones, value for value and
 * in order: `SESSION_WIRE_E2E_VERB = ["keys", "pkmsg", "msg", "nack"] as
 * const;` and its four siblings in wireTypes.ts, which the server's
 * typespecs generate. A value the server adds there reddens here, rather
 * than every event that carries it being dropped as malformed. */
static void pin_closed_set(const char *src, const char *name, const char *(*spell)(size_t),
                           size_t count) {
    char needle[96];
    snprintf(needle, sizeof(needle), "export const %s = [", name);
    const char *at = strstr(src, needle);
    if (!at) fprintf(stderr, "  %s not found in wireTypes.ts\n", name);
    CHECK(at != NULL);
    if (!at) return;
    const char *close = strchr(at, ']');
    CHECK(close != NULL);
    if (!close) return;
    size_t quoted = 0;
    const char *p = at + strlen(needle);
    for (;;) {
        const char *q = memchr(p, '"', (size_t)(close - p));
        if (!q) break;
        const char *e = memchr(q + 1, '"', (size_t)(close - q - 1));
        if (!e) break;
        char value[64];
        size_t n = (size_t)(e - q - 1);
        if (n >= sizeof(value)) n = sizeof(value) - 1;
        memcpy(value, q + 1, n);
        value[n] = 0;
        const char *ours = quoted < count ? spell(quoted) : "(none)";
        if (strcmp(value, ours) != 0)
            fprintf(stderr, "  %s[%zu]: server says \"%s\", wire.c says \"%s\"\n", name, quoted,
                    value, ours);
        CHECK_STR(ours, value);
        quoted++;
        p = e + 1;
    }
    CHECK_LONG(quoted, count);
}

static const char *spell_verb(size_t i) { return wire_e2e_verb_name((wire_e2e_verb)i); }
static const char *spell_drop(size_t i) { return wire_e2e_drop_reason_name((wire_e2e_drop_reason)i); }
static const char *spell_side(size_t i) { return wire_pairing_side_name((wire_pairing_side)i); }
static const char *spell_close(size_t i) {
    return wire_pairing_close_reason_name((wire_pairing_close_reason)i);
}
static const char *spell_req(size_t i) {
    return wire_e2e_request_state_name((wire_e2e_request_state)i);
}

TEST(the_e2e_closed_sets_are_the_servers) {
    char *src = read_repo_file("cicchetto/src/lib/wireTypes.ts");
    CHECK(src != NULL);
    if (!src) return;
    pin_closed_set(src, "SESSION_WIRE_E2E_VERB", spell_verb, wire_e2e_verb_count());
    pin_closed_set(src, "SESSION_WIRE_E2E_DROP_REASON", spell_drop, wire_e2e_drop_reason_count());
    pin_closed_set(src, "E2E_PAIRING_WIRE_SIDE", spell_side, wire_pairing_side_count());
    pin_closed_set(src, "E2E_PAIRING_WIRE_CLOSE_REASON", spell_close,
                   wire_pairing_close_reason_count());
    pin_closed_set(src, "E2E_REQUESTS_WIRE_WIRE_STATE", spell_req, wire_e2e_request_state_count());
    free(src);
}

/* The number shottino declares is the number the server publishes.
 *
 * `Grappa.Protocol` bumps `@protocol_version` on every wire-shape change,
 * additive included, and cic's `wire_pin` reddens when the shape moves
 * under a still number. shottino had no such tripwire, which is how it
 * sat unaware through nine bumps. This is it: when the server's number
 * moves, this test reddens, and whoever bumps it reads what changed
 * (`git log -p lib/grappa/protocol.ex`), teaches wire.c the new fields
 * or decides they do not apply to a terminal, and moves the constant.
 * A server newer than the client is NOT a failure at runtime — the wire
 * is additive — so this is a build-time question for a human, never a
 * refusal for the user. Read off disk, because the constant must agree
 * with the SOURCE the release is cut from, not with a running server. */
TEST(the_declared_protocol_is_the_one_the_server_publishes) {
    const char *paths[] = {"../../lib/grappa/protocol.ex", "../../../lib/grappa/protocol.ex"};
    char *ex = NULL;
    for (size_t i = 0; i < 2 && !ex; i++) {
        FILE *f = fopen(paths[i], "rb");
        if (!f) continue;
        fseek(f, 0, SEEK_END);
        long n = ftell(f);
        rewind(f);
        if (n > 0) {
            ex = malloc((size_t)n + 1);
            size_t got = fread(ex, 1, (size_t)n, f);
            ex[got] = 0;
        }
        fclose(f);
    }
    if (!ex) fprintf(stderr, "  lib/grappa/protocol.ex not found — run from the repo checkout\n");
    CHECK(ex != NULL);
    if (!ex) return;
    const char *at = strstr(ex, "\n  @protocol_version ");
    CHECK(at != NULL);
    long server = at ? strtol(at + strlen("\n  @protocol_version "), NULL, 10) : -1;
    if (server != WIRE_PROTOCOL_VERSION)
        fprintf(stderr, "  server publishes v%ld, wire.h declares v%d — read what moved and "
                        "update WIRE_PROTOCOL_VERSION\n",
                server, WIRE_PROTOCOL_VERSION);
    CHECK_LONG(server, WIRE_PROTOCOL_VERSION);
    free(ex);
}

/* The two call defaults are only correct TOGETHER.
 *
 * The room page derives the SFU from its own path, so moving it off
 * `/call/` breaks that derivation — and it had to move: the cicchetto
 * PWA on that origin answers every top-level navigation it has not
 * denylisted from its own cache, and `/call` is not on that list, so a
 * call link opened the PWA on every device with it installed. `/uploads`
 * IS denylisted.
 *
 * Shipping the new base_url WITHOUT the sfu_url beside it would be a
 * default that loads the page and then cannot reach the SFU — a worse
 * failure than the one it replaces, because it looks like it is
 * working. Hence one test over both, and a check that the old value is
 * gone rather than merely joined: leaving it behind is how one of a pair
 * gets updated later and the other does not. */
TEST(the_call_defaults_move_the_page_and_the_sfu_together) {
    CHECK(strstr(source, "\"https://grappa.nexlab.net/api/call\"") != NULL);
    CHECK(strstr(source, "\"https://grappa.nexlab.net/call/rtc\"") != NULL);
    CHECK(strstr(source, "\"https://grappa.nexlab.net/call\"") == NULL);
    /* And not the first attempt either: `/uploads/` is on the PWA's
     * denylist but THIS client reads any URL containing it as an image
     * (grappa serves uploads with no extension), so every call link
     * rendered as a broken picture. A prefix has to clear both clients'
     * heuristics. */
    CHECK(strstr(source, "\"https://grappa.nexlab.net/uploads/call\"") == NULL);
}

/* `$call` is a SECOND VIEW of one call, not a second place it lives.
 *
 * The call happens where it was placed: the picture-in-picture draw puts
 * it in whatever window is being read, the conversation included. This
 * tab exists only so the picture can have the whole screen when it is
 * wanted.
 *
 * The load-bearing part is the `false` — never focused. A tab that
 * appears is an offer; a tab that steals the screen moves you out of the
 * conversation you are having, which is what made the first version of
 * this feel wrong. Video only: an audio call has nothing to show, and a
 * tab drawing an empty box is worse than no tab. */
/* Leaving does not orphan a call.
 *
 * /quit and /exit only cleared `running`, so leaving mid-call left the
 * helper and its ffmpeg alive — still holding the webcam, with nothing
 * left to stop them — while the reader threads went on touching state
 * the exit was tearing down. That is a segfault on the way out AND a
 * camera nobody can use afterwards.
 *
 * Pinned by POSITION, because the fix is where it lives: the teardown
 * has to run where every exit passes, not on one verb. Attach it to
 * /quit and /exit misses it; attach it to both and the next exit path
 * misses it again. */
TEST(leaving_stops_a_running_call) {
    /* The EXIT SEQUENCE specifically, not merely somewhere in the same
     * function — there is another teardown inside the loop, for a call
     * that dropped on its own, and matching that one would make this
     * test pass with the exit path still broken. It did, before this
     * was tightened; a test that cannot fail is worse than none. */
    CHECK(strstr(source, "call_helper_stop(app);\n    mouse_reporting(false);") != NULL);
}

TEST(the_call_window_is_offered_never_forced) {
    CHECK(strstr(source, "if (video) add_window_ex(app, network, CALL_WINDOW, false);") != NULL);
    /* Not `true` under any spelling — that is the regression that would
     * put somebody in a video tab mid-sentence. */
    CHECK(strstr(source, "add_window_ex(app, network, CALL_WINDOW, true)") == NULL);
    /* And the small view still has its branch: one call, two sizes, one
     * decoded frame. */
    CHECK(strstr(source, "is_call_window(w->channel)") != NULL);
}

/* The two wiring points behind `call_invite_is_current`'s `ended` flag.
 *
 * The predicate itself is unit-tested; nothing reachable from a test can
 * observe who SETS the flag, and a flag nobody sets is a fix that does
 * not exist. Both live in the source, so the source is what gets read. */
TEST(a_stopped_call_marks_its_invite_spent) {
    /* Set where the call is torn down — one choke point for /hangup, an
     * SFU drop, a crash and closing the window alike. */
    CHECK(strstr(source, "app->call_last.ended = true;") != NULL);
    /* Matched on the window, not assumed: a call ending in #a says
     * nothing about an invite that arrived meanwhile in #b. */
    CHECK(strstr(source, "irc_name_eq(app->call_last.channel, app->call_live.channel)") != NULL);
    /* And cleared by a NEW invite, or one ended call would poison every
     * invite that followed it in the same window. */
    CHECK(strstr(source, "app->call_last.ended = false;") != NULL);
}

TEST(call_new_mints_rather_than_joining) {
    /* The override reaches call_command as `true`, and the plain verbs
     * still reach it as `false` — a `true` on those would mint a second
     * room every time two people called at once, which is the failure
     * the join-existing branch exists to prevent. */
    CHECK(strstr(source, "\"/call new\") == 0) {\n        call_command(app, CALL_AUDIO, true);") !=
          NULL);
    CHECK(strstr(source,
                 "\"/videocall new\") == 0) {\n        call_command(app, CALL_VIDEO, true);") !=
          NULL);
    CHECK(strstr(source, "call_command(app, CALL_AUDIO, false);") != NULL);
    CHECK(strstr(source, "call_command(app, CALL_VIDEO, false);") != NULL);
    /* And it is the flag that suppresses the join, not a second copy of
     * the currency test. */
    CHECK(strstr(source, "!fresh && call_invite_is_current(") != NULL);
    /* The advice printed when a call IS running has to name the way out
     * that exists. It used to say "/hangup first", which never cleared
     * the record and so never helped. */
    CHECK(strstr(source, "/call new (or /videocall new) mints a fresh room") != NULL);
}

/* An unverified marker writes nothing and rings nothing.
 *
 * The verdict and the host rule are unit-tested; what no test can
 * observe is the ORDER — that call_consider hands off to the queue and
 * returns, and that everything which writes call state or rings sits
 * behind the probe in call_invite_accept. Get that backwards and both
 * halves still pass while any link rings the terminal again. */
TEST(an_unchecked_invite_neither_rings_nor_is_remembered) {
    /* The gate: probing on means enqueue and return, nothing else. */
    CHECK(strstr(source, "if (!app->call_probe) {\n        call_invite_accept(") != NULL);
    CHECK(strstr(source, "struct job job = {.kind = JOB_CALL_PROBE, .num = (int)kind};") != NULL);
    /* Believing happens in ONE place, and the probe is the only caller
     * besides the probe-off shortcut above. */
    CHECK(strstr(source, "static void call_invite_accept(") != NULL);
    /* The ring and the record are inside it, not beside it. */
    size_t accept_at = (size_t)(strstr(source, "static void call_invite_accept(") - source);
    const char *ring = strstr(source, "app->call_ring_bell = true;");
    const char *record = strstr(source, "app->call_last.present = true;\n        /* A NEW invite");
    CHECK(ring != NULL && (size_t)(ring - source) > accept_at);
    CHECK(record != NULL && (size_t)(record - source) > accept_at);

    /* Checked by default: a default of off would ship the bug with a
     * setting that nobody turns on. */
    CHECK(strstr(source, "app->call_probe = true;") != NULL);

    /* The probe asks with OPTIONS and no credentials, and judges with
     * the shared verdict rather than a second local rule. */
    CHECK(strstr(source, "whip_request(&u, \"OPTIONS\", NULL, NULL, CALL_PROBE_TIMEOUT_MS") != NULL);
    CHECK(strstr(source, "whip_endpoint_verdict(resp.status, resp.accept_post)") != NULL);
    /* And judges by the ANSWER, not by the address. An address-class
     * filter here refused a LAN or VPN SFU — an ordinary setup — while
     * buying almost nothing, since nothing but a WHIP endpoint can
     * produce a pass. Named so it is not reintroduced by reflex. */
    CHECK(strstr(source, "call_probe_host_allowed") == NULL);

    /* Never on the socket thread: the probe reaches the worker through
     * the job queue, like every other network round trip here. */
    CHECK(strstr(source, "case JOB_CALL_PROBE:\n            call_probe_job(app, &job);") != NULL);

    /* And being on the worker, it SNAPSHOTS what it needs rather than
     * reading app state live. call_sfu_base trims its buffer in place,
     * so the probe must not be the thing that calls it — a write racing
     * /set is not a bug any test could reproduce afterwards. */
    CHECK(strstr(source, "call_rtc_base_from(sfu, job->arg1, rtc, sizeof(rtc));") != NULL);
    CHECK(strstr(source, "snprintf(sfu, sizeof(sfu), \"%s\", call_sfu_base(app));") != NULL);
}

/* The invite's SFU has to be consulted at the ONE place the media base
 * is derived, or half the call paths read it and half do not. */
TEST(the_terminal_reads_the_invites_sfu) {
    CHECK(strstr(source, "else if (call_invite_sfu_of(room_url, theirs, sizeof(theirs)))") != NULL);
    /* Ahead of our own setting, which is the whole point — reading ours
     * first is the bug. */
    size_t theirs = (size_t)(strstr(source, "call_invite_sfu_of(room_url, theirs") - source);
    size_t ours = (size_t)(strstr(source, "else if (sfu && sfu[0])") - source);
    CHECK(theirs < ours);
    /* One derivation, so the probe and the publish cannot disagree about
     * where the SFU is. */
    CHECK(strstr(source, "static void call_rtc_base_from(") != NULL);
}

/* Reaching the top of a pane reaches the bouncer.
 *
 * history_wanted and the insertion are unit-tested; what no test can
 * observe is the WIRING — that the draw path is what asks, that it asks
 * through the queue, and that the page it asks for is bounded by the
 * window's own oldest row rather than by wall-clock or by nothing. */
TEST(the_top_of_a_pane_asks_for_what_came_before_it) {
    /* Asked only from INSIDE the at_top branch: the walk is the one
     * thing that knows the pane reached the oldest row the buffer holds
     * for this window, and that — not the scroll gesture on its own — is
     * what a fetch answers. */
    const char *top = strstr(source, "    if (view.at_top) {");
    const char *ask = strstr(source, "if (history_wanted(pane->scroll_pinned");
    const char *after = top ? strstr(top, "\n    }\n") : NULL;
    CHECK(top != NULL && ask != NULL && after != NULL);
    CHECK(ask > top && ask < after);
    CHECK(strstr(source, "request_older_history_locked(app, w);") != NULL);

    /* And the walk itself never leaves the process. Scrolling moves a
     * window over the buffer that is already here; the buffer running
     * out is a different event, and it is the only one that reaches
     * grappa. A fetch inside the walk would put an HTTP round trip on
     * the draw path once per frame. */
    const char *walk = strstr(source, "static void pane_view_collect(");
    CHECK(walk != NULL);
    size_t walk_len = (size_t)(strstr(walk, "\n}\n") - walk);
    char *body = strndup(walk, walk_len);
    CHECK(body != NULL);
    CHECK(strstr(body, "http_request") == NULL);
    CHECK(strstr(body, "enqueue_job") == NULL);
    CHECK(strstr(body, "fetch_") == NULL);
    free(body);

    /* Through the queue: an HTTP round trip on the draw path would stop
     * the client for as long as the bouncer took to answer. */
    CHECK(strstr(source, "case JOB_HISTORY:\n            fetch_older_scrollback(") != NULL);
    /* And queued QUIETLY. The talking form reports through log_line,
     * which takes app->lock — the lock the draw path is holding. A full
     * queue would have hung the client instead of dropping a job. */
    CHECK(strstr(source, "if (enqueue_job_quiet(app, job)) w->history_inflight = true;") != NULL);

    /* The cursor is the window's own oldest id, and the page is the same
     * size the window opened with. */
    CHECK(strstr(source, "messages?before=%ld&limit=%d") != NULL);
    CHECK(strstr(source, "window_oldest_id_locked(app, window_scope_id_locked(app, w->network,") !=
          NULL);

    /* Written above the rows already there, by marking the ONE door
     * rather than teaching the ingest to insert — a page renders through
     * exactly the path a live message does. */
    CHECK(strstr(source, "window_first_row_locked(app, window_scope_id_locked(app, network, channel))") !=
          NULL);
    CHECK(strstr(source, "app->log_insert_active = true;") != NULL);
    /* The id stamp follows the row rather than the tail. */
    CHECK(strstr(source, "app->log_ids[app->log_last_index] = id;") != NULL);

    /* Only an empty page latches the window shut. An HTTP failure is not
     * the server saying there is nothing older, and treating it as one
     * would end paging for the session on a single blip. */
    CHECK(strstr(source, "if (ok && got == 0) app->windows[i].history_exhausted = true;") != NULL);
}

int main(void) {
    test_use_temp_home();

    source = read_source();
    if (!source) {
        fprintf(stderr, "test_commands: cannot read shottino.c (run from frontends/shottino)\n");
        return 1;
    }
    scan("strcmp(line, ");
    scan("strncmp(line, ");
    /* The third shape: a WHOLE-WORD match. /who and /names moved to it
     * because a bare strncmp let /whois fall into /who carrying an
     * argument. Adding the shape here is what the floor assertion is
     * for — it failed loudly the moment the dispatcher grew one. */
    scan("verb_args(line, ");
    for (size_t i = 0; i < sizeof(oper_verbs) / sizeof(oper_verbs[0]); i++)
        verb_add(oper_verbs[i].verb);

    RUN(scan_finds_the_dispatcher);
    RUN(every_dispatched_verb_completes);
    RUN(every_completion_entry_dispatches);
    RUN(completion_table_is_sorted);
    RUN(every_dispatched_verb_has_a_help_topic);
    RUN(nothing_spells_its_own_version);
    RUN(the_handshake_declares_the_protocol_it_speaks);
    RUN(a_protocol_gap_names_its_direction);
    RUN(the_declared_protocol_is_the_one_the_server_publishes);
    RUN(the_closed_sets_are_the_servers_in_the_servers_order);
    RUN(every_kind_cicchetto_narrows_is_known_here);
    RUN(the_e2e_closed_sets_are_the_servers);
    RUN(the_call_defaults_move_the_page_and_the_sfu_together);
    RUN(leaving_stops_a_running_call);
    RUN(a_stopped_call_marks_its_invite_spent);
    RUN(call_new_mints_rather_than_joining);
    RUN(an_unchecked_invite_neither_rings_nor_is_remembered);
    RUN(the_terminal_reads_the_invites_sfu);
    RUN(the_top_of_a_pane_asks_for_what_came_before_it);
    RUN(the_call_window_is_offered_never_forced);

    free(source);
    return test_report();
}
