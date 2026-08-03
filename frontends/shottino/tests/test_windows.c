/* test_windows — one window per IRC name, whatever case it arrives in.
 *
 * IRC names are case-insensitive, and this client compared them with
 * strcmp: `#Chan` and `#chan` opened two tabs, a NOTICE from `AzzuRRa`
 * opened a third beside the `azzurra` one already there, and a row whose
 * prefix disagreed with its window's spelling was filed under a scope no
 * window asked for — so it was drawn in none of them.
 *
 * The invariant this suite guards: a window is identified by its FOLDED
 * name, the fold is the ircd's (ASCII, `A-Z` only — `foo[1]` and `foo{1}`
 * stay two people), and every row files under the same canonical key its
 * window looks up.
 *
 * Like test_layout and test_commands, it compiles shottino.c itself: the
 * thing under test is app state, not a leaf module. */
#define main shottino_main_unused
#include "../shottino.c"
#undef main

#include "test.h"

static struct app *window_app(void) {
    struct app *app = calloc(1, sizeof(*app));
    if (!app) return NULL;
    pthread_mutex_init(&app->lock, NULL);
    pthread_mutex_init(&app->jobs_lock, NULL);
    pthread_cond_init(&app->jobs_cond, NULL);
    snprintf(app->subject, sizeof(app->subject), "user:vjt");
    struct network *n = &app->networks[app->network_count++];
    snprintf(n->slug, sizeof(n->slug), "azzurra");
    snprintf(n->nick, sizeof(n->nick), "vjt");
    /* 1, matching the live capture the admin tests replay — azzurra is
     * network 1 on a fresh instance, and the sessions tab resolves
     * `network_id` back to a slug through this table. */
    n->id = 1;
    return app;
}

static void free_app(struct app *app) {
    for (size_t i = 0; i < app->log_count; i++) free(app->log[i]);
    /* Mirrors the production teardown: the captured defaults are heap
     * strings and ASan is watching. */
    settings_free_defaults(app);
    /* Panel rows are heap-allocated too — the app owns them via
     * clear_panel_lines_locked in production. */
    for (size_t i = 0; i < app->panel_line_count; i++) free(app->panel_lines[i]);
    pthread_mutex_destroy(&app->lock);
    pthread_mutex_destroy(&app->jobs_lock);
    pthread_cond_destroy(&app->jobs_cond);
    free(app);
}

TEST(names_are_compared_under_the_ircds_casemapping) {
    CHECK(irc_name_eq("#chan", "#CHAN"));
    CHECK(irc_name_eq("AzzuRRa", "azzurra"));
    CHECK(!irc_name_eq("#chan", "#chan2"));
    /* CASEMAPPING=ascii: the bracket characters are ordinary, and two
     * nicks that differ in them are two people (#525). */
    CHECK(!irc_name_eq("foo[1]", "foo{1}"));
    /* Non-ASCII is left alone — the ircd keeps those apart. */
    CHECK(!irc_name_eq("#caf\xc3\x89", "#caf\xc3\xa9"));
}

TEST(a_channel_opened_twice_in_two_spellings_is_one_window) {
    struct app *app = window_app();
    CHECK(app != NULL);
    add_window_ex(app, "azzurra", "#Sniffo", false);
    add_window_ex(app, "azzurra", "#sniffo", false);
    add_window_ex(app, "AzzuRRa", "#SNIFFO", false);
    CHECK_LONG(app->window_count, 1);
    /* The FIRST spelling is what stays on screen: a window does not
     * rename itself under the user because a later message shouted. */
    CHECK_STR(app->windows[0].channel, "#Sniffo");
    free_app(app);
}

TEST(a_query_answered_in_another_case_reuses_its_window) {
    struct app *app = window_app();
    CHECK(app != NULL);
    add_window_ex(app, "azzurra", "Alice", false);
    add_window_ex(app, "azzurra", "alice", false);
    CHECK_LONG(app->window_count, 1);
    free_app(app);
}

TEST(a_row_files_under_its_windows_canonical_key) {
    struct app *app = window_app();
    CHECK(app != NULL);
    add_window_ex(app, "azzurra", "#Sniffo", true);

    /* A row whose prefix shouts, and a window whose name does not. */
    log_line(app, "[AzzuRRa/#SNIFFO] 10:00 <alice> ciao");
    char want[MAX_SLUG + MAX_CHANNEL + 8];
    window_scope_key(app->windows[0].network, app->windows[0].channel, want, sizeof(want));
    CHECK_STR(want, "[azzurra/#sniffo]");
    CHECK(log_row_in_scope(app, app->log_count - 1, want));

    /* A different channel still does not leak in. */
    log_line(app, "[azzurra/#other] 10:01 <bob> altrove");
    CHECK(!log_row_in_scope(app, app->log_count - 1, want));
    free_app(app);
}

TEST(the_server_window_is_a_name_not_a_spelling) {
    CHECK(is_server_window("$server"));
    CHECK(is_server_window("$SERVER"));
    CHECK(!is_server_window("#server"));
}

TEST(traffic_named_after_the_network_is_the_server_talking) {
    CHECK_STR(route_target("azzurra", "AzzuRRa"), "$server");
    CHECK_STR(route_target("azzurra", "azzurra"), "$server");
    /* A person, a channel and the server window itself are left alone. */
    CHECK_STR(route_target("azzurra", "alice"), "alice");
    CHECK_STR(route_target("azzurra", "#azzurra"), "#azzurra");
    CHECK_STR(route_target("azzurra", "$server"), "$server");
}

TEST(the_server_talking_opens_no_window_of_its_own) {
    struct app *app = window_app();
    CHECK(app != NULL);
    add_window_ex(app, "azzurra", "$server", false);
    /* Both spellings the ircd has used, and the query window grappa
     * minted for them. None of it is a new tab. */
    add_window_ex(app, "azzurra", "AzzuRRa", false);
    add_window_ex(app, "azzurra", "azzurra", false);
    CHECK_LONG(app->window_count, 1);
    CHECK_STR(app->windows[0].channel, "$server");
    free_app(app);
}

TEST(a_reply_card_lands_in_the_window_that_asked) {
    struct app *app = window_app();
    CHECK(app != NULL);
    add_window_ex(app, "azzurra", "$server", false);
    add_window_ex(app, "azzurra", "#sniffo", true); /* what the user is reading */

    card(app, "azzurra", "--- WHOIS alice");
    char here[MAX_SLUG + MAX_CHANNEL + 8], server[MAX_SLUG + MAX_CHANNEL + 8];
    window_scope_key("azzurra", "#sniffo", here, sizeof(here));
    window_scope_key("azzurra", "$server", server, sizeof(server));
    CHECK(log_row_in_scope(app, app->log_count - 1, here));
    CHECK(!log_row_in_scope(app, app->log_count - 1, server));

    /* An answer from a network the reader is not in stays on that
     * network's server window rather than barging into the channel. */
    card(app, "other", "--- WHOIS bob");
    char elsewhere[MAX_SLUG + MAX_CHANNEL + 8];
    window_scope_key("other", "$server", elsewhere, sizeof(elsewhere));
    CHECK(log_row_in_scope(app, app->log_count - 1, elsewhere));
    CHECK(!log_row_in_scope(app, app->log_count - 1, here));
    free_app(app);
}

/* ── The block list ────────────────────────────────────────────────── */

TEST(a_block_matches_the_person_not_the_spelling) {
    struct app *app = window_app();
    CHECK(app != NULL);
    CHECK(block_add_locked(app, "SpamMer"));
    CHECK(is_blocked_locked(app, "spammer"));
    CHECK(is_blocked_locked(app, "SPAMMER"));
    CHECK(!is_blocked_locked(app, "spammer2"));
    /* Adding twice is not two entries, and says so by returning false. */
    CHECK(!block_add_locked(app, "spammer"));
    CHECK_LONG(app->block_count, 1);
    /* Removing takes any spelling too, and only the once. */
    CHECK(block_remove_locked(app, "SPAMMER"));
    CHECK(!block_remove_locked(app, "spammer"));
    CHECK_LONG(app->block_count, 0);
    free_app(app);
}

TEST(a_blocked_person_is_not_drawn_but_is_still_counted) {
    struct app *app = window_app();
    CHECK(app != NULL);
    add_window_ex(app, "azzurra", "#sniffo", true);
    block_add_locked(app, "spammer");

    struct wire_scrollback_message m = { 0 };
    m.id = 41;
    m.network = "azzurra";
    m.channel = "#sniffo";
    m.sender = "alice";
    m.body = "ciao";
    m.kind = MSG_PRIVMSG;
    render_message(app, &m, true);
    size_t after_alice = app->log_count;
    CHECK(after_alice > 0);

    m.id = 42;
    m.sender = "SpamMer"; /* the same person, shouting */
    m.body = "buy things";
    render_message(app, &m, true);
    /* Nothing drawn... */
    CHECK_LONG(app->log_count, after_alice);
    /* ...but the window still knows how far the conversation got, so
     * reconnecting does not re-deliver what was hidden. */
    CHECK_LONG(app->windows[0].last_id, 42);
    /* And the row that IS on screen keeps its own id: a hidden message
     * must not stamp its id onto somebody else's line, which is what
     * drags the unread divider onto the wrong row. */
    CHECK_LONG(app->log_ids[after_alice - 1], 41);
    free_app(app);
}

/* ── The right-click menu ──────────────────────────────────────────── */

static size_t menu_for(struct app *app, const char *nick, struct overlay_item *items, size_t max) {
    app->overlay.kind = OVERLAY_MENU;
    snprintf(app->overlay.nick, sizeof(app->overlay.nick), "%s", nick);
    snprintf(app->overlay.body, sizeof(app->overlay.body), "%s", "something they said");
    return overlay_items_locked(app, items, max);
}

/* Does any row in the buffer say this? Used where a row is not
 * necessarily the LAST one — answering a CTCP query writes a line of
 * its own after the card. */
static bool log_has(struct app *app, const char *needle) {
    for (size_t i = 0; i < app->log_count; i++)
        if (strstr(app->log[i], needle)) return true;
    return false;
}

static bool menu_offers(struct overlay_item *items, size_t n, enum overlay_action action) {
    for (size_t i = 0; i < n; i++)
        if (items[i].action == action) return true;
    return false;
}

TEST(the_menu_offers_the_op_actions_only_to_an_op) {
    struct app *app = window_app();
    CHECK(app != NULL);
    add_window_ex(app, "azzurra", "#sniffo", true);
    struct window *w = &app->windows[0];
    snprintf(w->members[0].nick, sizeof(w->members[0].nick), "vjt");
    snprintf(w->members[0].modes, sizeof(w->members[0].modes), "+"); /* voiced, not op */
    snprintf(w->members[1].nick, sizeof(w->members[1].nick), "alice");
    w->member_count = 2;

    struct overlay_item items[64];
    size_t n = menu_for(app, "alice", items, 64);
    /* Everyone gets these. */
    CHECK(menu_offers(items, n, ACT_REPLY));
    CHECK(menu_offers(items, n, ACT_QUERY));
    CHECK(menu_offers(items, n, ACT_WHOIS));
    CHECK(menu_offers(items, n, ACT_PING));
    CHECK(menu_offers(items, n, ACT_BLOCK));
    /* A voiced user cannot kick, so the menu does not pretend. */
    CHECK(!menu_offers(items, n, ACT_KICK));
    CHECK(!menu_offers(items, n, ACT_BAN));
    CHECK(!menu_offers(items, n, ACT_KICKBAN));

    snprintf(w->members[0].modes, sizeof(w->members[0].modes), "@");
    n = menu_for(app, "alice", items, 64);
    CHECK(menu_offers(items, n, ACT_KICK));
    CHECK(menu_offers(items, n, ACT_BAN));
    CHECK(menu_offers(items, n, ACT_KICKBAN));
    free_app(app);
}

TEST(op_actions_stay_out_of_a_query_window) {
    struct app *app = window_app();
    CHECK(app != NULL);
    /* @ carried in a channel says nothing about a private conversation:
     * there is nobody to kick out of a query. */
    add_window_ex(app, "azzurra", "alice", true);
    struct window *w = &app->windows[0];
    snprintf(w->members[0].nick, sizeof(w->members[0].nick), "vjt");
    snprintf(w->members[0].modes, sizeof(w->members[0].modes), "@");
    w->member_count = 1;
    struct overlay_item items[64];
    size_t n = menu_for(app, "alice", items, 64);
    CHECK(!menu_offers(items, n, ACT_KICK));
    CHECK(menu_offers(items, n, ACT_PING));
    free_app(app);
}

TEST(the_block_entry_is_a_toggle) {
    struct app *app = window_app();
    CHECK(app != NULL);
    add_window_ex(app, "azzurra", "#sniffo", true);
    struct overlay_item items[64];
    size_t n = menu_for(app, "alice", items, 64);
    CHECK(menu_offers(items, n, ACT_BLOCK));
    CHECK(!menu_offers(items, n, ACT_UNBLOCK));

    block_add_locked(app, "ALICE");
    n = menu_for(app, "alice", items, 64);
    CHECK(menu_offers(items, n, ACT_UNBLOCK));
    CHECK(!menu_offers(items, n, ACT_BLOCK));
    free_app(app);
}

/* ── CTCP replies ──────────────────────────────────────────────────── */

TEST(a_ctcp_reply_is_an_answer_not_a_message) {
    struct app *app = window_app();
    CHECK(app != NULL);
    add_window_ex(app, "azzurra", "$server", false);
    add_window_ex(app, "azzurra", "#sniffo", true);

    struct wire_scrollback_message m = { 0 };
    m.id = 7;
    m.network = "azzurra";
    m.channel = "vjt";
    m.sender = "alice";
    m.kind = MSG_NOTICE;
    /* Registered first: a PING reply is only OURS if we are waiting on
     * that exact stamp. This test used to send an unregistered one and
     * expect it reported, which is the behaviour that announced a round
     * trip for somebody else's ping crossing our scrollback. */
    long stamp = monotonic_ms() - 420;
    ping_remember(app, "azzurra", "alice", stamp);
    char body[64];
    snprintf(body, sizeof(body), "\001PING %ld\001", stamp);
    m.body = body;
    render_message(app, &m, true);
    CHECK(app->log_count > 0);

    /* Drawn as a card, in the window the user is reading — not as a raw
     * control-character line, and not in a query window of its own. */
    CHECK_LONG(app->window_count, 2);
    const char *row = app->log[app->log_count - 1];
    CHECK(strstr(row, "PING reply from alice") != NULL);
    CHECK(strstr(row, "\001") == NULL);
    char here[MAX_SLUG + MAX_CHANNEL + 8];
    window_scope_key("azzurra", "#sniffo", here, sizeof(here));
    CHECK(log_row_in_scope(app, app->log_count - 1, here));

    /* A CTCP we did not stamp is shown for what it is rather than turned
     * into a nonsense duration. */
    m.id = 8;
    m.body = "\001VERSION irssi 1.4.5\001";
    render_message(app, &m, true);
    CHECK(strstr(app->log[app->log_count - 1], "CTCP VERSION reply from alice: irssi 1.4.5") != NULL);
    free_app(app);
}

/* ── Operator verbs ───────────────────────────────────────────────────
 *
 * These go out as raw lines, so the only thing that can be wrong is the
 * line — a missing colon turns a reason into a truncated first word, and
 * a colon where the ircd wanted a parameter turns a K:line duration into
 * text. That is what is asserted here. */

static const struct oper_verb *oper_verb_named(const char *verb) {
    for (size_t i = 0; i < sizeof(oper_verbs) / sizeof(oper_verbs[0]); i++)
        if (strcmp(oper_verbs[i].verb, verb) == 0) return &oper_verbs[i];
    return NULL;
}

static const char *oper_line(const char *verb, const char *args) {
    static char out[MAX_LINE];
    const struct oper_verb *v = oper_verb_named(verb);
    if (!v) return "(no such verb)";
    if (!oper_verb_line(v, args, out, sizeof(out))) return "(refused)";
    return out;
}

TEST(oper_verbs_put_their_arguments_where_the_ircd_wants_them) {
    /* A reason is a trailing parameter: everything after the nick, in
     * one piece, spaces and all. */
    CHECK_STR(oper_line("/kill", "alice being rude on #chan"),
              "KILL alice :being rude on #chan");
    CHECK_STR(oper_line("/squit", "hub.azzurra.org rerouting"),
              "SQUIT hub.azzurra.org :rerouting");
    /* The broadcasts are all trailing parameter. */
    CHECK_STR(oper_line("/wallops", "netsplit incoming"), "WALLOPS :netsplit incoming");
    CHECK_STR(oper_line("/globops", "who is on duty?"), "GLOBOPS :who is on duty?");
    CHECK_STR(oper_line("/locops", "local only"), "LOCOPS :local only");
    /* bahamut's K:line takes an optional leading duration, which must
     * NOT be read as the mask. */
    CHECK_STR(oper_line("/kline", "*@spam.example flooding"),
              "KLINE *@spam.example :flooding");
    CHECK_STR(oper_line("/kline", "3600 *@spam.example flooding"),
              "KLINE 3600 *@spam.example :flooding");
    /* Server-specific grammar goes through untouched — a colon we
     * invented would corrupt it. */
    CHECK_STR(oper_line("/sconnect", "leaf.azzurra.org 6667"), "CONNECT leaf.azzurra.org 6667");
    CHECK_STR(oper_line("/trace", ""), "TRACE");
    CHECK_STR(oper_line("/trace", "alice"), "TRACE alice");
    CHECK_STR(oper_line("/die", ""), "DIE");
}

TEST(an_oper_verb_missing_its_arguments_is_refused_not_sent) {
    /* Half a KILL is not a KILL: the server would reject it, and the
     * user would read the rejection as the client having sent nothing. */
    CHECK_STR(oper_line("/kill", "alice"), "(refused)");
    CHECK_STR(oper_line("/kill", ""), "(refused)");
    CHECK_STR(oper_line("/wallops", ""), "(refused)");
    CHECK_STR(oper_line("/kline", "3600"), "(refused)");
    CHECK_STR(oper_line("/kline", "*@host"), "(refused)");
    /* The ones whose arguments are genuinely optional still go. */
    CHECK_STR(oper_line("/restart", ""), "RESTART");
}

TEST(an_oper_verb_is_matched_as_a_whole_word) {
    /* /kill must not be answered by /kickban, and a verb must not
     * swallow a longer word that starts the same way. */
    CHECK(verb_args("/kill alice", "/kill") != NULL);
    CHECK(verb_args("/kill", "/kill") != NULL);
    CHECK(verb_args("/killer alice", "/kill") == NULL);
    CHECK(verb_args("/kickban alice", "/kill") == NULL);
}

TEST(every_oper_verb_explains_itself) {
    for (size_t i = 0; i < sizeof(oper_verbs) / sizeof(oper_verbs[0]); i++) {
        const struct oper_verb *v = &oper_verbs[i];
        /* The table IS the help: a topic that does not start with the
         * verb is a topic about something else. */
        CHECK(v->usage != NULL);
        CHECK(strncmp(v->usage, v->verb, strlen(v->verb)) == 0);
        /* And the wire verb is the ircd's, in the ircd's case. */
        for (const char *c = v->wire; *c; c++) CHECK(*c >= 'A' && *c <= 'Z');
    }
}

TEST(kill_is_offered_only_to_an_oper) {
    struct app *app = window_app();
    CHECK(app != NULL);
    add_window_ex(app, "azzurra", "#sniffo", true);
    struct overlay_item items[64];

    size_t n = menu_for(app, "alice", items, 64);
    CHECK(!menu_offers(items, n, ACT_KILL));

    /* +o arrives from the server, not from having typed /oper. */
    snprintf(app->networks[0].umodes, sizeof(app->networks[0].umodes), "iwS");
    n = menu_for(app, "alice", items, 64);
    CHECK(!menu_offers(items, n, ACT_KILL));

    snprintf(app->networks[0].umodes, sizeof(app->networks[0].umodes), "iwo");
    n = menu_for(app, "alice", items, 64);
    CHECK(menu_offers(items, n, ACT_KILL));

    /* Network-wide, so it is offered in a query window too — unlike the
     * channel-op actions. */
    add_window_ex(app, "azzurra", "bob", true);
    n = menu_for(app, "bob", items, 64);
    CHECK(menu_offers(items, n, ACT_KILL));
    CHECK(!menu_offers(items, n, ACT_KICK));
    free_app(app);
}

/* ── /wire ─────────────────────────────────────────────────────────── */

TEST(the_wire_echo_never_prints_a_payload) {
    char out[MAX_LINE];
    /* The verb and the network it names — that is the diagnostic. */
    wire_push_summary("whois", "{\"network_id\":7,\"nick\":\"alice\"}", out, sizeof(out));
    CHECK_STR(out, "wire -> whois (network_id=7)");
    CHECK(strstr(out, "alice") == NULL);

    /* And NOT the payload, which is where the passwords are: /oper
     * carries one directly, and a raw line carries whatever was typed —
     * including the IDENTIFY every network's services want. A debug
     * switch that leaks a credential is worse than the bug it was turned
     * on to find. */
    wire_push_summary("oper", "{\"network_id\":7,\"name\":\"vjt\",\"password\":\"hunter2\"}", out,
                      sizeof(out));
    CHECK(strstr(out, "hunter2") == NULL);
    CHECK(strstr(out, "vjt") == NULL);
    wire_push_summary("raw", "{\"network_id\":7,\"line\":\"PRIVMSG NickServ :IDENTIFY hunter2\"}",
                      out, sizeof(out));
    CHECK(strstr(out, "hunter2") == NULL);
    CHECK(strstr(out, "IDENTIFY") == NULL);

    /* A payload without a network still names its verb. */
    wire_push_summary("read_cursor", "{\"channel\":\"#c\"}", out, sizeof(out));
    CHECK_STR(out, "wire -> read_cursor");
}

/* ── Phoenix v2 framing ────────────────────────────────────────────── */

TEST(a_push_carries_the_joins_ref_not_its_own) {
    /* [join_ref, ref, topic, event, payload]. On a client push the FIRST
     * slot must be the ref of the phx_join that opened the channel:
     * Phoenix matches it against the channel's own join_ref and discards
     * anything else with no reply and no error. Sending a fresh ref in
     * both slots — which this client did — meant every verb it asked
     * (whois, lusers, motd, away, quote, read cursors) was thrown away
     * in silence, while REST verbs and server→client pushes kept
     * working. That is the bug this test exists for. */
    char *join = ws_v2_frame(3, 3, "grappa:user:vjt", "phx_join", "{}");
    CHECK_STR(join, "[\"3\",\"3\",\"grappa:user:vjt\",\"phx_join\",{}]");
    free(join);

    char *push = ws_v2_frame(3, 7, "grappa:user:vjt", "whois", "{\"nick\":\"alice\"}");
    CHECK_STR(push, "[\"3\",\"7\",\"grappa:user:vjt\",\"whois\",{\"nick\":\"alice\"}]");
    free(push);

    /* The heartbeat rides a topic nobody joins, so its join_ref is null
     * rather than a number that matches no channel. */
    char *hb = ws_v2_frame(0, 9, "phoenix", "heartbeat", "{}");
    CHECK_STR(hb, "[null,\"9\",\"phoenix\",\"heartbeat\",{}]");
    free(hb);
}

/* ── CTCP ping lifecycle ───────────────────────────────────────────── */

TEST(a_ping_reply_is_matched_against_the_pings_we_are_waiting_on) {
    struct app *app = window_app();
    CHECK(app != NULL);
    add_window_ex(app, "azzurra", "$server", false);
    add_window_ex(app, "azzurra", "#sniffo", true);

    long stamp = monotonic_ms() - 420;
    ping_remember(app, "azzurra", "Alice", stamp);
    CHECK_LONG(app->ping_count, 1);

    /* The reply comes back from the same person in whatever case the
     * ircd spells them, and claims the entry exactly once. */
    CHECK(ping_claim(app, "azzurra", "alice", stamp));
    CHECK_LONG(app->ping_count, 0);
    CHECK(!ping_claim(app, "azzurra", "alice", stamp));

    /* Somebody else's ping, and our own stamp from another network, are
     * not ours to report. */
    ping_remember(app, "azzurra", "alice", stamp);
    CHECK(!ping_claim(app, "azzurra", "bob", stamp));
    CHECK(!ping_claim(app, "other", "alice", stamp));
    CHECK(!ping_claim(app, "azzurra", "alice", stamp + 1));
    CHECK_LONG(app->ping_count, 1);
    free_app(app);
}

TEST(a_backfilled_ping_reply_still_reports_its_round_trip) {
    /* The reply to a ping that opened no query window arrives ONLY in
     * that window's backfill — not live. Reporting live-only (which the
     * first version did) meant /ping answered nothing at all for anyone
     * you were not already talking to. */
    struct app *app = window_app();
    CHECK(app != NULL);
    add_window_ex(app, "azzurra", "$server", false);
    add_window_ex(app, "azzurra", "#sniffo", true);

    long stamp = monotonic_ms() - 250;
    ping_remember(app, "azzurra", "alice", stamp);

    char body[64];
    snprintf(body, sizeof(body), "\001PING %ld\001", stamp);
    struct wire_scrollback_message m = { 0 };
    m.id = 5;
    m.network = "azzurra";
    m.channel = "vjt";
    m.sender = "alice";
    m.kind = MSG_NOTICE;
    m.body = body;
    render_message(app, &m, false); /* NOT live: this is the backfill */

    const char *row = app->log[app->log_count - 1];
    CHECK(strstr(row, "PING reply from alice") != NULL);
    CHECK_LONG(app->ping_count, 0);
    free_app(app);
}

TEST(an_unsolicited_ping_reply_is_never_reported_as_our_round_trip) {
    /* A reply we never asked for must not be announced as a round trip
     * that never happened — no "PING reply from X: N.NNs" line, because
     * the stamp is not ours to subtract from. Live, it IS shown for what
     * it is (see a_ping_reply_we_did_not_time_is_still_shown_when_live);
     * out of a backfill it stays silent entirely. */
    struct app *app = window_app();
    CHECK(app != NULL);
    add_window_ex(app, "azzurra", "#sniffo", true);

    struct wire_scrollback_message m = { 0 };
    m.id = 6;
    m.network = "azzurra";
    m.channel = "vjt";
    m.sender = "mallory";
    m.kind = MSG_NOTICE;
    m.body = "\001PING 12345\001";
    render_message(app, &m, true);
    /* The TIMED form is "--- PING reply from X: N.NNs"; the untimed one
     * is "--- CTCP PING reply from X: <token>". Distinguished by the
     * prefix, so this asserts the absence of the former rather than
     * matching a substring both share. */
    CHECK(!log_has(app, "--- PING reply from mallory"));
    CHECK(log_has(app, "--- CTCP PING reply from mallory: 12345"));

    /* Backfilled: nothing at all. */
    size_t before = app->log_count;
    m.id = 7;
    render_message(app, &m, false);
    CHECK_LONG(app->log_count, before);
    free_app(app);
}

TEST(an_inbound_ctcp_query_is_named_not_dumped) {
    /* What a self-ping used to look like: `^APING 1234^A` drawn as a
     * chat line in a query window with yourself. It is a question asked
     * of this session, so it reads as one — and it opens no window. */
    struct app *app = window_app();
    CHECK(app != NULL);
    add_window_ex(app, "azzurra", "$server", false);
    add_window_ex(app, "azzurra", "#sniffo", true);
    size_t windows_before = app->window_count;

    struct wire_scrollback_message m = { 0 };
    m.id = 7;
    m.network = "azzurra";
    m.channel = "vjt";
    m.sender = "vjt";
    m.kind = MSG_PRIVMSG;
    m.body = "\001PING 1753776000123\001";
    render_message(app, &m, true);

    CHECK(log_has(app, "CTCP PING from vjt"));
    CHECK(!log_has(app, "\001"));
    CHECK_LONG(app->window_count, windows_before);
    free_app(app);
}

TEST(a_ctcp_query_is_answered_only_where_it_is_ours_to_answer) {
    char verb[32], payload[MAX_LINE];

    /* The split the responder and the renderer share. */
    ctcp_split("\001PING 1753776000123\001", verb, sizeof(verb), payload, sizeof(payload));
    CHECK_STR(verb, "PING");
    CHECK_STR(payload, "1753776000123");

    /* Lowercase verbs are the same verb; a token-less query has no
     * token rather than a made-up one. */
    ctcp_split("\001ping\001", verb, sizeof(verb), payload, sizeof(payload));
    CHECK_STR(verb, "PING");
    CHECK_STR(payload, "");

    /* The payload is copied verbatim — spaces and all — because for
     * PING it is the asker's token and must return unchanged. */
    ctcp_split("\001PING a b c\001", verb, sizeof(verb), payload, sizeof(payload));
    CHECK_STR(payload, "a b c");

    struct app *app = window_app();
    CHECK(app != NULL);
    add_window_ex(app, "azzurra", "#sniffo", true);

    /* VERSION is grappa's to answer — it is awake when this client is
     * not, and two answers to one query is worse than none. Asking the
     * responder to handle it must do nothing at all. */
    app->ctcp_last_reply_ms = 0;
    ctcp_respond(app, "azzurra", "alice", "VERSION", "");
    CHECK_LONG(app->ctcp_last_reply_ms, 0);

    /* A nameless sender is nobody to answer. */
    ctcp_respond(app, "azzurra", "", "PING", "1");
    CHECK_LONG(app->ctcp_last_reply_ms, 0);

    /* A PING is answered — the throttle stamp is the observable part
     * here; the socket is not connected in a test, so the push itself
     * is a no-op. */
    ctcp_respond(app, "azzurra", "alice", "PING", "1");
    CHECK(app->ctcp_last_reply_ms != 0);

    /* And the next one, immediately after, is throttled: a client that
     * answers every query in a flood is a client that can be pointed at
     * the server. */
    long first = app->ctcp_last_reply_ms;
    ctcp_respond(app, "azzurra", "bob", "PING", "2");
    CHECK_LONG(app->ctcp_last_reply_ms, first);

    /* A token too long to fit an IRC line is NOT echoed: the asker would
     * receive a truncated one back and rightly ignore it, and answering
     * with a corrupted echo is a lie about what they sent. */
    static char huge[CTCP_REPLY_MAX_TOKEN + 64];
    memset(huge, 'x', sizeof(huge) - 1);
    huge[sizeof(huge) - 1] = 0;
    app->ctcp_last_reply_ms = 0;
    ctcp_respond(app, "azzurra", "alice", "PING", huge);
    CHECK_LONG(app->ctcp_last_reply_ms, 0);
    free_app(app);
}

TEST(a_ping_reply_routed_to_server_still_lands_in_the_active_window) {
    /* grappa carves a CTCP-framed NOTICE out of the peer-DM route and
     * persists it on $server, so it mints no query window. The reply then
     * arrives with channel = "$server" rather than the peer's name — and
     * it must STILL be reported where the question was asked, exactly
     * like /whois. The client keys on the FRAMING and the outstanding
     * ping, never on which window the row was filed under, which is what
     * makes it survive that routing change. */
    struct app *app = window_app();
    CHECK(app != NULL);
    add_window_ex(app, "azzurra", "$server", false);
    add_window_ex(app, "azzurra", "#sniffo", true);

    long stamp = monotonic_ms() - 310;
    ping_remember(app, "azzurra", "alice", stamp);

    char body[64];
    snprintf(body, sizeof(body), "\001PING %ld\001", stamp);
    struct wire_scrollback_message m = { 0 };
    m.id = 9;
    m.network = "azzurra";
    m.channel = "$server"; /* where grappa now files it */
    m.sender = "alice";
    m.kind = MSG_NOTICE;
    m.body = body;
    render_message(app, &m, true);

    CHECK(log_has(app, "PING reply from alice"));
    /* In the window being READ, not in $server. */
    char here[MAX_SLUG + MAX_CHANNEL + 8], server[MAX_SLUG + MAX_CHANNEL + 8];
    window_scope_key("azzurra", "#sniffo", here, sizeof(here));
    window_scope_key("azzurra", "$server", server, sizeof(server));
    CHECK(log_row_in_scope(app, app->log_count - 1, here));
    CHECK(!log_row_in_scope(app, app->log_count - 1, server));
    /* And no tab for the person we pinged. */
    CHECK_LONG(app->window_count, 2);
    free_app(app);
}

TEST(a_ctcp_query_is_framed_the_way_the_protocol_expects) {
    char out[MAX_LINE];

    /* `<target> <VERB> [args]` → `PRIVMSG target :\001VERB args\001`.
     * The verb upcases (protocol convention, and services match on it);
     * the arguments go through VERBATIM, because for PING they are a
     * token that has to round-trip. */
    CHECK(ctcp_request_line("alice VERSION", out, sizeof(out)));
    CHECK_STR(out, "PRIVMSG alice :\001VERSION\001");

    CHECK(ctcp_request_line("alice version", out, sizeof(out)));
    CHECK_STR(out, "PRIVMSG alice :\001VERSION\001");

    CHECK(ctcp_request_line("alice PING 1753776000123", out, sizeof(out)));
    CHECK_STR(out, "PRIVMSG alice :\001PING 1753776000123\001");

    /* A channel is a legal CTCP target. */
    CHECK(ctcp_request_line("#sniffo TIME", out, sizeof(out)));
    CHECK_STR(out, "PRIVMSG #sniffo :\001TIME\001");

    /* Multi-word arguments stay whole. */
    CHECK(ctcp_request_line("alice ACTION waves at you", out, sizeof(out)));
    CHECK_STR(out, "PRIVMSG alice :\001ACTION waves at you\001");

    /* Missing verb or target is usage, not `PRIVMSG  :\001\001`. */
    CHECK(!ctcp_request_line("alice", out, sizeof(out)));
    CHECK(!ctcp_request_line("", out, sizeof(out)));
    CHECK(!ctcp_request_line("   ", out, sizeof(out)));
}

TEST(a_ping_reply_we_did_not_time_is_still_shown_when_live) {
    /* `/ctcp nick PING <own-token>` gets an answer this client never
     * registered. Silently dropping it — which the matched-only rule did
     * — makes /ctcp PING look broken. Live, it is reported for what it
     * is; out of a backfill it stays quiet, because timing it against a
     * stamp from a previous run would be a lie. */
    struct app *app = window_app();
    CHECK(app != NULL);
    add_window_ex(app, "azzurra", "#sniffo", true);

    struct wire_scrollback_message m = { 0 };
    m.id = 11;
    m.network = "azzurra";
    m.channel = "$server";
    m.sender = "alice";
    m.kind = MSG_NOTICE;
    m.body = "\001PING deadbeef\001";
    render_message(app, &m, true);
    CHECK(log_has(app, "CTCP PING reply from alice: deadbeef"));

    size_t before = app->log_count;
    m.id = 12;
    render_message(app, &m, false); /* backfilled: stays quiet */
    CHECK_LONG(app->log_count, before);
    free_app(app);
}

/* ── Audio ─────────────────────────────────────────────────────────── */

TEST(audio_is_classified_before_the_uploads_heuristic) {
    /* The trap this test exists for: `/uploads/` marks anything this
     * deployment hosts as a picture, so an uploaded .mp3 would be handed
     * to the image decoder and look broken rather than unsupported.
     * Audio has to win first. */
    CHECK_LONG(media_kind_of("https://irc.example/uploads/abc123.mp3"), MEDIA_AUDIO);
    CHECK_LONG(media_kind_of("https://irc.example/uploads/abc123.png"), MEDIA_IMAGE);
    /* A bare /uploads/ URL with no extension stays a picture — that is
     * the pre-existing heuristic, deliberately untouched. */
    CHECK_LONG(media_kind_of("https://irc.example/uploads/abc123"), MEDIA_IMAGE);

    /* Every extension /upload can send, plus the ones it cannot: the
     * server refuses ogg/opus UPLOADS, but a link to somebody else's is
     * still audio and still playable. */
    const char *audio[] = {"http://h/a.mp3",  "http://h/a.m4a", "http://h/a.m4r",
                           "http://h/a.aac",  "http://h/a.wav", "http://h/a.flac",
                           "http://h/a.ogg",  "http://h/a.oga", "http://h/a.opus", NULL};
    for (size_t i = 0; audio[i]; i++) CHECK_LONG(media_kind_of(audio[i]), MEDIA_AUDIO);

    /* .ogv is VIDEO and must not be swallowed by the .ogg rule. */
    CHECK_LONG(media_kind_of("http://h/clip.ogv"), MEDIA_VIDEO);
    CHECK_LONG(media_kind_of("http://h/clip.mp4"), MEDIA_VIDEO);

    /* Case and a query string do not change the answer (same token
     * lowering every other kind goes through). */
    CHECK_LONG(media_kind_of("http://h/Song.MP3?sig=abc"), MEDIA_AUDIO);

    /* Not audio. */
    CHECK_LONG(media_kind_of("http://h/page.html"), MEDIA_NONE);

    /* Recording pre-existing behaviour rather than asserting what the
     * name promises: `token_has_suffix` is a strstr, so ANY extension
     * appearing anywhere in the token matches — `notes.mp3.txt` reads as
     * audio, exactly as `shot.png.txt` already reads as an image. Adding
     * a kind is not the change that should quietly tighten that for
     * every other kind too; noted, not fixed here. */
    CHECK_LONG(media_kind_of("http://h/notes.mp3.txt"), MEDIA_AUDIO);
    CHECK_LONG(media_kind_of("http://h/shot.png.txt"), MEDIA_IMAGE);
}

/* ── Admin panel wire shapes ───────────────────────────────────────────
 *
 * These renderers read the ADMIN API's JSON directly, and nothing linked
 * them to it: three of them had drifted to keys the server has never
 * sent, so the panel rendered "?" columns, a 0 B total and a visitor
 * count with no rows under it — all of it silent, because a missing JSON
 * key is indistinguishable from an empty one at the read site.
 *
 * The payloads below are VERBATIM captures from a live grappa
 * (0.8.0) — an invented fixture would only re-encode the same wrong
 * assumption the renderers made. */

static const char *const ADMIN_SESSIONS_JSON =
    "{\"sessions\":[{\"subject_kind\":\"user\",\"network_id\":1,"
    "\"subject_label\":\"nextime\","
    "\"subject_id\":\"df744b5e-ff5a-4d01-bf6f-fffb049e7f9e\","
    "\"last_seen_at\":\"2026-08-01T07:19:31.959297Z\","
    "\"live_state\":{\"alive\":true,\"peer_address\":\"15.161.158.234\","
    "\"peer_port\":6697,\"introspection_degraded\":[],"
    "\"joined_channels\":[\"#grappa\",\"#sniffo\",\"#vua\"],"
    "\"mailbox_len\":0,\"memory_bytes\":264648,\"peer_name\":null,"
    "\"pid_inspect\":\"#PID<0.893.0>\"}}]}";

static const char *const ADMIN_UPLOADS_JSON =
    "{\"live_bytes_sum\":0,\"global_cap_bytes\":10737418240,"
    "\"uploads\":[{\"id\":\"u1\",\"slug\":\"abc\",\"mime\":\"image/png\","
    "\"bytes\":2048,\"original_filename\":\"a.png\",\"subject_kind\":\"user\","
    "\"subject_id\":\"u\",\"expires_at\":null,\"deleted_at\":null,"
    "\"inserted_at\":\"2026-08-01T01:00:00Z\"}]}";

static const char *const ADMIN_VISITORS_JSON =
    "{\"visitors\":[{\"id\":\"v-123456789\",\"expires_at\":null,"
    "\"identified\":true,\"ip\":\"10.0.0.1\","
    "\"inserted_at\":\"2026-08-01T01:00:00Z\","
    "\"networks\":[{\"network_slug\":\"azzurra\",\"network_id\":1,"
    "\"nick\":\"guest42\",\"connection_state\":\"connected\","
    "\"live_state\":{\"alive\":true}}]}]}";

static void render_json(struct app *app, const char *json,
                        void (*render)(struct app *, const json_value *)) {
    json_doc *doc = json_parse(json, strlen(json), NULL, 0);
    CHECK(doc != NULL);
    if (!doc) return;
    render(app, json_root(doc));
    json_free(doc);
}

static bool panel_has(struct app *app, const char *needle) {
    for (size_t i = 0; i < app->panel_line_count; i++)
        if (strstr(app->panel_lines[i], needle)) return true;
    return false;
}

TEST(the_admin_sessions_tab_reads_the_shape_the_server_sends) {
    struct app *app = window_app();
    CHECK(app != NULL);
    render_json(app, ADMIN_SESSIONS_JSON, render_admin_sessions);

    /* network_id 1 resolves to the slug the client already knows. */
    CHECK(panel_has(app, "azzurra"));
    CHECK(panel_has(app, "user:nextime"));
    CHECK(panel_has(app, "alive"));
    /* joined_channels has three entries. */
    CHECK(panel_has(app, "3"));
    /* The old reader's tell was a row of literal question marks — one
     * per key it asked for and did not get. */
    CHECK(!panel_has(app, "?"));
    free_app(app);
}

TEST(the_admin_uploads_tab_totals_the_bytes_field) {
    struct app *app = window_app();
    CHECK(app != NULL);
    render_json(app, ADMIN_UPLOADS_JSON, render_admin_uploads);
    /* 2048 bytes — not the 0 B a `byte_size` reader reported. */
    CHECK(panel_has(app, "2.0 KB"));
    CHECK(!panel_has(app, "0 B total"));
    free_app(app);
}

TEST(the_admin_visitors_tab_renders_per_network_rows) {
    struct app *app = window_app();
    CHECK(app != NULL);
    render_json(app, ADMIN_VISITORS_JSON, render_admin_visitors);
    /* The row exists at all — the old top-level `nick` read made the
     * guard skip every visitor, so the count had nothing under it. */
    CHECK(panel_has(app, "v-123456789"));
    CHECK(panel_has(app, "identified"));
    /* The nick lives per-network, and so does its connection state. */
    CHECK(panel_has(app, "guest42"));
    CHECK(panel_has(app, "connected"));
    free_app(app);
}

TEST(a_setting_name_and_a_boolean_are_parsed_the_way_people_type_them) {
    bool v = false;
    /* Every spelling somebody reaches for, because "expected on or off"
     * after typing `yes` is a client arguing with its user. */
    const char *yes[] = { "on", "ON", "true", "1", "yes", "y", NULL };
    for (size_t i = 0; yes[i]; i++) {
        v = false;
        CHECK(setting_parse_bool(yes[i], &v));
        CHECK(v);
    }
    const char *no[] = { "off", "OFF", "false", "0", "no", "n", NULL };
    for (size_t i = 0; no[i]; i++) {
        v = true;
        CHECK(setting_parse_bool(no[i], &v));
        CHECK(!v);
    }
    /* Anything else is refused rather than guessed at. */
    CHECK(!setting_parse_bool("maybe", &v));
    CHECK(!setting_parse_bool("", &v));

    /* The registry is the answer to "what can I configure?" — a name
     * that dispatches must be findable, case-insensitively. */
    CHECK(setting_find("mouse") != NULL);
    CHECK(setting_find("LLM.Token") != NULL);
    CHECK(setting_find("nonesuch") == NULL);
}

TEST(the_settings_listing_never_prints_the_token) {
    struct app *app = window_app();
    CHECK(app != NULL);
    snprintf(app->llm.token, sizeof(app->llm.token), "sk-thisisasecret");
    snprintf(app->llm.model, sizeof(app->llm.model), "gpt-4o-mini");

    char out[256];
    setting_value(app, "llm.token", out, sizeof(out));
    CHECK_STR(out, "********");
    CHECK(strstr(out, "sk-") == NULL);

    /* Everything else reports itself normally — the masking is one
     * field's rule, not a blanket that hides the config. */
    setting_value(app, "llm.model", out, sizeof(out));
    CHECK_STR(out, "gpt-4o-mini");
    setting_value(app, "mouse", out, sizeof(out));
    CHECK(strcmp(out, "on") == 0 || strcmp(out, "off") == 0);
    free_app(app);
}

/* ── /bot: who may drive it ────────────────────────────────────────── */

TEST(a_nick_match_alone_is_never_the_owner) {
    struct app *app = window_app();
    CHECK(app != NULL);
    add_window_ex(app, "azzurra", "#sniffo", true);
    snprintf(app->bot_owner, sizeof(app->bot_owner), "nextime");

    /* Somebody using the owner's nick, with NOTHING known about their
     * services login. This is the whole attack: a nick is borrowed,
     * dropped and taken every day, and a bare match must not authorise
     * anything. Unverifiable means not the owner. */
    CHECK(!bot_sender_is_owner(app, "azzurra", "nextime"));

    /* A different nick is not the owner however authenticated it is. */
    whois_fact_record(app, "mallory", "mallory-account", true);
    CHECK(!bot_sender_is_owner(app, "azzurra", "mallory"));

    /* Verified by services → owner. */
    whois_fact_record(app, "nextime", "nextime-account", true);
    CHECK(bot_sender_is_owner(app, "azzurra", "nextime"));

    /* Known to services but NOT identified is still not the owner. */
    whois_fact_record(app, "nextime", "", false);
    CHECK(!bot_sender_is_owner(app, "azzurra", "nextime"));

    /* No owner configured: nobody on the network qualifies, ever. */
    app->bot_owner[0] = 0;
    whois_fact_record(app, "nextime", "nextime-account", true);
    CHECK(!bot_sender_is_owner(app, "azzurra", "nextime"));
    free_app(app);
}

TEST(a_grant_is_per_person_and_per_tool) {
    struct app *app = window_app();
    CHECK(app != NULL);
    bot_grant_add(app, "alice", "send_message");

    CHECK(bot_has_grant(app, "alice", "send_message"));
    /* Case-folded like every other nick compare. */
    CHECK(bot_has_grant(app, "ALICE", "send_message"));
    /* Approving her to SPEAK does not approve her to make the client
     * join channels — that is the point of granting per pair. */
    CHECK(!bot_has_grant(app, "alice", "join_channel"));
    /* And it does not approve anybody else for anything. */
    CHECK(!bot_has_grant(app, "bob", "send_message"));

    /* Adding twice does not double the row. */
    bot_grant_add(app, "alice", "send_message");
    CHECK_LONG(app->bot_grant_count, 1);
    free_app(app);
}

/* A memory's filename is BUILT from the title, never taken from it: the
 * model picks the words, and it must not be able to pick the path. */
TEST(a_memory_filename_is_built_not_taken) {
    char slug[128];

    CHECK(bot_memory_slug("Nextime prefers short answers", slug, sizeof(slug)));
    CHECK_STR(slug, "nextime-prefers-short-answers.md");

    /* Traversal is not rejected — it is UNREPRESENTABLE. Dots and
     * slashes are simply not in the alphabet the builder draws from. */
    CHECK(bot_memory_slug("../../.ssh/authorized_keys", slug, sizeof(slug)));
    CHECK(strstr(slug, "..") == NULL);
    CHECK(strchr(slug, '/') == NULL);
    CHECK_STR(slug, "ssh-authorized-keys.md");

    CHECK(bot_memory_slug("a\nb\tc", slug, sizeof(slug)));
    CHECK_STR(slug, "a-b-c.md");

    /* Nothing to build a name from is a refusal, not a file called
     * ".md" — an empty-named note nobody can list or forget. */
    CHECK(!bot_memory_slug("...", slug, sizeof(slug)));
    CHECK(!bot_memory_slug("", slug, sizeof(slug)));

    /* An over-long title truncates instead of overflowing, and stays a
     * .md file. */
    char loud[512];
    memset(loud, 'x', sizeof(loud) - 1);
    loud[sizeof(loud) - 1] = 0;
    char small[24];
    CHECK(bot_memory_slug(loud, small, sizeof(small)));
    CHECK(strlen(small) < sizeof(small));
    CHECK(strstr(small, ".md") != NULL);

    /* Listing skips the in-flight temp file: a concurrent writer's
     * half-written note must never be read as a memory. */
    CHECK(is_memory_file("note.md"));
    CHECK(!is_memory_file(".4242.tmp"));
    CHECK(!is_memory_file("notes.txt"));
    CHECK(!is_memory_file(".md"));
}

/* Several shottinos run side by side under one unix user. Two accounts
 * must not share one bot's memories. */
TEST(two_identities_get_two_bot_directories) {
    /* Heap, not stack: `struct app` carries the whole scrollback and is
     * far larger than a thread stack. */
    /* Plain calloc: bot_dir_path touches no lock and logs nothing, so
     * these carry no allocation to release. */
    struct app *a = calloc(1, sizeof(*a));
    struct app *b = calloc(1, sizeof(*b));
    char da[LLM_MAX_PATH], db[LLM_MAX_PATH];

    snprintf(a->url.base, sizeof(a->url.base), "https://grappa.example");
    snprintf(a->subject, sizeof(a->subject), "user:alice");
    snprintf(b->url.base, sizeof(b->url.base), "https://grappa.example");
    snprintf(b->subject, sizeof(b->subject), "user:bob");
    bot_dir_path(a, da, sizeof(da));
    bot_dir_path(b, db, sizeof(db));
    CHECK(strcmp(da, db) != 0);

    /* Same identity, second window: deliberately the SAME bot. */
    snprintf(b->subject, sizeof(b->subject), "user:alice");
    bot_dir_path(b, db, sizeof(db));
    CHECK_STR(db, da);

    /* Same account on a DIFFERENT bouncer is a different bot too. */
    snprintf(b->url.base, sizeof(b->url.base), "https://other.example");
    bot_dir_path(b, db, sizeof(db));
    CHECK(strcmp(db, da) != 0);

    /* An explicit bot.dir is honoured verbatim — sharing a brain across
     * sessions is allowed, as long as it is asked for. */
    snprintf(a->bot_dir, sizeof(a->bot_dir), "/tmp/shared-brain");
    bot_dir_path(a, da, sizeof(da));
    CHECK_STR(da, "/tmp/shared-brain");
    free(a);
    free(b);
}

/* "Approve always" that forgets at the next restart is not a grant, it
 * is a longer session. */
/* You must be able to type your own language.
 *
 * The input path took BYTES from getch() and filtered them with
 * isprint(), which in a UTF-8 locale is false for every byte >= 0x80, so
 * every accented character was dropped one byte at a time in silence:
 * `perché` went out as `perch`, on a client whose main network is
 * Italian. And Backspace deleted one BYTE, so erasing an accented
 * character left the lead byte of its sequence behind — an invalid
 * prefix that the next keystroke appended to. */
TEST(an_accented_character_survives_typing_and_one_backspace) {
    /* The locale the terminal actually runs in; without it wcrtomb
     * encodes to something that is not UTF-8 and the test would be
     * asserting the wrong thing. */
    CHECK(setlocale(LC_ALL, "C.UTF-8") != NULL || setlocale(LC_ALL, "en_US.UTF-8") != NULL);
    struct app *app = window_app();
    CHECK(app != NULL);

    const wchar_t word[] = L"perché";
    for (size_t i = 0; word[i]; i++) input_append_wide(app, word[i]);

    /* Six characters, seven bytes: é is two of them. The old path stored
     * five and dropped the rest. */
    CHECK(strcmp(app->input, "perch\xc3\xa9") == 0);
    CHECK_LONG(app->input_len, 7);

    /* One Backspace removes the whole character, not half of it. */
    input_backspace(app);
    CHECK(strcmp(app->input, "perch") == 0);
    CHECK_LONG(app->input_len, 5);

    /* And an ASCII one still removes exactly one byte. */
    input_backspace(app);
    CHECK(strcmp(app->input, "perc") == 0);

    /* A character that will not fit whole is refused whole: half a
     * sequence in the buffer is a line that cannot be sent. */
    app->input_len = sizeof(app->input) - 2;
    memset(app->input, 'x', app->input_len);
    app->input[app->input_len] = 0;
    input_append_wide(app, L'é');
    CHECK_LONG(app->input_len, sizeof(app->input) - 2);
    CHECK(app->input[app->input_len] == 0);

    free_app(app);
}

/* Right-clicking a preference offers the values it can actually take.
 *
 * Built from the same table /set validates against, so the menu cannot
 * offer a word the command would then reject — and cannot silently stop
 * offering one that was added to the table. */
TEST(a_settings_menu_offers_what_the_setting_accepts) {
    struct app *app = window_app();
    CHECK(app != NULL);
    struct overlay_item items[64];

    /* A switch: both words, with the current one marked. */
    app->overlay.kind = OVERLAY_SETTING;
    app->mouse_enabled = true;
    snprintf(app->overlay.setting, sizeof(app->overlay.setting), "mouse");
    size_t n = overlay_items_locked(app, items, 64);
    CHECK_LONG(n, 2);
    CHECK(strstr(items[0].label, "on") != NULL);
    CHECK(strstr(items[1].label, "off") != NULL);
    CHECK(strstr(items[0].label, ">") != NULL);  /* mouse is on */
    CHECK(strstr(items[1].label, ">") == NULL);
    /* Choosing one goes through /set, so the value and the name travel
     * as the command would spell them. */
    CHECK_LONG(items[1].action, ACT_SET_VALUE);
    CHECK_STR(items[1].nick, "mouse");
    CHECK_STR(items[1].body, "off");

    /* A choice setting offers every word from its own `values` string —
     * the same one the usage message prints. */
    snprintf(app->overlay.setting, sizeof(app->overlay.setting), "media");
    n = overlay_items_locked(app, items, 64);
    CHECK_LONG(n, 4);
    const char *want[] = { "on", "off", "all", "first-party" };
    for (size_t i = 0; i < 4; i++) {
        CHECK(strstr(items[i].label, want[i]) != NULL);
        CHECK_STR(items[i].body, want[i]);
    }

    /* Free text has no list at all: no values means the modal shows a
     * FIELD instead, which is what makes the two modes one decision. */
    snprintf(app->overlay.setting, sizeof(app->overlay.setting), "stt.url");
    CHECK_LONG(overlay_items_locked(app, items, 64), 0);

    /* Every setting either lists values or is a field — and the kind
     * that decides is the one in the table, not a second opinion. */
    for (size_t i = 0; i < settings_count(); i++) {
        snprintf(app->overlay.setting, sizeof(app->overlay.setting), "%s", SETTINGS[i].name);
        size_t got = overlay_items_locked(app, items, 64);
        if (SETTINGS[i].kind == SET_TEXT) CHECK_LONG(got, 0);
        else CHECK(got > 0);
    }

    /* A name that is not a setting offers nothing rather than guessing. */
    snprintf(app->overlay.setting, sizeof(app->overlay.setting), "nonesuch");
    CHECK_LONG(overlay_items_locked(app, items, 64), 0);

    free_app(app);
}

/* Tab walks the media in this window instead of completing a word.
 *
 * The verbs that take a URL — /preview, /view, /stt — were asking the
 * user to read one out of the scrollback and type it, which is exactly
 * the work a client should be doing. /stt sees only audio: a candidate
 * it cannot transcribe is a keypress wasted. */
TEST(tab_cycles_through_the_media_in_this_window) {
    struct app *app = window_app();
    CHECK(app != NULL);
    app->url.base[0] = 0;
    add_window_ex(app, "azzurra", "#sniffo", true);
    /* Oldest first, so the picker's newest-first order is visible. */
    log_line(app, "[azzurra/#sniffo] 09:00 <a> https://ex.net/one.png");
    log_line(app, "[azzurra/#sniffo] 09:01 <b> https://ex.net/talk.ogg");
    log_line(app, "[azzurra/#sniffo] 09:02 <c> https://ex.net/two.png");

    /* /preview cycles pictures AND clips, newest first, and wraps. */
    snprintf(app->input, sizeof(app->input), "/preview ");
    app->input_len = strlen(app->input);
    complete_input(app);
    CHECK_STR(app->input, "/preview https://ex.net/two.png");
    complete_input(app);
    CHECK_STR(app->input, "/preview https://ex.net/talk.ogg");
    complete_input(app);
    CHECK_STR(app->input, "/preview https://ex.net/one.png");
    complete_input(app);
    CHECK_STR(app->input, "/preview https://ex.net/two.png"); /* wrapped */

    /* /stt sees the audio and nothing else. */
    snprintf(app->input, sizeof(app->input), "/stt ");
    app->input_len = strlen(app->input);
    complete_input(app);
    CHECK_STR(app->input, "/stt https://ex.net/talk.ogg");
    complete_input(app);
    CHECK_STR(app->input, "/stt https://ex.net/talk.ogg"); /* the only one */

    /* A URL typed by hand is never replaced: Tab starts a fresh cycle
     * rather than throwing away what the user put there. */
    snprintf(app->input, sizeof(app->input), "/preview https://typed.example/mine.png");
    app->input_len = strlen(app->input);
    complete_input(app);
    CHECK_STR(app->input, "/preview https://ex.net/two.png"); /* restarts at the newest */

    free_app(app);
}

/* /stt and /dictate are different features.
 *
 * /stt was doing both: bare, it took the microphone and typed for you.
 * That is dictation. Transcription is turning somebody ELSE'S audio
 * into words you read — a voice message in a channel — and the two
 * differ in whose voice it is and, crucially, where the words land:
 * dictation into the input line to be sent, transcription into the
 * window as a fact about the conversation. */
TEST(stt_transcribes_and_dictate_types) {
    struct app *app = window_app();
    CHECK(app != NULL);
    app->url.base[0] = 0;
    add_window_ex(app, "azzurra", "#sniffo", true);
    app->stt_enabled = true;
    snprintf(app->stt_url, sizeof(app->stt_url), "https://whisper.example/v1");

    /* Bare /stt no longer grabs the microphone; it says what it wants. */
    handle_command(app, "/stt");
    CHECK(log_has(app, "/stt <url|file>"));
    CHECK(log_has(app, "/dictate"));

    /* A URL is accepted and queued rather than rejected as a missing
     * file — the whole point of the change. */
    size_t before = app->jobs_tail;
    handle_command(app, "/stt https://example.net/voice.ogg");
    CHECK(app->jobs_tail != before);
    CHECK(!log_has(app, "cannot read"));

    /* A path that does not exist still says so. */
    handle_command(app, "/stt /nowhere/really-not-here.ogg");
    CHECK(log_has(app, "cannot read"));

    /* The queued job carries the source and its PURPOSE, which is what
     * decides where the words go. */
    size_t at = app->jobs_head;
    bool found = false;
    for (size_t i = 0; i < JOB_QUEUE && at != app->jobs_tail; i++, at = (at + 1) % JOB_QUEUE) {
        if (app->jobs[at].kind != JOB_STT) continue;
        found = true;
        CHECK_STR(app->jobs[at].arg1, "https://example.net/voice.ogg");
        CHECK_STR(app->jobs[at].arg2, "transcribe");
        break;
    }
    CHECK(found);

    /* And the right-click menu on audio offers it, next to playing it. */
    app->overlay.kind = OVERLAY_MENU;
    snprintf(app->overlay.media, sizeof(app->overlay.media), "https://example.net/voice.ogg");
    struct overlay_item items[64];
    size_t n = overlay_items_locked(app, items, 64);
    CHECK_LONG(n, 2);
    CHECK_LONG(items[0].action, ACT_PREVIEW);
    CHECK_LONG(items[1].action, ACT_TRANSCRIBE);
    CHECK_STR(items[1].body, "https://example.net/voice.ogg");

    free_app(app);
}

/* Settings must survive a restart. vjt reports losing them on every
 * reinstall, and the evidence was one line: a configured
 * `voice.source = alsa:hw:2` came back as `pulse:default`, the built-in
 * default, written back over the file.
 *
 * Round-trips through the REAL prefs_save/prefs_load against a HOME of
 * our own, because the bug can live in either half and asserting only
 * the parser would prove nothing about what gets written. */
TEST(a_configured_setting_survives_save_and_load) {
    /* HOME is already a temp dir for the whole suite — see main(). */
    struct app *app = window_app();
    CHECK(app != NULL);

    /* Defaults, as main() sets them before prefs_load runs. */
    snprintf(app->voice_source, sizeof(app->voice_source), "pulse:default");
    snprintf(app->video_source, sizeof(app->video_source), "v4l2:/dev/video0");
    settings_capture_defaults(app);

    /* What the user typed. */
    const struct setting_def *def = setting_find("voice.source");
    CHECK(def != NULL);
    CHECK(setting_apply(app, def, "alsa:hw:2"));
    CHECK_STR(app->voice_source, "alsa:hw:2");
    prefs_save(app);

    /* A FRESH process: defaults in memory, then load. */
    struct app *next = window_app();
    CHECK(next != NULL);
    snprintf(next->voice_source, sizeof(next->voice_source), "pulse:default");
    snprintf(next->video_source, sizeof(next->video_source), "v4l2:/dev/video0");
    settings_capture_defaults(next);
    prefs_load(next);
    /* THE PROPERTY: what was set is what comes back. */
    CHECK_STR(next->voice_source, "alsa:hw:2");

    /* And saving again must not quietly drop it — the reinstall cycle
     * is load, then some unrelated /set, then save. */
    prefs_save(next);
    struct app *third = window_app();
    CHECK(third != NULL);
    snprintf(third->voice_source, sizeof(third->voice_source), "pulse:default");
    settings_capture_defaults(third);
    prefs_load(third);
    CHECK_STR(third->voice_source, "alsa:hw:2");

    /* free_app, not a bare free: each of the three apps captured the
     * defaults above, and those are 28 heap strings per app hanging off
     * setting_default[] that only settings_free_defaults (which free_app
     * calls) gives back. The bare free released the struct and left 84
     * allocations behind — LeakSanitizer failed the suite and main with
     * it. */
    free_app(app);
    free_app(next);
    free_app(third);
}

/* The grid the call helper publishes is what ties a rectangle of the
 * composited frame to a person. Getting it wrong is not a crash — it is
 * everybody's face drawn under somebody else's name, which is the kind
 * of bug that gets believed rather than reported. */
TEST(the_call_tile_map_is_parsed_or_rejected_whole) {
    struct call_tile t[CALL_MAX_PEERS];
    int fw = 0, fh = 0;

    /* One peer: the whole frame. */
    CHECK(call_tiles_parse("160x120;0,0,0,160,120", &fw, &fh, t, CALL_MAX_PEERS) == 1);
    CHECK(fw == 160 && fh == 120);
    CHECK(t[0].slot == 0 && t[0].w == 160 && t[0].h == 120);

    /* Four in a 2x2, and the SLOT is carried through — it is not the
     * index. The live set has holes in it, so a cell for slot 5 must
     * stay slot 5 or it labels the wrong person. */
    int n = call_tiles_parse("160x120;0,0,0,80,60;2,80,0,80,60;5,0,60,80,60;7,80,60,80,60", &fw,
                             &fh, t, CALL_MAX_PEERS);
    CHECK(n == 4);
    CHECK(t[0].slot == 0 && t[1].slot == 2 && t[2].slot == 5 && t[3].slot == 7);
    CHECK(t[1].x == 80 && t[1].y == 0);
    CHECK(t[2].x == 0 && t[2].y == 60);

    /* ALL OR NOTHING. A cell that does not fit the frame it claims to
     * belong to would sample somebody else's pixels, so the whole line
     * is refused and the caller keeps the grid it already had — better
     * a stale picture than a mislabelled one. */
    CHECK(call_tiles_parse("160x120;0,0,0,80,60;1,100,0,80,60", &fw, &fh, t, CALL_MAX_PEERS) == 0);
    CHECK(call_tiles_parse("160x120;0,0,0,80,200", &fw, &fh, t, CALL_MAX_PEERS) == 0);
    CHECK(call_tiles_parse("160x120;0,-1,0,80,60", &fw, &fh, t, CALL_MAX_PEERS) == 0);
    CHECK(call_tiles_parse("160x120;0,0,0,0,60", &fw, &fh, t, CALL_MAX_PEERS) == 0);
    /* A slot outside the cap would index the nick table past its end. */
    CHECK(call_tiles_parse("160x120;99,0,0,80,60", &fw, &fh, t, CALL_MAX_PEERS) == 0);
    CHECK(call_tiles_parse("160x120;-1,0,0,80,60", &fw, &fh, t, CALL_MAX_PEERS) == 0);

    /* Malformed in the ways a truncated or reordered line actually is. */
    CHECK(call_tiles_parse("", &fw, &fh, t, CALL_MAX_PEERS) == 0);
    CHECK(call_tiles_parse("160x120", &fw, &fh, t, CALL_MAX_PEERS) == 0);
    CHECK(call_tiles_parse("160x120;0,0,0,80", &fw, &fh, t, CALL_MAX_PEERS) == 0);
    CHECK(call_tiles_parse("160x120;0,0,0,80,60;junk", &fw, &fh, t, CALL_MAX_PEERS) == 0);
    CHECK(call_tiles_parse("160x120;0,0,0,80,60trailing", &fw, &fh, t, CALL_MAX_PEERS) == 0);
    CHECK(call_tiles_parse("0x0;0,0,0,80,60", &fw, &fh, t, CALL_MAX_PEERS) == 0);
    CHECK(call_tiles_parse(NULL, &fw, &fh, t, CALL_MAX_PEERS) == 0);
    CHECK(call_tiles_parse("160x120;0,0,0,80,60", &fw, &fh, NULL, CALL_MAX_PEERS) == 0);

    /* An empty grid — everybody turned their camera off — is reported
     * as none rather than as a parse failure the caller would ignore. */
    CHECK(call_tiles_parse("160x120;", &fw, &fh, t, CALL_MAX_PEERS) == 0);

    /* The frame size is only adopted when the line as a whole was
     * good: a rejected line must not leave half of it applied. */
    fw = fh = 0;
    CHECK(call_tiles_parse("640x480;0,0,0,999,999", &fw, &fh, t, CALL_MAX_PEERS) == 0);
    CHECK(fw == 0 && fh == 0);
}

/* A client-local window is never asked about over REST.
 *
 * $llm is a conversation with a model; nothing on the wire has ever
 * named it. The checks that already knew this about $server did not
 * know it about $llm, so opening the window fetched scrollback and
 * members for a channel the bouncer does not have — an HTTP 400 and a
 * "members are not seeded yet" in a window whose whole point is that
 * the network is not involved. */
TEST(a_client_local_window_is_never_fetched_from_the_server) {
    CHECK(is_local_window("$llm"));
    CHECK(is_local_window("$server"));
    /* $call joined them: it exists only while a call is running and
     * shows the picture full size, and the bouncer has never heard of
     * it either. Missing from this set, opening it would fetch
     * scrollback and members for a channel that does not exist —
     * exactly the 400 that $llm used to produce. */
    CHECK(is_local_window("$call"));
    CHECK(is_call_window("$call"));
    CHECK(!is_call_window("$llm"));
    CHECK(!is_call_window("#sniffo"));
    /* Matched as a NAME, like every other window comparison. */
    CHECK(is_local_window("$LLM"));
    CHECK(is_local_window("$CALL"));
    CHECK(!is_local_window("#sniffo"));
    CHECK(!is_local_window("alice"));
    /* Not a prefix match: a real channel that merely starts the same
     * way is still a real channel. */
    CHECK(!is_local_window("$llmx"));
    CHECK(!is_local_window("$caller"));

    struct app *app = window_app();
    CHECK(app != NULL);
    app->url.base[0] = 0; /* any REST call would be visible as a failure */

    /* Neither door queues a job for it. */
    enqueue_fetch(app, "azzurra", "$llm");
    enqueue_members(app, "azzurra", "$llm");
    CHECK_LONG(app->jobs_head, app->jobs_tail); /* queue untouched */

    /* A real channel still goes. */
    enqueue_fetch(app, "azzurra", "#sniffo");
    CHECK(app->jobs_head != app->jobs_tail);

    free_app(app);
}

/* A conversation, and a budget that keeps it inside the window.
 *
 * There was no history at all: every request built its turns from the
 * current prompt and nothing else, so the model met the user fresh each
 * time and a follow-up referred to nothing. Both backends had the hole
 * for different reasons — openai got a one-message array, and the claude
 * CLI runs one subprocess per request with no session. */
TEST(a_conversation_is_remembered_and_rolls_to_fit) {
    struct app *app = window_app();
    CHECK(app != NULL);
    char *text[LLM_HISTORY_TURNS];
    const char *role[LLM_HISTORY_TURNS];

    llm_history_append(app, "azzurra", "$llm", false, "user", "who wrote Dune?");
    llm_history_append(app, "azzurra", "$llm", false, "assistant", "Frank Herbert.");
    size_t n = llm_history_load(app, "azzurra", "$llm", false, text, role, LLM_HISTORY_TURNS, 9999);
    CHECK_LONG(n, 2);
    CHECK_STR(text[0], "who wrote Dune?");
    CHECK_STR(role[0], "user");
    CHECK_STR(text[1], "Frank Herbert.");
    CHECK_STR(role[1], "assistant");
    for (size_t i = 0; i < n; i++) free(text[i]);

    /* A budget too small for everything keeps the NEWEST turns, because
     * that is what a follow-up refers to. */
    n = llm_history_load(app, "azzurra", "$llm", false, text, role, LLM_HISTORY_TURNS, 1);
    CHECK_LONG(n, 1);
    CHECK_STR(text[0], "Frank Herbert.");
    free(text[0]);

    /* /llm and /bot are separate conversations in the SAME window: one
     * is the owner thinking out loud, the other is a bot answering
     * strangers, and neither should read the other's. */
    llm_history_append(app, "azzurra", "#sniffo", false, "user", "private question");
    llm_history_append(app, "azzurra", "#sniffo", true, "user", "a stranger asked something");
    n = llm_history_load(app, "azzurra", "#sniffo", false, text, role, LLM_HISTORY_TURNS, 9999);
    CHECK_LONG(n, 1);
    CHECK_STR(text[0], "private question");
    free(text[0]);
    n = llm_history_load(app, "azzurra", "#sniffo", true, text, role, LLM_HISTORY_TURNS, 9999);
    CHECK_LONG(n, 1);
    CHECK_STR(text[0], "a stranger asked something");
    free(text[0]);

    /* Different windows are different conversations too. */
    n = llm_history_load(app, "azzurra", "$llm", false, text, role, LLM_HISTORY_TURNS, 9999);
    CHECK_LONG(n, 2);
    for (size_t i = 0; i < n; i++) free(text[i]);

    /* Clearing one leaves the others alone. */
    llm_history_clear(app, "azzurra", "$llm", false);
    CHECK_LONG(llm_history_load(app, "azzurra", "$llm", false, text, role, LLM_HISTORY_TURNS, 9999), 0);
    n = llm_history_load(app, "azzurra", "#sniffo", true, text, role, LLM_HISTORY_TURNS, 9999);
    CHECK_LONG(n, 1);
    free(text[0]);

    llm_history_free(app);
    free_app(app);
}

/* The budget is a fraction of the window, and the fixed parts are
 * subtracted rather than counted — the system prompt and the tool
 * declarations ride along with every request and cannot be trimmed. */
TEST(the_context_budget_leaves_room_for_the_fixed_parts) {
    struct app *app = window_app();
    CHECK(app != NULL);

    /* The default, and that it is a fraction rather than the whole. */
    CHECK_LONG(llm_context_tokens(&app->llm), LLM_CONTEXT_DEFAULT);
    CHECK_LONG(llm_context_budget(&app->llm), LLM_CONTEXT_DEFAULT * LLM_CONTEXT_TARGET_PCT / 100);
    CHECK(llm_context_budget(&app->llm) < llm_context_tokens(&app->llm));

    /* Configurable, and refused when it is a number nothing could work
     * with. */
    handle_command(app, "/set llm.context 128000");
    CHECK_LONG(llm_context_tokens(&app->llm), 128000);
    handle_command(app, "/set llm.context 12");
    CHECK_LONG(llm_context_tokens(&app->llm), 128000); /* unchanged */
    CHECK(log_has(app, "between 4096"));

    /* A system prompt costs the conversation room. */
    size_t bare = llm_fixed_cost(app, &app->llm, -1);
    snprintf(app->llm.prompt, sizeof(app->llm.prompt), "%s",
             "You are a helpful assistant answering on IRC in plain text with no markdown.");
    CHECK(llm_fixed_cost(app, &app->llm, -1) > bare);
    /* And so do the tool declarations. */
    CHECK(llm_fixed_cost(app, &app->llm, 1) > llm_fixed_cost(app, &app->llm, -1));

    free_app(app);
}

/* Every config write keeps the previous version.
 *
 * Both files are written wholesale from memory, so anything wrong in
 * memory becomes wrong on disk in one step. That has cost this client's
 * own config three times — a /unset that discarded rather than
 * restored, an empty prompt line that overwrote its default, and a
 * schema change that zeroed fields an older file did not mention. Each
 * was a different bug; what they shared was that the damage was instant
 * and total. */
TEST(a_config_write_leaves_the_previous_version_behind) {
    char home[] = "/tmp/shottino-backup-XXXXXX";
    CHECK(mkdtemp(home) != NULL);
    char *old_home = getenv("HOME");
    char *saved = old_home ? strdup(old_home) : NULL;
    setenv("HOME", home, 1);

    struct app *app = window_app();
    CHECK(app != NULL);

    /* First write: nothing to back up yet. */
    snprintf(app->voice_source, sizeof(app->voice_source), "first");
    prefs_save(app);
    char path[512], backup[520];
    char *p = prefs_path();
    snprintf(path, sizeof(path), "%s", p);
    snprintf(backup, sizeof(backup), "%s~", p);
    free(p);
    struct stat st;
    CHECK(stat(path, &st) == 0);
    CHECK(stat(backup, &st) != 0); /* no previous version existed */

    /* Second write: the first one is kept. */
    snprintf(app->voice_source, sizeof(app->voice_source), "second");
    prefs_save(app);
    CHECK(stat(backup, &st) == 0);
    CHECK_LONG(st.st_mode & 0777, 0600); /* the backup is no more readable than the file */

    FILE *f = fopen(backup, "r");
    CHECK(f != NULL);
    char buf[2048] = "";
    if (f) {
        size_t n = fread(buf, 1, sizeof(buf) - 1, f);
        buf[n] = 0;
        fclose(f);
    }
    CHECK(strstr(buf, "voice.source = first") != NULL);   /* the OLD value */
    CHECK(strstr(buf, "second") == NULL);

    /* And the live file has the new one. */
    f = fopen(path, "r");
    CHECK(f != NULL);
    if (f) {
        size_t n = fread(buf, 1, sizeof(buf) - 1, f);
        buf[n] = 0;
        fclose(f);
    }
    CHECK(strstr(buf, "voice.source = second") != NULL);

    unlink(path);
    unlink(backup);
    free_app(app);
    if (saved) setenv("HOME", saved, 1);
    else unsetenv("HOME");
    free(saved);
}

/* An empty system prompt is a STATE, not an absence.
 *
 * Empty means "use the built-in" now, so a settings row that renders it
 * blank says the opposite of what it does — and the built-in is the
 * whole reason the model knows it is on IRC and has tools. */
TEST(an_unset_prompt_says_the_built_in_is_in_use) {
    struct app *app = window_app();
    CHECK(app != NULL);
    char shown[256];

    app->llm.prompt[0] = 0;
    setting_value(app, "llm.prompt", shown, sizeof(shown));
    CHECK(shown[0] != 0);
    CHECK(strstr(shown, "built-in") != NULL);

    /* But the RAW value stays empty, or saving the row would write that
     * sentence into the config as if it were a prompt. */
    char raw[MAX_LINE];
    CHECK_LONG(setting_raw(app, "llm.prompt", raw, sizeof(raw)), 0);
    CHECK_STR(raw, "");

    /* A configured prompt shows itself. */
    snprintf(app->llm.prompt, sizeof(app->llm.prompt), "answer only in Italian");
    setting_value(app, "llm.prompt", shown, sizeof(shown));
    CHECK_STR(shown, "answer only in Italian");
    CHECK(setting_raw(app, "llm.prompt", raw, sizeof(raw)) > 0);
    CHECK_STR(raw, "answer only in Italian");

    free_app(app);
}

/* Tab on a value completes what that setting accepts.
 *
 * `/set media <TAB>` used to complete nothing: the completer bails when
 * the stem is empty, and a trailing space is exactly the moment the
 * values are wanted. The words come from the same table /set validates
 * against, so what completes is what would be accepted. */
TEST(tab_completes_the_values_a_setting_accepts) {
    struct app *app = window_app();
    CHECK(app != NULL);

    /* A choice setting, with the value half-typed. */
    snprintf(app->input, sizeof(app->input), "/set media fir");
    app->input_len = strlen(app->input);
    complete_input(app);
    CHECK_STR(app->input, "/set media first-party ");

    /* And with NOTHING typed after the name — the empty-stem case. Four
     * words match, so the line is left alone and the choices listed. */
    snprintf(app->input, sizeof(app->input), "/set media ");
    app->input_len = strlen(app->input);
    complete_input(app);
    CHECK_STR(app->input, "/set media ");
    CHECK(log_has(app, "first-party"));

    /* A switch offers its two words. */
    snprintf(app->input, sizeof(app->input), "/set mouse of");
    app->input_len = strlen(app->input);
    complete_input(app);
    CHECK_STR(app->input, "/set mouse off ");

    /* The NAME still completes, which is the case that already worked. */
    snprintf(app->input, sizeof(app->input), "/set voice.so");
    app->input_len = strlen(app->input);
    complete_input(app);
    CHECK_STR(app->input, "/set voice.source ");

    /* /unset completes names the same way. */
    snprintf(app->input, sizeof(app->input), "/unset anim");
    app->input_len = strlen(app->input);
    complete_input(app);
    CHECK_STR(app->input, "/unset animate ");

    /* A free-text setting completes to what is SET, so a path is edited
     * rather than retyped. */
    snprintf(app->stt_model, sizeof(app->stt_model), "whisper-large-v3");
    snprintf(app->input, sizeof(app->input), "/set stt.model ");
    app->input_len = strlen(app->input);
    complete_input(app);
    CHECK_STR(app->input, "/set stt.model whisper-large-v3 ");

    /* But never a secret: a token must not appear in the input line
     * because somebody pressed Tab. */
    snprintf(app->stt_token, sizeof(app->stt_token), "sk-not-a-real-key-8842");
    snprintf(app->input, sizeof(app->input), "/set stt.token ");
    app->input_len = strlen(app->input);
    complete_input(app);
    CHECK_STR(app->input, "/set stt.token ");
    CHECK(!log_has(app, "sk-not-a-real-key"));

    free_app(app);
}

/* The modal seeds its field with what is SET, never with a secret.
 *
 * Showing a token in a box on screen is showing it to whoever is behind
 * you, and the field is bigger and more legible than the masked row it
 * came from. */
TEST(the_setting_modal_seeds_its_field_but_never_a_secret) {
    struct app *app = window_app();
    CHECK(app != NULL);
    snprintf(app->stt_url, sizeof(app->stt_url), "https://whisper.example/v1");
    snprintf(app->stt_token, sizeof(app->stt_token), "sk-not-a-real-key-8842");

    settings_open_modal(app, "stt.url");
    CHECK_LONG(app->overlay.kind, OVERLAY_SETTING);
    CHECK_STR(app->overlay.setting, "stt.url");
    CHECK_STR(app->overlay.edit, "https://whisper.example/v1");
    CHECK_LONG(app->overlay.edit_len, strlen("https://whisper.example/v1"));

    /* A token opens EMPTY, so saving without typing clears it rather
     * than writing back a mask. */
    settings_open_modal(app, "stt.token");
    CHECK_STR(app->overlay.edit, "");
    CHECK(strstr(app->stt_token, "sk-not-a-real-key") != NULL); /* untouched until saved */

    /* The field takes characters and gives them back one at a time,
     * through the same helpers the input line uses. */
    settings_open_modal(app, "stt.model");
    utf8_append(app->overlay.edit, sizeof(app->overlay.edit), &app->overlay.edit_len, L'é');
    CHECK_LONG(app->overlay.edit_len, 2);
    utf8_backspace(app->overlay.edit, &app->overlay.edit_len);
    CHECK_LONG(app->overlay.edit_len, 0);

    /* An unknown name opens nothing at all. */
    overlay_close(app);
    settings_open_modal(app, "nonesuch");
    CHECK_LONG(app->overlay.kind, OVERLAY_NONE);

    free_app(app);
}

/* /unset restores what the client STARTED with, not a table constant.
 *
 * Several defaults are computed — inline media follows whether ffmpeg is
 * installed, stt.local follows whichever whisper binary is found — so a
 * `default` column could not have held them. Capturing the boot values
 * means /unset cannot disagree with the defaults: it is holding them. */
TEST(unset_puts_a_preference_back_to_how_it_started) {
    struct app *app = window_app();
    CHECK(app != NULL);
    app->url.base[0] = 0;

    /* Boot state, then remember it — the order main uses. */
    snprintf(app->voice_source, sizeof(app->voice_source), "pulse:default");
    app->animate_media = true;
    settings_capture_defaults(app);

    handle_command(app, "/set voice.source alsa:hw:1");
    CHECK_STR(app->voice_source, "alsa:hw:1");
    handle_command(app, "/set animate off");
    CHECK(!app->animate_media);

    handle_command(app, "/unset voice.source");
    CHECK_STR(app->voice_source, "pulse:default");
    CHECK(log_has(app, "back to the default"));
    handle_command(app, "/unset animate");
    CHECK(app->animate_media);

    /* A setting whose fresh-install value is EMPTY is not "restored" by
     * /unset — it is discarded, permanently, and written to disk. The
     * report has to say which of the two happened, because "back to the
     * default" reads as reversible and this is not. */
    snprintf(app->stt_url, sizeof(app->stt_url), "https://whisper.example/v1");
    handle_command(app, "/unset stt.url");
    CHECK_STR(app->stt_url, "");
    CHECK(log_has(app, "CLEARED"));
    CHECK(log_has(app, "no default to go back to"));

    /* And a setting that DOES have one still says "back to the default". */
    handle_command(app, "/set voice.source alsa:hw:2");
    handle_command(app, "/unset voice.source");
    CHECK_STR(app->voice_source, "pulse:default");
    CHECK(log_has(app, "back to the default"));

    /* A name nobody has says so rather than doing nothing quietly. */
    handle_command(app, "/unset nonesuch");
    CHECK(log_has(app, "no such setting"));

    /* Bare /unset explains itself instead of resetting everything. */
    handle_command(app, "/unset");
    CHECK(log_has(app, "put one preference back"));

    free_app(app);
}

/* Three threads send on one websocket; a ref must belong to one of them.
 *
 * ws_ref was incremented from main, the job worker and the model thread
 * with nothing serialising them, so two frames could carry the SAME ref —
 * and Phoenix silently discards a push whose join_ref names no channel of
 * its own, which is the failure mode that hides. The socket itself is not
 * needed to test this: with ws_connected false nothing is written, and
 * what is under test is the number, not the write.
 *
 * Deterministic in the passing direction — with the lock the refs are
 * always distinct, so a slow box cannot make this red. Without it, this
 * much contention loses increments. */
#define REF_THREADS 4
#define REF_EACH 5000
static void *ref_grabber(void *arg) {
    struct app *app = arg;
    static _Thread_local unsigned long mine[REF_EACH];
    for (size_t i = 0; i < REF_EACH; i++) mine[i] = ws_join(app, "grappa:user:vjt");
    unsigned long *out = malloc(sizeof(mine));
    memcpy(out, mine, sizeof(mine));
    return out;
}

TEST(a_websocket_ref_is_never_handed_out_twice) {
    struct app *app = window_app();
    CHECK(app != NULL);
    pthread_mutex_init(&app->ws_lock, NULL);
    /* Not connected: ws_send_text_locked returns immediately and no
     * socket is touched, leaving the ref allocation as the whole test. */
    app->ws_connected = false;

    pthread_t t[REF_THREADS];
    for (size_t i = 0; i < REF_THREADS; i++)
        CHECK(pthread_create(&t[i], NULL, ref_grabber, app) == 0);

    /* Every ref ever handed out, marked in a bitmap: any repeat is a lost
     * increment, and the total must be exactly what was asked for. */
    static bool seen[REF_THREADS * REF_EACH + 2];
    size_t collected = 0, duplicates = 0, out_of_range = 0;
    for (size_t i = 0; i < REF_THREADS; i++) {
        unsigned long *refs = NULL;
        pthread_join(t[i], (void **)&refs);
        CHECK(refs != NULL);
        for (size_t k = 0; k < REF_EACH; k++) {
            collected++;
            if (refs[k] == 0 || refs[k] >= sizeof(seen) / sizeof(seen[0])) { out_of_range++; continue; }
            if (seen[refs[k]]) duplicates++;
            seen[refs[k]] = true;
        }
        free(refs);
    }
    CHECK_LONG(collected, REF_THREADS * REF_EACH);
    CHECK_LONG(duplicates, 0);
    CHECK_LONG(out_of_range, 0);
    CHECK_LONG(app->ws_ref, REF_THREADS * REF_EACH);

    pthread_mutex_destroy(&app->ws_lock);
    free_app(app);
}

/* Quitting has to be able to tell the model thread apart from a corpse.
 *
 * llm_stop was declared and read and assigned NOWHERE, so shutdown freed
 * every log line, destroyed app->lock and freed the app while that thread
 * was still parked on a condvar — and there was no way to ask whether it
 * had gone. An idle thread must notice the stop and SAY so, which is the
 * signal the shutdown path waits on before it frees anything. */
TEST(the_model_thread_announces_that_it_stopped) {
    struct app *app = window_app();
    CHECK(app != NULL);
    pthread_mutex_init(&app->llm_lock, NULL);
    pthread_cond_init(&app->llm_cond, NULL);

    pthread_t t;
    CHECK(pthread_create(&t, NULL, llm_main, app) == 0);

    /* Generous deadline: this asserts that the handshake HAPPENS, not how
     * quickly — a slow CI box must not turn into a red build. */
    struct timespec deadline;
    clock_gettime(CLOCK_REALTIME, &deadline);
    deadline.tv_sec += 5;
    pthread_mutex_lock(&app->llm_lock);
    app->llm_stop = true;
    pthread_cond_broadcast(&app->llm_cond);
    while (!app->llm_exited)
        if (pthread_cond_timedwait(&app->llm_cond, &app->llm_lock, &deadline) == ETIMEDOUT) break;
    bool exited = app->llm_exited;
    pthread_mutex_unlock(&app->llm_lock);

    CHECK(exited);
    pthread_join(t, NULL);
    pthread_cond_destroy(&app->llm_cond);
    pthread_mutex_destroy(&app->llm_lock);
    free_app(app);
}

/* Retiring a row must carry its whole row with it.
 *
 * Six arrays are parallel-indexed: the text, mention, pending-echo,
 * scrollback id, media slot, scope. clear_matching_pending_echo used to
 * memmove three of them by hand and leave the other three where they
 * were, so after every message you sent while its echo was on screen,
 * every row above it took on a NEIGHBOUR's id, image slot and window. The
 * ring's own comment says exactly two functions may know the full set;
 * this asserts that the retirement path is not a third. */
TEST(retiring_an_echo_moves_every_row_not_just_its_text) {
    struct app *app = window_app();
    CHECK(app != NULL);

    /* Three rows, each with metadata that names it, and the pending echo
     * FIRST so the two below it have to slide. */
    pthread_mutex_lock(&app->lock);
    log_push_locked(app, strdup("[azzurra/#sniffo] 10:00 <vjt> hello there"), false, true);
    log_push_locked(app, strdup("[azzurra/#sniffo] 10:01 <alice> second"), true, false);
    log_push_locked(app, strdup("[azzurra/#altro] 10:02 <bob> third"), false, false);
    app->log_ids[0] = 100; app->log_media[0] = 0;
    app->log_ids[1] = 101; app->log_media[1] = 1;
    app->log_ids[2] = 102; app->log_media[2] = 2;
    char scope1[MAX_SLUG + MAX_CHANNEL + 8], scope2[MAX_SLUG + MAX_CHANNEL + 8];
    snprintf(scope1, sizeof(scope1), "%s", app->log_scope[1]);
    snprintf(scope2, sizeof(scope2), "%s", app->log_scope[2]);
    pthread_mutex_unlock(&app->lock);
    CHECK_LONG(app->log_count, 3);

    clear_matching_pending_echo(app, "azzurra", "#sniffo", "hello there");
    CHECK_LONG(app->log_count, 2);

    /* Each surviving row still carries ITS id, ITS image and ITS window —
     * not the ones belonging to the row that used to sit below it. */
    CHECK(strstr(app->log[0], "second") != NULL);
    CHECK_LONG(app->log_ids[0], 101);
    CHECK_LONG(app->log_media[0], 1);
    CHECK(app->log_mentions[0]);
    CHECK(strcmp(app->log_scope[0], scope1) == 0);

    CHECK(strstr(app->log[1], "third") != NULL);
    CHECK_LONG(app->log_ids[1], 102);
    CHECK_LONG(app->log_media[1], 2);
    CHECK(!app->log_mentions[1]);
    CHECK(strcmp(app->log_scope[1], scope2) == 0);
    /* The two rows came from different channels, so a scope that did not
     * move would file one of them into the other's window. */
    CHECK(strcmp(scope1, scope2) != 0);

    free_app(app);
}

/* The bot's door, not its judgement.
 *
 * bot_consider spent its whole life inside the `default:` arm of
 * render_message's kind switch — the arm reached by exactly the kinds that
 * are NOT conversation — so its `conversational &&` guard was false every
 * time it ran and the bot never saw one message. Everything downstream (the
 * approval gate, the grants, the memories) was correct code behind a door
 * that never opened, which is why no test caught it: they all tested the
 * room and none tested the door.
 *
 * So this asserts reachability, at the only place it can be observed from
 * outside: a mention while /bot is on lands a turn on the llm queue. */
TEST(a_conversation_reaches_the_bot_and_a_join_does_not) {
    struct app *app = window_app();
    CHECK(app != NULL);
    add_window_ex(app, "azzurra", "#sniffo", true);
    app->bot_enabled = true;

    struct wire_scrollback_message m = { 0 };
    m.id = 1;
    m.network = "azzurra";
    m.channel = "#sniffo";
    m.sender = "alice";
    m.kind = MSG_PRIVMSG;
    m.body = "vjt: are you there?";   /* our own nick — a mention */
    render_message(app, &m, true);
    CHECK(app->llm_tail != app->llm_head);

    /* A PRESENCE row is not conversation and must NOT wake it: that is the
     * half of the guard the misplaced brace was accidentally enforcing,
     * and moving the call must not lose it. */
    size_t after_privmsg = app->llm_tail;
    m.id = 2;
    m.kind = MSG_JOIN;
    m.body = "";
    render_message(app, &m, true);
    CHECK_LONG(app->llm_tail, after_privmsg);

    /* Still ours only when we are addressed — an unrelated line in a
     * channel the bot is sitting in is not a question for it. */
    m.id = 3;
    m.kind = MSG_PRIVMSG;
    m.body = "alice is talking to bob about lunch";
    render_message(app, &m, true);
    CHECK_LONG(app->llm_tail, after_privmsg);

    free_app(app);
}

/* An action says it is an action ONCE.
 *
 * /me goes on the wire as \001ACTION ciao\001, grappa types the row
 * :action and preserves the \x01 verbatim (round-trip fidelity for CTCP
 * is an invariant on that side), so the row arrives typed AND wrapped.
 * Rendering the body raw produced
 *     * nextime ^AACTION devo accendere il camino^A
 * — the star saying it, and the control characters saying it again. */
TEST(an_action_is_shown_as_words_not_control_characters) {
    char out[MAX_LINE];

    CHECK_STR(ctcp_action_text("\001ACTION devo accendere il camino\001", out, sizeof(out)),
              "devo accendere il camino");
    /* Both shapes genuinely arrive — the --ircd bridge already had to
     * make the same allowance in the other direction. */
    CHECK_STR(ctcp_action_text("\001ACTION no trailing wrapper", out, sizeof(out)),
              "no trailing wrapper");
    /* An action with nothing in it is still an action, not a PRIVMSG. */
    CHECK_STR(ctcp_action_text("\001ACTION\001", out, sizeof(out)), "");
    /* Some clients do not shout the verb. */
    CHECK_STR(ctcp_action_text("\001action ciao\001", out, sizeof(out)), "ciao");

    /* NOT an action: the caller falls back to its ordinary rendering
     * rather than showing a mangled body. */
    CHECK(ctcp_action_text("plain words", out, sizeof(out)) == NULL);
    CHECK(ctcp_action_text("\001PING 12345\001", out, sizeof(out)) == NULL);
    CHECK(ctcp_action_text("\001ACTIONS are fun\001", out, sizeof(out)) == NULL);
    CHECK(ctcp_action_text("", out, sizeof(out)) == NULL);
    CHECK(ctcp_action_text(NULL, out, sizeof(out)) == NULL);

    /* Through the real ingest path: what lands in scrollback carries no
     * \x01 at all. */
    struct app *app = window_app();
    CHECK(app != NULL);
    add_window_ex(app, "azzurra", "#sniffo", true);
    struct wire_scrollback_message m = { 0 };
    m.id = 1;
    m.network = "azzurra";
    m.channel = "#sniffo";
    m.sender = "nextime";
    m.kind = MSG_ACTION;
    m.body = "\001ACTION devo accendere il camino\001";
    render_message(app, &m, true);
    const char *row = app->log[app->log_count - 1];
    CHECK(strstr(row, "* nextime devo accendere il camino") != NULL);
    CHECK(strchr(row, '\001') == NULL);

    /* And your OWN action, echoed locally before the server's copy comes
     * back — the same bug, one screen earlier. */
    add_pending_echo(app, "azzurra", "#sniffo", "nextime", "\001ACTION saluta\001");
    row = app->log[app->log_count - 1];
    CHECK(strstr(row, "* nextime saluta") != NULL);
    CHECK(strchr(row, '\001') == NULL);

    /* The pending RECORD keeps the raw body: it is matched against what
     * the server sends back, and a prettied copy would never retire. */
    CHECK(app->pending_count > 0);
    CHECK_STR(app->pending[app->pending_count - 1].body, "\001ACTION saluta\001");

    /* An ordinary message is untouched. */
    add_pending_echo(app, "azzurra", "#sniffo", "nextime", "ciao a tutti");
    CHECK(strstr(app->log[app->log_count - 1], "<nextime> ciao a tutti") != NULL);

    free_app(app);
}

/* The question belongs in the window that will hold the answer.
 *
 * Asking from a channel opened $llm and put the REPLY there and nothing
 * else, so the window read as a model talking to itself — and after two
 * questions there was no way to tell which answer went with which.
 * Typing directly INTO $llm did echo, at its own call site, so the two
 * doors to the same conversation disagreed. */
TEST(a_question_is_written_where_its_answer_will_land) {
    struct app *app = window_app();
    CHECK(app != NULL);
    add_window_ex(app, "azzurra", "#sniffo", true);

    char want[MAX_SLUG + MAX_CHANNEL + 8];

    /* Asked from a CHANNEL: the question still goes to $llm, and the
     * window is opened now rather than when the answer turns up. */
    llm_enqueue(app, "azzurra", "#sniffo", "what is a bouncer?", false);
    bool opened = false;
    for (size_t i = 0; i < app->window_count; i++)
        if (irc_name_eq(app->windows[i].channel, LLM_WINDOW)) opened = true;
    CHECK(opened);
    window_scope_key("azzurra", LLM_WINDOW, want, sizeof(want));
    CHECK(log_row_in_scope(app, app->log_count - 1, want));
    CHECK(strstr(app->log[app->log_count - 1], "what is a bouncer?") != NULL);
    CHECK(strstr(app->log[app->log_count - 1], "<you>") != NULL);

    /* Asked from $llm itself: exactly ONE echo, not two. The echo used
     * to live at that call site, so moving it without removing it would
     * double every question typed in the window. */
    size_t before = app->log_count;
    llm_enqueue(app, "azzurra", LLM_WINDOW, "and a bnc?", false);
    CHECK_LONG((long)(app->log_count - before), 1);
    CHECK(strstr(app->log[app->log_count - 1], "and a bnc?") != NULL);

    /* PUBLIC goes to the channel everyone is reading, so nothing is
     * written to $llm — and the bot's prompt is a quoted stranger, not
     * something you asked. */
    before = app->log_count;
    llm_enqueue(app, "azzurra", "#sniffo", "tell the channel", true);
    CHECK_LONG((long)(app->log_count - before), 0);

    /* /llm-compact's text is an instruction to the model. Showing it as
     * something YOU said is a lie about who typed it. */
    llm_enqueue_full(app, "azzurra", "#sniffo", "Summarise the conversation so far", false, NULL,
                     false, false, true);
    CHECK(strstr(app->log[app->log_count - 1], "Summarise the conversation") == NULL);

    free_app(app);
}

/* The picture-in-picture box, in cells.
 *
 * Half blocks mean two PIXEL rows per cell row, so the pixel height is
 * rows*2 — which is why the 4:3 arithmetic divides by 8 rather than 4
 * and looks off by two without being. Getting it wrong does not crash:
 * it silently stretches everybody's face. */
TEST(the_call_picture_is_a_share_of_the_width) {
    int c = 0, r = 0;

    /* A share, not a constant: 40 cells on an 80-column terminal is the
     * whole client; 24 on a 200-column one is a stamp. */
    call_video_box(80, &c, &r);
    CHECK_LONG(c, 20);
    call_video_box(200, &c, &r);
    CHECK_LONG(c, 40); /* capped */
    call_video_box(40, &c, &r);
    CHECK_LONG(c, 16); /* floored */

    /* 4:3 in PIXELS, where the pixel height is rows*2. */
    for (int total = 40; total <= 240; total += 8) {
        call_video_box(total, &c, &r);
        CHECK(c >= 16 && c <= 40);
        CHECK(r >= 6);
        /* Never taller than it is wide, in pixels — that would be a
         * portrait box for a landscape camera. */
        CHECK(r * 2 <= c);
    }
}

/* A second /call where one is already running JOINS it.
 *
 * Minting a second room would put two people in two rooms, each waiting
 * for the other and each having told the channel to come somewhere
 * else. Currency is judged by the clock because there is no way to ask
 * the SFU "is anyone in room X" without also publishing what rooms
 * exist — and a room name is the credential. */
TEST(a_call_already_running_here_is_the_call) {
    const time_t now = 1000000;

    /* Same window, recent: join it. */
    CHECK(call_invite_is_current(true, now - 60, "azzurra", "#sniffo", "azzurra", "#sniffo", now));
    /* Channels are matched as NAMES, like every other window compare. */
    CHECK(call_invite_is_current(true, now - 60, "azzurra", "#SNIFFO", "azzurra", "#sniffo", now));

    /* A different window is a different call. */
    CHECK(!call_invite_is_current(true, now - 60, "azzurra", "#other", "azzurra", "#sniffo", now));
    CHECK(!call_invite_is_current(true, now - 60, "libera", "#sniffo", "azzurra", "#sniffo", now));

    /* Stale: this morning's invite must not swallow tonight's /call into
     * a room nobody is in. */
    CHECK(!call_invite_is_current(true, now - CALL_INVITE_CURRENT_SECS - 1, "azzurra", "#sniffo",
                                  "azzurra", "#sniffo", now));
    /* Exactly at the edge still counts — the boundary belongs to the
     * side that joins, because joining an empty room is recoverable and
     * splitting a live call is not. */
    CHECK(call_invite_is_current(true, now - CALL_INVITE_CURRENT_SECS, "azzurra", "#sniffo",
                                 "azzurra", "#sniffo", now));

    /* Nothing seen at all. */
    CHECK(!call_invite_is_current(false, now, "azzurra", "#sniffo", "azzurra", "#sniffo", now));
    /* A clock that went backwards must not make an invite eternal. */
    CHECK(!call_invite_is_current(true, now + 500, "azzurra", "#sniffo", "azzurra", "#sniffo", now));
    CHECK(!call_invite_is_current(true, now, NULL, "#sniffo", "azzurra", "#sniffo", now));
}

/* ── Calls ─────────────────────────────────────────────────────────────
 *
 * The whole anti-annoyance posture of the feature lives in the parser:
 * anyone in a channel can paste a meeting link, quote one, or link a
 * recording of one, and none of those may make every shottino in the
 * room scream. Only what a caller deliberately sends does. */
TEST(only_a_marked_invite_is_a_call) {
    enum call_kind kind = CALL_VIDEO;
    char url[MAX_LINE];

    CHECK(call_invite_parse("📞 https://meet.example/abc", &kind, url, sizeof(url)));
    CHECK_LONG(kind, CALL_AUDIO);
    CHECK_STR(url, "https://meet.example/abc");

    CHECK(call_invite_parse("📹 https://meet.example/abc", &kind, url, sizeof(url)));
    CHECK_LONG(kind, CALL_VIDEO);

    /* Trailing prose is allowed, so WHICH link gets opened never depends
     * on reading a sentence. */
    CHECK(call_invite_parse("📞 https://meet.example/abc join us!", &kind, url, sizeof(url)));
    CHECK_STR(url, "https://meet.example/abc");

    /* A bare link is somebody talking. */
    CHECK(!call_invite_parse("https://meet.example/abc", &kind, url, sizeof(url)));
    /* A marker further in is somebody talking ABOUT a call. */
    CHECK(!call_invite_parse("look at 📞 https://meet.example/abc", &kind, url, sizeof(url)));
    /* The marker is a word of its own. */
    CHECK(!call_invite_parse("📞https://meet.example/abc", &kind, url, sizeof(url)));
    /* Answering hands the URL to the desktop opener, so the scheme is an
     * allowlist rather than a suggestion: a stranger must not be able to
     * put a registered handler one keystroke away. */
    CHECK(!call_invite_parse("📞 file:///etc/passwd", &kind, url, sizeof(url)));
    CHECK(!call_invite_parse("📞 javascript:alert(1)", &kind, url, sizeof(url)));
    CHECK(!call_invite_parse("📞 ftp://host/x", &kind, url, sizeof(url)));
    /* Somebody else's marker. */
    CHECK(!call_invite_parse("📸 https://meet.example/abc", &kind, url, sizeof(url)));
    CHECK(!call_invite_parse("", &kind, url, sizeof(url)));

    /* A URL that does not fit is REFUSED, never truncated: half a room
     * name is not a shorter link, it is a different room. */
    char tiny[10];
    CHECK(!call_invite_parse("📞 https://meet.example/abc", &kind, tiny, sizeof(tiny)));
}

/* What /call posts is what a receiving shottino reads back. */
TEST(an_invite_round_trips_through_its_own_parser) {
    char room[96];
    call_room_name(room, sizeof(room));
    CHECK(strncmp(room, "shottino-", 9) == 0);
    CHECK_LONG((long)strlen(room), 9 + 32); /* 128 bits, as hex */

    /* Two rooms are two rooms — the name is the only thing standing
     * between a stranger and the call. */
    char second[96];
    call_room_name(second, sizeof(second));
    CHECK(strcmp(room, second) != 0);

    for (int v = 0; v < 2; v++) {
        enum call_kind sent = v ? CALL_VIDEO : CALL_AUDIO;
        char line[512];
        call_invite_build(sent, "https://meet.example", room, line, sizeof(line));
        enum call_kind got;
        char url[MAX_LINE];
        CHECK(call_invite_parse(line, &got, url, sizeof(url)));
        CHECK_LONG(got, sent);
        CHECK(strstr(url, room) != NULL);
    }

    /* One slash however the base was spelled: a doubled one is a 404 on
     * some services and a different room on others. */
    char line[512];
    call_invite_build(CALL_AUDIO, "https://meet.example/", "r", line, sizeof(line));
    CHECK(strstr(line, "https://meet.example/#r=r") != NULL);
    CHECK(strstr(line, "//#") == NULL);
    call_invite_build(CALL_AUDIO, "https://meet.example", "r", line, sizeof(line));
    CHECK(strstr(line, "https://meet.example/#r=r") != NULL);
}

/* The room rides in the FRAGMENT, and a fragment is never sent to a
 * server — which is the whole reason the room page can learn who is in
 * a call without any endpoint being able to list room NAMES. A room
 * name is the credential, so a listable endpoint hands every call in
 * progress to whoever asks. */
TEST(an_invite_carries_its_room_in_the_fragment) {
    char base[MAX_LINE], room[160];

    CHECK(call_invite_split("https://h/call/#r=shottino-4f2c&peers=ann,bob", base, sizeof(base),
                            room, sizeof(room)));
    CHECK_STR(base, "https://h/call");
    CHECK_STR(room, "shottino-4f2c");

    /* Order in the fragment is not ours to assume. */
    CHECK(call_invite_split("https://h/call/#peers=ann&r=xyz", base, sizeof(base), room,
                            sizeof(room)));
    CHECK_STR(room, "xyz");

    /* The base owns no trailing slash, so joining it cannot double one. */
    CHECK(call_invite_split("https://h/call///#r=z", base, sizeof(base), room, sizeof(room)));
    CHECK_STR(base, "https://h/call");

    /* No fragment: the shape shottino posted BEFORE the room page, where
     * the URL was the room base. Refused here so the caller falls back
     * to it rather than deriving nonsense — an older client's invite
     * stays answerable instead of silently unjoinable. */
    CHECK(!call_invite_split("https://meet.jit.si/shottino-4f2c", base, sizeof(base), room,
                             sizeof(room)));
    /* A fragment with no room in it is not an invite we can act on. */
    CHECK(!call_invite_split("https://h/call/#peers=ann", base, sizeof(base), room, sizeof(room)));
    CHECK(!call_invite_split("#r=x", base, sizeof(base), room, sizeof(room)));
    CHECK(!call_invite_split(NULL, base, sizeof(base), room, sizeof(room)));

    /* The participant list survives the split — it lives in the same
     * fragment and must not confuse the room lookup. */
    CHECK(call_invite_split("https://h/call/#r=abc&peers=ann,bob", base, sizeof(base), room,
                            sizeof(room)));
    CHECK_STR(room, "abc");
    /* `me` is appended when a link is OPENED, never when it is posted,
     * so the splitter has to survive seeing it. */
    CHECK(call_invite_split("https://h/call/#r=abc&peers=ann&me=bob", base, sizeof(base), room,
                            sizeof(room)));
    CHECK_STR(room, "abc");

    /* What /call posts is what the splitter reads back. */
    char line[512];
    call_invite_build(CALL_VIDEO, "https://h/call", "shottino-99", line, sizeof(line));
    enum call_kind kind;
    char url[MAX_LINE];
    CHECK(call_invite_parse(line, &kind, url, sizeof(url)));
    CHECK_LONG(kind, CALL_VIDEO);
    CHECK(call_invite_split(url, base, sizeof(base), room, sizeof(room)));
    CHECK_STR(base, "https://h/call");
    CHECK_STR(room, "shottino-99");
}

TEST(a_query_rings_and_a_channel_only_announces) {
    CHECK(call_should_ring(CALL_RING_QUERIES, true));
    CHECK(!call_should_ring(CALL_RING_QUERIES, false));
    CHECK(call_should_ring(CALL_RING_ALL, true));
    CHECK(call_should_ring(CALL_RING_ALL, false));
    CHECK(!call_should_ring(CALL_RING_OFF, true));
    CHECK(!call_should_ring(CALL_RING_OFF, false));

    /* The word /set accepts, the word it shows and the word the config
     * file holds are ONE pair of functions, so they cannot drift. */
    static const enum call_ring_policy all[] = { CALL_RING_OFF, CALL_RING_QUERIES, CALL_RING_ALL };
    for (size_t i = 0; i < sizeof(all) / sizeof(all[0]); i++) {
        enum call_ring_policy back;
        CHECK(call_ring_parse(call_ring_word(all[i]), &back));
        CHECK_LONG(back, all[i]);
    }
    enum call_ring_policy ignored;
    CHECK(!call_ring_parse("sometimes", &ignored));
    CHECK(!call_ring_parse("", &ignored));
}

/* The ring, through the real ingest path — the guards that matter are at
 * the CALL SITE (live, not blocked, conversational), so a test that
 * called call_consider directly would prove none of them. */
TEST(an_arriving_call_rings_only_where_it_should) {
    struct app *app = window_app();
    CHECK(app != NULL);
    add_window_ex(app, "azzurra", "#sniffo", true);
    add_window_ex(app, "azzurra", "alice", true);
    /* Stated rather than inherited: the harness does not run the boot
     * defaults, and a test of a POLICY that silently depended on one
     * would pass for the wrong reason the day the default changed. */
    app->call_ring = CALL_RING_QUERIES;

    struct wire_scrollback_message m = { 0 };
    m.id = 1;
    m.network = "azzurra";
    m.channel = "#sniffo";
    m.sender = "alice";
    m.kind = MSG_PRIVMSG;
    m.body = "📞 https://meet.example/room1";
    render_message(app, &m, true);
    /* Default policy: a channel does not interrupt... */
    CHECK_LONG(app->overlay.kind, OVERLAY_NONE);
    /* ...but the invite is still reachable, which is what /answer needs
     * and what makes the quiet policy usable rather than merely quiet. */
    CHECK(app->call_last.present);
    CHECK_STR(app->call_last.url, "https://meet.example/room1");

    /* A query is somebody calling YOU. */
    m.id = 2;
    m.channel = "alice";
    m.body = "📹 https://meet.example/room2";
    render_message(app, &m, true);
    CHECK_LONG(app->overlay.kind, OVERLAY_CALL);
    CHECK_LONG(app->call_last.kind, CALL_VIDEO);
    CHECK(app->call_ring_bell);

    /* Decline is what sel=0 lands on: a ring that arrives mid-keystroke
     * must not open a stranger's link on the Enter already being typed. */
    struct overlay_item items[8];
    size_t n = overlay_items_locked(app, items, sizeof(items) / sizeof(items[0]));
    CHECK_LONG((long)n, 2);
    CHECK_LONG(app->overlay.sel, 0);
    CHECK_LONG(items[0].action, ACT_CALL_DECLINE);
    CHECK_LONG(items[1].action, ACT_CALL_ANSWER);

    /* A second caller does not steal the ring that is up, nor silently
     * retarget what Answer would reach. */
    m.id = 3;
    m.sender = "bob";
    m.body = "📞 https://meet.example/room3";
    render_message(app, &m, true);
    CHECK_STR(app->call_last.url, "https://meet.example/room2");

    /* Dismissing is local AND non-destructive. */
    call_hangup(app);
    CHECK_LONG(app->overlay.kind, OVERLAY_NONE);
    CHECK(app->call_last.present);
    CHECK_STR(app->call_last.url, "https://meet.example/room2");

    /* Our own invite, arriving back from the server, must not ring us —
     * otherwise every call rings its own caller. */
    m.id = 4;
    m.sender = "vjt";
    m.body = "📞 https://meet.example/mine";
    render_message(app, &m, true);
    CHECK_LONG(app->overlay.kind, OVERLAY_NONE);
    CHECK_STR(app->call_last.url, "https://meet.example/room2");

    /* A blocked person cannot ring you at all: the guard is the same one
     * that decides they are not drawn. */
    pthread_mutex_lock(&app->lock);
    block_add_locked(app, "carol");
    pthread_mutex_unlock(&app->lock);
    m.id = 5;
    m.sender = "carol";
    m.channel = "alice";
    m.body = "📞 https://meet.example/blocked";
    render_message(app, &m, true);
    CHECK_LONG(app->overlay.kind, OVERLAY_NONE);
    CHECK_STR(app->call_last.url, "https://meet.example/room2");

    /* History is not an event: a scrollback fetch replaying yesterday's
     * calls must not ring. */
    m.id = 6;
    m.sender = "alice";
    m.body = "📞 https://meet.example/yesterday";
    render_message(app, &m, false);
    CHECK_LONG(app->overlay.kind, OVERLAY_NONE);
    CHECK_STR(app->call_last.url, "https://meet.example/room2");

    free_app(app);
}

/* Every preference the panel shows must come back after a restart.
 *
 * Only the llm.* half had a writer: an STT endpoint, its token, the capture
 * devices and the three display toggles were set-and-lose, while the
 * settings panel presented both halves identically. */
TEST(a_preference_survives_a_restart) {
    char home[] = "/tmp/shottino-prefs-test-XXXXXX";
    CHECK(mkdtemp(home) != NULL);
    char *old_home = getenv("HOME");
    char *saved = old_home ? strdup(old_home) : NULL;
    setenv("HOME", home, 1);

    struct app *a = window_app();
    /* Through the same door /set uses, so the test cannot pass by
     * writing fields the real command would have parsed differently. */
    CHECK(setting_apply(a, setting_find("stt.url"), "https://whisper.example/v1"));
    CHECK(setting_apply(a, setting_find("stt.token"), "sk-not-a-real-key-8842"));
    CHECK(setting_apply(a, setting_find("voice.source"), "pulse:default"));
    CHECK(setting_apply(a, setting_find("media"), "all"));
    CHECK(setting_apply(a, setting_find("animate"), "off"));
    prefs_save(a);

    struct app *b = window_app();
    prefs_load(b);
    CHECK(strcmp(b->stt_url, "https://whisper.example/v1") == 0);
    CHECK(strcmp(b->stt_token, "sk-not-a-real-key-8842") == 0);
    CHECK(strcmp(b->voice_source, "pulse:default") == 0);
    CHECK(b->inline_media_enabled && b->inline_media_peers);
    CHECK(!b->animate_media);

    /* A value never set stays unset rather than coming back as whatever
     * the listing would have DISPLAYED for it: setting_value substitutes a
     * discovered binary for stt.local and a derived path for bot.dir, and
     * storing either would freeze a probe result into an explicit
     * preference. */
    CHECK(b->stt_local[0] == 0);
    CHECK(b->bot_dir[0] == 0);

    /* llm.* is llm.conf's business — writing it here too would give one
     * value two files to disagree from. */
    char path[512];
    snprintf(path, sizeof(path), "%s/.local/share/shottino/shottino.conf", home);
    FILE *f = fopen(path, "r");
    CHECK(f != NULL);
    char buf[4096];
    size_t n = fread(buf, 1, sizeof(buf) - 1, f);
    buf[n] = 0;
    fclose(f);
    CHECK(strstr(buf, "llm.") == NULL);
    CHECK(strstr(buf, "stt.token = sk-not-a-real-key-8842") != NULL);

    /* 0600: the token is in clear in there. */
    struct stat st;
    CHECK(stat(path, &st) == 0);
    CHECK_LONG(st.st_mode & 0777, 0600);

    unlink(path);
    free_app(a);
    free_app(b);
    if (saved) setenv("HOME", saved, 1);
    else unsetenv("HOME");
    free(saved);
}

/* A standing grant belongs to a PERSON, not to a nick.
 *
 * A nick is borrowed furniture: the person you approved can drop it and
 * the next person to take it inherits the permission. So a grant carries
 * the services account it was given to and applies only while that nick
 * is identified as that account again — and a grant given to somebody
 * services cannot vouch for is never written down at all, because a
 * promise made to a bare nick would be handed to whoever holds it when
 * the file is next read.
 */
static void identify(struct app *app, const char *nick, const char *account) {
    struct whois_fact *w = &app->whois_cache[app->whois_cache_count++];
    snprintf(w->nick, sizeof(w->nick), "%s", nick);
    snprintf(w->account, sizeof(w->account), "%s", account);
    w->registered = true;
}

/* An identity's private state follows it across the hash change.
 *
 * The token cache and the bot directory are named after a digest of
 * (server, identity). That name used to come from djb2 — a hash for
 * spreading strings across buckets, not for telling them apart on
 * purpose, and a collision would hand one identity's bearer token,
 * notes and standing grants to another. Replacing it renames every
 * path, so the old name is looked up once and MOVED: without that,
 * upgrading would log everyone out and orphan every bot directory,
 * leaving the notes on disk under a name nothing looks for. */
TEST(an_identity_keeps_its_notes_across_the_rename) {
    char home[] = "/tmp/shottino-migrate-XXXXXX";
    CHECK(mkdtemp(home) != NULL);
    char *old_home = getenv("HOME");
    char *saved = old_home ? strdup(old_home) : NULL;
    setenv("HOME", home, 1);

    struct app *app = window_app();
    snprintf(app->url.base, sizeof(app->url.base), "https://grappa.example.net");
    snprintf(app->subject, sizeof(app->subject), "user:vjt");

    /* A bot directory written under the OLD name, with a note in it. */
    char *state = shottino_state_dir();
    char legacy[512];
    snprintf(legacy, sizeof(legacy), "%s/bot-%lx", state,
             token_key_hash_legacy(app->url.base, app->subject));
    CHECK(mkdir(legacy, 0700) == 0);
    char note[640];
    snprintf(note, sizeof(note), "%s/grants", legacy);
    FILE *f = fopen(note, "w");
    CHECK(f != NULL);
    if (f) { fputs("alice alice_ send_message\n", f); fclose(f); }

    /* Asking for the directory moves it. */
    char now[LLM_MAX_PATH];
    bot_dir_path(app, now, sizeof(now));
    CHECK(strcmp(now, legacy) != 0); /* it really did change name */
    struct stat st;
    CHECK(stat(now, &st) == 0);
    CHECK(stat(legacy, &st) != 0);   /* and the old one is gone, not copied */

    /* The grant inside came with it. */
    bot_grants_load(app);
    CHECK_LONG(app->bot_grant_count, 1);

    /* Asking again is a no-op rather than a second move. */
    char again[LLM_MAX_PATH];
    bot_dir_path(app, again, sizeof(again));
    CHECK_STR(again, now);

    char rm[640];
    snprintf(rm, sizeof(rm), "%s/grants", now);
    unlink(rm);
    rmdir(now);
    free(state);
    free_app(app);
    if (saved) setenv("HOME", saved, 1);
    else unsetenv("HOME");
    free(saved);
}

TEST(a_standing_grant_survives_a_restart) {
    char dir[] = "/tmp/shottino-grants-test-XXXXXX";
    CHECK(mkdtemp(dir) != NULL);

    struct app *a = window_app();
    snprintf(a->bot_dir, sizeof(a->bot_dir), "%s", dir);
    identify(a, "alice", "alice_");
    identify(a, "bob", "bob_");
    CHECK(bot_grant_add(a, "alice", "send_message"));
    CHECK(bot_grant_add(a, "bob", "join_channel"));
    CHECK_LONG(a->bot_grant_count, 2);

    /* A second client, same identity: it reads what the first wrote —
     * and must know the same people, or it cannot honour the grants. */
    struct app *b = window_app();
    snprintf(b->bot_dir, sizeof(b->bot_dir), "%s", dir);
    identify(b, "alice", "alice_");
    identify(b, "bob", "bob_");
    bot_grants_load(b);
    CHECK_LONG(b->bot_grant_count, 2);
    CHECK(bot_has_grant(b, "alice", "send_message"));
    CHECK(bot_has_grant(b, "bob", "join_channel"));
    /* Still per PAIR after a round trip — the property that matters. */
    CHECK(!bot_has_grant(b, "alice", "join_channel"));
    CHECK(!bot_has_grant(b, "bob", "send_message"));
    /* And still a nick MATCH, not a spelling. */
    CHECK(bot_has_grant(b, "ALICE", "send_message"));

    /* THE POINT: somebody else holding the nick inherits nothing. */
    struct app *imposter = window_app();
    snprintf(imposter->bot_dir, sizeof(imposter->bot_dir), "%s", dir);
    identify(imposter, "alice", "someone_else");
    bot_grants_load(imposter);
    CHECK_LONG(imposter->bot_grant_count, 2);
    CHECK(!bot_has_grant(imposter, "alice", "send_message"));

    /* And so does somebody holding it while identified to nobody. */
    struct app *stranger = window_app();
    snprintf(stranger->bot_dir, sizeof(stranger->bot_dir), "%s", dir);
    bot_grants_load(stranger);
    CHECK(!bot_has_grant(stranger, "alice", "send_message"));

    /* A revoke reaches the file too, or the grant comes back tomorrow. */
    for (size_t i = 0; i < a->bot_grant_count; i++) {
        if (strcmp(a->bot_grants[i].nick, "alice") != 0) continue;
        memmove(a->bot_grants + i, a->bot_grants + i + 1,
                sizeof(a->bot_grants[0]) * (a->bot_grant_count - i - 1));
        a->bot_grant_count--;
        break;
    }
    bot_grants_save(a);
    struct app *c = window_app();
    snprintf(c->bot_dir, sizeof(c->bot_dir), "%s", dir);
    identify(c, "bob", "bob_");
    bot_grants_load(c);
    CHECK_LONG(c->bot_grant_count, 1);
    CHECK(bot_has_grant(c, "bob", "join_channel"));

    /* A grant to somebody services cannot vouch for lasts the session
     * and is NOT written down. */
    struct app *e = window_app();
    snprintf(e->bot_dir, sizeof(e->bot_dir), "%s", dir);
    CHECK(!bot_grant_add(e, "mallory", "names"));   /* false: not lasting */
    CHECK(bot_has_grant(e, "mallory", "names"));    /* but honoured here */
    bot_grants_save(e);
    struct app *f = window_app();
    snprintf(f->bot_dir, sizeof(f->bot_dir), "%s", dir);
    bot_grants_load(f);
    CHECK(!bot_has_grant(f, "mallory", "names"));

    /* A line naming a tool this build does not have authorises nothing,
     * so it must not be shown as an authorisation. */
    char path[512];
    snprintf(path, sizeof(path), "%s/grants", dir);
    FILE *fp = fopen(path, "w");
    CHECK(fp != NULL);
    fprintf(fp, "# comment\n\nmallory mallory_ rm_minus_rf\ncarol carol_ names\n");
    fclose(fp);
    struct app *d = window_app();
    snprintf(d->bot_dir, sizeof(d->bot_dir), "%s", dir);
    identify(d, "carol", "carol_");
    bot_grants_load(d);
    CHECK_LONG(d->bot_grant_count, 1);
    CHECK(bot_has_grant(d, "carol", "names"));
    CHECK(!bot_has_grant(d, "mallory", "rm_minus_rf"));

    /* And a line in the OLD two-field format — a grant keyed on a bare
     * nick — is dropped rather than migrated: those are exactly the ones
     * that could be inherited. */
    fp = fopen(path, "w");
    CHECK(fp != NULL);
    fprintf(fp, "carol names\n");
    fclose(fp);
    struct app *g = window_app();
    snprintf(g->bot_dir, sizeof(g->bot_dir), "%s", dir);
    identify(g, "carol", "carol_");
    bot_grants_load(g);
    CHECK_LONG(g->bot_grant_count, 0);
    CHECK(log_has(g, "written before grants were bound"));

    unlink(path);
    rmdir(dir);
    /* free_app, not free: loading dropped a grant and SAID so, and a
     * logged line is an allocation. */
    free_app(a);
    free_app(b);
    free_app(c);
    free_app(d);
    free_app(e);
    free_app(f);
    free_app(g);
    free_app(imposter);
    free_app(stranger);
}
TEST(a_truncated_string_keeps_only_whole_characters) {
    char s[16];

    /* A 2-byte character whose second byte did not fit: the lead goes.
     * Built byte by byte rather than truncated from a literal, so the
     * test says which byte survived instead of leaving it to snprintf. */
    memset(s, 'a', 14);
    s[14] = (char)0xC3; /* lead byte of é... */
    s[15] = 0;          /* ...and no room for its continuation byte */
    utf8_trim_partial_tail(s);
    CHECK_STR(s, "aaaaaaaaaaaaaa");

    /* A character that FITS is kept whole. */
    snprintf(s, sizeof(s), "%s", "ciao perch\xc3\xa9");
    utf8_trim_partial_tail(s);
    CHECK_STR(s, "ciao perch\xc3\xa9");

    /* Pure ASCII is untouched, and so is an empty string. */
    snprintf(s, sizeof(s), "%s", "hello");
    utf8_trim_partial_tail(s);
    CHECK_STR(s, "hello");
    s[0] = 0;
    utf8_trim_partial_tail(s);
    CHECK_STR(s, "");

    /* A 3-byte character cut after one byte, and after two. */
    char t[8] = "ab\xe2\x82";
    utf8_trim_partial_tail(t);
    CHECK_STR(t, "ab");
    char u[8] = "ab\xe2";
    utf8_trim_partial_tail(u);
    CHECK_STR(u, "ab");
    /* Whole, it stays. */
    char v[8] = "ab\xe2\x82\xac";
    utf8_trim_partial_tail(v);
    CHECK_STR(v, "ab\xe2\x82\xac");
}

/* A command must refuse what it cannot do, rather than do something else.
 *
 * `/msg nick ` reached the wire as an empty PRIVMSG: the dispatcher's
 * whitespace trim only fires when the whole tail is blank, and here the
 * nick is in the way. `/approve alwyas` approved ONCE and said nothing
 * about the word it had not understood, so the user believed they had
 * granted a standing permission they had not — and answering the prompt
 * is the half that cannot be taken back. */
TEST(a_command_refuses_what_it_cannot_do) {
    struct app *app = window_app();
    app->url.base[0] = 0;
    add_window_ex(app, "azzurra", "#sniffo", true);

    handle_command(app, "/msg alice ");
    CHECK(log_has(app, "/msg requires"));
    /* And nothing was queued for the wire. */
    CHECK_LONG(app->pending_count, 0);

    /* A real body still goes. */
    handle_command(app, "/msg alice ciao");
    CHECK_LONG(app->pending_count, 1);

    /* A word /approve does not know approves NOTHING — the check happens
     * before the answer is recorded, not after. */
    pthread_mutex_lock(&app->lock);
    app->bot_ask.pending = true;
    app->bot_ask.answered = false;
    app->bot_ask.approved = false;
    snprintf(app->bot_ask.nick, sizeof(app->bot_ask.nick), "alice");
    snprintf(app->bot_ask.tool, sizeof(app->bot_ask.tool), "send_message");
    pthread_mutex_unlock(&app->lock);

    handle_command(app, "/approve alwyas");
    CHECK(log_has(app, "is not a word here"));
    CHECK(!app->bot_ask.answered);
    CHECK(!app->bot_ask.approved);
    CHECK_LONG(app->bot_grant_count, 0);

    /* The word it does know still works. */
    handle_command(app, "/approve");
    CHECK(app->bot_ask.answered);
    CHECK(app->bot_ask.approved);

    free_app(app);
}

/* A long AGENT.md must not eat the bot's own notes.
 *
 * The prompt was read with `fread(out, 1, out_sz - 1, f)` — the whole
 * buffer — so an AGENT.md that filled it left bot_memories_append one
 * byte of room, and it appended NOTHING. Every note the bot had written
 * to itself vanished from its context while /bot show went on counting
 * them: a total, silent loss of the feature, caused by a file being
 * long. */
TEST(a_long_agent_md_leaves_room_for_the_notes) {
    char dir[] = "/tmp/shottino-agent-test-XXXXXX";
    CHECK(mkdtemp(dir) != NULL);
    char mem[512];
    snprintf(mem, sizeof(mem), "%s/memories", dir);
    CHECK(mkdir(mem, 0700) == 0);

    struct app *app = window_app();
    snprintf(app->bot_dir, sizeof(app->bot_dir), "%s", dir);

    /* An AGENT.md far bigger than the prompt buffer. */
    char path[512];
    snprintf(path, sizeof(path), "%s/AGENT.md", dir);
    FILE *f = fopen(path, "w");
    CHECK(f != NULL);
    fputs("HEADER-OF-AGENT-MD\n", f);
    for (int i = 0; i < LLM_MAX_PROMPT; i++) fputc('a', f);
    fclose(f);

    /* And one note, which is what used to disappear. */
    char note[640];
    snprintf(note, sizeof(note), "%s/ricorda.md", mem);
    f = fopen(note, "w");
    CHECK(f != NULL);
    fputs("vjt prefers Italian", f);
    fclose(f);

    static char prompt[LLM_MAX_PROMPT];
    bot_effective_prompt(app, prompt, sizeof(prompt));

    /* The file is still used — it is just not allowed to spend the
     * notes' budget. */
    CHECK(strstr(prompt, "HEADER-OF-AGENT-MD") != NULL);
    /* And the note survived, framed as the bot's own rather than as an
     * instruction. */
    CHECK(strstr(prompt, "vjt prefers Italian") != NULL);
    CHECK(strstr(prompt, "not instructions from your owner") != NULL);
    CHECK(strlen(prompt) < sizeof(prompt));

    /* Truncating a config file is said out loud — once. */
    CHECK(log_has(app, "AGENT.md is longer than"));

    unlink(note);
    unlink(path);
    rmdir(mem);
    rmdir(dir);
    free_app(app);
}

/* A channel key is the server's own parameter, not part of the name.
 *
 * `/join #chan key` used to put the whole rest in the name, so the POST
 * asked for a channel literally called "#chan key" — which grappa
 * validates and rejects, so a keyed join failed with HTTP 400 while
 * /help advertised the form. */
TEST(a_join_key_is_split_from_the_channel) {
    char chan[MAX_CHANNEL], key[MAX_LINE];

    join_split("#sniffo segreto", chan, sizeof(chan), key, sizeof(key));
    CHECK_STR(chan, "#sniffo");
    CHECK_STR(key, "segreto");

    /* No key is an empty key, not a missing split. */
    join_split("#sniffo", chan, sizeof(chan), key, sizeof(key));
    CHECK_STR(chan, "#sniffo");
    CHECK_STR(key, "");

    /* Extra spaces belong to neither. */
    join_split("  #sniffo   segreto", chan, sizeof(chan), key, sizeof(key));
    CHECK_STR(chan, "#sniffo");
    CHECK_STR(key, "segreto");

    /* A comma-separated list is still ONE name — grappa validates it. */
    join_split("#uno,#due", chan, sizeof(chan), key, sizeof(key));
    CHECK_STR(chan, "#uno,#due");
    CHECK_STR(key, "");

    /* A key with a space in it is not a thing IRC has: everything after
     * the first gap is the key, spaces and all, and the server decides. */
    join_split("#chan a b", chan, sizeof(chan), key, sizeof(key));
    CHECK_STR(chan, "#chan");
    CHECK_STR(key, "a b");
}

/* A verb is a whole word, not a prefix.
 *
 * /who matched with a bare strncmp, so a bare /whois — which the
 * with-argument arm above it does not accept — fell through to it AND
 * brought an argument: the target was read from line + 5, so /whois
 * asked the server to list a channel called "s" and /whowas one called
 * "was". Silent, plausible, and wrong. */
TEST(a_verb_is_matched_as_a_whole_word_not_a_prefix) {
    struct app *app = window_app();
    app->url.base[0] = 0;
    add_window_ex(app, "azzurra", "#sniffo", true);

    /* Bare, they explain themselves rather than becoming another verb. */
    handle_command(app, "/whois");
    CHECK(log_has(app, "/whois <nick>"));
    handle_command(app, "/whowas");
    CHECK(log_has(app, "/whowas <nick>"));

    /* Neither may reach /who — which, not being connected, would have
     * complained about the websocket instead. */
    CHECK(!log_has(app, "not connected"));

    /* A typo is an unknown verb, not a NAMES for a channel called "oo". */
    handle_command(app, "/namesfoo");
    CHECK(log_has(app, "unknown command"));

    /* With an argument they still work — the point is the boundary, not
     * refusing everything. Both reach the socket and report it missing. */
    handle_command(app, "/whois alice");
    CHECK(log_has(app, "not connected"));

    free_app(app);
}

/* All three spellings of the window verb reach the same window.
 *
 * The argument used to be found by indexing fixed offsets off a guess:
 * `line[2] == 'w'` is true for NO spelling (index 2 is 'n' in /window,
 * 'i' in /win, and the space in /w), so `/w 3` fell through to
 * `line + 8` — four bytes past the end of the string, reading whatever
 * was left in the buffer. Usually atoi found garbage and /w looked
 * simply dead; occasionally it found a number and moved somewhere
 * nobody asked for. */
TEST(every_spelling_of_the_window_verb_finds_its_number) {
    struct app *app = window_app();
    app->url.base[0] = 0;
    add_window_ex(app, "azzurra", "$server", false);
    add_window_ex(app, "azzurra", "#sniffo", true);
    add_window_ex(app, "azzurra", "#terzo", true);
    CHECK_LONG(app->window_count, 3);

    handle_command(app, "/window 2");
    CHECK_LONG(focused_window_locked(app), 1);
    handle_command(app, "/win 3");
    CHECK_LONG(focused_window_locked(app), 2);
    handle_command(app, "/w 1");
    CHECK_LONG(focused_window_locked(app), 0);

    /* Extra spaces are still the same request. */
    handle_command(app, "/w   2");
    CHECK_LONG(focused_window_locked(app), 1);

    /* A number nobody has stays where it is rather than guessing. */
    handle_command(app, "/w 99");
    CHECK_LONG(focused_window_locked(app), 1);

    free_app(app);
}

TEST(a_tab_completed_verb_still_dispatches) {
    struct app *app = window_app();
    app->url.base[0] = 0; /* nothing here should reach the network */

    /* The exact string completion produces for `/vid<TAB>`. Reaching
     * the recorder means it matched; ffmpeg is absent under test, so it
     * refuses for a reason that is NOT "unknown command". */
    handle_command(app, "/video ");
    CHECK(!log_has(app, "unknown command"));

    handle_command(app, "/voicemsg ");
    CHECK(!log_has(app, "unknown command"));
    handle_command(app, "/vmsg ");
    CHECK(!log_has(app, "unknown command"));

    /* Not just the new verbs: this was every argument-less verb in the
     * client. */
    handle_command(app, "/help ");
    CHECK(!log_has(app, "unknown command"));

    /* Several spaces, and a tab, are still "no arguments". */
    handle_command(app, "/help    ");
    CHECK(!log_has(app, "unknown command"));

    /* And a verb that really is unknown still says so — the trim must
     * not turn the error into silence. */
    handle_command(app, "/vidyo ");
    CHECK(log_has(app, "unknown command"));

    free_app(app);
}

/* The panel and /set must show the SAME set of preferences. A panel that
 * lists its own hand-written subset is a panel that quietly stops
 * mentioning whatever was added last. */
TEST(the_settings_panel_lists_every_setting) {
    struct app *app = window_app();
    app->panel = PANEL_SETTINGS;
    /* A secret worth masking: llm_token_redacted renders an EMPTY token
     * as visibly empty, so an unset one proves nothing about masking. */
    snprintf(app->llm.token, sizeof(app->llm.token), "sk-not-a-real-key-8842");
    settings_rows(app);

    CHECK(app->panel_line_count == settings_count());
    CHECK(settings_count() > 10); /* a table that emptied itself is not a pass */
    /* settings_capture_defaults stops at 32 slots, so a table that grows
     * past it loses /unset for the tail — SILENTLY, which is the part
     * that matters: the row still lists, still sets, and only "put it
     * back how it was" quietly stops working. */
    CHECK(settings_count() <= 32);

    for (size_t i = 0; i < settings_count(); i++) {
        /* Every row names its setting and shows a value — not "?" , the
         * shape the admin panel used to render before #the-values-fix. */
        CHECK(strstr(app->panel_lines[i], SETTINGS[i].name) != NULL);
        CHECK(strstr(app->panel_lines[i], SETTINGS[i].help) != NULL);
    }

    /* A secret is masked in the panel exactly as it is in the listing:
     * the panel is drawn on a screen people share. */
    for (size_t i = 0; i < settings_count(); i++) {
        if (strcmp(SETTINGS[i].name, "llm.token") != 0) continue;
        CHECK(strstr(app->panel_lines[i], "*") != NULL);
        CHECK(strstr(app->panel_lines[i], "sk-not") == NULL);
    }

    /* An edit is reflected in place — the panel does not re-fetch to
     * show that a switch moved. */
    size_t mouse_row = settings_count();
    for (size_t i = 0; i < settings_count(); i++)
        if (strcmp(SETTINGS[i].name, "mouse") == 0) mouse_row = i;
    CHECK(mouse_row < settings_count());
    /* Row 0 is a VALID position for the block, and the refresh must work
     * there: treating zero as "no block" is the bug this pins. */
    CHECK(app->settings_row0 == 0);
    CHECK(app->settings_shown);
    app->mouse_enabled = !app->mouse_enabled;
    settings_rows_refresh_locked(app);
    CHECK(strstr(app->panel_lines[mouse_row], app->mouse_enabled ? "on" : "off") != NULL);

    free_app(app);
}

int main(void) {
    /* A HOME OF OUR OWN, before a single test runs.
     *
     * This suite calls the real prefs_save/prefs_load, and prefs_path
     * resolves $HOME at call time — so without this it writes the
     * developer's OWN ~/.local/share/shottino/shottino.conf, with
     * whatever defaults a test app happens to hold. That is exactly
     * what it did: vjt lost `voice.source = alsa:hw:2` to
     * `pulse:default` on every `make check`, and blamed the reinstall
     * that always happened alongside it.
     *
     * Set once here rather than per test, because the next test to call
     * prefs_save is the one nobody remembers to guard. */
    char test_home[] = "/tmp/shottino-test-home-XXXXXX";
    if (mkdtemp(test_home)) setenv("HOME", test_home, 1);

    RUN(names_are_compared_under_the_ircds_casemapping);
    RUN(a_channel_opened_twice_in_two_spellings_is_one_window);
    RUN(a_query_answered_in_another_case_reuses_its_window);
    RUN(a_row_files_under_its_windows_canonical_key);
    RUN(the_server_window_is_a_name_not_a_spelling);
    RUN(traffic_named_after_the_network_is_the_server_talking);
    RUN(the_server_talking_opens_no_window_of_its_own);
    RUN(a_reply_card_lands_in_the_window_that_asked);
    RUN(a_block_matches_the_person_not_the_spelling);
    RUN(a_blocked_person_is_not_drawn_but_is_still_counted);
    RUN(the_menu_offers_the_op_actions_only_to_an_op);
    RUN(op_actions_stay_out_of_a_query_window);
    RUN(the_block_entry_is_a_toggle);
    RUN(a_ctcp_reply_is_an_answer_not_a_message);
    RUN(oper_verbs_put_their_arguments_where_the_ircd_wants_them);
    RUN(an_oper_verb_missing_its_arguments_is_refused_not_sent);
    RUN(an_oper_verb_is_matched_as_a_whole_word);
    RUN(every_oper_verb_explains_itself);
    RUN(kill_is_offered_only_to_an_oper);
    RUN(the_wire_echo_never_prints_a_payload);
    RUN(a_push_carries_the_joins_ref_not_its_own);
    RUN(a_ping_reply_is_matched_against_the_pings_we_are_waiting_on);
    RUN(a_backfilled_ping_reply_still_reports_its_round_trip);
    RUN(a_ping_reply_routed_to_server_still_lands_in_the_active_window);
    RUN(an_unsolicited_ping_reply_is_never_reported_as_our_round_trip);
    RUN(an_inbound_ctcp_query_is_named_not_dumped);
    RUN(a_ctcp_query_is_answered_only_where_it_is_ours_to_answer);
    RUN(a_ctcp_query_is_framed_the_way_the_protocol_expects);
    RUN(audio_is_classified_before_the_uploads_heuristic);
    RUN(the_admin_sessions_tab_reads_the_shape_the_server_sends);
    RUN(the_admin_uploads_tab_totals_the_bytes_field);
    RUN(the_admin_visitors_tab_renders_per_network_rows);
    RUN(a_setting_name_and_a_boolean_are_parsed_the_way_people_type_them);
    RUN(the_settings_listing_never_prints_the_token);
    RUN(a_nick_match_alone_is_never_the_owner);
    RUN(a_grant_is_per_person_and_per_tool);
    RUN(a_memory_filename_is_built_not_taken);
    RUN(two_identities_get_two_bot_directories);
    RUN(an_accented_character_survives_typing_and_one_backspace);
    RUN(a_settings_menu_offers_what_the_setting_accepts);
    RUN(tab_cycles_through_the_media_in_this_window);
    RUN(stt_transcribes_and_dictate_types);
    RUN(a_configured_setting_survives_save_and_load);
    RUN(the_call_tile_map_is_parsed_or_rejected_whole);
    RUN(a_client_local_window_is_never_fetched_from_the_server);
    RUN(a_conversation_is_remembered_and_rolls_to_fit);
    RUN(the_context_budget_leaves_room_for_the_fixed_parts);
    RUN(a_config_write_leaves_the_previous_version_behind);
    RUN(an_unset_prompt_says_the_built_in_is_in_use);
    RUN(tab_completes_the_values_a_setting_accepts);
    RUN(the_setting_modal_seeds_its_field_but_never_a_secret);
    RUN(unset_puts_a_preference_back_to_how_it_started);
    RUN(a_websocket_ref_is_never_handed_out_twice);
    RUN(the_model_thread_announces_that_it_stopped);
    RUN(retiring_an_echo_moves_every_row_not_just_its_text);
    RUN(a_conversation_reaches_the_bot_and_a_join_does_not);
    RUN(a_preference_survives_a_restart);
    RUN(an_identity_keeps_its_notes_across_the_rename);
    RUN(a_standing_grant_survives_a_restart);
    RUN(a_truncated_string_keeps_only_whole_characters);
    RUN(a_command_refuses_what_it_cannot_do);
    RUN(a_long_agent_md_leaves_room_for_the_notes);
    RUN(a_join_key_is_split_from_the_channel);
    RUN(a_verb_is_matched_as_a_whole_word_not_a_prefix);
    RUN(every_spelling_of_the_window_verb_finds_its_number);
    RUN(a_tab_completed_verb_still_dispatches);
    RUN(the_settings_panel_lists_every_setting);
    RUN(a_ping_reply_we_did_not_time_is_still_shown_when_live);
    RUN(the_call_picture_is_a_share_of_the_width);
    RUN(an_action_is_shown_as_words_not_control_characters);
    RUN(a_question_is_written_where_its_answer_will_land);
    RUN(only_a_marked_invite_is_a_call);
    RUN(an_invite_round_trips_through_its_own_parser);
    RUN(a_call_already_running_here_is_the_call);
    RUN(an_invite_carries_its_room_in_the_fragment);
    RUN(a_query_rings_and_a_channel_only_announces);
    RUN(an_arriving_call_rings_only_where_it_should);
    return test_report();
}
