/* test_ircd — the downstream IRC server (--ircd).
 *
 * Two halves, for two kinds of bug.
 *
 * The grammar half is pure: the bind spec, the line parser, the fold,
 * the sanitiser. Those decide whether "--ircd=[::1]:6668" means what the
 * user wrote and whether a hostile message body can inject a command
 * into someone's client, and none of it needs a socket.
 *
 * The conversation half is not pure and must not be faked. A bridge is
 * judged by what a real client sees after it says hello, so the test
 * opens a REAL socket to the bridge, sends the bytes irssi sends, and
 * reads back what came out — through the client's own accept/read/
 * dispatch/flush pass, not a copy of it. Everything behind the bridge
 * (grappa, the websocket, the worker) is absent, which is exactly the
 * point: what is asserted is the translation, and translation is where
 * bridges go wrong. */
#define main shottino_main_unused
#include "../shottino.c"
#undef main

#include "test.h"
#include <sys/socket.h>
#include <netinet/in.h>

/* ── The grammar ───────────────────────────────────────────────────── */

TEST(bind_spec_reads_ports_addresses_and_both_families) {
    char host[128], port[16];

    /* Bare --ircd: loopback, the port the world calls IRC. */
    CHECK(ircd_parse_bind("", host, sizeof(host), port, sizeof(port)));
    CHECK_STR(host, "127.0.0.1");
    CHECK_STR(port, "6667");

    CHECK(ircd_parse_bind("6668", host, sizeof(host), port, sizeof(port)));
    CHECK_STR(host, "127.0.0.1");
    CHECK_STR(port, "6668");

    CHECK(ircd_parse_bind("10.0.0.2", host, sizeof(host), port, sizeof(port)));
    CHECK_STR(host, "10.0.0.2");
    CHECK_STR(port, "6667");

    CHECK(ircd_parse_bind("10.0.0.2:6668", host, sizeof(host), port, sizeof(port)));
    CHECK_STR(host, "10.0.0.2");
    CHECK_STR(port, "6668");

    /* A bare IPv6 literal is all colons and no port — told apart from
     * host:port by counting them, which is the whole reason the bracket
     * form exists. */
    CHECK(ircd_parse_bind("::1", host, sizeof(host), port, sizeof(port)));
    CHECK_STR(host, "::1");
    CHECK_STR(port, "6667");

    CHECK(ircd_parse_bind("fe80::dead:beef", host, sizeof(host), port, sizeof(port)));
    CHECK_STR(host, "fe80::dead:beef");
    CHECK_STR(port, "6667");

    CHECK(ircd_parse_bind("[::1]:6668", host, sizeof(host), port, sizeof(port)));
    CHECK_STR(host, "::1");
    CHECK_STR(port, "6668");

    CHECK(ircd_parse_bind("[::]", host, sizeof(host), port, sizeof(port)));
    CHECK_STR(host, "::");
    CHECK_STR(port, "6667");

    CHECK(ircd_parse_bind("localhost:6669", host, sizeof(host), port, sizeof(port)));
    CHECK_STR(host, "localhost");
    CHECK_STR(port, "6669");

    /* Nonsense is refused rather than silently listening somewhere the
     * user did not ask for. */
    CHECK(!ircd_parse_bind("[::1", host, sizeof(host), port, sizeof(port)));
    CHECK(!ircd_parse_bind(":6667", host, sizeof(host), port, sizeof(port)));
}

/* Whether a password is REQUIRED hangs on this, so 127.0.0.2 counting as
 * loopback is a decision, not an accident. */
TEST(loopback_is_the_whole_127_block_and_the_v6_one) {
    CHECK(ircd_bind_is_loopback("127.0.0.1"));
    CHECK(ircd_bind_is_loopback("127.0.0.2"));
    CHECK(ircd_bind_is_loopback("::1"));
    CHECK(ircd_bind_is_loopback("localhost"));
    CHECK(!ircd_bind_is_loopback("0.0.0.0"));
    CHECK(!ircd_bind_is_loopback("::"));
    CHECK(!ircd_bind_is_loopback("192.168.1.10"));
    CHECK(!ircd_bind_is_loopback(""));
}

TEST(client_lines_parse_into_command_and_params) {
    struct ircd_msg m;

    CHECK(ircd_parse_line("PRIVMSG #chan :hello there, world", &m));
    CHECK_STR(m.command, "PRIVMSG");
    CHECK_LONG(m.param_count, 2);
    CHECK_STR(m.params[0], "#chan");
    /* The trailing parameter keeps its spaces and loses only the ':'. */
    CHECK_STR(m.params[1], "hello there, world");

    /* Case is the client's business, not ours. */
    CHECK(ircd_parse_line("privmsg #chan :hi", &m));
    CHECK(ircd_command_is(&m, "PRIVMSG"));

    /* A prefix is accepted and ignored, as a server must. */
    CHECK(ircd_parse_line(":nick!user@host JOIN #chan", &m));
    CHECK_STR(m.prefix, "nick!user@host");
    CHECK_STR(m.command, "JOIN");
    CHECK_STR(m.params[0], "#chan");

    /* An empty trailing is a parameter, not an absence: "QUIT :" means
     * quit with no reason, and dropping it changes the command. */
    CHECK(ircd_parse_line("QUIT :", &m));
    CHECK_LONG(m.param_count, 1);
    CHECK_STR(m.params[0], "");

    CHECK(ircd_parse_line("USER u 0 * :Real Name Here", &m));
    CHECK_LONG(m.param_count, 4);
    CHECK_STR(m.params[3], "Real Name Here");

    CHECK(!ircd_parse_line("", &m));
    CHECK(!ircd_parse_line("   ", &m));
}

TEST(pass_names_the_network_or_is_only_a_password) {
    char network[64], secret[64];

    ircd_split_pass("azzurra:hunter2", network, sizeof(network), secret, sizeof(secret));
    CHECK_STR(network, "azzurra");
    CHECK_STR(secret, "hunter2");

    /* No colon: it is one or the other and the string cannot say which,
     * so both readings come back and the caller — which knows the
     * network names — decides. */
    ircd_split_pass("azzurra", network, sizeof(network), secret, sizeof(secret));
    CHECK_STR(network, "azzurra");
    CHECK_STR(secret, "azzurra");

    ircd_split_pass("azzurra:", network, sizeof(network), secret, sizeof(secret));
    CHECK_STR(network, "azzurra");
    CHECK_STR(secret, "");
}

/* A message body arrives from IRC, through grappa, and back out to a
 * client. Without this, anyone who can speak in a channel can end our
 * line early and start one of their own in someone else's session. */
TEST(a_body_cannot_become_a_second_protocol_line) {
    char out[256];
    ircd_sanitize("hello\r\nPRIVMSG #ops :I am the server", out, sizeof(out));
    CHECK(strchr(out, '\r') == NULL);
    CHECK(strchr(out, '\n') == NULL);
    CHECK_STR(out, "helloPRIVMSG #ops :I am the server");

    /* Formatting and CTCP survive: this is a bridge, not a filter. */
    ircd_sanitize("\002bold\003" "04 red \001ACTION waves\001", out, sizeof(out));
    CHECK(strchr(out, '\002') != NULL);
    CHECK(strchr(out, '\001') != NULL);

    /* A nick cannot forge a different sender through the prefix. */
    char prefix[128];
    ircd_sender_prefix("evil nick!real@host", prefix, sizeof(prefix));
    CHECK(strstr(prefix, "evil_nick_real_host") != NULL);
}

TEST(names_fold_the_way_the_ircd_folds_them) {
    /* CASEMAPPING=ascii: A-Z, and nothing else. bahamut advertises it
     * and implements it, so the four rfc1459 bracket characters are
     * ORDINARY here — this suite used to assert the opposite, which is
     * the same over-fold grappa corrected server-side in #525. */
    CHECK(ircd_name_equal("#Chan", "#chan"));
    CHECK(!ircd_name_equal("#chan[1]", "#chan{1}"));
    CHECK(!ircd_name_equal("nick\\away", "nick|away"));
    CHECK(!ircd_name_equal("A~b", "a^B"));
    CHECK(ircd_name_equal("A~B", "a~b"));
    CHECK(!ircd_name_equal("#chan", "#chan2"));
    /* ASCII only: those are two different rooms on that server, and
     * merging them here would put two conversations in one window. */
    CHECK(!ircd_name_equal("#caf\xc3\x89", "#caf\xc3\xa9"));
}

TEST(sigils_follow_the_multi_prefix_the_client_asked_for) {
    char out[8];
    /* Without multi-prefix a client expects exactly one, the highest:
     * "@+nick" reads as a nick called "+nick". */
    ircd_member_sigils("@+", "@%+", false, out, sizeof(out));
    CHECK_STR(out, "@");
    ircd_member_sigils("@+", "@%+", true, out, sizeof(out));
    CHECK_STR(out, "@+");
    ircd_member_sigils("", "@%+", true, out, sizeof(out));
    CHECK_STR(out, "");
}

TEST(server_time_is_tagged_only_when_asked_for) {
    char out[64];
    ircd_time_tag(1753776000123L, true, out, sizeof(out));
    CHECK_STR(out, "@time=2025-07-29T08:00:00.123Z ");
    /* A client that did not negotiate server-time gets no tag at all —
     * an unasked-for tag is a parse error in an older client. */
    ircd_time_tag(1753776000123L, false, out, sizeof(out));
    CHECK_STR(out, "");
    ircd_time_tag(0, true, out, sizeof(out));
    CHECK_STR(out, "");
}

TEST(selectors_name_a_point_in_the_conversation) {
    struct ircd_selector sel;

    CHECK(ircd_parse_selector("*", &sel));
    CHECK_LONG(sel.kind, IRCD_SEL_STAR);

    CHECK(ircd_parse_selector("timestamp=2025-07-29T08:00:00.123Z", &sel));
    CHECK_LONG(sel.kind, IRCD_SEL_TIME);
    CHECK_LONG(sel.time_ms, 1753776000123L);

    CHECK(ircd_parse_selector("msgid=4321", &sel));
    CHECK_LONG(sel.kind, IRCD_SEL_MSGID);
    CHECK_LONG(sel.msgid, 4321);

    /* Unreadable is REFUSED, not quietly turned into the beginning of
     * time: a selector that means "everything" when the client meant
     * "since yesterday" answers a question nobody asked. */
    CHECK(!ircd_parse_selector("timestamp=yesterday", &sel));
    CHECK(!ircd_parse_selector("msgid=", &sel));
    CHECK(!ircd_parse_selector("banana", &sel));
    CHECK(!ircd_parse_selector("", &sel));

    /* The format is UTC by definition; reading it in the local zone
     * would move every selector by the offset. */
    long ms = 0;
    CHECK(ircd_parse_time("2025-01-01T00:00:00.000Z", &ms));
    CHECK_LONG(ms, 1735689600000L);
    /* Milliseconds are optional in what clients send. */
    CHECK(ircd_parse_time("2025-01-01T00:00:00Z", &ms));
    CHECK_LONG(ms, 1735689600000L);
    CHECK(!ircd_parse_time("nonsense", &ms));
}

TEST(tags_are_built_as_one_prefix_or_not_at_all) {
    char out[128];
    /* Nothing negotiated: no tags, and no stray "@" either. */
    ircd_tags(1753776000123L, false, 42, false, NULL, out, sizeof(out));
    CHECK_STR(out, "");
    /* server-time alone. */
    ircd_tags(1753776000123L, true, 42, false, NULL, out, sizeof(out));
    CHECK_STR(out, "@time=2025-07-29T08:00:00.123Z ");
    /* With message-tags, the id a client can point back at. */
    ircd_tags(1753776000123L, true, 42, true, NULL, out, sizeof(out));
    CHECK_STR(out, "@time=2025-07-29T08:00:00.123Z;msgid=42 ");
    /* In a batch, all three, separated once each. */
    ircd_tags(1753776000123L, true, 42, true, "sh1", out, sizeof(out));
    CHECK_STR(out, "@time=2025-07-29T08:00:00.123Z;msgid=42;batch=sh1 ");
    /* message-tags without server-time still carries the id. */
    ircd_tags(1753776000123L, false, 42, true, NULL, out, sizeof(out));
    CHECK_STR(out, "@msgid=42 ");
    /* A buffer too small for the tags produces NOTHING, not a truncated
     * prefix and not a write past the end. snprintf returns what it
     * WOULD have written, so accumulating that unclamped let the offset
     * pass the buffer and the remaining size wrap to an enormous
     * size_t — the next leg would then write without a bound. */
    char tiny[8];
    memset(tiny, 'x', sizeof(tiny));
    ircd_tags(1753776000123L, true, 42, true, "sh7", tiny, sizeof(tiny));
    CHECK_STR(tiny, "");
    /* And a buffer that is exactly big enough still builds the whole
     * thing — the clamp must not refuse work that fits. */
    char room[128];
    ircd_tags(1753776000123L, true, 42, true, "sh7", room, sizeof(room));
    CHECK(strstr(room, "msgid=42") != NULL);
    CHECK(strstr(room, "batch=sh7") != NULL);
    CHECK(room[strlen(room) - 1] == ' ');

}

/* ── The conversation ──────────────────────────────────────────────── */

static struct app *bridge_app(void) {
    struct app *app = calloc(1, sizeof(*app));
    if (!app) return NULL;
    pthread_mutex_init(&app->lock, NULL);
    pthread_mutex_init(&app->jobs_lock, NULL);
    pthread_cond_init(&app->jobs_cond, NULL);
    snprintf(app->subject, sizeof(app->subject), "user:vjt");
    struct network *n = &app->networks[app->network_count++];
    snprintf(n->slug, sizeof(n->slug), "azzurra");
    snprintf(n->nick, sizeof(n->nick), "vjt");
    n->id = 7;
    n->prefix_letters[0] = 'o';
    n->prefix_sigils[0] = '@';
    n->prefix_letters[1] = 'v';
    n->prefix_sigils[1] = '+';
    n->prefix_count = 2;

    struct window *w = &app->windows[app->window_count++];
    snprintf(w->network, sizeof(w->network), "azzurra");
    snprintf(w->channel, sizeof(w->channel), "#sniffo");
    snprintf(w->topic, sizeof(w->topic), "the topic, with spaces");
    snprintf(w->members[0].nick, sizeof(w->members[0].nick), "vjt");
    snprintf(w->members[0].modes, sizeof(w->members[0].modes), "@");
    snprintf(w->members[1].nick, sizeof(w->members[1].nick), "alice");
    snprintf(w->members[1].modes, sizeof(w->members[1].modes), "+");
    snprintf(w->members[2].nick, sizeof(w->members[2].nick), "bob");
    w->member_count = 3;
    return app;
}

/* Connect to the bridge as a client would, and give the bridge a pass so
 * the connection is accepted. */
static int bridge_connect(struct app *app) {
    struct sockaddr_in addr;
    socklen_t len = sizeof(addr);
    if (getsockname(app->ircd.listen_fd[0], (struct sockaddr *)&addr, &len) != 0) return -1;
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) return -1;
    if (connect(fd, (struct sockaddr *)&addr, len) != 0) {
        close(fd);
        return -1;
    }
    ircd_poll_once(app, 20); /* accept */
    return fd;
}

static void client_send(int fd, const char *line) {
    char buf[1024];
    int n = snprintf(buf, sizeof(buf), "%s\r\n", line);
    ssize_t w = write(fd, buf, (size_t)n);
    (void)w;
}

/* Read whatever the bridge has to say, giving it a few passes to answer:
 * a reply may be produced by one pass and flushed by the next. */
static void client_drain(struct app *app, int fd, char *out, size_t out_sz) {
    size_t used = 0;
    out[0] = '\0';
    for (int pass = 0; pass < 12; pass++) {
        ircd_poll_once(app, 10);
        for (;;) {
            char buf[4096];
            ssize_t n = recv(fd, buf, sizeof(buf) - 1, MSG_DONTWAIT);
            if (n <= 0) break;
            buf[n] = '\0';
            size_t room = out_sz - used - 1;
            size_t take = (size_t)n < room ? (size_t)n : room;
            memcpy(out + used, buf, take);
            used += take;
            out[used] = '\0';
        }
    }
}

static struct app *started_bridge(void) {
    struct app *app = bridge_app();
    if (!app) return NULL;
    /* Port 0: the kernel picks a free one, so a suite running twice at
     * once does not fight over 6667. */
    if (!ircd_start(app, "127.0.0.1:0")) {
        free(app);
        return NULL;
    }
    return app;
}

TEST(a_client_registers_and_is_shown_the_session_it_joined) {
    struct app *app = started_bridge();
    CHECK(app != NULL);
    if (!app) return;
    int fd = bridge_connect(app);
    CHECK(fd >= 0);
    if (fd < 0) return;

    char out[65536];
    client_send(fd, "CAP LS 302");
    client_send(fd, "PASS azzurra");
    client_send(fd, "NICK someoneelse");
    client_send(fd, "USER u 0 * :Real Name");
    client_send(fd, "CAP REQ :server-time multi-prefix");
    client_send(fd, "CAP END");
    client_drain(app, fd, out, sizeof(out));

    /* Capabilities are offered and acknowledged. */
    CHECK(strstr(out, "CAP * LS :server-time multi-prefix echo-message") != NULL);
    CHECK(strstr(out, "ACK :server-time multi-prefix") != NULL);

    /* The nick is grappa's, not the one the client guessed: a bouncer
     * speaks as the account it bridges, and it says so with the NICK a
     * real server would have sent. */
    CHECK(strstr(out, "NICK :vjt") != NULL);
    CHECK(strstr(out, " 001 vjt :Welcome") != NULL);
    CHECK(strstr(out, " 005 vjt CHANTYPES") != NULL);
    CHECK(strstr(out, "PREFIX=(ov)@+") != NULL);
    CHECK(strstr(out, "NETWORK=azzurra") != NULL);
    CHECK(strstr(out, " 376 vjt :End of /MOTD") != NULL);

    /* The channels grappa already holds open ARE the session: a client
     * that had to rejoin them would be rejoining channels it never
     * left. */
    CHECK(strstr(out, ":vjt!vjt@grappa JOIN #sniffo") != NULL);
    CHECK(strstr(out, " 332 vjt #sniffo :the topic, with spaces") != NULL);
    /* multi-prefix was negotiated, so the roster carries the sigils the
     * server actually advertises. */
    CHECK(strstr(out, "@vjt") != NULL);
    CHECK(strstr(out, "+alice") != NULL);
    CHECK(strstr(out, "bob") != NULL);
    CHECK(strstr(out, " 366 vjt #sniffo :End of /NAMES list") != NULL);

    close(fd);
    ircd_stop(app);
    for (size_t i = 0; i < app->log_count; i++) free(app->log[i]);
    free(app);
}

/* A registered client is a live view of the network: what grappa pushes
 * has to arrive as the line an IRC client expects, and what the client
 * says has to reach grappa. */
TEST(messages_cross_the_bridge_in_both_directions) {
    struct app *app = started_bridge();
    CHECK(app != NULL);
    if (!app) return;
    int fd = bridge_connect(app);
    CHECK(fd >= 0);
    if (fd < 0) return;
    char out[65536];
    client_send(fd, "PASS azzurra");
    client_send(fd, "NICK vjt");
    client_send(fd, "USER u 0 * :r");
    client_drain(app, fd, out, sizeof(out));
    CHECK(strstr(out, " 001 vjt") != NULL);

    /* Downstream: what the client says becomes a job for the worker,
     * addressed to the network THIS connection chose. */
    client_send(fd, "PRIVMSG #sniffo :ciao a tutti");
    client_drain(app, fd, out, sizeof(out));
    CHECK_LONG(app->jobs_tail, 1);
    CHECK_LONG(app->jobs[0].kind, JOB_SEND);
    CHECK_STR(app->jobs[0].network, "azzurra");
    CHECK_STR(app->jobs[0].channel, "#sniffo");
    CHECK_STR(app->jobs[0].arg1, "ciao a tutti");

    /* Upstream: a message from someone else, as grappa delivers it. */
    struct wire_scrollback_message m = {.id = 101,
                                        .network = "azzurra",
                                        .channel = "#sniffo",
                                        .server_time = 1753776000000L,
                                        .kind = MSG_PRIVMSG,
                                        .sender = "alice",
                                        .body = "ciao vjt"};
    ircd_publish(app, &m, "#sniffo");
    client_drain(app, fd, out, sizeof(out));
    CHECK(strstr(out, ":alice!alice@grappa PRIVMSG #sniffo :ciao vjt") != NULL);
    /* No server-time was negotiated by this client, so no tag. */
    CHECK(strstr(out, "@time=") == NULL);

    /* Our own message must NOT come back: the client printed it when it
     * sent it, and echoing doubles every line. */
    struct wire_scrollback_message own = m;
    own.id = 102;
    own.sender = "vjt";
    own.body = "sono io";
    ircd_publish(app, &own, "#sniffo");
    client_drain(app, fd, out, sizeof(out));
    CHECK(strstr(out, "sono io") == NULL);

    /* A DM is addressed to US, not to the window it is filed under. */
    struct wire_scrollback_message dm = {.id = 103,
                                         .network = "azzurra",
                                         .channel = "alice",
                                         .server_time = 1753776000000L,
                                         .kind = MSG_PRIVMSG,
                                         .sender = "alice",
                                         .body = "sei li?"};
    ircd_publish(app, &dm, "alice");
    client_drain(app, fd, out, sizeof(out));
    CHECK(strstr(out, ":alice!alice@grappa PRIVMSG vjt :sei li?") != NULL);

    /* Presence rows are messages on grappa's wire and commands on IRC's. */
    struct wire_scrollback_message join = {.id = 104,
                                           .network = "azzurra",
                                           .channel = "#sniffo",
                                           .kind = MSG_JOIN,
                                           .sender = "carol",
                                           .body = ""};
    ircd_publish(app, &join, "#sniffo");
    struct wire_scrollback_message action = {.id = 105,
                                             .network = "azzurra",
                                             .channel = "#sniffo",
                                             .kind = MSG_ACTION,
                                             .sender = "alice",
                                             .body = "waves"};
    ircd_publish(app, &action, "#sniffo");
    client_drain(app, fd, out, sizeof(out));
    CHECK(strstr(out, ":carol!carol@grappa JOIN #sniffo") != NULL);
    CHECK(strstr(out, "PRIVMSG #sniffo :\001ACTION waves\001") != NULL);

    close(fd);
    ircd_stop(app);
    for (size_t i = 0; i < app->log_count; i++) free(app->log[i]);
    free(app);
}

/* echo-message is how a client says "show me what I sent from
 * elsewhere", which is the whole reason to run a bouncer. */
TEST(echo_message_turns_our_own_lines_back_on) {
    struct app *app = started_bridge();
    CHECK(app != NULL);
    if (!app) return;
    int fd = bridge_connect(app);
    CHECK(fd >= 0);
    if (fd < 0) return;
    char out[65536];
    client_send(fd, "CAP LS");
    client_send(fd, "CAP REQ :echo-message server-time");
    client_send(fd, "PASS azzurra");
    client_send(fd, "NICK vjt");
    client_send(fd, "USER u 0 * :r");
    client_send(fd, "CAP END");
    client_drain(app, fd, out, sizeof(out));

    struct wire_scrollback_message own = {.id = 200,
                                          .network = "azzurra",
                                          .channel = "#sniffo",
                                          .server_time = 1753776000123L,
                                          .kind = MSG_PRIVMSG,
                                          .sender = "vjt",
                                          .body = "sent from cicchetto"};
    ircd_publish(app, &own, "#sniffo");
    client_drain(app, fd, out, sizeof(out));
    CHECK(strstr(out, "sent from cicchetto") != NULL);
    /* And with server-time negotiated it is stamped when it was SAID,
     * not when it was relayed. */
    CHECK(strstr(out, "@time=2025-07-29T08:00:00.123Z ") != NULL);

    close(fd);
    ircd_stop(app);
    for (size_t i = 0; i < app->log_count; i++) free(app->log[i]);
    free(app);
}

/* What a client missed is the reason it reconnects. */
TEST(a_late_client_is_given_the_conversation_it_missed) {
    struct app *app = started_bridge();
    CHECK(app != NULL);
    if (!app) return;

    struct wire_scrollback_message earlier = {.id = 300,
                                              .network = "azzurra",
                                              .channel = "#sniffo",
                                              .server_time = 1753776000000L,
                                              .kind = MSG_PRIVMSG,
                                              .sender = "alice",
                                              .body = "said before you connected"};
    ircd_publish(app, &earlier, "#sniffo");
    /* A presence row from an hour ago would tell the client someone is
     * arriving NOW, so replay carries conversation only. */
    struct wire_scrollback_message old_join = {.id = 301,
                                               .network = "azzurra",
                                               .channel = "#sniffo",
                                               .kind = MSG_JOIN,
                                               .sender = "carol",
                                               .body = ""};
    ircd_publish(app, &old_join, "#sniffo");
    /* Another network's traffic belongs to another connection. */
    struct wire_scrollback_message elsewhere = {.id = 302,
                                                .network = "libera",
                                                .channel = "#other",
                                                .kind = MSG_PRIVMSG,
                                                .sender = "dave",
                                                .body = "different network"};
    ircd_publish(app, &elsewhere, "#other");

    int fd = bridge_connect(app);
    CHECK(fd >= 0);
    if (fd < 0) return;
    char out[65536];
    client_send(fd, "PASS azzurra");
    client_send(fd, "NICK vjt");
    client_send(fd, "USER u 0 * :r");
    client_drain(app, fd, out, sizeof(out));

    CHECK(strstr(out, "said before you connected") != NULL);
    CHECK(strstr(out, "different network") == NULL);
    CHECK(strstr(out, ":carol!carol@grappa JOIN") == NULL);

    close(fd);
    ircd_stop(app);
    for (size_t i = 0; i < app->log_count; i++) free(app->log[i]);
    free(app);
}

/* A client naming a network that does not exist is the likeliest first
 * mistake, and the answer has to say what the choices are. */
TEST(an_unknown_network_is_refused_with_the_list) {
    struct app *app = started_bridge();
    CHECK(app != NULL);
    if (!app) return;
    int fd = bridge_connect(app);
    CHECK(fd >= 0);
    if (fd < 0) return;
    char out[65536];
    client_send(fd, "PASS libera:secret");
    client_send(fd, "NICK vjt");
    client_send(fd, "USER u 0 * :r");
    client_drain(app, fd, out, sizeof(out));
    CHECK(strstr(out, "ERROR :no such network libera") != NULL);
    CHECK(strstr(out, "azzurra") != NULL);
    CHECK(strstr(out, " 001 ") == NULL);

    close(fd);
    ircd_stop(app);
    for (size_t i = 0; i < app->log_count; i++) free(app->log[i]);
    free(app);
}

/* A wrong password learns NOTHING — not even which networks exist.
 *
 * The "no such network X — this account has: ..." reply is a kindness to
 * somebody who mistyped, and it used to be sent BEFORE the password was
 * checked. So anyone who could reach the port could name a network that
 * does not exist and be handed the complete list of the ones that do,
 * without knowing the password at all. */
TEST(a_bad_password_is_told_nothing_about_the_account) {
    setenv("SHOTTINO_IRCD_PASS", "hunter2", 1);
    struct app *app = bridge_app();
    CHECK(app != NULL);
    if (!app) { unsetenv("SHOTTINO_IRCD_PASS"); return; }
    if (!ircd_start(app, "127.0.0.1:0")) {
        free(app);
        unsetenv("SHOTTINO_IRCD_PASS");
        return;
    }
    CHECK(app->ircd.secret_required);

    int fd = bridge_connect(app);
    CHECK(fd >= 0);
    if (fd >= 0) {
        char out[65536];
        /* A network that does not exist AND a password that is wrong. */
        client_send(fd, "PASS libera:wrong");
        client_send(fd, "NICK vjt");
        client_send(fd, "USER u 0 * :r");
        client_drain(app, fd, out, sizeof(out));
        CHECK(strstr(out, "464") != NULL);
        /* Not the list, not the name of any network, not a welcome. */
        CHECK(strstr(out, "azzurra") == NULL);
        CHECK(strstr(out, "no such network") == NULL);
        CHECK(strstr(out, " 001 ") == NULL);
        close(fd);
    }

    /* The right password still gets in. */
    int ok_fd = bridge_connect(app);
    CHECK(ok_fd >= 0);
    if (ok_fd >= 0) {
        char out[65536];
        client_send(ok_fd, "PASS azzurra:hunter2");
        client_send(ok_fd, "NICK vjt");
        client_send(ok_fd, "USER u 0 * :r");
        client_drain(app, ok_fd, out, sizeof(out));
        CHECK(strstr(out, " 001 ") != NULL);
        close(ok_fd);
    }

    ircd_stop(app);
    for (size_t i = 0; i < app->log_count; i++) free(app->log[i]);
    free(app);
    unsetenv("SHOTTINO_IRCD_PASS");
}

/* The bridge hands over the user's whole IRC session. On loopback that
 * is bounded by who can run processes as them; anywhere else it is
 * bounded by nothing, so it refuses to come up rather than listening
 * where anyone can reach it. */
TEST(a_reachable_bind_without_a_password_refuses_to_start) {
    struct app *app = bridge_app();
    CHECK(app != NULL);
    if (!app) return;
    unsetenv("SHOTTINO_IRCD_PASS");
    CHECK(!ircd_start(app, "0.0.0.0:0"));
    CHECK(!app->ircd.enabled);
    CHECK_LONG(app->ircd.listen_count, 0);

    /* With one set, the same bind is allowed — and the password is then
     * required of every client. */
    setenv("SHOTTINO_IRCD_PASS", "hunter2", 1);
    CHECK(ircd_start(app, "0.0.0.0:0"));
    CHECK(app->ircd.secret_required);
    ircd_stop(app);

    /* On loopback with a password set, it is still required: setting one
     * and having it ignored would be the worst of both. */
    CHECK(ircd_start(app, "127.0.0.1:0"));
    CHECK(app->ircd.secret_required);
    int fd = bridge_connect(app);
    CHECK(fd >= 0);
    if (fd >= 0) {
        char out[8192];
        client_send(fd, "PASS azzurra:wrong");
        client_send(fd, "NICK vjt");
        client_send(fd, "USER u 0 * :r");
        client_drain(app, fd, out, sizeof(out));
        CHECK(strstr(out, "464") != NULL);
        CHECK(strstr(out, " 001 ") == NULL);
        close(fd);
    }
    ircd_stop(app);
    unsetenv("SHOTTINO_IRCD_PASS");
    for (size_t i = 0; i < app->log_count; i++) free(app->log[i]);
    free(app);
}

/* Whatever the bridge does not implement, the real server does. */
TEST(unknown_commands_are_forwarded_in_the_clients_own_words) {
    struct app *app = started_bridge();
    CHECK(app != NULL);
    if (!app) return;
    int fd = bridge_connect(app);
    CHECK(fd >= 0);
    if (fd < 0) return;
    char out[65536];
    client_send(fd, "PASS azzurra");
    client_send(fd, "NICK vjt");
    client_send(fd, "USER u 0 * :r");
    client_drain(app, fd, out, sizeof(out));

    /* Joining a channel grappa already holds open is answered from
     * state, not asked of the server again. */
    size_t before = app->jobs_tail;
    client_send(fd, "JOIN #SNIFFO"); /* and the case is the ircd's to fold */
    client_drain(app, fd, out, sizeof(out));
    CHECK_LONG(app->jobs_tail, before);
    CHECK(strstr(out, "JOIN #SNIFFO") != NULL);

    /* A channel it does not have becomes a job for the worker. */
    client_send(fd, "JOIN #altro");
    client_drain(app, fd, out, sizeof(out));
    CHECK_LONG(app->jobs_tail, before + 1);
    CHECK_LONG(app->jobs[before].kind, JOB_JOIN);
    CHECK_STR(app->jobs[before].channel, "#altro");
    CHECK_STR(app->jobs[before].network, "azzurra");

    /* NAMES and WHO answer from the roster the client already keeps. */
    client_send(fd, "NAMES #sniffo");
    client_drain(app, fd, out, sizeof(out));
    CHECK(strstr(out, " 353 vjt = #sniffo :") != NULL);
    client_send(fd, "WHO #sniffo");
    client_drain(app, fd, out, sizeof(out));
    CHECK(strstr(out, " 352 vjt #sniffo") != NULL);
    CHECK(strstr(out, " 315 vjt #sniffo :End of /WHO list") != NULL);

    /* PING is answered here — a bridge that let the client time out
     * while grappa was fine would be blamed for grappa. */
    client_send(fd, "PING :12345");
    client_drain(app, fd, out, sizeof(out));
    CHECK(strstr(out, "PONG grappa :12345") != NULL);

    close(fd);
    ircd_stop(app);
    for (size_t i = 0; i < app->log_count; i++) free(app->log[i]);
    free(app);
}

/* CHATHISTORY is how a client asks for what it missed instead of being
 * told once at connect time. The slice it returns is the whole feature:
 * "the last five" that returns the FIRST five is worse than an error. */
static void seed_history(struct app *app, const char *channel, const char *sender, long id,
                         long ms, const char *body) {
    struct wire_scrollback_message m = {.id = id,
                                        .network = "azzurra",
                                        .channel = channel,
                                        .server_time = ms,
                                        .kind = MSG_PRIVMSG,
                                        .sender = sender,
                                        .body = body};
    ircd_publish(app, &m, channel);
}

TEST(chathistory_returns_the_slice_that_was_asked_for) {
    struct app *app = started_bridge();
    CHECK(app != NULL);
    if (!app) return;
    /* Ten messages, one per minute, before anyone connects. */
    for (int i = 0; i < 10; i++) {
        char body[64];
        snprintf(body, sizeof(body), "line %d", i);
        seed_history(app, "#sniffo", "alice", 100 + i, 1753776000000L + i * 60000L, body);
    }
    seed_history(app, "bob", "bob", 200, 1753776600000L, "a private word");

    int fd = bridge_connect(app);
    CHECK(fd >= 0);
    if (fd < 0) return;
    char out[65536];
    client_send(fd, "CAP LS");
    client_send(fd, "CAP REQ :server-time message-tags batch draft/chathistory");
    client_send(fd, "PASS azzurra");
    client_send(fd, "NICK vjt");
    client_send(fd, "USER u 0 * :r");
    client_send(fd, "CAP END");
    client_drain(app, fd, out, sizeof(out));
    CHECK(strstr(out, "ACK :server-time message-tags batch draft/chathistory") != NULL);
    CHECK(strstr(out, "draft/chathistory") != NULL);

    /* LATEST 3: the last three, in the order a client renders them. */
    client_send(fd, "CHATHISTORY LATEST #sniffo * 3");
    client_drain(app, fd, out, sizeof(out));
    CHECK(strstr(out, "BATCH +") != NULL);
    CHECK(strstr(out, "chathistory #sniffo") != NULL);
    CHECK(strstr(out, "line 7") != NULL);
    CHECK(strstr(out, "line 9") != NULL);
    CHECK(strstr(out, "line 6") == NULL);
    const char *seven = strstr(out, "line 7");
    const char *nine = strstr(out, "line 9");
    CHECK(seven && nine && seven < nine); /* oldest first */
    CHECK(strstr(out, "BATCH -") != NULL);
    /* Tagged with the id the client can point back at. */
    CHECK(strstr(out, "msgid=109") != NULL);

    /* BEFORE a message id: what came earlier, not what came after. */
    client_send(fd, "CHATHISTORY BEFORE #sniffo msgid=103 2");
    client_drain(app, fd, out, sizeof(out));
    CHECK(strstr(out, "line 1") != NULL);
    CHECK(strstr(out, "line 2") != NULL);
    CHECK(strstr(out, "line 3") == NULL);
    CHECK(strstr(out, "line 0") == NULL); /* the limit drops the oldest */

    /* AFTER a timestamp. */
    client_send(fd, "CHATHISTORY AFTER #sniffo timestamp=2025-07-29T08:07:00.000Z 5");
    client_drain(app, fd, out, sizeof(out));
    CHECK(strstr(out, "line 8") != NULL);
    CHECK(strstr(out, "line 9") != NULL);
    CHECK(strstr(out, "line 7") == NULL);

    /* BETWEEN two points, exclusive of both. */
    client_send(fd, "CHATHISTORY BETWEEN #sniffo msgid=102 msgid=105 10");
    client_drain(app, fd, out, sizeof(out));
    CHECK(strstr(out, "line 3") != NULL);
    CHECK(strstr(out, "line 4") != NULL);
    CHECK(strstr(out, "line 2") == NULL);
    CHECK(strstr(out, "line 5") == NULL);

    /* AROUND: some either side of the point. */
    client_send(fd, "CHATHISTORY AROUND #sniffo msgid=105 4");
    client_drain(app, fd, out, sizeof(out));
    CHECK(strstr(out, "line 3") != NULL);
    CHECK(strstr(out, "line 5") != NULL);
    CHECK(strstr(out, "line 0") == NULL);

    /* Another channel's history is not this channel's. */
    client_send(fd, "CHATHISTORY LATEST #sniffo * 50");
    client_drain(app, fd, out, sizeof(out));
    CHECK(strstr(out, "a private word") == NULL);
    /* A DM is a target like any other. */
    client_send(fd, "CHATHISTORY LATEST bob * 50");
    client_drain(app, fd, out, sizeof(out));
    CHECK(strstr(out, "a private word") != NULL);

    /* TARGETS says who there is history WITH, which is how a client
     * decides what to ask about next. */
    client_send(fd, "CHATHISTORY TARGETS timestamp=2020-01-01T00:00:00.000Z "
                    "timestamp=2030-01-01T00:00:00.000Z 20");
    client_drain(app, fd, out, sizeof(out));
    CHECK(strstr(out, "CHATHISTORY TARGETS #sniffo") != NULL);
    CHECK(strstr(out, "CHATHISTORY TARGETS bob") != NULL);

    /* A selector that cannot be read is refused, not guessed at. */
    client_send(fd, "CHATHISTORY BEFORE #sniffo timestamp=yesterday 5");
    client_drain(app, fd, out, sizeof(out));
    CHECK(strstr(out, "FAIL CHATHISTORY INVALID_PARAMS") != NULL);
    client_send(fd, "CHATHISTORY LATEST");
    client_drain(app, fd, out, sizeof(out));
    CHECK(strstr(out, "FAIL CHATHISTORY NEED_MORE_PARAMS") != NULL);

    close(fd);
    ircd_stop(app);
    for (size_t i = 0; i < app->log_count; i++) free(app->log[i]);
    free(app);
}

/* With --ircd-archive, a request the session's own history cannot fill
 * becomes a query against grappa — addressed to the client that asked,
 * and to the network THAT connection chose. */
TEST(archive_mode_asks_grappa_only_when_the_ring_falls_short) {
    struct app *app = started_bridge();
    CHECK(app != NULL);
    if (!app) return;
    app->ircd.archive = true;
    for (int i = 0; i < 4; i++) {
        char body[64];
        snprintf(body, sizeof(body), "line %d", i);
        seed_history(app, "#sniffo", "alice", 100 + i, 1753776000000L + i * 60000L, body);
    }
    int fd = bridge_connect(app);
    CHECK(fd >= 0);
    if (fd < 0) return;
    char out[65536];
    client_send(fd, "PASS azzurra");
    client_send(fd, "NICK vjt");
    client_send(fd, "USER u 0 * :r");
    client_drain(app, fd, out, sizeof(out));

    /* Four in the ring and three asked for: answered here, no query. */
    size_t before = app->jobs_tail;
    client_send(fd, "CHATHISTORY LATEST #sniffo * 3");
    client_drain(app, fd, out, sizeof(out));
    CHECK_LONG(app->jobs_tail, before);
    CHECK(strstr(out, "line 3") != NULL);

    /* Ten asked for and four to give: grappa is asked for the rest, and
     * nothing is sent from the ring — one answer, from one source. */
    client_send(fd, "CHATHISTORY LATEST #sniffo * 10");
    client_drain(app, fd, out, sizeof(out));
    CHECK_LONG(app->jobs_tail, before + 1);
    CHECK_LONG(app->jobs[before].kind, JOB_CHATHISTORY);
    CHECK_STR(app->jobs[before].network, "azzurra");
    CHECK_STR(app->jobs[before].channel, "#sniffo");
    CHECK(strstr(out, "BATCH") == NULL);

    /* A msgid selector IS grappa's page cursor, so BEFORE goes over
     * verbatim rather than being approximated. */
    client_send(fd, "CHATHISTORY BEFORE #sniffo msgid=100 50");
    client_drain(app, fd, out, sizeof(out));
    CHECK_LONG(app->jobs_tail, before + 2);
    CHECK(strstr(app->jobs[before + 1].arg1, "before 100") != NULL);

    /* The reply is addressed to the client that asked: the id in the
     * job is this connection's, and it is never reused. */
    unsigned long asked_by = strtoul(app->jobs[before + 1].arg1, NULL, 10);
    CHECK(asked_by > 0);
    pthread_mutex_lock(&app->ircd.lock);
    bool matches = false;
    for (size_t i = 0; i < IRCD_MAX_CLIENTS; i++)
        if (app->ircd.clients[i].fd >= 0 && app->ircd.clients[i].id == asked_by) matches = true;
    pthread_mutex_unlock(&app->ircd.lock);
    CHECK(matches);

    /* Without the flag the same request stays local, however short the
     * answer: reaching into the archive is opt-in. */
    app->ircd.archive = false;
    size_t quiet = app->jobs_tail;
    client_send(fd, "CHATHISTORY LATEST #sniffo * 100");
    client_drain(app, fd, out, sizeof(out));
    CHECK_LONG(app->jobs_tail, quiet);
    CHECK(strstr(out, "line 0") != NULL);

    close(fd);
    ircd_stop(app);
    for (size_t i = 0; i < app->log_count; i++) free(app->log[i]);
    free(app);
}

int main(void) {
    test_use_temp_home();

    RUN(bind_spec_reads_ports_addresses_and_both_families);
    RUN(loopback_is_the_whole_127_block_and_the_v6_one);
    RUN(client_lines_parse_into_command_and_params);
    RUN(pass_names_the_network_or_is_only_a_password);
    RUN(a_body_cannot_become_a_second_protocol_line);
    RUN(names_fold_the_way_the_ircd_folds_them);
    RUN(sigils_follow_the_multi_prefix_the_client_asked_for);
    RUN(server_time_is_tagged_only_when_asked_for);
    RUN(selectors_name_a_point_in_the_conversation);
    RUN(tags_are_built_as_one_prefix_or_not_at_all);
    RUN(a_client_registers_and_is_shown_the_session_it_joined);
    RUN(messages_cross_the_bridge_in_both_directions);
    RUN(echo_message_turns_our_own_lines_back_on);
    RUN(a_late_client_is_given_the_conversation_it_missed);
    RUN(an_unknown_network_is_refused_with_the_list);
    RUN(a_bad_password_is_told_nothing_about_the_account);
    RUN(a_reachable_bind_without_a_password_refuses_to_start);
    RUN(unknown_commands_are_forwarded_in_the_clients_own_words);
    RUN(chathistory_returns_the_slice_that_was_asked_for);
    RUN(archive_mode_asks_grappa_only_when_the_ring_falls_short);
    return test_report();
}
