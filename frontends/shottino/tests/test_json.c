/* test_json.c — the JSON reader.
 *
 * The cases here are the ones the old strstr/key-scan approach got wrong,
 * plus the malformed shapes a narrower has to reject rather than crash on.
 */
#include "../json.h"
#include "test.h"

#include <stdlib.h>

static json_doc *parse_ok(const char *text) {
    char err[160];
    json_doc *doc = json_parse(text, strlen(text), err, sizeof(err));
    if (!doc) fprintf(stderr, "  (parse error: %s)\n", err);
    return doc;
}

TEST(scalars) {
    json_doc *d = parse_ok("{\"s\":\"hi\",\"n\":42,\"b\":true,\"z\":null}");
    CHECK(d != NULL);
    const json_value *r = json_root(d);
    CHECK(json_type_of(r) == JSON_OBJECT);
    CHECK_STR(json_string(json_get(r, "s")), "hi");
    long n = 0;
    CHECK(json_long(json_get(r, "n"), &n));
    CHECK_LONG(n, 42);
    CHECK(json_bool(json_get(r, "b"), false) == true);
    CHECK(json_is_null(json_get(r, "z")));
    /* A missing key reads as null rather than exploding, so narrowers can
     * probe optional fields without a presence check first. */
    CHECK(json_is_null(json_get(r, "absent")));
    json_free(d);
}

/* The bug that motivated the parser: a key-anywhere scan finds the FIRST
 * "channel" in the buffer, which for a `message` event is the nested one —
 * or worse, whichever the encoder happened to emit first. Nesting must be
 * addressed explicitly. */
TEST(nested_keys_do_not_leak) {
    json_doc *d = parse_ok("{\"channel\":\"#outer\",\"message\":{\"channel\":\"#inner\","
                           "\"sender\":\"bob\"}}");
    CHECK(d != NULL);
    const json_value *r = json_root(d);
    CHECK_STR(json_string(json_get(r, "channel")), "#outer");
    const json_value *msg = json_get(r, "message");
    CHECK_STR(json_string(json_get(msg, "channel")), "#inner");
    CHECK_STR(json_string(json_get(msg, "sender")), "bob");
    json_free(d);
}

TEST(arrays) {
    json_doc *d = parse_ok("{\"members\":[{\"nick\":\"a\",\"modes\":[\"o\"]},"
                           "{\"nick\":\"b\",\"modes\":[]}]}");
    CHECK(d != NULL);
    const json_value *members = json_get(json_root(d), "members");
    CHECK_LONG(json_len(members), 2);
    CHECK_STR(json_string(json_get(json_at(members, 0), "nick")), "a");
    CHECK_LONG(json_len(json_get(json_at(members, 0), "modes")), 1);
    CHECK_STR(json_string(json_at(json_get(json_at(members, 0), "modes"), 0)), "o");
    CHECK_LONG(json_len(json_get(json_at(members, 1), "modes")), 0);
    /* Out-of-range index is NULL, not UB. */
    CHECK(json_at(members, 2) == NULL);
    json_free(d);
}

/* `query_windows_list.windows` and ISUPPORT's PREFIX map are keyed by data
 * (a nick, a mode letter), so they must be walkable by position. */
TEST(object_iteration) {
    json_doc *d = parse_ok("{\"prefix\":{\"o\":\"@\",\"v\":\"+\"}}");
    CHECK(d != NULL);
    const json_value *pfx = json_get(json_root(d), "prefix");
    CHECK_LONG(json_len(pfx), 2);
    CHECK_STR(json_key_at(pfx, 0), "o");
    CHECK_STR(json_string(json_value_at(pfx, 0)), "@");
    CHECK_STR(json_key_at(pfx, 1), "v");
    CHECK_STR(json_string(json_value_at(pfx, 1)), "+");
    json_free(d);
}

TEST(string_escapes) {
    json_doc *d = parse_ok("{\"a\":\"line\\nbreak\",\"b\":\"quo\\\"te\",\"c\":\"back\\\\slash\","
                           "\"d\":\"tab\\there\"}");
    CHECK(d != NULL);
    const json_value *r = json_root(d);
    CHECK_STR(json_string(json_get(r, "a")), "line\nbreak");
    CHECK_STR(json_string(json_get(r, "b")), "quo\"te");
    CHECK_STR(json_string(json_get(r, "c")), "back\\slash");
    CHECK_STR(json_string(json_get(r, "d")), "tab\there");
    json_free(d);
}

/* CTCP ACTION arrives as \u0001ACTION ...\u0001 and MUST survive intact —
 * round-trip fidelity for /me is a documented project invariant. */
TEST(ctcp_and_unicode_escapes) {
    json_doc *d = parse_ok("{\"body\":\"\\u0001ACTION waves\\u0001\",\"chan\":\"#caf\\u00e9\","
                           "\"emoji\":\"\\ud83d\\ude00\"}");
    CHECK(d != NULL);
    const json_value *r = json_root(d);
    /* Octal escapes, not \x01 — a hex escape is greedy and "\x01A" would
     * lex as the single byte 0x1A followed by "CTION". */
    CHECK_STR(json_string(json_get(r, "body")), "\001ACTION waves\001");
    CHECK_STR(json_string(json_get(r, "chan")), "#caf\xc3\xa9");
    /* Surrogate pair joined into one astral code point (U+1F600). */
    CHECK_STR(json_string(json_get(r, "emoji")), "\xf0\x9f\x98\x80");
    json_free(d);
}

TEST(phoenix_frame_envelope) {
    /* Phoenix v2 frames are arrays: [join_ref, ref, topic, event, payload] */
    json_doc *d = parse_ok("[null,\"7\",\"grappa:user:vjt\",\"event\","
                           "{\"kind\":\"joined\",\"channel\":\"#dev\"}]");
    CHECK(d != NULL);
    const json_value *r = json_root(d);
    CHECK(json_type_of(r) == JSON_ARRAY);
    CHECK_LONG(json_len(r), 5);
    CHECK(json_is_null(json_at(r, 0)));
    CHECK_STR(json_string(json_at(r, 2)), "grappa:user:vjt");
    CHECK_STR(json_string(json_at(r, 3)), "event");
    CHECK_STR(json_string(json_get(json_at(r, 4), "kind")), "joined");
    json_free(d);
}

TEST(field_helpers) {
    json_doc *d = parse_ok("{\"net\":\"azz\",\"reason\":null,\"num\":404,\"flag\":false}");
    CHECK(d != NULL);
    const json_value *r = json_root(d);

    const char *s = NULL;
    CHECK(json_str_req(r, "net", &s));
    CHECK_STR(s, "azz");
    /* Required-but-null and required-but-absent both fail. */
    CHECK(!json_str_req(r, "reason", &s));
    CHECK(!json_str_req(r, "missing", &s));

    /* Optional tolerates null AND absent, yielding NULL either way. */
    CHECK(json_str_opt(r, "reason", &s));
    CHECK(s == NULL);
    CHECK(json_str_opt(r, "missing", &s));
    CHECK(s == NULL);
    /* ...but a present field of the wrong type is still a shape error. */
    CHECK(!json_str_opt(r, "num", &s));

    long n = 0;
    CHECK(json_long_req(r, "num", &n));
    CHECK_LONG(n, 404);
    CHECK(!json_long_req(r, "net", &n));

    bool present = true;
    CHECK(json_long_opt(r, "reason", &n, &present));
    CHECK(present == false);

    bool b = true;
    CHECK(json_bool_req(r, "flag", &b));
    CHECK(b == false);
    /* Defaulting read: absent field yields the default without failing —
     * a stale server omitting badge_count must not drop the cursor sync. */
    CHECK(json_bool_dflt(r, "missing", true, &b));
    CHECK(b == true);

    CHECK(json_str_is(json_get(r, "net"), "azz"));
    CHECK(!json_str_is(json_get(r, "net"), "other"));
    CHECK(!json_str_is(json_get(r, "num"), "404"));
    json_free(d);
}

TEST(rejects_malformed) {
    char err[160];
    const char *bad[] = {
        "{",                      /* unterminated object   */
        "{\"a\":}",               /* missing value         */
        "{\"a\" 1}",              /* missing colon         */
        "[1,2",                   /* unterminated array    */
        "{\"a\":\"unterminated",  /* unterminated string   */
        "{\"a\":tru}",            /* malformed literal     */
        "{\"a\":1}trailing",      /* trailing bytes        */
        "{\"a\":\"\\q\"}",        /* unknown escape        */
        "{\"t\\u0000x\":\"chal\"}", /* a key with a NUL      */
        "{\"a\":{\"\\u0000\":1}}",    /* nested, all NUL       */
        "",                       /* empty input           */
    };
    for (size_t i = 0; i < sizeof(bad) / sizeof(bad[0]); i++) {
        json_doc *d = json_parse(bad[i], strlen(bad[i]), err, sizeof(err));
        CHECK(d == NULL);
        CHECK(err[0] != '\0');
        json_free(d);
    }
}

/* A NUL inside an object KEY makes the document unparseable. Keys are
 * matched with strcmp, so {"t\u0000x":"chal"} read as t=chal here while
 * JSON.parse keeps the whole key "t\0x": one document, two readings, and
 * cicchetto is the other reader. No key on grappa's wire or in the E2E
 * payloads contains a NUL, so refusing costs nothing; a VALUE may still
 * carry one (an IRC body), read with json_string_len. */
TEST(a_nul_in_a_key_is_refused_but_not_in_a_value) {
    const char *key = "{\"t\\u0000x\":\"chal\"}";
    CHECK(json_parse(key, strlen(key), NULL, 0) == NULL);
    const char *val = "{\"t\":\"a\\u0000b\"}";
    json_doc *d = json_parse(val, strlen(val), NULL, 0);
    CHECK(d != NULL);
    CHECK_LONG(json_string_len(json_get(json_root(d), "t")), 3);
    json_free(d);
}

/* A hostile frame must not blow the C stack. */
TEST(rejects_deep_nesting) {
    char buf[4096];
    size_t n = 0;
    for (int i = 0; i < 200; i++) buf[n++] = '[';
    for (int i = 0; i < 200; i++) buf[n++] = ']';
    char err[160];
    json_doc *d = json_parse(buf, n, err, sizeof(err));
    CHECK(d == NULL);
    json_free(d);

    /* Just inside the limit still parses. */
    n = 0;
    for (int i = 0; i < JSON_MAX_DEPTH - 1; i++) buf[n++] = '[';
    for (int i = 0; i < JSON_MAX_DEPTH - 1; i++) buf[n++] = ']';
    d = json_parse(buf, n, err, sizeof(err));
    CHECK(d != NULL);
    json_free(d);
}

/* Accessors are total: a NULL value (missing key at any hop) reads as
 * absent rather than dereferencing. This is what lets narrowers chain. */
TEST(null_safety) {
    CHECK(json_string(NULL) == NULL);
    CHECK(json_get(NULL, "x") == NULL);
    CHECK(json_at(NULL, 0) == NULL);
    CHECK_LONG(json_len(NULL), 0);
    CHECK(json_is_null(NULL));
    CHECK(json_bool(NULL, true) == true);
    long n;
    CHECK(!json_long(NULL, &n));
    CHECK(json_key_at(NULL, 0) == NULL);
    CHECK(json_root(NULL) == NULL);
}

/* A number nobody can represent is a malformed number.
 *
 * `1e999` used to parse "successfully" as infinity, because strtod's
 * ERANGE was never checked — and an infinity has no JSON spelling, so
 * round-tripping one through json_write emitted `inf`, which the next
 * parser rejects. Out-of-range integers were worse than wrong: casting
 * a double outside long's range is undefined behaviour, and the wire
 * narrowers were performing that cast while believing they were
 * rejecting bad shapes. */
TEST(a_number_nobody_can_represent_is_refused) {
    /* Overflow to infinity is a parse failure, not a value. */
    CHECK(json_parse("{\"x\":1e999}", 11, NULL, 0) == NULL);
    CHECK(json_parse("{\"x\":-1e999}", 12, NULL, 0) == NULL);

    /* A finite number too big for a long is refused BY json_long rather
     * than cast into undefined behaviour — the document is fine, the
     * field is not an integer. */
    json_doc *d = parse_ok("{\"huge\":1e300,\"ok\":42}");
    CHECK(d != NULL);
    if (d) {
        const json_value *r = json_root(d);
        long n = 12345;
        CHECK(!json_long(json_get(r, "huge"), &n));
        CHECK_LONG(n, 12345); /* untouched on refusal */
        CHECK(json_long(json_get(r, "ok"), &n));
        CHECK_LONG(n, 42);
        /* And it still round-trips as a NUMBER, not as `inf`. */
        char out[128];
        CHECK(json_write(json_get(r, "huge"), out, sizeof(out)));
        CHECK(strstr(out, "inf") == NULL);
        CHECK(strstr(out, "nan") == NULL);
        json_free(d);
    }

    /* The everyday sizes still work, including the biggest thing the
     * wire actually carries. */
    d = parse_ok("{\"id\":9007199254740991}");
    CHECK(d != NULL);
    if (d) {
        long n = 0;
        CHECK(json_long(json_get(json_root(d), "id"), &n));
        CHECK(n == 9007199254740991L);
        json_free(d);
    }
}

TEST(numbers) {
    json_doc *d = parse_ok("{\"neg\":-17,\"big\":1753500000,\"real\":1.5,\"exp\":1e3,\"zero\":0}");
    CHECK(d != NULL);
    const json_value *r = json_root(d);
    long n = 0;
    CHECK(json_long(json_get(r, "neg"), &n));
    CHECK_LONG(n, -17);
    /* server_time is a unix second count — must not lose precision. */
    CHECK(json_long(json_get(r, "big"), &n));
    CHECK_LONG(n, 1753500000);
    double dv = 0;
    CHECK(json_number(json_get(r, "real"), &dv));
    CHECK(dv > 1.49 && dv < 1.51);
    CHECK(json_long(json_get(r, "exp"), &n));
    CHECK_LONG(n, 1000);
    CHECK(json_long(json_get(r, "zero"), &n));
    CHECK_LONG(n, 0);
    json_free(d);
}

TEST(empty_containers) {
    json_doc *d = parse_ok("{\"a\":[],\"o\":{}}");
    CHECK(d != NULL);
    const json_value *r = json_root(d);
    CHECK(json_type_of(json_get(r, "a")) == JSON_ARRAY);
    CHECK_LONG(json_len(json_get(r, "a")), 0);
    CHECK(json_type_of(json_get(r, "o")) == JSON_OBJECT);
    CHECK_LONG(json_len(json_get(r, "o")), 0);
    json_free(d);
}

/* The growable builder: commas placed by structure, strings escaped as
 * json_write escapes them, and what it writes parses back to the same. */
TEST(builder_writes_compact_json_that_parses_back) {
    json_buf b;
    jb_init(&b);
    jb_obj_open(&b);
    jb_key(&b, "v");
    jb_num(&b, 2);
    jb_key(&b, "s");
    jb_str(&b, "a\"b\\c\n\x01");
    jb_key(&b, "arr");
    jb_arr_open(&b);
    jb_num(&b, 1.5);
    jb_bool(&b, true);
    jb_null(&b);
    jb_obj_open(&b);
    jb_obj_close(&b);
    jb_arr_close(&b);
    jb_key(&b, "empty");
    jb_arr_open(&b);
    jb_arr_close(&b);
    jb_obj_close(&b);
    char *text = jb_take(&b);
    CHECK_STR(text, "{\"v\":2,\"s\":\"a\\\"b\\\\c\\n\\u0001\",\"arr\":[1.5,true,null,{}],\"empty\":[]}");
    json_doc *d = parse_ok(text);
    CHECK(d != NULL);
    CHECK_STR(json_string(json_get(json_root(d), "s")), "a\"b\\c\n\x01");

    /* A parsed value goes back out member for member. */
    json_buf again;
    jb_init(&again);
    jb_value(&again, json_root(d));
    char *text2 = jb_take(&again);
    CHECK_STR(text2, text);
    free(text2);
    free(text);
    json_free(d);

    /* Nothing written is the empty text, not NULL. */
    jb_init(&b);
    text = jb_take(&b);
    CHECK_STR(text, "");
    free(text);
}

int main(void) {
    RUN(scalars);
    RUN(nested_keys_do_not_leak);
    RUN(arrays);
    RUN(object_iteration);
    RUN(string_escapes);
    RUN(ctcp_and_unicode_escapes);
    RUN(phoenix_frame_envelope);
    RUN(field_helpers);
    RUN(rejects_malformed);
    RUN(a_nul_in_a_key_is_refused_but_not_in_a_value);
    RUN(rejects_deep_nesting);
    RUN(null_safety);
    RUN(numbers);
    RUN(a_number_nobody_can_represent_is_refused);
    RUN(empty_containers);
    RUN(builder_writes_compact_json_that_parses_back);
    return test_report();
}
