/* test_keys — what the client does with the bytes a terminal sends.
 *
 * Every key bug in shottino so far has been a DELIVERY bug, not a
 * handler bug: the roster was bound to KEY_SPREVIOUS, which most
 * terminfo entries never define, so the key arrived as an undecoded
 * escape burst and the list never moved. Reasoning about that from the
 * source is how it shipped twice.
 *
 * So this suite writes the actual bytes into a pty and asks getch()
 * what came out, through the client's own decode path — define_pane_keys()
 * plus resolve_escape(). Two terminfo entries matter and they fail
 * differently:
 *
 *   xterm-256color  describes modified arrows, so ncurses decodes them
 *                   and our define_key() has to WIN over what terminfo
 *                   already bound;
 *   screen-256color describes none of them, so the bytes fall through
 *                   to resolve_escape() — the case that used to type
 *                   "1;5A" into the input line.
 *
 * A host without a pty, or without those entries, skips rather than
 * fails: the suite asserts shottino's decoding, not the host's
 * terminal database. */
#define main shottino_main_unused
#include "../shottino.c"
#undef main

#include "test.h"
#include <pty.h>

/* Feed one sequence and read back the single key it should become.
 * Anything left in the queue afterwards is reported by the caller: a
 * sequence that decodes to a key PLUS four stray bytes is the bug this
 * file exists for, and "the first code was right" would hide it. */
static int decode(int mfd, size_t *leftover) {
    int ch = getch();
    if (ch == 27) ch = resolve_escape();
    *leftover = 0;
    while (getch() != ERR) (*leftover)++;
    (void)mfd;
    return ch;
}

struct expectation {
    const char *name;
    const char *seq;
    int code;
};

static void run_expectations(const char *term, const struct expectation *cases, size_t n) {
    int mfd, sfd;
    if (openpty(&mfd, &sfd, NULL, NULL, NULL) != 0) {
        fprintf(stderr, "test_keys: no pty — skipping %s\n", term);
        return;
    }
    FILE *in = fdopen(sfd, "r+");
    FILE *out = fdopen(dup(sfd), "w");
    SCREEN *screen = in && out ? newterm(term, out, in) : NULL;
    if (!screen) {
        fprintf(stderr, "test_keys: no terminfo for %s — skipping\n", term);
        close(mfd);
        return;
    }
    cbreak();
    noecho();
    keypad(stdscr, TRUE);
    define_pane_keys();
    timeout(200);

    for (size_t i = 0; i < n; i++) {
        size_t leftover = 0;
        ssize_t w = write(mfd, cases[i].seq, strlen(cases[i].seq));
        (void)w;
        usleep(20000);
        int got = decode(mfd, &leftover);
        if (got != cases[i].code || leftover != 0)
            fprintf(stderr, "  %s/%s: got %d (want %d), %zu bytes left over\n", term,
                    cases[i].name, got, cases[i].code, leftover);
        CHECK_LONG(got, cases[i].code);
        /* Nothing may be left behind. Leftover bytes do not vanish —
         * they are typed into the input line. */
        CHECK_LONG((long)leftover, 0);
    }
    endwin();
    delscreen(screen);
    close(mfd);
}

/* The same sequences must mean the same thing whether terminfo
 * describes them or not. */
static const struct expectation MODIFIED_KEYS[] = {
    {"Ctrl-Shift-Up",   "\033[1;6A", KEY_ROSTER_UP},
    {"Ctrl-Shift-Down", "\033[1;6B", KEY_ROSTER_DOWN},
    {"Shift-Up",        "\033[1;2A", KEY_ROSTER_UP},
    {"Shift-Down",      "\033[1;2B", KEY_ROSTER_DOWN},
    {"Shift-PgUp",      "\033[5;2~", KEY_ROSTER_UP},
    {"Shift-PgDn",      "\033[6;2~", KEY_ROSTER_DOWN},
    {"Ctrl-Up",         "\033[1;5A", KEY_CHAT_UP},
    {"Ctrl-Down",       "\033[1;5B", KEY_CHAT_DOWN},
    {"Ctrl-Alt-Up",     "\033[1;7A", KEY_PANE_PREV},
    {"Ctrl-Alt-Down",   "\033[1;7B", KEY_PANE_NEXT},
    {"Alt-Up",          "\033[1;3A", KEY_PANE_PREV},
    {"Alt-Down",        "\033[1;3B", KEY_PANE_NEXT},
    /* Ctrl-Tab walks the WINDOW list, in both spellings terminals use:
     * xterm's modifyOtherKeys form and the CSI-u form kitty, foot and
     * wezterm send. Terminfo describes neither, which is exactly why
     * they are bound directly. */
    {"Ctrl-Tab",        "\033[27;5;9~", KEY_WIN_NEXT},
    {"Ctrl-Tab (CSI-u)", "\033[9;5u",   KEY_WIN_NEXT},
    {"Ctrl-Shift-Tab",  "\033[27;6;9~", KEY_WIN_PREV},
    {"Ctrl-Shift-Tab (CSI-u)", "\033[9;6u", KEY_WIN_PREV},
    {"plain Up",        "\033[A",    KEY_UP},
    {"plain Down",      "\033[B",    KEY_DOWN},
};

TEST(modified_keys_decode_where_terminfo_describes_them) {
    run_expectations("xterm-256color", MODIFIED_KEYS,
                     sizeof(MODIFIED_KEYS) / sizeof(MODIFIED_KEYS[0]));
}

TEST(modified_keys_decode_where_terminfo_describes_nothing) {
    /* screen/tmux: ncurses knows none of these sequences, so they reach
     * resolve_escape() as raw bytes. Before it read the sequence to its
     * end, the ESC was eaten and "1;5A" was typed into the input. */
    run_expectations("screen-256color", MODIFIED_KEYS,
                     sizeof(MODIFIED_KEYS) / sizeof(MODIFIED_KEYS[0]));
}

/* The member list only holds the keyboard when it is asked to, and
 * hands it straight back to anything that is not a movement. */
TEST(roster_focus_takes_the_arrows_and_gives_them_back) {
    struct app *app = calloc(1, sizeof(*app));
    CHECK(app != NULL);
    if (!app) return;
    pthread_mutex_init(&app->lock, NULL);
    struct window *w = &app->windows[app->window_count++];
    snprintf(w->network, sizeof(w->network), "%s", "azzurra");
    snprintf(w->channel, sizeof(w->channel), "%s", "#chan");
    w->member_count = 40;
    app->pane_count = 1;

    /* Without focus the arrows belong to the input history. */
    CHECK(!roster_key(app, KEY_UP));
    CHECK(!roster_key(app, KEY_DOWN));

    CHECK(roster_key(app, 21)); /* Ctrl-U */
    CHECK(app->roster_focus);
    CHECK(roster_key(app, KEY_DOWN));
    CHECK_LONG(app->panes[0].member_offset, 1);
    CHECK(roster_key(app, KEY_NPAGE));
    CHECK_LONG(app->panes[0].member_offset, 11);
    CHECK(roster_key(app, KEY_UP));
    CHECK_LONG(app->panes[0].member_offset, 10);
    CHECK(roster_key(app, KEY_HOME));
    CHECK_LONG(app->panes[0].member_offset, 0);

    /* Escape leaves the mode and does nothing else. */
    CHECK(roster_key(app, 27));
    CHECK(!app->roster_focus);

    /* Typing while focused is not swallowed: the mode ends and the key
     * goes on to be handled as usual, so there is nothing to get stuck
     * in. */
    CHECK(roster_key(app, 21));
    CHECK(app->roster_focus);
    CHECK(!roster_key(app, 'a'));
    CHECK(!app->roster_focus);

    /* A window with no members has no list to focus. */
    w->member_count = 0;
    CHECK(roster_key(app, 21));
    CHECK(!app->roster_focus);

    for (size_t i = 0; i < app->log_count; i++) free(app->log[i]);
    pthread_mutex_destroy(&app->lock);
    free(app);
}

/* The line can be EDITED, not just appended to.
 *
 * There was no cursor at all: characters went on the end and Backspace
 * came off the end, so fixing a typo four words back meant deleting
 * four words. Arrows now move within the line, and everything that
 * writes at the cursor has to respect where it is. */
TEST(the_input_line_has_a_cursor_you_can_move) {
    struct app *app = calloc(1, sizeof(*app));
    if (!app) return;
    pthread_mutex_init(&app->lock, NULL);

    for (const char *p = "ciao"; *p; p++) input_append_wide(app, (wchar_t)*p);
    CHECK_STR(app->input, "ciao");
    CHECK_LONG(app->input_pos, 4);

    /* Left three, then insert: the text lands where the cursor is. */
    input_move(app, -1);
    input_move(app, -1);
    input_move(app, -1);
    CHECK_LONG(app->input_pos, 1);
    input_append_wide(app, L'X');
    CHECK_STR(app->input, "cXiao");
    CHECK_LONG(app->input_pos, 2);

    /* Backspace takes the character BEFORE the cursor, not the last one. */
    input_backspace(app);
    CHECK_STR(app->input, "ciao");
    CHECK_LONG(app->input_pos, 1);

    /* Delete takes the one AT the cursor. */
    input_delete(app);
    CHECK_STR(app->input, "cao");
    CHECK_LONG(app->input_pos, 1);

    /* Home and End are the ends of the line. */
    input_jump(app, true);
    CHECK_LONG(app->input_pos, 3);
    input_jump(app, false);
    CHECK_LONG(app->input_pos, 0);

    /* Moving past either end stays put rather than running off. */
    input_move(app, -1);
    CHECK_LONG(app->input_pos, 0);
    input_backspace(app);
    CHECK_STR(app->input, "cao");
    input_jump(app, true);
    input_move(app, 1);
    CHECK_LONG(app->input_pos, 3);
    input_delete(app);
    CHECK_STR(app->input, "cao");

    /* The locale the terminal runs in; without it wcrtomb cannot encode
     * a non-ASCII character at all and the test would be asserting
     * about an empty buffer. */
    CHECK(setlocale(LC_ALL, "C.UTF-8") != NULL || setlocale(LC_ALL, "en_US.UTF-8") != NULL);

    /* The locale the terminal runs in; without it wcrtomb cannot encode
     * a non-ASCII character and the test would assert about an empty
     * buffer rather than about the cursor. */
    CHECK(setlocale(LC_ALL, "C.UTF-8") != NULL || setlocale(LC_ALL, "en_US.UTF-8") != NULL);

    /* A multibyte character is ONE step, and one delete, in both
     * directions — the cursor never lands inside one. */
    app->input[0] = 0;
    app->input_len = app->input_pos = 0;
    input_append_wide(app, L'a');
    input_append_wide(app, L'é');
    input_append_wide(app, L'b');
    CHECK_LONG(app->input_len, 4);
    input_move(app, -1);          /* before b */
    CHECK_LONG(app->input_pos, 3);
    input_move(app, -1);          /* before é, not inside it */
    CHECK_LONG(app->input_pos, 1);
    input_delete(app);            /* removes é whole */
    CHECK_STR(app->input, "ab");

    pthread_mutex_destroy(&app->lock);
    free(app);
}

/* A key that arrives mid-escape-sequence must SURVIVE it.
 *
 * With `mouse on` shottino asks for 1003, which reports every mouse
 * MOVE, so escape sequences arrive more or less continuously. Any Tab
 * pressed while one was being decoded used to be read by resolve_csi's
 * scanner, fail its "is this a CSI byte" test, and be dropped on the
 * floor — so nick completion simply stopped working, and only with the
 * mouse enabled, which made it look like a mouse feature rather than a
 * lost keystroke.
 *
 * Tab is the one that got reported, but the property is general: the
 * scanner must put back anything that turned out not to belong to it. */
TEST(a_key_interrupting_an_escape_sequence_is_not_swallowed) {
    int mfd = -1, sfd = -1;
    if (openpty(&mfd, &sfd, NULL, NULL, NULL) != 0) {
        fprintf(stderr, "test_keys: no pty — skipping\n");
        return;
    }
    FILE *in = fdopen(sfd, "r+");
    FILE *out = fdopen(dup(sfd), "w");
    SCREEN *screen = in && out ? newterm("xterm", out, in) : NULL;
    if (!screen) {
        fprintf(stderr, "test_keys: no terminfo for xterm — skipping\n");
        close(mfd);
        return;
    }
    cbreak();
    noecho();
    keypad(stdscr, TRUE);
    define_pane_keys();
    timeout(200);

    /* An INCOMPLETE CSI — no final byte — with a Tab hard behind it,
     * which is exactly the shape a mouse report interrupted by a
     * keypress produces. */
    const char *seq = "\033[1;\t";
    ssize_t w = write(mfd, seq, strlen(seq));
    (void)w;
    usleep(20000);

    int first = getch();
    if (first == 27) first = resolve_escape();
    /* Whatever the truncated sequence resolves to is not the point. */
    (void)first;
    /* THE POINT: the Tab is still there, as its own key. */
    int next = getch();
    CHECK_LONG(next, '\t');

    endwin();
    delscreen(screen);
    if (in) fclose(in);
    if (out) fclose(out);
    close(mfd);
}

int main(void) {
    test_use_temp_home();

    RUN(the_input_line_has_a_cursor_you_can_move);
    RUN(modified_keys_decode_where_terminfo_describes_them);
    RUN(modified_keys_decode_where_terminfo_describes_nothing);
    RUN(roster_focus_takes_the_arrows_and_gives_them_back);
    RUN(a_key_interrupting_an_escape_sequence_is_not_swallowed);
    return test_report();
}
