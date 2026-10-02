/* test_wire.c — wire narrowing.
 *
 * Two things are being asserted throughout:
 *   1. A valid payload narrows to the right typed values.
 *   2. A payload missing a required field, or carrying one of the wrong
 *      type, is REJECTED as a unit — not half-applied.
 *
 * (2) is why the narrower exists, so it gets equal weight. Where the
 * server contract deliberately tolerates a missing/garbled field (badge
 * counts, lusers counts, host aliases), the test pins the tolerance so a
 * later "tightening" can't silently drop a load-bearing payload.
 */
#include "../wire.h"
#include "test.h"

#include <stdlib.h>

/* Narrow a JSON literal. Returns the doc (caller frees) or NULL; `ok`
 * reports whether narrowing succeeded. */
static json_doc *narrow(const char *text, struct wire_event *ev, bool *ok) {
    char err[160];
    json_doc *d = json_parse(text, strlen(text), err, sizeof(err));
    if (!d) {
        fprintf(stderr, "  (test JSON did not parse: %s)\n", err);
        *ok = false;
        return NULL;
    }
    *ok = wire_narrow(json_root(d), ev);
    return d;
}

/* Assert a payload is rejected. */
static void reject(const char *text) {
    struct wire_event ev;
    bool ok = false;
    json_doc *d = narrow(text, &ev, &ok);
    test_checks++;
    if (ok) {
        test_failures++;
        fprintf(stderr, "FAIL [%s] expected rejection, narrowed as %s: %s\n", test_current,
                wire_kind_name(ev.kind), text);
    }
    json_free(d);
}

#define MSG_OK                                                                                     \
    "{\"kind\":\"message\",\"message\":{\"id\":7,\"network\":\"azz\",\"channel\":\"#dev\","         \
    "\"server_time\":1753500000,\"kind\":\"privmsg\",\"sender\":\"bob\",\"body\":\"hi\","           \
    "\"meta\":{}}}"

TEST(message) {
    struct wire_event ev;
    bool ok;
    json_doc *d = narrow(MSG_OK, &ev, &ok);
    CHECK(ok);
    CHECK(ev.kind == WIRE_MESSAGE);
    CHECK_LONG(ev.u.message.id, 7);
    CHECK_STR(ev.u.message.network, "azz");
    CHECK_STR(ev.u.message.channel, "#dev");
    CHECK_LONG(ev.u.message.server_time, 1753500000);
    CHECK(ev.u.message.kind == MSG_PRIVMSG);
    CHECK_STR(ev.u.message.sender, "bob");
    CHECK_STR(ev.u.message.body, "hi");
    json_free(d);

    /* body is nullable — a JOIN row carries no body. */
    d = narrow("{\"kind\":\"message\",\"message\":{\"id\":8,\"network\":\"azz\","
               "\"channel\":\"#dev\",\"server_time\":1,\"kind\":\"join\",\"sender\":\"bob\","
               "\"body\":null,\"meta\":{}}}",
               &ev, &ok);
    CHECK(ok);
    CHECK(ev.u.message.body == NULL);
    CHECK(ev.u.message.kind == MSG_JOIN);
    json_free(d);

    /* dm_with (protocol 36) is optional: absent from a server that predates
     * it, null off a DM, the peer on a DM row. Absent and null both narrow
     * to NULL, which is what sends render_message to its fallback. */
    d = narrow(MSG_OK, &ev, &ok);
    CHECK(ok);
    CHECK(ev.u.message.dm_with == NULL);
    json_free(d);
    d = narrow("{\"kind\":\"message\",\"message\":{\"id\":9,\"network\":\"azz\","
               "\"channel\":\"vjt\",\"server_time\":1,\"kind\":\"privmsg\",\"sender\":\"bob\","
               "\"body\":\"hi\",\"meta\":{},\"dm_with\":\"bob\"}}",
               &ev, &ok);
    CHECK(ok);
    CHECK_STR(ev.u.message.dm_with, "bob");
    json_free(d);
    d = narrow("{\"kind\":\"message\",\"message\":{\"id\":10,\"network\":\"azz\","
               "\"channel\":\"#dev\",\"server_time\":1,\"kind\":\"privmsg\",\"sender\":\"bob\","
               "\"body\":\"hi\",\"meta\":{},\"dm_with\":null}}",
               &ev, &ok);
    CHECK(ok);
    CHECK(ev.u.message.dm_with == NULL);
    json_free(d);
}

TEST(message_rejects_bad_shapes) {
    /* Missing each required field in turn. */
    reject("{\"kind\":\"message\",\"message\":{\"network\":\"a\",\"channel\":\"#c\","
           "\"server_time\":1,\"kind\":\"privmsg\",\"sender\":\"s\",\"body\":\"b\",\"meta\":{}}}");
    reject("{\"kind\":\"message\",\"message\":{\"id\":1,\"channel\":\"#c\",\"server_time\":1,"
           "\"kind\":\"privmsg\",\"sender\":\"s\",\"body\":\"b\",\"meta\":{}}}");
    reject("{\"kind\":\"message\",\"message\":{\"id\":1,\"network\":\"a\",\"channel\":\"#c\","
           "\"server_time\":1,\"kind\":\"privmsg\",\"sender\":\"s\",\"body\":\"b\"}}");
    /* id as a string, not a number. */
    reject("{\"kind\":\"message\",\"message\":{\"id\":\"1\",\"network\":\"a\",\"channel\":\"#c\","
           "\"server_time\":1,\"kind\":\"privmsg\",\"sender\":\"s\",\"body\":\"b\",\"meta\":{}}}");
    /* A kind outside the closed set must not pass as an untyped string. */
    reject("{\"kind\":\"message\",\"message\":{\"id\":1,\"network\":\"a\",\"channel\":\"#c\","
           "\"server_time\":1,\"kind\":\"telepathy\",\"sender\":\"s\",\"body\":\"b\","
           "\"meta\":{}}}");
    /* meta must be an object, not null. */
    reject("{\"kind\":\"message\",\"message\":{\"id\":1,\"network\":\"a\",\"channel\":\"#c\","
           "\"server_time\":1,\"kind\":\"privmsg\",\"sender\":\"s\",\"body\":\"b\","
           "\"meta\":null}}");
    /* dm_with present must be a string. */
    reject("{\"kind\":\"message\",\"message\":{\"id\":1,\"network\":\"a\",\"channel\":\"#c\","
           "\"server_time\":1,\"kind\":\"privmsg\",\"sender\":\"s\",\"body\":\"b\","
           "\"meta\":{},\"dm_with\":7}}");
    /* No message object at all. */
    reject("{\"kind\":\"message\"}");
}

TEST(every_message_kind_round_trips) {
    const char *kinds[] = {"privmsg", "notice", "action",      "join",  "part",  "quit",
                           "nick_change", "mode", "topic", "kick", "server_event"};
    for (size_t i = 0; i < sizeof(kinds) / sizeof(kinds[0]); i++) {
        char buf[512];
        snprintf(buf, sizeof(buf),
                 "{\"kind\":\"message\",\"message\":{\"id\":1,\"network\":\"a\","
                 "\"channel\":\"#c\",\"server_time\":1,\"kind\":\"%s\",\"sender\":\"s\","
                 "\"body\":null,\"meta\":{}}}",
                 kinds[i]);
        struct wire_event ev;
        bool ok;
        json_doc *d = narrow(buf, &ev, &ok);
        CHECK(ok);
        CHECK_STR(wire_message_kind_name(ev.u.message.kind), kinds[i]);
        json_free(d);
    }
}

TEST(window_state) {
    struct wire_event ev;
    bool ok;
    json_doc *d = narrow("{\"kind\":\"joined\",\"network\":\"azz\",\"channel\":\"#dev\","
                         "\"state\":\"joined\"}",
                         &ev, &ok);
    CHECK(ok);
    CHECK(ev.kind == WIRE_JOINED);
    CHECK_STR(ev.u.window_state.channel, "#dev");
    json_free(d);

    d = narrow("{\"kind\":\"kicked\",\"network\":\"azz\",\"channel\":\"#dev\","
               "\"state\":\"kicked\",\"by\":\"op\",\"reason\":\"bye\"}",
               &ev, &ok);
    CHECK(ok);
    CHECK(ev.kind == WIRE_KICKED);
    CHECK_STR(ev.u.window_state.by, "op");
    CHECK_STR(ev.u.window_state.reason, "bye");
    json_free(d);

    /* A kick with no reason given — both nullable fields absent. */
    d = narrow("{\"kind\":\"kicked\",\"network\":\"azz\",\"channel\":\"#dev\","
               "\"state\":\"kicked\",\"by\":null,\"reason\":null}",
               &ev, &ok);
    CHECK(ok);
    CHECK(ev.u.window_state.by == NULL);
    CHECK(ev.u.window_state.reason == NULL);
    json_free(d);

    /* The `state` discriminant must agree with `kind` — a mismatched pair
     * is a server bug and must not be quietly accepted. */
    reject("{\"kind\":\"joined\",\"network\":\"a\",\"channel\":\"#c\",\"state\":\"kicked\"}");
    reject("{\"kind\":\"kicked\",\"network\":\"a\",\"channel\":\"#c\",\"state\":\"joined\"}");
}

/* Regression pin for cic's S13: `numeric` is legitimately null when the
 * failing numeric was never recorded. Requiring it once dropped the whole
 * reconnect "failed tab" snapshot. */
TEST(join_failed_tolerates_null_numeric) {
    struct wire_event ev;
    bool ok;
    json_doc *d = narrow("{\"kind\":\"join_failed\",\"network\":\"azz\",\"channel\":\"#dev\","
                         "\"state\":\"failed\",\"reason\":\"+i\",\"numeric\":473}",
                         &ev, &ok);
    CHECK(ok);
    CHECK(ev.u.window_state.has_numeric);
    CHECK_LONG(ev.u.window_state.numeric, 473);
    CHECK_STR(ev.u.window_state.reason, "+i");
    json_free(d);

    d = narrow("{\"kind\":\"join_failed\",\"network\":\"azz\",\"channel\":\"#dev\","
               "\"state\":\"failed\",\"reason\":null,\"numeric\":null}",
               &ev, &ok);
    CHECK(ok); /* must NOT drop */
    CHECK(!ev.u.window_state.has_numeric);
    CHECK(ev.u.window_state.reason == NULL);
    json_free(d);
}

TEST(members_seeded) {
    struct wire_event ev;
    bool ok;
    json_doc *d = narrow("{\"kind\":\"members_seeded\",\"network\":\"azz\",\"channel\":\"#dev\","
                         "\"members\":[{\"nick\":\"alice\",\"modes\":[\"o\"]},"
                         "{\"nick\":\"bob\",\"modes\":[]}]}",
                         &ev, &ok);
    CHECK(ok);
    CHECK_LONG(ev.u.members_seeded.member_count, 2);
    struct wire_member m;
    CHECK(wire_member_at(ev.u.members_seeded.members, 0, &m));
    CHECK_STR(m.nick, "alice");
    CHECK_LONG(m.mode_count, 1);
    CHECK_STR(wire_string_at(m.modes, 0), "o");
    CHECK(wire_member_at(ev.u.members_seeded.members, 1, &m));
    CHECK_STR(m.nick, "bob");
    CHECK_LONG(m.mode_count, 0);
    CHECK(!wire_member_at(ev.u.members_seeded.members, 2, &m));
    json_free(d);

    /* An empty roster is valid. */
    d = narrow("{\"kind\":\"members_seeded\",\"network\":\"a\",\"channel\":\"#c\",\"members\":[]}",
               &ev, &ok);
    CHECK(ok);
    CHECK_LONG(ev.u.members_seeded.member_count, 0);
    json_free(d);

    /* ONE malformed element drops the WHOLE payload — a half-typed roster
     * is worse than none. */
    reject("{\"kind\":\"members_seeded\",\"network\":\"a\",\"channel\":\"#c\","
           "\"members\":[{\"nick\":\"ok\",\"modes\":[]},{\"modes\":[]}]}");
    reject("{\"kind\":\"members_seeded\",\"network\":\"a\",\"channel\":\"#c\","
           "\"members\":[{\"nick\":\"ok\",\"modes\":[7]}]}");
    reject("{\"kind\":\"members_seeded\",\"network\":\"a\",\"channel\":\"#c\","
           "\"members\":\"notanarray\"}");
}

TEST(topic_changed) {
    struct wire_event ev;
    bool ok;
    json_doc *d = narrow("{\"kind\":\"topic_changed\",\"network\":\"azz\",\"channel\":\"#dev\","
                         "\"topic\":{\"text\":\"hi\",\"set_by\":\"op\",\"set_at\":\"2026-07-26\"}}",
                         &ev, &ok);
    CHECK(ok);
    CHECK_STR(ev.u.topic_changed.text, "hi");
    CHECK_STR(ev.u.topic_changed.set_by, "op");
    json_free(d);

    /* A cleared topic is all-null, and must still narrow. */
    d = narrow("{\"kind\":\"topic_changed\",\"network\":\"a\",\"channel\":\"#c\","
               "\"topic\":{\"text\":null,\"set_by\":null,\"set_at\":null}}",
               &ev, &ok);
    CHECK(ok);
    CHECK(ev.u.topic_changed.text == NULL);
    json_free(d);

    reject("{\"kind\":\"topic_changed\",\"network\":\"a\",\"channel\":\"#c\"}");
    reject("{\"kind\":\"topic_changed\",\"network\":\"a\",\"channel\":\"#c\",\"topic\":\"str\"}");
}

TEST(read_cursor_and_counts) {
    struct wire_event ev;
    bool ok;
    json_doc *d = narrow("{\"kind\":\"read_cursor_set\",\"last_read_message_id\":42,"
                         "\"badge_count\":3}",
                         &ev, &ok);
    CHECK(ok);
    CHECK_LONG(ev.u.read_cursor.last_read_message_id, 42);
    CHECK_LONG(ev.u.read_cursor.badge_count, 3);
    json_free(d);

    /* A server that omits badge_count must NOT drop the cursor sync —
     * the cursor is the load-bearing half of this event. */
    d = narrow("{\"kind\":\"read_cursor_set\",\"last_read_message_id\":42}", &ev, &ok);
    CHECK(ok);
    CHECK_LONG(ev.u.read_cursor.badge_count, 0);
    json_free(d);
    reject("{\"kind\":\"read_cursor_set\"}");

    /* Severity atoms are SINGULAR on the server (`:mention`, `:message`,
     * `:event`, `:none`) even though the sibling count fields are plural.
     * Pinning all four so the transcription can't drift. */
    d = narrow("{\"kind\":\"window_counts\",\"channel\":\"#dev\",\"messages\":5,\"mentions\":2,"
               "\"events\":1,\"severity\":\"mention\"}",
               &ev, &ok);
    CHECK(ok);
    CHECK_LONG(ev.u.window_counts.messages, 5);
    CHECK(ev.u.window_counts.severity == COUNTS_MENTION);
    json_free(d);

    const char *sev[] = {"mention", "message", "event", "none"};
    wire_counts_severity expect[] = {COUNTS_MENTION, COUNTS_MESSAGE, COUNTS_EVENT, COUNTS_NONE};
    for (size_t i = 0; i < 4; i++) {
        char buf[256];
        snprintf(buf, sizeof(buf),
                 "{\"kind\":\"window_counts\",\"channel\":\"#d\",\"messages\":0,\"mentions\":0,"
                 "\"events\":0,\"severity\":\"%s\"}",
                 sev[i]);
        json_doc *sd = narrow(buf, &ev, &ok);
        CHECK(ok);
        CHECK(ev.u.window_counts.severity == expect[i]);
        json_free(sd);
    }

    /* Unknown severity degrades to none rather than dropping the counts. */
    d = narrow("{\"kind\":\"window_counts\",\"channel\":\"#d\",\"messages\":1,\"mentions\":0,"
               "\"events\":0,\"severity\":\"catastrophic\"}",
               &ev, &ok);
    CHECK(ok);
    CHECK(ev.u.window_counts.severity == COUNTS_NONE);
    json_free(d);
    reject("{\"kind\":\"window_counts\",\"channel\":\"#d\",\"messages\":1,\"mentions\":0}");
}

TEST(whois_bundle) {
    struct wire_event ev;
    bool ok;
    json_doc *d = narrow(
        "{\"kind\":\"whois_bundle\",\"network\":\"azz\",\"target\":\"bob\",\"user\":\"b\","
        "\"host\":\"h.example\",\"realname\":\"Bob\",\"server\":\"irc.example\","
        "\"server_info\":\"hub\",\"is_operator\":true,\"oper_text\":\"an IRC op\","
        "\"idle_seconds\":90,\"signon\":1753500000,\"channels\":[\"@#dev\",\"#chat\"],"
        "\"using_ssl\":true,\"is_registered\":true,\"is_admin\":false,"
        "\"is_services_admin\":false,\"is_helper\":false,\"is_chanop\":false,"
        "\"is_agent\":false,\"is_java\":false,\"umodes\":\"+iw\",\"away_message\":null,"
        "\"actually_host\":null,\"actually_ip\":null,\"account\":\"bob\",\"secure\":true,"
        "\"secure_cipher\":\"TLSv1.3\",\"certfp\":null,"
        "\"extra_lines\":[{\"numeric\":320,\"text\":\"is a bot\"}]}",
        &ev, &ok);
    CHECK(ok);
    CHECK(ev.kind == WIRE_WHOIS_BUNDLE);
    CHECK_STR(ev.u.whois.target, "bob");
    CHECK_STR(ev.u.whois.oper_text, "an IRC op");
    CHECK(ev.u.whois.is_operator);
    CHECK(!ev.u.whois.is_admin);
    CHECK(ev.u.whois.has_idle);
    CHECK_LONG(ev.u.whois.idle_seconds, 90);
    CHECK(ev.u.whois.has_channels);
    CHECK_LONG(ev.u.whois.channel_count, 2);
    CHECK_STR(wire_string_at(ev.u.whois.channels, 0), "@#dev");
    CHECK(ev.u.whois.away_message == NULL);
    CHECK_STR(ev.u.whois.account, "bob");
    CHECK_LONG(ev.u.whois.extra_count, 1);
    struct wire_whois_extra x;
    CHECK(wire_whois_extra_at(ev.u.whois.extra_lines, 0, &x));
    CHECK_LONG(x.numeric, 320);
    CHECK_STR(x.text, "is a bot");
    json_free(d);
}

TEST(whois_minimal_and_rejects) {
    /* Every numeric-derived field nullable; only network + target and the
     * boolean flags are required. A hidden-channels WHOIS sends null. */
    struct wire_event ev;
    bool ok;
    json_doc *d = narrow(
        "{\"kind\":\"whois_bundle\",\"network\":\"azz\",\"target\":\"ghost\",\"user\":null,"
        "\"host\":null,\"realname\":null,\"server\":null,\"server_info\":null,"
        "\"is_operator\":false,\"oper_text\":null,\"idle_seconds\":null,\"signon\":null,"
        "\"channels\":null,\"using_ssl\":false,\"is_registered\":false,\"is_admin\":false,"
        "\"is_services_admin\":false,\"is_helper\":false,\"is_chanop\":false,"
        "\"is_agent\":false,\"is_java\":false,\"umodes\":null,\"away_message\":null,"
        "\"actually_host\":null,\"actually_ip\":null,\"account\":null,\"secure\":false,"
        "\"secure_cipher\":null,\"certfp\":null,\"extra_lines\":null}",
        &ev, &ok);
    CHECK(ok);
    CHECK(!ev.u.whois.has_channels);
    CHECK(!ev.u.whois.has_idle);
    CHECK_LONG(ev.u.whois.extra_count, 0);
    json_free(d);

    /* A missing boolean flag DEFAULTS to false rather than dropping the
     * bundle. The server emits them all today (false when the numeric
     * did not fire), but the wire is additive-only and a client must
     * survive a field it does not get: requiring them meant one absent
     * flag threw away a whole WHOIS, which reads to the user as the
     * command having done nothing at all. Network and target are still
     * required — without them there is nothing to show. */
    {
        struct wire_event bare;
        bool bare_ok;
        json_doc *bd =
            narrow("{\"kind\":\"whois_bundle\",\"network\":\"a\",\"target\":\"t\"}", &bare,
                   &bare_ok);
        CHECK(bare_ok);
        CHECK_STR(bare.u.whois.target, "t");
        CHECK(!bare.u.whois.is_operator);
        CHECK(!bare.u.whois.secure);
        json_free(bd);
    }
    reject("{\"kind\":\"whois_bundle\",\"network\":\"a\"}");
    /* A non-string element in `channels` drops the whole bundle. */
    reject("{\"kind\":\"whois_bundle\",\"network\":\"a\",\"target\":\"t\",\"user\":null,"
           "\"host\":null,\"realname\":null,\"server\":null,\"server_info\":null,"
           "\"is_operator\":false,\"oper_text\":null,\"idle_seconds\":null,\"signon\":null,"
           "\"channels\":[\"#ok\",42],\"using_ssl\":false,\"is_registered\":false,"
           "\"is_admin\":false,\"is_services_admin\":false,\"is_helper\":false,"
           "\"is_chanop\":false,\"is_agent\":false,\"is_java\":false,\"umodes\":null,"
           "\"away_message\":null,\"actually_host\":null,\"actually_ip\":null,"
           "\"account\":null,\"secure\":false,\"secure_cipher\":null,\"certfp\":null}");
}

TEST(who_reply) {
    struct wire_event ev;
    bool ok;
    json_doc *d = narrow("{\"kind\":\"who_reply\",\"network\":\"azz\",\"target\":\"#dev\","
                         "\"users\":[{\"nick\":\"a\",\"user\":\"u\",\"host\":\"h\","
                         "\"server\":\"s\",\"modes\":\"H@\",\"channel\":\"#dev\",\"hops\":0,"
                         "\"realname\":\"A\"}]}",
                         &ev, &ok);
    CHECK(ok);
    CHECK_LONG(ev.u.who_reply.user_count, 1);
    struct wire_who_user u;
    CHECK(wire_who_user_at(ev.u.who_reply.users, 0, &u));
    CHECK_STR(u.nick, "a");
    CHECK_STR(u.modes, "H@");
    CHECK(u.has_hops);
    CHECK_LONG(u.hops, 0);
    CHECK_STR(u.realname, "A");
    json_free(d);

    /* RFC-violating servers omit the trailing field: hops/realname null. */
    d = narrow("{\"kind\":\"who_reply\",\"network\":\"a\",\"target\":\"#c\","
               "\"users\":[{\"nick\":\"a\",\"user\":\"u\",\"host\":\"h\",\"server\":\"s\","
               "\"modes\":\"H\",\"channel\":\"#c\",\"hops\":null,\"realname\":null}]}",
               &ev, &ok);
    CHECK(ok);
    CHECK(wire_who_user_at(ev.u.who_reply.users, 0, &u));
    CHECK(!u.has_hops);
    CHECK(u.realname == NULL);
    json_free(d);

    reject("{\"kind\":\"who_reply\",\"network\":\"a\",\"target\":\"#c\","
           "\"users\":[{\"nick\":\"a\"}]}");
}

TEST(lusers_tolerates_garbled_counts) {
    struct wire_event ev;
    bool ok;
    json_doc *d = narrow("{\"kind\":\"lusers_bundle\",\"network\":\"azz\",\"total_users\":100,"
                         "\"invisible\":20,\"servers\":2,\"operators\":1,"
                         "\"unknown_connections\":null,\"channels_formed\":50,"
                         "\"local_clients\":10,\"local_servers\":1,\"current_local\":10,"
                         "\"max_local\":20,\"current_global\":100,\"max_global\":200}",
                         &ev, &ok);
    CHECK(ok);
    CHECK(ev.u.lusers.has[LUSERS_TOTAL_USERS]);
    CHECK_LONG(ev.u.lusers.total_users, 100);
    /* 253 RPL_LUSERUNKNOWN is optional — null is normal, not a failure. */
    CHECK(!ev.u.lusers.has[LUSERS_UNKNOWN_CONNECTIONS]);
    CHECK(ev.u.lusers.has[LUSERS_MAX_GLOBAL]);
    CHECK_LONG(ev.u.lusers.max_global, 200);
    json_free(d);

    /* One garbled count must render as "—", NOT blow away the good ones.
     * This is a display-only card; whole-payload rejection would be worse. */
    d = narrow("{\"kind\":\"lusers_bundle\",\"network\":\"azz\",\"total_users\":\"lots\","
               "\"servers\":2}",
               &ev, &ok);
    CHECK(ok);
    CHECK(!ev.u.lusers.has[LUSERS_TOTAL_USERS]);
    CHECK(ev.u.lusers.has[LUSERS_SERVERS]);
    CHECK_LONG(ev.u.lusers.servers, 2);
    json_free(d);

    /* network is still required. */
    reject("{\"kind\":\"lusers_bundle\",\"total_users\":1}");
}

TEST(banlist_and_links) {
    struct wire_event ev;
    bool ok;
    json_doc *d = narrow("{\"kind\":\"banlist_bundle\",\"network\":\"azz\",\"channel\":\"#dev\","
                         "\"entries\":[{\"mask\":\"*!*@bad.host\",\"setter\":\"op\","
                         "\"set_ts\":\"1753500000\"},{\"mask\":\"x!*@*\",\"setter\":null,"
                         "\"set_ts\":null}]}",
                         &ev, &ok);
    CHECK(ok);
    CHECK_LONG(ev.u.banlist.entry_count, 2);
    struct wire_banlist_entry b;
    CHECK(wire_banlist_entry_at(ev.u.banlist.entries, 0, &b));
    CHECK_STR(b.mask, "*!*@bad.host");
    CHECK_STR(b.setter, "op");
    CHECK(wire_banlist_entry_at(ev.u.banlist.entries, 1, &b));
    CHECK(b.setter == NULL);
    json_free(d);
    reject("{\"kind\":\"banlist_bundle\",\"network\":\"a\",\"channel\":\"#c\","
           "\"entries\":[{\"setter\":\"op\"}]}");

    d = narrow("{\"kind\":\"links_bundle\",\"network\":\"azz\","
               "\"entries\":[{\"server\":\"hub.example\",\"linked_to\":null,\"hopcount\":0,"
               "\"description\":\"the hub\"}]}",
               &ev, &ok);
    CHECK(ok);
    CHECK_LONG(ev.u.links.entry_count, 1);
    struct wire_links_entry l;
    CHECK(wire_links_entry_at(ev.u.links.entries, 0, &l));
    CHECK_STR(l.server, "hub.example");
    CHECK(l.linked_to == NULL);
    CHECK(l.has_hopcount);
    json_free(d);

    /* An EMPTY topology is the restricted/hidden signal, not malformed. */
    d = narrow("{\"kind\":\"links_bundle\",\"network\":\"azz\",\"entries\":[]}", &ev, &ok);
    CHECK(ok);
    CHECK_LONG(ev.u.links.entry_count, 0);
    json_free(d);
}

TEST(server_reply) {
    /* The server's closed set, all four. `admin` was missing here and
     * in wire.c, and this test asserted the omission — so every /admin
     * reply was dropped and the suite called that correct. */
    const char *sources[] = {"info", "version", "motd", "admin"};
    wire_reply_source expect[] = {REPLY_INFO, REPLY_VERSION, REPLY_MOTD, REPLY_ADMIN};
    for (size_t i = 0; i < sizeof(sources) / sizeof(sources[0]); i++) {
        char buf[256];
        snprintf(buf, sizeof(buf),
                 "{\"kind\":\"server_reply\",\"network\":\"a\",\"source\":\"%s\","
                 "\"lines\":[\"one\",\"two\"]}",
                 sources[i]);
        struct wire_event ev;
        bool ok;
        json_doc *d = narrow(buf, &ev, &ok);
        CHECK(ok);
        CHECK(ev.u.server_reply.source == expect[i]);
        CHECK_LONG(ev.u.server_reply.line_count, 2);
        CHECK_STR(wire_string_at(ev.u.server_reply.lines, 1), "two");
        json_free(d);
    }
    /* Source outside the closed set is rejected, not tolerated. */
    reject("{\"kind\":\"server_reply\",\"network\":\"a\",\"source\":\"stats\",\"lines\":[]}");
    reject("{\"kind\":\"server_reply\",\"network\":\"a\",\"source\":\"motd\",\"lines\":[1]}");
}

TEST(presence) {
    struct wire_event ev;
    bool ok;
    json_doc *d = narrow("{\"kind\":\"presence_changed\",\"network_id\":3,\"nick\":\"bob\","
                         "\"presence\":\"online\",\"initial\":false,\"source\":\"monitor\","
                         "\"ts\":\"2026-07-26T00:00:00Z\"}",
                         &ev, &ok);
    CHECK(ok);
    CHECK_LONG(ev.u.presence_changed.network_id, 3);
    CHECK(ev.u.presence_changed.online);
    CHECK(ev.u.presence_changed.from_monitor);
    CHECK(!ev.u.presence_changed.initial);
    json_free(d);

    reject("{\"kind\":\"presence_changed\",\"network_id\":3,\"nick\":\"b\",\"presence\":\"maybe\","
           "\"initial\":false,\"source\":\"monitor\",\"ts\":\"t\"}");
    reject("{\"kind\":\"presence_changed\",\"network_id\":3,\"nick\":\"b\",\"presence\":\"online\","
           "\"initial\":false,\"source\":\"telepathy\",\"ts\":\"t\"}");

    d = narrow("{\"kind\":\"presence_snapshot\",\"network_id\":3,"
               "\"nicks\":{\"alice\":\"online\",\"bob\":\"offline\",\"carol\":\"unknown\"}}",
               &ev, &ok);
    CHECK(ok);
    CHECK_LONG(ev.u.presence_snapshot.nick_count, 3);
    const char *nick = NULL;
    wire_presence pr;
    CHECK(wire_presence_at(ev.u.presence_snapshot.nicks, 0, &nick, &pr));
    CHECK_STR(nick, "alice");
    CHECK(pr == PRESENCE_ONLINE);
    CHECK(wire_presence_at(ev.u.presence_snapshot.nicks, 2, &nick, &pr));
    CHECK(pr == PRESENCE_UNKNOWN);
    json_free(d);
    reject("{\"kind\":\"presence_snapshot\",\"network_id\":3,\"nicks\":{\"a\":\"asleep\"}}");

    d = narrow("{\"kind\":\"presence_error\",\"network_id\":3,\"reason\":\"list_full\","
               "\"detail\":\"MONITOR list full\"}",
               &ev, &ok);
    CHECK(ok);
    CHECK_STR(ev.u.presence_error.detail, "MONITOR list full");
    json_free(d);
    reject("{\"kind\":\"presence_error\",\"network_id\":3,\"reason\":\"other\",\"detail\":\"d\"}");
}

TEST(maps_keyed_by_data) {
    struct wire_event ev;
    bool ok;
    /* query_windows_list is keyed by nick — the keys are DATA, so only the
     * values are shape-checked, and iteration must be positional. */
    json_doc *d = narrow("{\"kind\":\"query_windows_list\",\"windows\":{"
                         "\"alice\":[{\"network_id\":1,\"target_nick\":\"alice\","
                         "\"opened_at\":\"2026-07-26\"}],"
                         "\"bob\":[{\"network_id\":1,\"target_nick\":\"bob\","
                         "\"opened_at\":\"2026-07-26\"}]}}",
                         &ev, &ok);
    CHECK(ok);
    CHECK_LONG(ev.u.query_windows.nick_count, 2);
    CHECK_STR(json_key_at(ev.u.query_windows.windows, 0), "alice");
    json_free(d);

    d = narrow("{\"kind\":\"query_windows_list\",\"windows\":{}}", &ev, &ok);
    CHECK(ok);
    CHECK_LONG(ev.u.query_windows.nick_count, 0);
    json_free(d);

    reject("{\"kind\":\"query_windows_list\",\"windows\":{\"a\":[{\"network_id\":1}]}}");
    reject("{\"kind\":\"query_windows_list\",\"windows\":[]}");

    d = narrow("{\"kind\":\"notify_list\",\"networks\":{\"azz\":[{\"network_id\":1,"
               "\"nick\":\"bob\",\"added_at\":\"2026-07-26\"}]}}",
               &ev, &ok);
    CHECK(ok);
    CHECK_LONG(ev.u.notify_list.network_count, 1);
    json_free(d);
}

TEST(isupport) {
    struct wire_event ev;
    bool ok;
    json_doc *d = narrow("{\"kind\":\"isupport_changed\",\"network_id\":1,"
                         "\"chanmodes_a\":[\"b\",\"e\"],\"chanmodes_b\":[\"k\"],"
                         "\"chanmodes_c\":[\"l\"],\"chanmodes_d\":[\"i\",\"m\"],"
                         "\"prefix\":{\"o\":\"@\",\"v\":\"+\"}}",
                         &ev, &ok);
    CHECK(ok);
    CHECK_LONG(ev.u.isupport.network_id, 1);
    CHECK_LONG(json_len(ev.u.isupport.chanmodes_a), 2);
    CHECK_STR(json_string(json_get(ev.u.isupport.prefix, "o")), "@");
    json_free(d);
    reject("{\"kind\":\"isupport_changed\",\"network_id\":1,\"chanmodes_a\":[\"b\"],"
           "\"chanmodes_b\":[],\"chanmodes_c\":[],\"chanmodes_d\":[],\"prefix\":{\"o\":7}}");
}

/* A network joined or left the session (CLIENT_PROTOCOL §4e, v28). Both
 * name what moved and NOTHING else — no state, by contract: `GET
 * /networks` owns the answer, and a client that infers an attach from
 * connection_state_changed keeps showing the network as available with
 * no row. */
TEST(network_attached_and_detached) {
    struct wire_event ev;
    bool ok;
    json_doc *d = narrow("{\"kind\":\"network_attached\",\"network_id\":7,\"network_slug\":\"libera\"}",
                         &ev, &ok);
    CHECK(ok);
    CHECK(ev.kind == WIRE_NETWORK_ATTACHED);
    CHECK_LONG(ev.u.network_link.network_id, 7);
    CHECK_STR(ev.u.network_link.network_slug, "libera");
    json_free(d);
    d = narrow("{\"kind\":\"network_detached\",\"network_id\":7,\"network_slug\":\"libera\"}",
               &ev, &ok);
    CHECK(ok);
    CHECK(ev.kind == WIRE_NETWORK_DETACHED);
    CHECK_STR(ev.u.network_link.network_slug, "libera");
    json_free(d);
    /* Either name missing drops the event whole. */
    d = narrow("{\"kind\":\"network_attached\",\"network_id\":7}", &ev, &ok);
    CHECK(!ok);
    json_free(d);
    d = narrow("{\"kind\":\"network_detached\",\"network_slug\":\"libera\"}", &ev, &ok);
    CHECK(!ok);
    json_free(d);
}

/* The flood ladder severed this bearer (§6): a code and nothing else,
 * and the socket is about to close. The operator refused an invite
 * (§9): the window it named is the banner to drop. */
TEST(severed_and_invite_declined) {
    struct wire_event ev;
    bool ok;
    json_doc *d = narrow("{\"kind\":\"web_session_severed\",\"code\":\"rate_limit_flood\"}", &ev, &ok);
    CHECK(ok);
    CHECK(ev.kind == WIRE_WEB_SESSION_SEVERED);
    CHECK_STR(ev.u.severed.code, "rate_limit_flood");
    json_free(d);
    d = narrow("{\"kind\":\"web_session_severed\"}", &ev, &ok);
    CHECK(!ok);
    json_free(d);
    d = narrow("{\"kind\":\"window_invite_declined\",\"network\":\"azz\",\"channel\":\"#secret\"}",
               &ev, &ok);
    CHECK(ok);
    CHECK(ev.kind == WIRE_WINDOW_INVITE_DECLINED);
    CHECK_STR(ev.u.window_open.network, "azz");
    CHECK_STR(ev.u.window_open.channel, "#secret");
    json_free(d);
}

/* A peer offered a file (§4b, v19–21). The offer is not window state and
 * carries none: `channel` says where to RENDER it. Its resolution is one
 * event with a closed reason. */
TEST(dcc_offer_and_its_resolution) {
    struct wire_event ev;
    bool ok;
    json_doc *d = narrow("{\"kind\":\"dcc_offer\",\"network\":\"azzurra\",\"channel\":\"$server\","
                         "\"offer_id\":\"n4xk\",\"from\":\"alice\",\"filename\":\"holiday.jpg\","
                         "\"size\":12345}",
                         &ev, &ok);
    CHECK(ok);
    CHECK(ev.kind == WIRE_DCC_OFFER);
    CHECK_STR(ev.u.dcc_offer.network, "azzurra");
    CHECK_STR(ev.u.dcc_offer.channel, "$server");
    CHECK_STR(ev.u.dcc_offer.offer_id, "n4xk");
    CHECK_STR(ev.u.dcc_offer.from, "alice");
    CHECK_STR(ev.u.dcc_offer.filename, "holiday.jpg");
    CHECK_LONG(ev.u.dcc_offer.size, 12345);
    json_free(d);
    d = narrow("{\"kind\":\"dcc_offer_resolved\",\"network\":\"azzurra\",\"channel\":\"$server\","
               "\"offer_id\":\"n4xk\",\"resolution\":\"expired\"}",
               &ev, &ok);
    CHECK(ok);
    CHECK(ev.kind == WIRE_DCC_OFFER_RESOLVED);
    CHECK_STR(ev.u.dcc_resolved.offer_id, "n4xk");
    CHECK_STR(ev.u.dcc_resolved.resolution, "expired");
    json_free(d);
    /* A handle with no id names nothing. */
    d = narrow("{\"kind\":\"dcc_offer\",\"network\":\"azzurra\",\"channel\":\"$server\","
               "\"from\":\"alice\",\"filename\":\"x\",\"size\":1}",
               &ev, &ok);
    CHECK(!ok);
    json_free(d);
}

/* `:failing` is a value of the server's set (#1675, v5): the session
 * process is alive and the backoff is running while the upstream link
 * is NOT registered. It was missing from the C enum, so every event
 * that touched it — the ones an operator most wants to see — was
 * dropped whole and the sidebar kept saying connected. */
TEST(a_failing_link_is_a_state_and_not_a_dropped_event) {
    struct wire_event ev;
    bool ok;
    json_doc *d = narrow(
        "{\"kind\":\"connection_state_changed\",\"user_id\":\"u1\",\"network_id\":1,"
        "\"network_slug\":\"libera\",\"from\":\"connected\",\"to\":\"failing\","
        "\"reason\":\"connection refused\",\"at\":null,\"network\":{\"slug\":\"libera\","
        "\"nick\":\"vjt\",\"connection_state\":\"failing\","
        "\"connection_state_reason\":\"connection refused\","
        "\"connection_state_changed_at\":null}}",
        &ev, &ok);
    CHECK(ok);
    CHECK(ev.u.connection_state.to == CONN_FAILING);
    CHECK(ev.u.connection_state.state == CONN_FAILING);
    CHECK_STR(wire_connection_state_name(CONN_FAILING), "failing");
    CHECK_STR(ev.u.connection_state.reason, "connection refused");
    json_free(d);
    /* And back: failing → connected on 001. */
    d = narrow("{\"kind\":\"connection_state_changed\",\"user_id\":\"u1\",\"network_id\":1,"
               "\"network_slug\":\"libera\",\"from\":\"failing\",\"to\":\"connected\","
               "\"reason\":null,\"at\":null,\"network\":{\"slug\":\"libera\",\"nick\":\"vjt\","
               "\"connection_state\":\"connected\",\"connection_state_reason\":null,"
               "\"connection_state_changed_at\":null}}",
               &ev, &ok);
    CHECK(ok);
    CHECK(ev.u.connection_state.from == CONN_FAILING);
    json_free(d);
}

TEST(connection_state_changed) {
    struct wire_event ev;
    bool ok;
    json_doc *d = narrow(
        "{\"kind\":\"connection_state_changed\",\"user_id\":\"u1\",\"network_id\":1,"
        "\"network_slug\":\"azz\",\"from\":\"parked\",\"to\":\"connected\",\"reason\":null,"
        "\"at\":\"2026-07-26T00:00:00Z\",\"network\":{\"slug\":\"azz\",\"nick\":\"vjt\","
        "\"connection_state\":\"connected\",\"connection_state_reason\":null,"
        "\"connection_state_changed_at\":\"2026-07-26T00:00:00Z\"}}",
        &ev, &ok);
    CHECK(ok);
    CHECK(ev.u.connection_state.from == CONN_PARKED);
    CHECK(ev.u.connection_state.to == CONN_CONNECTED);
    CHECK_STR(ev.u.connection_state.nick, "vjt");
    CHECK_STR(wire_connection_state_name(ev.u.connection_state.state), "connected");
    json_free(d);

    /* A VISITOR credential has user_id null (the XOR FK) — must narrow. */
    d = narrow("{\"kind\":\"connection_state_changed\",\"user_id\":null,\"network_id\":1,"
               "\"network_slug\":\"azz\",\"from\":\"connected\",\"to\":\"failed\","
               "\"reason\":\"timeout\",\"at\":null,\"network\":{\"slug\":\"azz\","
               "\"nick\":\"guest\",\"connection_state\":\"failed\","
               "\"connection_state_reason\":\"timeout\","
               "\"connection_state_changed_at\":null}}",
               &ev, &ok);
    CHECK(ok);
    CHECK(ev.u.connection_state.to == CONN_FAILED);
    CHECK_STR(ev.u.connection_state.reason, "timeout");
    json_free(d);

    /* A state outside the closed set is a hard reject. */
    reject("{\"kind\":\"connection_state_changed\",\"user_id\":null,\"network_id\":1,"
           "\"network_slug\":\"a\",\"from\":\"connected\",\"to\":\"exploded\",\"reason\":null,"
           "\"at\":null,\"network\":{\"slug\":\"a\",\"nick\":\"n\","
           "\"connection_state\":\"connected\",\"connection_state_reason\":null,"
           "\"connection_state_changed_at\":null}}");
}

TEST(simple_arms) {
    struct wire_event ev;
    bool ok;
    json_doc *d;

    d = narrow("{\"kind\":\"channels_changed\"}", &ev, &ok);
    CHECK(ok);
    CHECK(ev.kind == WIRE_CHANNELS_CHANGED);
    json_free(d);

    d = narrow("{\"kind\":\"own_nick_changed\",\"network_id\":1,\"nick\":\"newnick\"}", &ev, &ok);
    CHECK(ok);
    CHECK_STR(ev.u.own_nick.nick, "newnick");
    json_free(d);

    d = narrow("{\"kind\":\"away_confirmed\",\"network\":\"azz\",\"state\":\"away\"}", &ev, &ok);
    CHECK(ok);
    CHECK(ev.u.away_confirmed.away);
    json_free(d);
    reject("{\"kind\":\"away_confirmed\",\"network\":\"a\",\"state\":\"maybe\"}");

    d = narrow("{\"kind\":\"connection_progress\",\"network\":\"azz\",\"state\":\"connecting\"}",
               &ev, &ok);
    CHECK(ok);
    CHECK(!ev.u.connection_progress.connected);
    json_free(d);

    d = narrow("{\"kind\":\"peer_away\",\"network\":\"azz\",\"peer\":\"bob\","
               "\"message\":\"back later\"}",
               &ev, &ok);
    CHECK(ok);
    CHECK_STR(ev.u.peer_away.message, "back later");
    json_free(d);

    d = narrow("{\"kind\":\"invite_ack\",\"network\":\"azz\",\"channel\":\"#dev\","
               "\"peer\":\"bob\"}",
               &ev, &ok);
    CHECK(ok);
    CHECK_STR(ev.u.invite_ack.peer, "bob");
    json_free(d);

    d = narrow("{\"kind\":\"window_pending\",\"network\":\"azz\",\"channel\":\"#dev\","
               "\"state\":\"pending\"}",
               &ev, &ok);
    CHECK(ok);
    CHECK(ev.kind == WIRE_WINDOW_PENDING);
    json_free(d);
    /* pending/invited must not accept each other's state discriminant. */
    reject("{\"kind\":\"window_pending\",\"network\":\"a\",\"channel\":\"#c\","
           "\"state\":\"invited\"}");

    d = narrow("{\"kind\":\"umode_changed\",\"network_id\":1,\"modes\":[\"i\",\"w\"]}", &ev, &ok);
    CHECK(ok);
    CHECK_LONG(ev.u.umodes.mode_count, 2);
    json_free(d);
    reject("{\"kind\":\"umode_changed\",\"network_id\":1,\"modes\":\"iw\"}");

    d = narrow("{\"kind\":\"archive_purged\",\"network_slug\":\"azz\",\"target\":\"#old\"}", &ev,
               &ok);
    CHECK(ok);
    CHECK_STR(ev.u.archive.target, "#old");
    json_free(d);

    d = narrow("{\"kind\":\"directory_complete\",\"network\":\"azz\",\"total\":1200}", &ev, &ok);
    CHECK(ok);
    CHECK_LONG(ev.u.directory.count, 1200);
    json_free(d);

    d = narrow("{\"kind\":\"whowas_bundle\",\"network\":\"azz\",\"target\":\"gone\","
               "\"not_found\":true,\"user\":null,\"host\":null,\"realname\":null,"
               "\"server\":null,\"logoff_time\":null}",
               &ev, &ok);
    CHECK(ok);
    CHECK(ev.u.whowas.not_found);
    json_free(d);

    d = narrow("{\"kind\":\"bundle_hash\",\"hash\":\"abc123\",\"version\":\"1.2\"}", &ev, &ok);
    CHECK(ok);
    CHECK_STR(ev.u.bundle_hash.version, "1.2");
    json_free(d);
    /* Absent/empty version normalises to NULL, not "". */
    d = narrow("{\"kind\":\"bundle_hash\",\"hash\":\"abc123\"}", &ev, &ok);
    CHECK(ok);
    CHECK(ev.u.bundle_hash.version == NULL);
    json_free(d);
    reject("{\"kind\":\"bundle_hash\",\"hash\":\"\"}");
}

TEST(server_settings) {
    struct wire_event ev;
    bool ok;
    json_doc *d = narrow(
        "{\"kind\":\"server_settings_changed\",\"upload\":{\"active_host\":\"local\","
        "\"image_per_file_cap_bytes\":1048576,\"video_per_file_cap_bytes\":10485760,"
        "\"document_per_file_cap_bytes\":2097152,\"audio_per_file_cap_bytes\":5242880,"
        "\"global_cap_bytes\":104857600},\"http_host_aliases\":[\"a.example\"]}",
        &ev, &ok);
    CHECK(ok);
    CHECK_STR(ev.u.server_settings.active_host, "local");
    CHECK_LONG(ev.u.server_settings.image_cap, 1048576);
    CHECK_LONG(ev.u.server_settings.alias_count, 1);
    json_free(d);

    /* Aliases are LENIENT: a malformed list degrades to none rather than
     * stranding the upload caps that ride along in the same payload. */
    d = narrow("{\"kind\":\"server_settings_changed\",\"upload\":{\"active_host\":\"local\","
               "\"image_per_file_cap_bytes\":1,\"video_per_file_cap_bytes\":1,"
               "\"document_per_file_cap_bytes\":1,\"audio_per_file_cap_bytes\":1,"
               "\"global_cap_bytes\":1},\"http_host_aliases\":\"nope\"}",
               &ev, &ok);
    CHECK(ok);
    CHECK_LONG(ev.u.server_settings.alias_count, 0);
    json_free(d);

    /* A non-positive cap is a contract break — caps gate uploads. */
    reject("{\"kind\":\"server_settings_changed\",\"upload\":{\"active_host\":\"local\","
           "\"image_per_file_cap_bytes\":0,\"video_per_file_cap_bytes\":1,"
           "\"document_per_file_cap_bytes\":1,\"audio_per_file_cap_bytes\":1,"
           "\"global_cap_bytes\":1}}");
}

TEST(mentions_bundle) {
    struct wire_event ev;
    bool ok;
    json_doc *d = narrow("{\"kind\":\"mentions_bundle\",\"network\":\"azz\","
                         "\"away_started_at\":\"2026-07-26T00:00:00Z\","
                         "\"away_ended_at\":\"2026-07-26T01:00:00Z\",\"away_reason\":\"lunch\","
                         "\"messages\":[{\"server_time\":1753500000,\"channel\":\"#dev\","
                         "\"sender\":\"bob\",\"body\":\"ping\",\"kind\":\"privmsg\"}]}",
                         &ev, &ok);
    CHECK(ok);
    CHECK_STR(ev.u.mentions_bundle.away_reason, "lunch");
    CHECK_LONG(ev.u.mentions_bundle.message_count, 1);
    struct wire_mention m;
    CHECK(wire_mention_at(ev.u.mentions_bundle.messages, 0, &m));
    CHECK_STR(m.sender, "bob");
    CHECK_STR(m.body, "ping");
    CHECK(m.kind == MSG_PRIVMSG);
    json_free(d);

    reject("{\"kind\":\"mentions_bundle\",\"network\":\"a\","
           "\"away_started_at\":\"t\",\"away_ended_at\":\"t\",\"away_reason\":null,"
           "\"messages\":[{\"server_time\":1,\"channel\":\"#c\",\"sender\":\"s\","
           "\"body\":null,\"kind\":\"telepathy\"}]}");
}

/* Unknown kinds and non-objects must drop, never crash — the default-null
 * arm of the cic narrowers. A version-skewed server WILL send these. */
TEST(unknown_and_malformed_drop) {
    reject("{\"kind\":\"some_future_event\",\"data\":1}");
    reject("{\"nokind\":true}");
    reject("{\"kind\":42}");
    reject("[]");
    reject("\"just a string\"");
    reject("null");

    struct wire_event ev;
    CHECK(!wire_narrow(NULL, &ev));
}

TEST(phoenix_frame) {
    char err[160];
    const char *text = "[null,null,\"grappa:user:vjt\",\"event\",{\"kind\":\"channels_changed\"}]";
    json_doc *d = json_parse(text, strlen(text), err, sizeof(err));
    CHECK(d != NULL);
    struct wire_frame f;
    CHECK(wire_frame_split(json_root(d), &f));
    CHECK_STR(f.topic, "grappa:user:vjt");
    CHECK_STR(f.event, "event");
    CHECK(f.ref == NULL);
    /* The user topic names no network. */
    CHECK(f.network[0] == 0);
    struct wire_event ev;
    CHECK(wire_narrow(f.payload, &ev));
    CHECK(ev.kind == WIRE_CHANNELS_CHANGED);
    json_free(d);

    /* A per-channel topic does, and the frame says which: window_counts
     * and read_cursor_set carry no network of their own — they are
     * scoped by the topic they arrive on — and #chan on two networks is
     * two windows with two counts. The slug is what sits between
     * `/network:` and `/channel:`, however the channel is spelled. */
    text = "[null,null,\"grappa:user:vjt/network:libera/channel:#chan\",\"event\","
           "{\"kind\":\"window_counts\",\"channel\":\"#chan\",\"messages\":3,"
           "\"mentions\":0,\"events\":0,\"severity\":\"message\"}]";
    d = json_parse(text, strlen(text), err, sizeof(err));
    CHECK(wire_frame_split(json_root(d), &f));
    CHECK_STR(f.network, "libera");
    json_free(d);
    text = "[null,null,\"grappa:user:v/network:azzurra/channel:some/one\",\"event\",{}]";
    d = json_parse(text, strlen(text), err, sizeof(err));
    CHECK(wire_frame_split(json_root(d), &f));
    CHECK_STR(f.network, "azzurra");
    json_free(d);
    text = "[null,null,\"grappa:user:vjt/network:azzurra\",\"event\",{}]";
    d = json_parse(text, strlen(text), err, sizeof(err));
    CHECK(wire_frame_split(json_root(d), &f));
    CHECK_STR(f.network, "azzurra");
    json_free(d);

    /* A reply frame carries a ref. */
    text = "[\"1\",\"2\",\"topic\",\"phx_reply\",{\"status\":\"ok\",\"response\":{}}]";
    d = json_parse(text, strlen(text), err, sizeof(err));
    CHECK(wire_frame_split(json_root(d), &f));
    CHECK_STR(f.ref, "2");
    CHECK_STR(f.event, "phx_reply");
    json_free(d);

    /* Not a v2 frame. */
    text = "{\"topic\":\"t\"}";
    d = json_parse(text, strlen(text), err, sizeof(err));
    CHECK(!wire_frame_split(json_root(d), &f));
    json_free(d);

    text = "[null,null,\"t\"]";
    d = json_parse(text, strlen(text), err, sizeof(err));
    CHECK(!wire_frame_split(json_root(d), &f));
    json_free(d);
}

/* Every kind in the table must round-trip through its name, so a new arm
 * cannot be added to the enum without a name entry. */
TEST(kind_names_are_total) {
    for (int k = WIRE_MESSAGE; k <= WIRE_DIRECTORY_FAILED; k++) {
        const char *name = wire_kind_name((wire_kind)k);
        CHECK(strcmp(name, "unknown") != 0);
    }
    CHECK_STR(wire_kind_name(WIRE_UNKNOWN), "unknown");
}

/* The subject key, against the THREE real response shapes.
 *
 * Regression pin: login and share-consume NEST the subject under
 * `subject` while /me is flat. A reader anchored only to the root
 * resolves login to an empty subject and the client dies with "login
 * response missing subject" — which is exactly what shipped. */
TEST(subject_key_shapes) {
    char err[160], key[256];

    /* POST /auth/login — nested user subject. */
    const char *login =
        "{\"token\":\"SFMyNTY.abc\",\"subject\":{\"kind\":\"user\","
        "\"id\":\"u-1\",\"name\":\"nextime\"}}";
    json_doc *d = json_parse(login, strlen(login), err, sizeof(err));
    CHECK(d != NULL);
    CHECK(wire_subject_key(json_root(d), key, sizeof(key)));
    CHECK_STR(key, "nextime");
    json_free(d);

    /* POST /auth/share/consume — nested visitor subject. */
    const char *consume =
        "{\"token\":\"tok\",\"subject\":{\"kind\":\"visitor\","
        "\"id\":\"v-42\",\"registered\":false}}";
    d = json_parse(consume, strlen(consume), err, sizeof(err));
    CHECK(wire_subject_key(json_root(d), key, sizeof(key)));
    CHECK_STR(key, "visitor:v-42");
    json_free(d);

    /* GET /me — FLAT user subject (the subject IS the document). */
    const char *me =
        "{\"kind\":\"user\",\"id\":\"u-1\",\"name\":\"nextime\","
        "\"badge_count\":0}";
    d = json_parse(me, strlen(me), err, sizeof(err));
    CHECK(wire_subject_key(json_root(d), key, sizeof(key)));
    CHECK_STR(key, "nextime");
    json_free(d);

    /* GET /me — FLAT visitor subject. */
    const char *me_v = "{\"kind\":\"visitor\",\"id\":\"v-42\"}";
    d = json_parse(me_v, strlen(me_v), err, sizeof(err));
    CHECK(wire_subject_key(json_root(d), key, sizeof(key)));
    CHECK_STR(key, "visitor:v-42");
    json_free(d);

    /* `identifier` is accepted as a fallback name. */
    const char *ident = "{\"kind\":\"user\",\"identifier\":\"someone\"}";
    d = json_parse(ident, strlen(ident), err, sizeof(err));
    CHECK(wire_subject_key(json_root(d), key, sizeof(key)));
    CHECK_STR(key, "someone");
    json_free(d);
}

/* An unresolvable subject must FAIL rather than yield a half-formed key:
 * "visitor:" or "" would be used verbatim as a PubSub topic. */
TEST(subject_key_refuses_half_formed) {
    char err[160], key[256];
    const char *cases[] = {
        "{\"token\":\"t\"}",                                  /* no subject at all */
        "{\"token\":\"t\",\"subject\":{}}",                    /* empty subject   */
        "{\"kind\":\"visitor\"}",                             /* visitor, no id  */
        "{\"kind\":\"visitor\",\"id\":\"\"}",                 /* visitor, empty  */
        "{\"kind\":\"user\"}",                                /* user, no name   */
        "{\"kind\":\"user\",\"name\":\"\"}",                  /* user, empty     */
        "{\"subject\":{\"kind\":\"user\",\"name\":\"\"}}",    /* nested, empty   */
    };
    for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); i++) {
        json_doc *d = json_parse(cases[i], strlen(cases[i]), err, sizeof(err));
        CHECK(d != NULL);
        CHECK(!wire_subject_key(json_root(d), key, sizeof(key)));
        CHECK_STR(key, ""); /* and never a partial key */
        json_free(d);
    }
    /* A non-object `subject` falls back to the root rather than crashing. */
    const char *odd = "{\"subject\":\"nope\",\"kind\":\"user\",\"name\":\"bob\"}";
    json_doc *d = json_parse(odd, strlen(odd), err, sizeof(err));
    CHECK(wire_subject_key(json_root(d), key, sizeof(key)));
    CHECK_STR(key, "bob");
    json_free(d);

    CHECK(!wire_subject_key(NULL, key, sizeof(key)));
    CHECK(!wire_subject_key(NULL, NULL, 0));
}

int main(void) {
    RUN(subject_key_shapes);
    RUN(subject_key_refuses_half_formed);
    RUN(message);
    RUN(message_rejects_bad_shapes);
    RUN(every_message_kind_round_trips);
    RUN(window_state);
    RUN(join_failed_tolerates_null_numeric);
    RUN(members_seeded);
    RUN(topic_changed);
    RUN(read_cursor_and_counts);
    RUN(whois_bundle);
    RUN(whois_minimal_and_rejects);
    RUN(who_reply);
    RUN(lusers_tolerates_garbled_counts);
    RUN(banlist_and_links);
    RUN(server_reply);
    RUN(presence);
    RUN(maps_keyed_by_data);
    RUN(isupport);
    RUN(network_attached_and_detached);
    RUN(severed_and_invite_declined);
    RUN(dcc_offer_and_its_resolution);
    RUN(a_failing_link_is_a_state_and_not_a_dropped_event);
    RUN(connection_state_changed);
    RUN(simple_arms);
    RUN(server_settings);
    RUN(mentions_bundle);
    RUN(unknown_and_malformed_drop);
    RUN(phoenix_frame);
    RUN(kind_names_are_total);
    return test_report();
}
