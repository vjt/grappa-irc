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
         * not see. */
        while (*q && (islower((unsigned char)*q) || *q == '-') && n + 1 < sizeof(verb))
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

    free(source);
    return test_report();
}
