/* test_layout — the chat area's clipping contract.
 *
 * The one suite that does NOT link a leaf module: it compiles shottino.c
 * itself (with `main` renamed away) and drives the real drawing functions
 * against an offscreen ncurses screen, reading the result back out of the
 * virtual screen with mvinch(). No TTY is involved — newterm() renders to
 * /dev/null and the assertions read stdscr, which is pure memory.
 *
 * It exists because every layout bug in this client has been ONE bug: the
 * measuring pass and the draw pass disagreeing about how many rows
 * something occupies, always paid for by the newest message at the bottom
 * of the region. The property asserted here is the one that makes partial
 * scrolling safe — drawing a row from its `skip`-th display line must
 * produce exactly what a full draw puts on those same lines. Anything
 * else means the row reflows as it scrolls off, and the height the
 * measuring pass computed stops describing what is drawn.
 *
 * shottino.c has no other test target: the socket, the event dispatch and
 * the app state need a live server. Keep this suite to functions that are
 * pure given a screen. */
#define main shottino_main_unused
#include "../shottino.c"
#undef main

#include "test.h"

enum { MAX_W = 120, MAX_H = 64 };

static char full_rows[MAX_H][MAX_W + 1];
static char part_rows[MAX_H][MAX_W + 1];

static void snap(char dst[MAX_H][MAX_W + 1], int rows, int cols) {
    for (int y = 0; y < rows && y < MAX_H; y++) {
        for (int x = 0; x < cols && x < MAX_W; x++) dst[y][x] = (char)(mvinch(y, x) & A_CHARTEXT);
        dst[y][cols < MAX_W ? cols : MAX_W] = '\0';
    }
}

/* Is `needle` anywhere on the rendered screen?
 *
 * Reads the virtual screen back through the same snap() the tail checks
 * use. This is what tells "drawn" from "would be drawn" — the whole
 * point of rendering to a real ncurses screen rather than asserting
 * about the state that feeds it. */
static bool screen_has(const char *needle) {
    int rows = getmaxy(stdscr), cols = getmaxx(stdscr);
    snap(full_rows, rows, cols);
    for (int y = 0; y < rows && y < MAX_H; y++)
        if (strstr(full_rows[y], needle)) return true;
    return false;
}

/* The colour pair a run of text was drawn in.
 *
 * screen_has answers "was it drawn"; this answers "drawn HOW", which is
 * the only way to assert a colour decision — the alternative is to
 * re-state the constant the code already names and prove nothing.
 * Returns -1 when the needle is not on screen. */
static int screen_pair_of(const char *needle) {
    int rows = getmaxy(stdscr), cols = getmaxx(stdscr);
    snap(full_rows, rows, cols);
    for (int y = 0; y < rows && y < MAX_H; y++) {
        const char *at = strstr(full_rows[y], needle);
        if (!at) continue;
        return (int)PAIR_NUMBER(mvinch(y, (int)(at - full_rows[y])) & A_COLOR);
    }
    return -1;
}

/* The tail of a wrapped body, drawn from line `skip`, is the full draw's
 * lines `skip`.. — same break points, same cells. */
static void check_text_tail(const char *s, int width, int height, int skip) {
    erase();
    draw_wrapped_text(0, 0, width, 0, height, CP_MAIN, 0, s);
    snap(full_rows, height, width);
    erase();
    draw_wrapped_text(0, 0, width, skip, height - skip, CP_MAIN, 0, s);
    snap(part_rows, height - skip, width);
    for (int y = 0; y + skip < height; y++) CHECK_STR(part_rows[y], full_rows[y + skip]);
}

/* Same for a whole log row, which additionally owns a timestamp and
 * `<nick>` on its FIRST line only: a tail must reproduce the continuation
 * lines, header and all, exactly where the full draw put them. */
static void check_msg_tail(const char *line, int width, int height, int skip) {
    erase();
    draw_message_line(0, 0, width, 0, height, line, false, false);
    snap(full_rows, height, width);
    erase();
    draw_message_line(0, 0, width, skip, height - skip, line, false, false);
    snap(part_rows, height - skip, width);
    for (int y = 0; y + skip < height; y++) CHECK_STR(part_rows[y], full_rows[y + skip]);
}

static const char *const BODIES[] = {
    "the quick brown fox jumps over the lazy dog and keeps going well past the wrap "
    "point so that this body occupies a good handful of display lines",
    /* mIRC formatting: the run walker must be walked from the start even
     * when its early runs land on skipped lines, or the tail loses the
     * colour it inherits. */
    "\x02" "bold start\x0F plain then \x03" "04,08coloured text that wraps across more "
    "than one display line to exercise the run walker end to end",
    /* Embedded newlines break lines without filling the width. */
    "first line\nsecond line that is long enough to wrap on its own once or twice\nthird",
    "\xc3\xa8 accented bytes \xc3\xa0 \xc3\xb9 repeated until this wraps a few times over "
    "so the byte-wise wrap is exercised too",
};

TEST(wrapped_text_tail_matches_full_draw) {
    for (size_t b = 0; b < sizeof(BODIES) / sizeof(BODIES[0]); b++) {
        for (int width = 12; width <= 40; width += 7) {
            int h = wrapped_text_lines_visible(BODIES[b], width);
            if (h > MAX_H) h = MAX_H;
            for (int skip = 0; skip < h; skip++) check_text_tail(BODIES[b], width, h, skip);
        }
    }
}

TEST(message_line_tail_matches_full_draw) {
    static const char *const LINES[] = {
        "[azzurra/#chan] 12:34 <someone> a message long enough to wrap over several "
        "lines in a narrow pane, which is the whole point of this check",
        "[azzurra/#chan] 12:34 --> someone has joined",
        "[azzurra/#chan] 12:34 <someone> https://example.net/a/very/long/link/that/wraps/"
        "around/the/pane/edge/more/than/once/for/sure.png",
    };
    for (size_t l = 0; l < sizeof(LINES) / sizeof(LINES[0]); l++) {
        for (int width = 30; width <= 60; width += 10) {
            int h = message_display_lines(LINES[l], width);
            if (h > MAX_H) h = MAX_H;
            for (int skip = 0; skip < h; skip++) check_msg_tail(LINES[l], width, h, skip);
        }
    }
}

/* A skip of zero must leave the ordinary path byte-identical — the
 * parameter is a clip, not a reflow. */
TEST(zero_skip_is_the_ordinary_draw) {
    const char *line = "[azzurra/#chan] 12:34 <someone> plain and short";
    erase();
    draw_message_line(0, 0, 60, 0, 3, line, false, false);
    snap(full_rows, 3, 60);
    CHECK(strstr(full_rows[0], "<someone>") != NULL);
    CHECK(strstr(full_rows[0], "plain and short") != NULL);
}

/* The header belongs to the row's first line; a tail must not repeat it. */
TEST(tail_omits_the_nick_header) {
    const char *line = "[azzurra/#chan] 12:34 <someone> a message long enough to wrap over "
                       "several lines in a narrow pane so a tail exists at all";
    int h = message_display_lines(line, 40);
    CHECK(h > 1);
    erase();
    draw_message_line(0, 0, 40, 1, h - 1, line, false, false);
    snap(part_rows, h - 1, 40);
    CHECK(strstr(part_rows[0], "<someone>") == NULL);
    CHECK(strstr(part_rows[0], "12:34") == NULL);
}

/* ── Roster tiers ──────────────────────────────────────────────────────
 *
 * The member list is ordered and labelled off PREFIX SIGILS, because
 * that is what the wire carries. It used to test mode LETTERS, which
 * matches nothing a server sends: every member ranked plain, the roster
 * never tiered, and no sigil was ever drawn beside a nick. These pin the
 * representation so that cannot come back silently. */
static struct app *test_app(void) {
    struct app *app = calloc(1, sizeof(*app));
    if (!app) return NULL;
    pthread_mutex_init(&app->lock, NULL);
    return app;
}

static void add_test_network(struct app *app, const char *slug, const char *letters,
                             const char *sigils) {
    struct network *n = &app->networks[app->network_count++];
    snprintf(n->slug, sizeof(n->slug), "%s", slug);
    n->prefix_count = 0;
    for (size_t i = 0; letters[i] && sigils[i]; i++) {
        n->prefix_letters[n->prefix_count] = letters[i];
        n->prefix_sigils[n->prefix_count] = sigils[i];
        n->prefix_count++;
    }
}

static struct window *add_test_window(struct app *app, const char *net, const char *chan) {
    struct window *w = &app->windows[app->window_count++];
    snprintf(w->network, sizeof(w->network), "%s", net);
    snprintf(w->channel, sizeof(w->channel), "%s", chan);
    return w;
}

static void seed(struct window *w, size_t i, const char *nick, const char *modes) {
    snprintf(w->members[i].nick, sizeof(w->members[i].nick), "%s", nick);
    snprintf(w->members[i].modes, sizeof(w->members[i].modes), "%s", modes);
}

TEST(member_tiers_read_prefix_sigils_not_mode_letters) {
    struct app *app = test_app();
    CHECK(app != NULL);
    if (!app) return;
    add_test_network(app, "azzurra", "ohv", "@%+");

    CHECK_LONG(member_rank_locked(app, "azzurra", "@"), 0);
    CHECK_LONG(member_rank_locked(app, "azzurra", "%"), 1);
    CHECK_LONG(member_rank_locked(app, "azzurra", "+"), 2);
    CHECK_LONG(member_rank_locked(app, "azzurra", ""), 3);
    /* A member holding several sigils tiers by the highest. */
    CHECK_LONG(member_rank_locked(app, "azzurra", "@+"), 0);
    /* The mode LETTER is not a sigil: 'o' must NOT read as an op. */
    CHECK_LONG(member_rank_locked(app, "azzurra", "o"), 3);

    CHECK_LONG(member_sigil_locked(app, "azzurra", "@"), '@');
    CHECK_LONG(member_sigil_locked(app, "azzurra", "+"), '+');
    CHECK_LONG(member_sigil_locked(app, "azzurra", ""), 0);
    CHECK_STR(member_rank_label_locked(app, "azzurra", "@"), "op");
    CHECK_STR(member_rank_label_locked(app, "azzurra", "%"), "halfop");
    CHECK_STR(member_rank_label_locked(app, "azzurra", "+"), "voice");
    CHECK_STR(member_rank_label_locked(app, "azzurra", ""), "user");

    /* Before 005 lands there is no PREFIX for the network: the
     * conventional ~&@%+ map still has to tier, or every roster drawn
     * during connect is flat. */
    CHECK_LONG(member_rank_locked(app, "unknown-net", "@"), 2);
    CHECK_LONG(member_sigil_locked(app, "unknown-net", "@"), '@');

    pthread_mutex_destroy(&app->lock);
    free(app);
}

TEST(roster_sorts_by_tier_then_nick) {
    struct app *app = test_app();
    CHECK(app != NULL);
    if (!app) return;
    add_test_network(app, "azzurra", "ohv", "@%+");
    struct window *w = add_test_window(app, "azzurra", "#chan");
    seed(w, 0, "zoe", "");
    seed(w, 1, "Bob", "@");
    seed(w, 2, "alice", "+");
    seed(w, 3, "Carol", "@");
    seed(w, 4, "dave", "");
    seed(w, 5, "mod", "%");
    w->member_count = 6;
    sort_members_locked(app, "azzurra", w->members, w->member_count);

    CHECK_STR(w->members[0].nick, "Bob");
    CHECK_STR(w->members[1].nick, "Carol");
    CHECK_STR(w->members[2].nick, "mod");
    CHECK_STR(w->members[3].nick, "alice");
    CHECK_STR(w->members[4].nick, "dave");
    CHECK_STR(w->members[5].nick, "zoe");

    pthread_mutex_destroy(&app->lock);
    free(app);
}

TEST(roster_edits_keep_the_order_and_the_prefixes) {
    struct app *app = test_app();
    CHECK(app != NULL);
    if (!app) return;
    add_test_network(app, "azzurra", "ohv", "@%+");
    struct window *w = add_test_window(app, "azzurra", "#chan");
    seed(w, 0, "Bob", "@");
    seed(w, 1, "alice", "");
    w->member_count = 2;

    CHECK(roster_add_locked(w, "zoe"));
    CHECK(!roster_add_locked(w, "ZOE")); /* already here, folded */
    sort_members_locked(app, "azzurra", w->members, w->member_count);
    CHECK_LONG(w->member_count, 3);
    CHECK_STR(w->members[0].nick, "Bob");
    CHECK_STR(w->members[1].nick, "alice");
    CHECK_STR(w->members[2].nick, "zoe");

    /* A rename keeps the prefix: an op stays an op across a NICK. */
    CHECK(roster_rename_locked(w, "Bob", "Roberto"));
    CHECK_STR(w->members[0].nick, "Roberto");
    CHECK_STR(w->members[0].modes, "@");

    CHECK(roster_remove_locked(w, "ALICE"));
    CHECK(!roster_remove_locked(w, "nobody"));
    CHECK_LONG(w->member_count, 2);
    CHECK_STR(w->members[0].nick, "Roberto");
    CHECK_STR(w->members[1].nick, "zoe");

    pthread_mutex_destroy(&app->lock);
    free(app);
}

TEST(muted_tier_needs_a_known_plus_m) {
    struct app *app = test_app();
    CHECK(app != NULL);
    if (!app) return;
    struct window *w = add_test_window(app, "azzurra", "#chan");
    /* Never been told is NOT "not moderated": the label is only claimed
     * when the modes are actually known. */
    CHECK(!channel_is_moderated(w));
    w->chan_modes_known = true;
    snprintf(w->chan_modes, sizeof(w->chan_modes), "nt");
    CHECK(!channel_is_moderated(w));
    snprintf(w->chan_modes, sizeof(w->chan_modes), "nmt");
    CHECK(channel_is_moderated(w));
    pthread_mutex_destroy(&app->lock);
    free(app);
}

/* The pane reserves one row per member plus a separator above the muted
 * group — measured by the same walk that draws, so the scroll bound and
 * the drawing cannot disagree. */
TEST(roster_rows_count_the_muted_separator) {
    struct app *app = test_app();
    CHECK(app != NULL);
    if (!app) return;
    add_test_network(app, "azzurra", "ohv", "@%+");
    struct window *w = add_test_window(app, "azzurra", "#chan");
    seed(w, 0, "Bob", "@");
    seed(w, 1, "alice", "");
    seed(w, 2, "zoe", "");
    w->member_count = 3;

    CHECK_LONG(draw_member_list(app, w, -1, 0, 0, 0, 0), 3);
    w->chan_modes_known = true;
    snprintf(w->chan_modes, sizeof(w->chan_modes), "nmt");
    CHECK_LONG(draw_member_list(app, w, -1, 0, 0, 0, 0), 4); /* + separator */
    /* Everyone opped under +m: nobody is muted, so no separator row. */
    seed(w, 1, "alice", "@");
    seed(w, 2, "zoe", "@");
    CHECK_LONG(draw_member_list(app, w, -1, 0, 0, 0, 0), 3);

    pthread_mutex_destroy(&app->lock);
    free(app);
}

/* The focused window's identity is COPIED out under the lock. Handing
 * back a pointer into app->windows let the socket thread rewrite the
 * string, or /win move app->current, between the call and the use. */
TEST(current_window_key_copies_and_reports_absence) {
    struct app *app = test_app();
    CHECK(app != NULL);
    if (!app) return;
    char net[MAX_SLUG], chan[MAX_CHANNEL];

    /* No windows: false, and the buffers are emptied rather than left
     * holding whatever the caller had on the stack — a caller that
     * ignores the return must not send a payload naming garbage. */
    snprintf(net, sizeof(net), "stale");
    snprintf(chan, sizeof(chan), "#stale");
    CHECK(!current_window_key(app, net, sizeof(net), chan, sizeof(chan)));
    CHECK_STR(net, "");
    CHECK_STR(chan, "");

    add_test_window(app, "azzurra", "#one");
    add_test_window(app, "azzurra", "#two");
    focused_pane_locked(app)->window = 1;
    CHECK(current_window_key(app, net, sizeof(net), chan, sizeof(chan)));
    CHECK_STR(net, "azzurra");
    CHECK_STR(chan, "#two");

    /* It is a COPY: moving focus does not rewrite what the caller holds. */
    focused_pane_locked(app)->window = 0;
    CHECK_STR(chan, "#two");

    /* Either buffer may be omitted. */
    CHECK(current_window_key(app, NULL, 0, chan, sizeof(chan)));
    CHECK_STR(chan, "#one");
    CHECK(current_window_key(app, net, sizeof(net), NULL, 0));
    CHECK_STR(net, "azzurra");

    /* current is out of range (a window closed under us): reported as
     * absent, not read past the end of the array. */
    focused_pane_locked(app)->window = 7;
    CHECK(!current_window_key(app, net, sizeof(net), chan, sizeof(chan)));

    pthread_mutex_destroy(&app->lock);
    free(app);
}

/* ── Panes ────────────────────────────────────────────────────────────
 *
 * "The current window" is derived from the focused pane rather than
 * stored beside it, and every pane holds an INDEX into a window array
 * that shifts when a window closes. Both are the kind of thing that
 * looks right until the second pane exists. */
TEST(focus_is_derived_from_the_focused_pane) {
    struct app *app = test_app();
    CHECK(app != NULL);
    if (!app) return;
    add_test_window(app, "azzurra", "#one");
    add_test_window(app, "azzurra", "#two");

    /* No panes configured yet: asking creates the one-pane case rather
     * than reading past the end of the array. */
    CHECK_LONG(app->pane_count, 0);
    CHECK_LONG(focused_window_locked(app), 0);
    CHECK_LONG(app->pane_count, 1);

    app->panes[1] = (struct pane){.window = 1, .weight = 1};
    app->pane_count = 2;
    app->focus = 1;
    CHECK_LONG(focused_window_locked(app), 1);
    CHECK(window_is_visible_locked(app, 0));
    CHECK(window_is_visible_locked(app, 1));

    app->panes[1].window = 0;
    CHECK(window_is_visible_locked(app, 0));
    CHECK(!window_is_visible_locked(app, 1)); /* nothing shows it now */

    /* Focus beyond the pane count is clamped, not trusted. */
    app->focus = 9;
    CHECK_LONG(focused_window_locked(app), 0);
    CHECK_LONG(app->focus, 1);

    pthread_mutex_destroy(&app->lock);
    free(app);
}

/* Closing a window shifts the array under EVERY pane, not just the
 * focused one — a pane left holding the old index silently starts
 * showing its neighbour. */
TEST(closing_a_window_renumbers_every_pane) {
    struct app *app = test_app();
    CHECK(app != NULL);
    if (!app) return;
    add_test_window(app, "azzurra", "#a");
    add_test_window(app, "azzurra", "#b");
    add_test_window(app, "azzurra", "#c");
    app->panes[0] = (struct pane){.window = 0, .weight = 1};
    app->panes[1] = (struct pane){.window = 2, .weight = 1, .scroll_offset = 5};
    app->pane_count = 2;
    app->focus = 0;

    /* Close #b, which sits BETWEEN them: the pane on #c must follow it
     * down to index 1, not keep pointing at 2 (now past the end). */
    remove_window(app, "azzurra", "#b");
    CHECK_LONG(app->window_count, 2);
    CHECK_LONG(app->panes[0].window, 0);
    CHECK_LONG(app->panes[1].window, 1);
    CHECK_STR(app->windows[app->panes[1].window].channel, "#c");
    /* A pane whose window survived keeps its scroll position. */
    CHECK_LONG(app->panes[1].scroll_offset, 5);

    /* Close the window a pane is ON: its view resets rather than
     * inheriting whatever slid into that index. */
    remove_window(app, "azzurra", "#c");
    CHECK_LONG(app->window_count, 1);
    CHECK_LONG(app->panes[1].window, 0);
    CHECK_LONG(app->panes[1].scroll_offset, 0);

    pthread_mutex_destroy(&app->lock);
    free(app);
}

/* ── Overlay ──────────────────────────────────────────────────────────
 *
 * The right-click menu and the Ctrl-R picker share one item builder, and
 * the draw and the activation both call it. If it ever returned a
 * different list to those two callers, Enter would act on the row above
 * the one highlighted — so the builder is what gets pinned. */
/* Through the production push, so a row seeded by a test carries the
 * same scope a row from the network would. Filling the arrays by hand
 * here is how a test starts asserting a buffer the client never
 * builds. */
static void seed_log(struct app *app, const char *line) {
    log_push_locked(app, strdup(line), false, false);
}

/* An operational line — preview progress, an upload result, a command's
 * answer — belongs to the window it happened in, and stays there. It
 * used to have no window at all and so appeared in ALL of them: leave
 * the channel where you typed /preview and its output came along. */
TEST(an_operational_line_belongs_to_the_window_it_happened_in) {
    struct app *app = test_app();
    CHECK(app != NULL);
    if (!app) return;
    add_test_window(app, "azzurra", "#chan");
    add_test_window(app, "azzurra", "#other");
    app->pane_count = 1;
    app->panes[0] = (struct pane){.window = 0, .weight = 1};

    seed_log(app, "preparing preview of https://example.org/cat.png");
    seed_log(app, "[azzurra/#other] 10:00 <dave> different channel");

    CHECK(log_row_in_scope(app, 0, "[azzurra/#chan]"));
    CHECK(!log_row_in_scope(app, 0, "[azzurra/#other]"));
    /* A chat row is filed by its own prefix, not by what was focused. */
    CHECK(log_row_in_scope(app, 1, "[azzurra/#other]"));
    CHECK(!log_row_in_scope(app, 1, "[azzurra/#chan]"));

    /* Switching windows does not move rows already written: the scope
     * was taken when the line was written, so switching back finds it
     * where it happened. */
    app->panes[0].window = 1;
    seed_log(app, "upload finished");
    CHECK(log_row_in_scope(app, 2, "[azzurra/#other]"));
    CHECK(!log_row_in_scope(app, 2, "[azzurra/#chan]"));
    CHECK(log_row_in_scope(app, 0, "[azzurra/#chan]"));

    for (size_t i = 0; i < app->log_count; i++) free(app->log[i]);
    pthread_mutex_destroy(&app->lock);
    free(app);
}

TEST(menu_offers_reply_and_query_for_the_clicked_nick) {
    struct app *app = test_app();
    CHECK(app != NULL);
    if (!app) return;
    struct overlay_item items[64];

    /* A message: everything you can do with a person, plus the one thing
     * that needs what they said. Typing their nick stays LAST — it is
     * the harmless entry the hand reaches for blindly. The op actions
     * are absent here because this fixture holds no @; the menu that
     * does is asserted in test_windows. */
    app->overlay.kind = OVERLAY_MENU;
    snprintf(app->overlay.nick, sizeof(app->overlay.nick), "alice");
    snprintf(app->overlay.body, sizeof(app->overlay.body), "something she said");
    CHECK_LONG(overlay_items_locked(app, items, 64), 6);
    CHECK_STR(items[0].label, "Reply to alice");
    CHECK_LONG(items[0].action, ACT_REPLY);
    CHECK_STR(items[1].label, "Open query with alice");
    CHECK_LONG(items[1].action, ACT_QUERY);
    CHECK_STR(items[1].nick, "alice");
    CHECK_LONG(items[2].action, ACT_WHOIS);
    CHECK_LONG(items[3].action, ACT_PING);
    CHECK_STR(items[4].label, "Block alice");
    CHECK_LONG(items[4].action, ACT_BLOCK);
    CHECK_LONG(items[5].action, ACT_INSERT);

    /* A roster row is a person with nothing said: replying to it would
     * be an entry that fails when chosen, so it is not offered. */
    app->overlay.body[0] = 0;
    CHECK_LONG(overlay_items_locked(app, items, 64), 5);
    CHECK_LONG(items[0].action, ACT_QUERY);
    CHECK_LONG(items[1].action, ACT_WHOIS);
    CHECK_LONG(items[2].action, ACT_PING);
    CHECK_LONG(items[3].action, ACT_BLOCK);
    CHECK_LONG(items[4].action, ACT_INSERT);

    /* No nick — a join row, a server notice — offers nothing rather than
     * a menu that acts on "". */
    app->overlay.nick[0] = 0;
    CHECK_LONG(overlay_items_locked(app, items, 64), 0);

    pthread_mutex_destroy(&app->lock);
    free(app);
}

TEST(reply_picker_lists_newest_first_and_filters) {
    struct app *app = test_app();
    CHECK(app != NULL);
    if (!app) return;
    add_test_network(app, "azzurra", "ohv", "@%+");
    add_test_window(app, "azzurra", "#chan");
    add_test_window(app, "azzurra", "#other");
    struct overlay_item items[64];

    seed_log(app, "[azzurra/#chan] 10:00 <alice> first thing");
    seed_log(app, "[azzurra/#chan] 10:01 <bob> a reply about coffee");
    seed_log(app, "[azzurra/#chan] 10:02 --> carol has joined");
    seed_log(app, "[azzurra/#other] 10:03 <dave> different channel");
    seed_log(app, "[azzurra/#chan] 10:04 <carol> last word");

    app->overlay.kind = OVERLAY_REPLY;
    size_t n = overlay_items_locked(app, items, 64);
    /* Newest first, this window only, and the join row is not something
     * you can reply to. */
    CHECK_LONG(n, 3);
    CHECK_STR(items[0].nick, "carol");
    CHECK_STR(items[1].nick, "bob");
    CHECK_STR(items[2].nick, "alice");

    /* The filter matches a nick... */
    snprintf(app->overlay.filter, sizeof(app->overlay.filter), "ali");
    CHECK_LONG(overlay_items_locked(app, items, 64), 1);
    CHECK_STR(items[0].nick, "alice");

    /* ...or the message text, which is how you find a line whose author
     * you have forgotten. */
    snprintf(app->overlay.filter, sizeof(app->overlay.filter), "coffee");
    CHECK_LONG(overlay_items_locked(app, items, 64), 1);
    CHECK_STR(items[0].nick, "bob");

    snprintf(app->overlay.filter, sizeof(app->overlay.filter), "zzz");
    CHECK_LONG(overlay_items_locked(app, items, 64), 0);

    for (size_t i = 0; i < app->log_count; i++) free(app->log[i]);
    pthread_mutex_destroy(&app->lock);
    free(app);
}

TEST(reply_picker_offers_every_line_not_one_per_nick) {
    struct app *app = test_app();
    CHECK(app != NULL);
    if (!app) return;
    add_test_network(app, "azzurra", "ohv", "@%+");
    add_test_window(app, "azzurra", "#chan");
    struct overlay_item items[64];
    seed_log(app, "[azzurra/#chan] 10:00 <alice> one");
    seed_log(app, "[azzurra/#chan] 10:01 <bob> two");
    seed_log(app, "[azzurra/#chan] 10:02 <bob> three");
    seed_log(app, "[azzurra/#chan] 10:03 <bob> four");
    app->overlay.kind = OVERLAY_REPLY;
    size_t n = overlay_items_locked(app, items, 64);
    /* Every line, newest first. bob saying three things in a row used to
     * collapse to his most recent, which reads well and answers the
     * wrong question: the chosen line is QUOTED into the reply, so the
     * two you cannot reach are two you might have meant. In a
     * conversation between two people the collapse hid everything but
     * the last line of each. */
    CHECK_LONG(n, 4);
    CHECK_STR(items[0].nick, "bob");
    CHECK(strstr(items[0].label, "four") != NULL);
    CHECK(strstr(items[1].label, "three") != NULL);
    CHECK(strstr(items[2].label, "two") != NULL);
    CHECK_STR(items[3].nick, "alice");
    for (size_t i = 0; i < app->log_count; i++) free(app->log[i]);
    pthread_mutex_destroy(&app->lock);
    free(app);
}

/* Unfiltered, the picker is "the last twenty", not "everything ever
 * said": a box cannot show a thousand rows and a list that pretends to
 * is a list you scroll forever. */
TEST(reply_picker_stops_at_twenty) {
    struct app *app = test_app();
    CHECK(app != NULL);
    if (!app) return;
    add_test_window(app, "azzurra", "#chan");
    struct overlay_item items[64];
    for (int i = 0; i < 30; i++) {
        char line[128];
        snprintf(line, sizeof(line), "[azzurra/#chan] 10:%02d <nick%d> message %d", i, i, i);
        seed_log(app, line);
    }
    app->overlay.kind = OVERLAY_REPLY;
    CHECK_LONG(overlay_items_locked(app, items, 64), PICKER_MAX);
    /* Newest first, so the cap drops the OLDEST — the twenty you can
     * still see, not the twenty you have forgotten. */
    CHECK(strstr(items[0].label, "message 29") != NULL);

    for (size_t i = 0; i < app->log_count; i++) free(app->log[i]);
    pthread_mutex_destroy(&app->lock);
    free(app);
}

/* The media picker: this window's pictures and clips, newest first,
 * each URL once. Same list for /preview and /view — the command decides
 * what Enter does with it. */
TEST(media_picker_lists_this_windows_pictures_once_each) {
    struct app *app = test_app();
    CHECK(app != NULL);
    if (!app) return;
    add_test_window(app, "azzurra", "#chan");
    add_test_window(app, "azzurra", "#other");
    struct overlay_item items[64];

    seed_log(app, "[azzurra/#chan] 10:00 <alice> look https://example.net/cat.png");
    seed_log(app, "[azzurra/#chan] 10:01 <bob> and https://example.net/clip.mp4");
    seed_log(app, "[azzurra/#chan] 10:02 <carol> read https://example.net/notes.html");
    seed_log(app, "[azzurra/#chan] 10:03 <dave> https://example.net/cat.png again");
    seed_log(app, "[azzurra/#other] 10:04 <eve> https://example.net/elsewhere.png");
    seed_log(app, "[azzurra/#chan] 10:05 --> frank has joined");

    app->overlay.kind = OVERLAY_MEDIA;
    app->overlay.pick_action = ACT_VIEW;
    size_t n = overlay_items_locked(app, items, 64);
    /* cat.png (repeated, listed once at its most recent mention),
     * clip.mp4 — and NOT the html, nor the other window's picture. */
    CHECK_LONG(n, 2);
    CHECK_STR(items[0].body, "https://example.net/cat.png");
    CHECK_STR(items[1].body, "https://example.net/clip.mp4");
    /* The row's author labels the entry, so a channel full of links is
     * still a list of people. */
    CHECK_STR(items[0].nick, "dave");
    CHECK_LONG(items[0].action, ACT_VIEW);

    /* Opened by /preview instead, the same list previews. */
    app->overlay.pick_action = ACT_PREVIEW;
    CHECK_LONG(overlay_items_locked(app, items, 64), 2);
    CHECK_LONG(items[0].action, ACT_PREVIEW);

    /* Typing filters by URL. */
    snprintf(app->overlay.filter, sizeof(app->overlay.filter), "mp4");
    CHECK_LONG(overlay_items_locked(app, items, 64), 1);
    CHECK_STR(items[0].body, "https://example.net/clip.mp4");

    for (size_t i = 0; i < app->log_count; i++) free(app->log[i]);
    pthread_mutex_destroy(&app->lock);
    free(app);
}

/* The saved file's extension is what the desktop picks a viewer from,
 * so the URL is asked first and the Content-Type answers for links that
 * carry no extension at all. */
TEST(view_names_the_file_after_its_type) {
    char ext[16];
    view_extension("https://example.net/cat.png", "", ext, sizeof(ext));
    CHECK_STR(ext, "png");
    /* A query string is not an extension. */
    view_extension("https://example.net/i?id=99", "image/jpeg", ext, sizeof(ext));
    CHECK_STR(ext, "jpg");
    view_extension("https://example.net/uploads/abc123", "video/mp4", ext, sizeof(ext));
    CHECK_STR(ext, "mp4");
    /* Nothing to go on: a name the desktop will not mis-handle. */
    view_extension("https://example.net/uploads/abc123", "application/octet-stream", ext,
                   sizeof(ext));
    CHECK_STR(ext, "bin");
}

TEST(reply_cites_the_original_and_keeps_what_was_typed) {
    char out[MAX_LINE];

    /* IRC has no threading, so the reply carries a piece of what it
     * answers: nick, citation, then your words. */
    compose_reply("alice", "the meeting is at four", "", out, sizeof(out));
    CHECK_STR(out, "alice: \xc2\xab" "the meeting is at four\xc2\xbb ");

    /* A half-written answer survives the citation being added. */
    compose_reply("alice", "the meeting is at four", "ok, see you there", out, sizeof(out));
    CHECK_STR(out, "alice: \xc2\xab" "the meeting is at four\xc2\xbb ok, see you there");

    /* Picking a DIFFERENT message replaces the citation instead of
     * stacking a second one, and still keeps the answer. */
    char again[MAX_LINE];
    compose_reply("alice", "actually make it five", out, again, sizeof(again));
    CHECK_STR(again, "alice: \xc2\xab" "actually make it five\xc2\xbb ok, see you there");

    /* Replying to someone else re-addresses it. */
    compose_reply("bob", "who is bringing the cake", again, out, sizeof(out));
    CHECK_STR(out, "bob: \xc2\xab" "who is bringing the cake\xc2\xbb ok, see you there");

    /* No body (a row with nothing to cite) is the plain address. */
    compose_reply("carol", "", "", out, sizeof(out));
    CHECK_STR(out, "carol: ");
}

TEST(reply_citation_is_flattened_and_cut_on_a_word) {
    char out[MAX_LINE];

    /* Formatting codes are not a citation. */
    compose_reply("alice", "\x02" "bold\x0f and \x03" "04red\x0f text", "", out, sizeof(out));
    CHECK_STR(out, "alice: \xc2\xab" "bold and red text\xc2\xbb ");

    /* Newlines and runs of spaces collapse: a citation is one line. */
    compose_reply("alice", "two\n\nlines   and    spaces", "", out, sizeof(out));
    CHECK_STR(out, "alice: \xc2\xab" "two lines and spaces\xc2\xbb ");

    /* Long originals are cut on a word boundary and say they were cut. */
    compose_reply("alice",
                  "this original message is quite a lot longer than the citation limit allows",
                  "", out, sizeof(out));
    CHECK(strstr(out, "\xe2\x80\xa6\xc2\xbb ") != NULL);   /* ends with an ellipsis */
    CHECK(strlen(out) < 80);
    CHECK(strstr(out, "this original message is quite") != NULL);
    /* Cut BETWEEN words, so the citation never ends mid-word. */
    const char *open = strstr(out, "\xc2\xab");
    const char *close = strstr(out, "\xe2\x80\xa6");
    CHECK(open && close && close > open);
    CHECK(close[-1] != ' ');

    /* A body that is exactly short enough is NOT marked as cut. */
    compose_reply("alice", "short enough", "", out, sizeof(out));
    CHECK(strstr(out, "\xe2\x80\xa6") == NULL);
}

TEST(reply_leaves_a_line_it_did_not_write_alone) {
    char out[MAX_LINE];
    /* "10:30 meeting: bring the thing" is a sentence, not a reply prefix
     * this function wrote — guessing wrong here eats someone's line. */
    compose_reply("alice", "yes", "10:30 meeting: bring the thing", out, sizeof(out));
    CHECK(strstr(out, "10:30 meeting: bring the thing") != NULL);
}

/* Right-clicking a name in the userlist has to reach the same menu as
 * right-clicking a message — which means the roster has to record where
 * it drew each nick, and only on the pass that actually drew it. */
TEST(the_roster_records_a_region_per_nick_it_draws) {
    struct app *app = test_app();
    CHECK(app != NULL);
    if (!app) return;
    add_test_network(app, "azzurra", "ohv", "@%+");
    struct window *w = add_test_window(app, "azzurra", "#chan");
    seed(w, 0, "alice", "@");
    seed(w, 1, "bob", "");
    seed(w, 2, "carol", "");
    w->member_count = 3;

    /* The MEASURING call draws nothing, so it must record nothing: a
     * region for a row that was never drawn is a click that lands on the
     * wrong nick. */
    app->msg_region_count = 0;
    draw_member_list(app, w, -1, 0, 0, 0, 0);
    CHECK_LONG(app->msg_region_count, 0);

    erase();
    app->msg_region_count = 0;
    draw_member_list(app, w, 0, 0, 14, 3, 0);
    CHECK_LONG(app->msg_region_count, 3);
    CHECK_STR(app->msg_regions[0].nick, "alice");
    CHECK_LONG(app->msg_regions[0].y0, 0);
    CHECK_STR(app->msg_regions[2].nick, "carol");
    CHECK_LONG(app->msg_regions[2].y0, 2);
    /* No message: that is what tells the menu this is a person rather
     * than something they said. */
    CHECK_STR(app->msg_regions[0].body, "");

    /* Scrolled, the regions follow what is on screen. */
    erase();
    app->msg_region_count = 0;
    draw_member_list(app, w, 0, 0, 14, 2, 1);
    CHECK_LONG(app->msg_region_count, 2);
    CHECK_STR(app->msg_regions[0].nick, "bob");

    pthread_mutex_destroy(&app->lock);
    free(app);
}

/* The wheel scrolls the pane under the POINTER. With a split, that is
 * not always the focused pane, and the pointer is what the user was
 * pointing at — so the draw pass has to say where each pane landed. */
TEST(each_pane_records_where_it_was_drawn) {
    struct app *app = test_app();
    CHECK(app != NULL);
    if (!app) return;
    add_test_window(app, "azzurra", "#one");
    add_test_window(app, "azzurra", "#two");
    app->pane_count = 2;
    app->panes[0] = (struct pane){.window = 0, .weight = 1};
    app->panes[1] = (struct pane){.window = 1, .weight = 1};

    erase();
    app->pane_region_count = 0;
    draw_chat_pane(app, &app->panes[0], 0, 0, 40, 10, true, true);
    draw_chat_pane(app, &app->panes[1], 0, 10, 40, 10, false, true);
    CHECK_LONG(app->pane_region_count, 2);
    CHECK_LONG(app->pane_regions[0].pane, 0);
    CHECK_LONG(app->pane_regions[0].y0, 0);
    CHECK_LONG(app->pane_regions[0].y1, 9);
    CHECK_LONG(app->pane_regions[1].pane, 1);
    CHECK_LONG(app->pane_regions[1].y0, 10);
    CHECK_LONG(app->pane_regions[1].y1, 19);

    /* And scrolling addresses that pane, not the focused one. */
    app->focus = 0;
    scroll_pane(app, 1, 3);
    CHECK_LONG(app->panes[1].scroll_offset, 3);
    CHECK_LONG(app->panes[0].scroll_offset, 0);
    CHECK(app->panes[1].scroll_pinned);

    /* Scrolling back to the bottom unpins it: a pane pinned above the
     * newest line stops following the conversation. */
    scroll_pane(app, 1, -3);
    CHECK_LONG(app->panes[1].scroll_offset, 0);
    CHECK(!app->panes[1].scroll_pinned);

    /* An index that is not a pane falls back to the focused one rather
     * than writing past the array. */
    scroll_pane(app, 99, 2);
    CHECK_LONG(app->panes[0].scroll_offset, 2);

    pthread_mutex_destroy(&app->lock);
    free(app);
}

/* Terminal graphics placements are not part of ncurses' model of the
 * screen: erase() does not remove them and a repaint does not cover
 * them. The client therefore has to notice when one has outlived the
 * frame that wanted it — a picture from the channel you just left,
 * floating over the one you just opened. */
TEST(a_placement_the_frame_did_not_paint_is_stale) {
    struct app *app = test_app();
    CHECK(app != NULL);
    if (!app) return;
    app->media_count = 2;
    app->frame_seq = 7;

    /* Nothing placed: nothing to reconcile. */
    CHECK(!media_placements_stale_locked(app));

    /* Placed, and repainted by the frame that just ran: still wanted. */
    app->media[0].drawn = true;
    app->media[0].painted_frame = 7;
    CHECK(!media_placements_stale_locked(app));

    /* The next frame does not paint it — /win, a scroll, a close — and
     * the placement is now hanging over whatever replaced it. */
    app->frame_seq = 8;
    CHECK(media_placements_stale_locked(app));

    /* Dropping clears EVERY slot, including the one this frame did
     * paint: the escape deletes all placements and cannot spare one, so
     * pretending otherwise would leave a picture the client believes is
     * on screen and the terminal has already forgotten. */
    app->media[1].drawn = true;
    app->media[1].painted_frame = 8;
    media_placements_drop_locked(app);
    CHECK(!app->media[0].drawn);
    CHECK(!app->media[1].drawn);
    CHECK(!media_placements_stale_locked(app));
    free(app);
}

/* The roster pane honours its scroll offset. The keys that drive it are
 * a terminal question, but "the offset moves the list" is not. */
TEST(roster_pane_draws_from_the_offset) {
    struct app *app = test_app();
    CHECK(app != NULL);
    if (!app) return;
    add_test_network(app, "azzurra", "ohv", "@%+");
    struct window *w = add_test_window(app, "azzurra", "#chan");
    seed(w, 0, "aa", "@");
    seed(w, 1, "bb", "");
    seed(w, 2, "cc", "");
    seed(w, 3, "dd", "");
    w->member_count = 4;

    erase();
    draw_member_list(app, w, 0, 0, 12, 2, 0);
    snap(full_rows, 2, 12);
    CHECK(strstr(full_rows[0], "aa") != NULL);
    CHECK(strstr(full_rows[1], "bb") != NULL);

    /* Scrolled by two, the same box shows the next pair. */
    erase();
    draw_member_list(app, w, 0, 0, 12, 2, 2);
    snap(part_rows, 2, 12);
    CHECK(strstr(part_rows[0], "cc") != NULL);
    CHECK(strstr(part_rows[1], "dd") != NULL);
    CHECK(strstr(part_rows[0], "aa") == NULL);

    pthread_mutex_destroy(&app->lock);
    free(app);
}

/* ── The topic band ────────────────────────────────────────────────────
 *
 * A band whose height depends on the topic is a band that eats the
 * conversation it describes: a paragraph of a topic used to be allowed
 * every row of the pane but two. And the label column was a fixed third
 * of the width whatever it said, so the topic began a third of the way
 * across and read as right-aligned with a hole beside it. */
TEST(the_topic_band_is_at_most_two_lines) {
    struct app *app = test_app();
    CHECK(app != NULL);
    if (!app) return;
    struct window *w = add_test_window(app, "azzurra", "#c");
    app->pane_count = 1;
    app->panes[0] = (struct pane){.window = 0, .weight = 1};
    /* Far more topic than a 40-column band can hold. */
    for (int i = 0; i < 12; i++)
        snprintf(w->topic + strlen(w->topic), sizeof(w->topic) - strlen(w->topic),
                 "sentence number %d of a very wordy topic. ", i);

    erase();
    draw_chat_pane(app, &app->panes[0], 0, 0, 40, 20, true, false);
    snap(full_rows, 20, 40);
    /* Row 2 is band, row 3 is not: the chat area starts there however
     * long the topic is. */
    CHECK(strstr(full_rows[0], "azzurra/#c") != NULL);
    CHECK(strstr(full_rows[1], "sentence") != NULL);
    CHECK(strstr(full_rows[2], "sentence") == NULL);

    /* A short topic takes ONE line — the band grows to two only when
     * there is something to put there. */
    snprintf(w->topic, sizeof(w->topic), "short");
    erase();
    draw_chat_pane(app, &app->panes[0], 0, 0, 40, 20, true, false);
    snap(full_rows, 20, 40);
    CHECK(strstr(full_rows[0], "short") != NULL);
    CHECK(strstr(full_rows[1], "short") == NULL);

    pthread_mutex_destroy(&app->lock);
    free(app);
}

/* The label takes what it needs, so the topic gets the rest of the
 * width instead of two thirds of it. */
TEST(a_short_channel_name_leaves_the_topic_the_width) {
    struct app *app = test_app();
    CHECK(app != NULL);
    if (!app) return;
    struct window *w = add_test_window(app, "az", "#c");
    app->pane_count = 1;
    app->panes[0] = (struct pane){.window = 0, .weight = 1};
    snprintf(w->topic, sizeof(w->topic), "%s", "TOPICSTART");

    erase();
    draw_chat_pane(app, &app->panes[0], 0, 0, 60, 20, true, false);
    snap(full_rows, 20, 60);
    const char *at = strstr(full_rows[0], "TOPICSTART");
    CHECK(at != NULL);
    /* "az/#c" is five columns, so the topic starts right after it — not
     * a third of the way across a 60-column band. */
    if (at) CHECK((long)(at - full_rows[0]) < 12);

    pthread_mutex_destroy(&app->lock);
    free(app);
}

/* A word is not cut in half, because a marquee that starts mid-word
 * reads as corrupted text rather than as a continuation. */
TEST(the_topic_breaks_on_a_word) {
    CHECK_LONG(topic_head_len("short", 40), 5);
    CHECK_LONG(topic_head_len("alpha beta gamma delta", 12), 10); /* after "alpha beta" */
    /* Nothing to break on: a hard cut at the width, rather than nothing. */
    CHECK_LONG(topic_head_len("aaaaaaaaaaaaaaaaaaaa", 8), 8);
    /* Never inside a UTF-8 character. */
    /* Split literal: "\xa8b" would parse as one three-digit escape. */
    CHECK_LONG(topic_head_len("aaaaaaa\xc3\xa8" "bbb", 8), 7);
}

/* ── The decoder decides what animates ────────────────────────────────
 *
 * This one runs the REAL ffmpeg, because the bug it guards is a property
 * of ffmpeg's filter graph and nothing else: the `fps` filter yields ZERO
 * frames for a single still image (it has no duration to sample), so
 * asking for frames that way silently broke every static picture, while
 * NOT asking meant an animated GIF whose URL did not end in .gif sat
 * there as one frame. Skipped, not failed, where ffmpeg is absent. */
static bool have_ffmpeg(void) {
    return system("ffmpeg -version >/dev/null 2>&1") == 0;
}

static int decode_frames(struct app *app, const char *path, media_protocol proto, bool anim) {
    app->inline_media_enabled = true; /* or the claim declines before ffmpeg runs */
    int slot = media_claim_locked(app, path, media_kind_of(path) == MEDIA_VIDEO);
    if (slot < 0) return -1;
    media_fit_cells(4, 3, 24, 8, &app->media[slot].cols, &app->media[slot].rows);
    app->media[slot].state = IM_FETCHING;
    app->proto = proto;
    app->animate_media = anim;
    media_decode_job(app, slot);
    int n = app->media[slot].state == IM_READY ? (int)app->media[slot].frame_count : -1;
    free(app->media[slot].rgb);
    free(app->media[slot].payload);
    app->media[slot].rgb = NULL;
    app->media[slot].payload = NULL;
    return n;
}

TEST(the_decoder_says_what_animates_not_the_url) {
    if (!have_ffmpeg()) {
        /* Not a skip by default. This test is the only thing in the tree
         * that asks the real decoder what it produced, and every CI run
         * so far printed "no ffmpeg — skipping" and reported green. */
        if (!test_skip_allowed())
            FAIL("ffmpeg is not on PATH: install it, or set SHOTTINO_TEST_ALLOW_SKIP=1");
        else
            fprintf(stderr, "test_layout: no ffmpeg — decode checks skipped on request\n");
        return;
    }
    char dir[] = "/tmp/shottino-test-XXXXXX";
    bool have_dir = mkdtemp(dir) != NULL;
    CHECK(have_dir);
    if (!have_dir) return;
    char gif[PATH_MAX], png[PATH_MAX], cmd[PATH_MAX * 2];
    snprintf(gif, sizeof(gif), "%s/a.bin", dir);  /* no extension to hint with */
    snprintf(png, sizeof(png), "%s/s.bin", dir);
    snprintf(cmd, sizeof(cmd),
             "ffmpeg -y -loglevel error -f lavfi -i testsrc=size=32x24:rate=10:duration=1 "
             "-f gif %s >/dev/null 2>&1", gif);
    bool made_gif = system(cmd) == 0;
    snprintf(cmd, sizeof(cmd),
             "ffmpeg -y -loglevel error -f lavfi -i testsrc=size=32x24:duration=1 -frames:v 1 "
             "-f image2 -c:v png %s >/dev/null 2>&1", png);
    bool made_png = system(cmd) == 0;
    /* An ffmpeg build without the gif or png encoder guarded away every
     * assertion below and still passed. There IS an ffmpeg here — that it
     * cannot produce these two files is a finding, not a reason to
     * report nothing. */
    CHECK(made_gif);
    CHECK(made_png);

    struct app *app = test_app();
    CHECK(app != NULL);
    if (app && made_gif) {
        /* An animated file whose NAME says nothing still animates on a
         * character-art terminal: the decoder is asked, not the URL. */
        CHECK(decode_frames(app, gif, MEDIA_PROTO_NONE, true) > 1);
        /* With animation off it is one frame again. */
        CHECK_LONG(decode_frames(app, gif, MEDIA_PROTO_NONE, false), 1);
    }
    if (app && made_png) {
        /* And a still stays one frame rather than vanishing — the fps
         * filter would have returned nothing at all here. */
        CHECK_LONG(decode_frames(app, png, MEDIA_PROTO_NONE, true), 1);
    }
    if (app) {
        pthread_mutex_destroy(&app->lock);
        free(app);
    }
    unlink(gif);
    unlink(png);
    rmdir(dir);
}

/* An audio link is clickable but never drawn as a picture.
 *
 * It was being claimed as inline media like any other URL, handed to
 * the image decoder, and rendered as "[image could not be decoded]"
 * under every voice message — a failure notice for something that was
 * never going to have a frame. The link must survive: clicking plays
 * it, and right-clicking offers to transcribe it. */
TEST(audio_is_clickable_but_not_drawn) {
    struct app *app = test_app();
    CHECK(app != NULL);
    if (!app) return;
    add_test_network(app, "azzurra", "ohv", "@%+");
    add_test_window(app, "azzurra", "#sniffo");
    app->inline_media_enabled = true;
    app->inline_media_peers = true;
    seed_log(app, "[azzurra/#sniffo] 09:00 <a> https://ex.net/voice.m4a");

    erase();
    draw(app);

    /* No slot was claimed for it, so nothing tries to decode it. */
    bool claimed = false;
    for (size_t i = 0; i < app->log_count; i++)
        if (app->log_media[i] >= 0) claimed = true;
    CHECK(!claimed);
    CHECK(!screen_has("could not be decoded"));

    /* But the link region is there, carrying its kind, so the pointer
     * can still reach it. */
    bool linked = false;
    for (size_t i = 0; i < app->link_region_count; i++)
        if (strstr(app->link_regions[i].url, "voice.m4a")) {
            linked = true;
            CHECK_LONG(app->link_regions[i].kind, MEDIA_AUDIO);
        }
    CHECK(linked);

    for (size_t i = 0; i < app->log_count; i++) free(app->log[i]);
    free(app);
}

/* Every window in the sidebar gets a clickable row.
 *
 * Recorded by the DRAW pass, because the layout is the only thing that
 * knows where a row ended up — the sidebar's width and the per-network
 * heading both move them. A region for a row that was never drawn is a
 * click that switches to the wrong channel. */
TEST(the_sidebar_records_a_row_for_every_window) {
    struct app *app = test_app();
    CHECK(app != NULL);
    if (!app) return;
    add_test_network(app, "azzurra", "ohv", "@%+");
    add_test_window(app, "azzurra", "$server");
    add_test_window(app, "azzurra", "#sniffo");
    add_test_window(app, "azzurra", "#grappa");

    erase();
    draw(app);

    /* One region per window, and each names the window it drew. */
    CHECK_LONG(app->win_region_count, app->window_count);
    for (size_t i = 0; i < app->win_region_count; i++) {
        CHECK_LONG(app->win_regions[i].window, i);
        CHECK(app->win_regions[i].x0 == 0);
        CHECK(app->win_regions[i].x1 > 0);
    }
    /* The rows are distinct lines, and the network heading pushes the
     * first one down — so they are not simply y = index. */
    for (size_t i = 1; i < app->win_region_count; i++)
        CHECK(app->win_regions[i].y > app->win_regions[i - 1].y);
    CHECK(app->win_regions[0].y > 1);

    /* And the row really is where that channel is drawn. */
    int y = app->win_regions[1].y;
    char row[MAX_W + 1];
    for (int x = 0; x < MAX_W && x <= app->win_regions[1].x1; x++)
        row[x] = (char)(mvinch(y, x) & A_CHARTEXT);
    row[app->win_regions[1].x1 + 1] = 0;
    CHECK(strstr(row, "#sniffo") != NULL);

    for (size_t i = 0; i < app->log_count; i++) free(app->log[i]);
    free(app);
}

/* A modal opened over the settings panel must actually be DRAWN.
 *
 * The panel draw path ends in `refresh(); return;` — a panel replaces
 * the chat area, so everything below it is about panes it is covering —
 * and the overlay drawing lived below that return. So a modal opened
 * from the settings panel was opened correctly, kept its state
 * correctly and took keys correctly, and was never painted: right-click
 * looked like it did nothing while the client sat waiting for an answer
 * to a question nobody could see.
 *
 * Rendered to a real (offscreen) ncurses screen and read back, because
 * that is the only way to tell "drawn" from "would be drawn". */
TEST(a_modal_over_the_settings_panel_is_drawn) {
    struct app *app = test_app();
    CHECK(app != NULL);
    if (!app) return;

    app->panel = PANEL_SETTINGS;
    panel_line(app, "settings");
    panel_line(app, "%s", "");
    panel_line(app, "preferences");
    settings_rows(app);

    /* No overlay yet. The panel LISTS llm.context as one of its rows, so
     * the name proves nothing — the modal's key hint is what only the
     * modal draws. */
    erase();
    draw(app);
    CHECK(screen_has("mouse"));        /* the panel itself is there */
    CHECK(!screen_has("Esc cancel"));  /* and no modal is */

    /* Now open one, exactly as the right-click does. */
    settings_open_modal(app, "llm.context");
    erase();
    draw(app);
    /* The setting's name and its help both belong to the modal, and
     * neither appears anywhere else on a settings panel row. */
    CHECK(screen_has("llm.context"));
    CHECK(screen_has("history rolls"));
    CHECK(screen_has("Esc cancel"));

    /* THE GEOMETRY A REAL DRAW RECORDS. Every check so far fed the hit
     * test numbers I chose; this feeds it the ones draw() wrote, which
     * is the only pair that matters. A right-click on the first
     * preference row must resolve to row 0. */
    overlay_close(app);
    erase();
    draw(app);
    pthread_mutex_lock(&app->lock);
    int first_row_y = app->panel_draw_y + (int)(app->settings_row0 - app->panel_offset);
    int mid_x = (app->panel_draw_x0 + app->panel_draw_x1) / 2;
    int got = settings_row_at_locked(app, mid_x, first_row_y);
    int below = settings_row_at_locked(app, mid_x, first_row_y + 1);
    int above = settings_row_at_locked(app, mid_x, app->panel_draw_y - 1);
    printf("  draw geometry: y=%d x0=%d x1=%d h=%d row0=%zu -> first row at y=%d\n",
           app->panel_draw_y, app->panel_draw_x0, app->panel_draw_x1, app->panel_draw_h,
           app->settings_row0, first_row_y);
    pthread_mutex_unlock(&app->lock);
    CHECK_LONG(got, 0);
    CHECK_LONG(below, 1);
    CHECK_LONG(above, -1);

    /* A choice setting shows its values rather than a field. */
    overlay_close(app);
    settings_open_modal(app, "media");
    erase();
    draw(app);
    CHECK(screen_has("first-party"));
    CHECK(screen_has("Enter choose"));

    for (size_t i = 0; i < app->panel_line_count; i++) free(app->panel_lines[i]);
    for (size_t i = 0; i < app->log_count; i++) free(app->log[i]);
    free(app);
}

/* An action is somebody DOING something, and it should read as the most
 * present line on the screen.
 *
 * It had no `<nick>`, so it missed the message arm and landed in the
 * plain-text fallback: CP_MUTED — dimmer than an ordinary message and
 * the same grey as system noise. Exactly backwards. */
TEST(an_action_is_drawn_louder_than_system_noise) {
    static const char action[] = "[azzurra/#sniffo] 21:29 * nextime accende il camino";

    erase();
    draw_message_line(0, 0, 60, 0, 3, action, false, false);
    CHECK_LONG(screen_pair_of("accende il camino"), CP_ACCENT);
    /* The nick keeps its own colour, so you can see WHO at a glance —
     * and it is not the muted timestamp column it used to share. */
    CHECK_LONG(screen_pair_of("nextime"), nick_pair("nextime"));
    CHECK(screen_pair_of("nextime") != CP_MUTED);

    /* The grey it used to be drawn in is still what an unattributed
     * system row gets, which is the contrast that was missing. */
    erase();
    draw_message_line(0, 0, 60, 0, 3, "reconnecting to azzurra", false, false);
    CHECK_LONG(screen_pair_of("reconnecting"), CP_MUTED);

    /* An ordinary message is untouched by the new arm. */
    erase();
    draw_message_line(0, 0, 60, 0, 3, "[azzurra/#sniffo] 21:30 <nextime> ciao", false, false);
    CHECK_LONG(screen_pair_of("ciao"), CP_MAIN);

    /* A mention still wins: it paints the whole row, action or not. */
    erase();
    draw_message_line(0, 0, 60, 0, 3, action, true, false);
    CHECK_LONG(screen_pair_of("accende il camino"), CP_MENTION);

    /* The star must sit in the TIMESTAMP column. A system row that
     * merely CONTAINS one is not somebody emoting — without this the
     * arm would swallow arbitrary text. */
    char prefix[256], nick[256];
    const char *body;
    CHECK(!split_action_line("the product is 2 * 3 today", prefix, sizeof(prefix), nick,
                             sizeof(nick), &body));
    CHECK(!split_action_line("[azzurra/#sniffo] 21:29 <nextime> 2 * 3", prefix, sizeof(prefix),
                             nick, sizeof(nick), &body));
    /* An action with no words is still an action. */
    CHECK(split_action_line("[azzurra/#sniffo] 21:29 * nextime", prefix, sizeof(prefix), nick,
                            sizeof(nick), &body));
    CHECK_STR(nick, "nextime");
    CHECK_STR(body, "");
}

/* The sampling draw is what lets ONE decoded call frame appear at two
 * sizes — a corner box while you read the channel, the whole pane when
 * you switch to the call — without asking the helper to re-encode. The
 * frame stream is a bare byte pipe with no framing, so a geometry
 * change mid-stream would have no boundary to resynchronise on; size
 * has to be a drawing question.
 *
 * The MAPPING is asserted directly rather than through the screen: this
 * offscreen terminal reports COLORS == 0, so every cell reads back as
 * the same colour pair and "which pixel did this come from" is
 * unanswerable from the virtual screen. The draw itself is asserted for
 * the property that does survive — that it FILLS its box rather than
 * clipping, which is the whole reason it exists.
 */
TEST(a_source_rectangle_is_clamped_into_the_picture) {
    /* The ordinary ask: the whole picture, spelled as "to the edge". */
    struct media_src_rect r = media_clamp_rect(0, 0, 0, 0, 40, 40);
    CHECK(r.x == 0 && r.y == 0 && r.w == 40 && r.h == 40);

    /* One tile lifted out of a composited frame. */
    r = media_clamp_rect(20, 20, 20, 20, 40, 40);
    CHECK(r.x == 20 && r.y == 20 && r.w == 20 && r.h == 20);

    /* Over-wide: trimmed to the edge, never past it. */
    r = media_clamp_rect(30, 30, 999, 999, 40, 40);
    CHECK(r.x == 30 && r.y == 30 && r.w == 10 && r.h == 10);

    /* Entirely outside — a tile layout the terminal resized under —
     * collapses to empty so the draw declines rather than reading past
     * the buffer. */
    r = media_clamp_rect(40, 0, 10, 10, 40, 40);
    CHECK(r.w == 0 && r.h == 0);
    r = media_clamp_rect(0, 99, 10, 10, 40, 40);
    CHECK(r.w == 0 && r.h == 0);

    /* Negative origins clamp to zero rather than indexing backwards. */
    r = media_clamp_rect(-5, -5, 10, 10, 40, 40);
    CHECK(r.x == 0 && r.y == 0 && r.w > 0 && r.h > 0);

    /* No picture at all. */
    r = media_clamp_rect(0, 0, 0, 0, 0, 40);
    CHECK(r.w == 0 && r.h == 0);
}

TEST(a_cell_samples_across_the_whole_rectangle) {
    struct media_src_rect full = media_clamp_rect(0, 0, 0, 0, 40, 40);
    int px, pt, pb;

    /* SMALLER than the source: the far corner cell must reach the far
     * corner of the picture. This is exactly what the clipping draw
     * fails to do — it would show the top-left tenth of a face. */
    media_sample_cell(&full, 5, 10, 0, 0, 40, 40, &px, &pt, &pb);
    CHECK(px == 0 && pt == 0);
    media_sample_cell(&full, 5, 10, 4, 9, 40, 40, &px, &pt, &pb);
    CHECK(px >= 36 && pt >= 32);
    /* Every sample stays inside the buffer. */
    for (int r = 0; r < 5; r++)
        for (int c = 0; c < 10; c++) {
            media_sample_cell(&full, 5, 10, r, c, 40, 40, &px, &pt, &pb);
            CHECK(px >= 0 && px < 40 && pt >= 0 && pt < 40 && pb >= 0 && pb < 40);
        }

    /* The two halves of a cell come from DIFFERENT rows — that is what
     * a half block is. Collapsing them would halve the resolution
     * silently. */
    media_sample_cell(&full, 5, 10, 0, 0, 40, 40, &px, &pt, &pb);
    CHECK(pb > pt);

    /* BIGGER than the source: nearest neighbour repeats pixels, and
     * must still never step outside. */
    for (int r = 0; r < 30; r++)
        for (int c = 0; c < 60; c++) {
            media_sample_cell(&full, 30, 60, r, c, 40, 40, &px, &pt, &pb);
            CHECK(px >= 0 && px < 40 && pt >= 0 && pt < 40 && pb >= 0 && pb < 40);
        }

    /* A SOURCE RECTANGLE offsets: the bottom-right quadrant never
     * reaches back into the top-left, which is how one peer's tile is
     * lifted out of a composited frame without smearing its neighbour
     * into it. */
    struct media_src_rect qr = media_clamp_rect(20, 20, 20, 20, 40, 40);
    for (int r = 0; r < 6; r++)
        for (int c = 0; c < 12; c++) {
            media_sample_cell(&qr, 6, 12, r, c, 40, 40, &px, &pt, &pb);
            CHECK(px >= 20 && px < 40);
            CHECK(pt >= 20 && pt < 40 && pb >= 20 && pb < 40);
        }

    /* An odd geometry — the case a resized terminal actually produces,
     * where the divisions do not come out even. */
    struct media_src_rect odd = media_clamp_rect(0, 0, 0, 0, 37, 41);
    for (int r = 0; r < 7; r++)
        for (int c = 0; c < 13; c++) {
            media_sample_cell(&odd, 7, 13, r, c, 37, 41, &px, &pt, &pb);
            CHECK(px >= 0 && px < 37 && pt >= 0 && pt < 41 && pb >= 0 && pb < 41);
        }
}

/* Count the half-block glyphs in a box.
 *
 * mvin_wch, not mvinch: the block is a WIDE character, and mvinch
 * reports it as a plain space with a flag bit — so the obvious
 * "is this cell non-blank" test silently counts nothing. */
static int count_blocks(int y0, int x0, int rows, int cols) {
    int n = 0;
    for (int y = y0; y < y0 + rows; y++)
        for (int x = x0; x < x0 + cols; x++) {
            cchar_t cc;
            if (mvin_wch(y, x, &cc) == OK && cc.chars[0] == L'\u2580') n++;
        }
    return n;
}

/* And the draw itself: it FILLS the box it was given. The colour of
 * each cell is unreadable here, but whether a cell was written at all
 * is not — and fill-versus-clip is the property that matters. */
TEST(the_sampling_draw_fills_its_box_rather_than_clipping) {
    struct inline_media m;
    memset(&m, 0, sizeof(m));
    m.state = IM_READY;
    m.cols = 40;
    m.rows = 20; /* 40 x 40 pixels */
    m.frame_count = 1;
    m.rgb = calloc((size_t)40 * 40 * 3, 1);

    /* A box SMALLER than the picture in cells. The ordinary draw clips
     * to the picture's own cell size; this one must cover all 5x10. */
    erase();
    draw_media_region_locked(&m, 2, 3, 0, 0, 0, 0, 5, 10);
    CHECK(count_blocks(2, 3, 5, 10) == 50);

    /* A box BIGGER than the picture in cells: 20x60 from a 40x20-cell
     * picture, every one written (and it fits this 24x80 screen — a box
     * running off the bottom would assert nothing). Under ASan, a
     * sampling slip past the pixel buffer fails here rather than in a
     * call. */
    erase();
    draw_media_region_locked(&m, 0, 0, 0, 0, 0, 0, 20, 60);
    CHECK(count_blocks(0, 0, 20, 60) == 1200);

    /* Refusals draw nothing at all rather than a partial box. */
    erase();
    draw_media_region_locked(&m, 0, 0, 500, 500, 10, 10, 4, 8);
    draw_media_region_locked(&m, 0, 0, 0, 0, 0, 0, 0, 10);
    draw_media_region_locked(&m, 0, 0, 0, 0, 0, 0, 5, 0);
    draw_media_region_locked(NULL, 0, 0, 0, 0, 0, 0, 5, 10);
    CHECK(count_blocks(0, 0, 10, 20) == 0);

    free(m.rgb);
}

/* No screen: everything below the offscreen terminal is unrunnable, and
 * saying so is the whole job. Returning 0 here reported a green suite
 * that had asserted nothing at all on any host without a terminal
 * database — see test_skip_allowed in test.h. */
static int no_screen(const char *why) {
    if (test_skip_allowed()) {
        fprintf(stderr, "test_layout: %s — drawing tests skipped on request\n", why);
        return test_report();
    }
    fprintf(stderr,
            "test_layout: %s — the drawing tests cannot run. Install a terminal\n"
            "database (ncurses-base), or set SHOTTINO_TEST_ALLOW_SKIP=1 to accept\n"
            "a run that asserts only what needs no screen.\n",
            why);
    return 1;
}

int main(void) {
    test_use_temp_home();

    /* Same as the real program does before it touches ncurses. Without
     * it ncursesw has no multibyte encoding to work with and writes a
     * SPACE where a half block was asked for — which makes every
     * assertion about drawn picture cells quietly vacuous. */
    setlocale(LC_ALL, "");

    /* These two need no screen — one is arithmetic on a string, the
     * other asks ffmpeg what it decoded. They run BEFORE the offscreen
     * terminal so that a host that cannot provide one still checks them
     * rather than reporting on nothing. */
    RUN(the_topic_breaks_on_a_word);
    RUN(the_decoder_says_what_animates_not_the_url);

    FILE *sink = fopen("/dev/null", "w");
    if (!sink) return no_screen("cannot open /dev/null");
    /* An offscreen screen: no TTY, no terminfo beyond the entry named here. */
    if (!newterm("xterm", sink, stdin)) {
        fclose(sink);
        return no_screen("no usable terminfo entry");
    }
    RUN(audio_is_clickable_but_not_drawn);
    RUN(the_sidebar_records_a_row_for_every_window);
    RUN(a_modal_over_the_settings_panel_is_drawn);
    RUN(wrapped_text_tail_matches_full_draw);
    RUN(message_line_tail_matches_full_draw);
    RUN(zero_skip_is_the_ordinary_draw);
    RUN(tail_omits_the_nick_header);
    RUN(member_tiers_read_prefix_sigils_not_mode_letters);
    RUN(roster_sorts_by_tier_then_nick);
    RUN(roster_edits_keep_the_order_and_the_prefixes);
    RUN(muted_tier_needs_a_known_plus_m);
    RUN(roster_rows_count_the_muted_separator);
    RUN(current_window_key_copies_and_reports_absence);
    RUN(focus_is_derived_from_the_focused_pane);
    RUN(closing_a_window_renumbers_every_pane);
    RUN(an_operational_line_belongs_to_the_window_it_happened_in);
    RUN(menu_offers_reply_and_query_for_the_clicked_nick);
    RUN(reply_picker_lists_newest_first_and_filters);
    RUN(reply_picker_offers_every_line_not_one_per_nick);
    RUN(reply_picker_stops_at_twenty);
    RUN(media_picker_lists_this_windows_pictures_once_each);
    RUN(view_names_the_file_after_its_type);
    RUN(reply_cites_the_original_and_keeps_what_was_typed);
    RUN(reply_citation_is_flattened_and_cut_on_a_word);
    RUN(reply_leaves_a_line_it_did_not_write_alone);
    RUN(the_roster_records_a_region_per_nick_it_draws);
    RUN(each_pane_records_where_it_was_drawn);
    RUN(a_placement_the_frame_did_not_paint_is_stale);
    RUN(roster_pane_draws_from_the_offset);
    RUN(the_topic_band_is_at_most_two_lines);
    RUN(a_short_channel_name_leaves_the_topic_the_width);
    RUN(an_action_is_drawn_louder_than_system_noise);
    RUN(a_source_rectangle_is_clamped_into_the_picture);
    RUN(a_cell_samples_across_the_whole_rectangle);
    RUN(the_sampling_draw_fills_its_box_rather_than_clipping);
    endwin();
    fclose(sink);
    return test_report();
}
