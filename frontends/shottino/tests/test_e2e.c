/* test_e2e.c — the E2E core: cicchetto's wire and engine, in C.
 *
 * Vectors first: the did and fb vectors and the line arithmetic are the
 * ones cicchetto's own suite pins (src/__tests__/e2eWire.test.ts), so
 * these are cross-language evidence, not this port agreeing with itself.
 * Then the shapes a receiver must refuse, the store, and engines talking
 * to each other through a fake grappa built from the very bodies a device
 * uploads (register, list, key bundle): KEYREQ → KEYS → PKMSG → MSG, the
 * replay, the tamper and its NACK and re-key, the key alarm, two devices
 * on one side, a sibling's copy, and a save/load in the middle of it.
 */
#include "../e2e.h"
#include "test.h"

#include <fcntl.h>
#include <limits.h>
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

static const char *E1 = "11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo";
static const char *E2 = "7l01yXGoarYtEU3nwHF01/CIo8/r8U0lJ01TnULT9IY";

static char *vz(char *s) {
    char *out = s ? strdup(s) : NULL;
    vz_str_free(s);
    return out;
}

static char *xfmt(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
static char *xfmt(const char *fmt, ...) {
    /* Measured into a small buffer first: a NULL one trips a GCC false
     * positive (-Wformat-truncation "null format string") under ASan. */
    char small[256];
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(small, sizeof(small), fmt, ap);
    va_end(ap);
    if (n < 0) abort();
    char *p = malloc((size_t)n + 1);
    if (!p) abort();
    if ((size_t)n < sizeof(small)) {
        memcpy(p, small, (size_t)n + 1);
        return p;
    }
    va_start(ap, fmt);
    vsnprintf(p, (size_t)n + 1, fmt, ap);
    va_end(ap);
    return p;
}

/* ── vectors ── */

TEST(did_vectors) {
    char did[E2E_DID_LEN + 1];
    CHECK(e2e_did(E1, did));
    CHECK_STR(did, "If4x36FUomE");
    CHECK(e2e_did(E2, did));
    CHECK_STR(did, "_Uw_z3-OAsk");
    CHECK(e2e_did_valid("_Uw_z3-OAsk"));
    /* The standard-alphabet spelling of the second is no did. */
    CHECK(!e2e_did_valid("/Uw/z3+OAsk"));
    CHECK(!e2e_did_valid("If4x36FUom"));
    CHECK(!e2e_did_valid("If4x36FUomEE"));
    CHECK(!e2e_did("not a key", did));
    /* A fresh key always gives 11 url-safe characters. */
    for (int i = 0; i < 10; i++) {
        vz_account *a = vz_account_new();
        char *e = vz(vz_account_ed25519_key(a));
        CHECK(e2e_did(e, did) && e2e_did_valid(did));
        free(e);
        vz_account_free(a);
    }
}

TEST(fb_vectors_are_cicchettos) {
    char fb[E2E_FB_LEN + 1];
    e2e_fb(E1, E2, fb);
    CHECK_STR(fb, "Rf23quZfNQGC3F4H6p4ZKw");
    e2e_fb(E2, E1, fb);
    CHECK_STR(fb, "uitrgaXwYBvIfv1QB+/bgQ");
}

TEST(signed_strings) {
    char *s = e2e_id_sig_text(E1, E2);
    char *want = xfmt("irc-e2e:v2:id:%s:%s", E1, E2);
    CHECK_STR(s, want);
    free(s);
    free(want);
    const char *two[] = {E1, E2};
    s = e2e_list_sig_text(7, two, 2);
    want = xfmt("irc-e2e:v2:list:7:%s,%s", E1, E2);
    CHECK_STR(s, want);
    free(s);
    free(want);
    s = e2e_cert_sig_text(2, E1);
    want = xfmt("irc-e2e:v2:dev:2:%s", E1);
    CHECK_STR(s, want);
    free(s);
    free(want);
    s = e2e_otk_sig_text(E1);
    want = xfmt("irc-e2e:v1:otk:%s", E1);
    CHECK_STR(s, want);
    free(s);
    free(want);

    /* A certificate signed over the literal text verifies under the
     * master, and not for another version. */
    vz_account *m = vz_account_new(), *d = vz_account_new();
    char *mk = vz(vz_account_ed25519_key(m)), *dk = vz(vz_account_ed25519_key(d));
    char *cert = e2e_sign_cert(m, 2, dk);
    char *lit = xfmt("irc-e2e:v2:dev:2:%s", dk);
    char *other = e2e_cert_sig_text(3, dk);
    CHECK(vz_verify_ed25519(mk, lit, cert) == 1);
    CHECK(vz_verify_ed25519(mk, other, cert) == 0);
    free(lit);
    free(other);
    free(cert);
    free(mk);
    free(dk);
    vz_account_free(m);
    vz_account_free(d);
}

TEST(base64_both_spellings_and_refusals) {
    uint8_t *b;
    size_t n;
    CHECK(e2e_unbase64("AQI=", &b, &n) && n == 2 && b[0] == 1 && b[1] == 2);
    free(b);
    CHECK(e2e_unbase64("AQI", &b, &n) && n == 2);
    free(b);
    CHECK(e2e_unbase64("", &b, &n) && n == 0);
    free(b);
    const char *bad[] = {"AQ-_", "A", "AQI==x", "AQ I=", "AQI==="};
    for (size_t i = 0; i < 5; i++) {
        CHECK(!e2e_unbase64(bad[i], &b, &n));
        CHECK(b == NULL);
    }
    uint8_t raw[] = {0xfb, 0xff, 0xbe};
    char *u = e2e_base64url(raw, 3);
    CHECK_STR(u, "-_--");
    free(u);
    uint8_t two[] = {1, 2};
    u = e2e_base64(two, 2);
    CHECK_STR(u, "AQI");
    free(u);
}

TEST(valid_ver_and_fold) {
    CHECK(e2e_valid_ver(1));
    CHECK(e2e_valid_ver(2147483647.0));
    CHECK(!e2e_valid_ver(0));
    CHECK(!e2e_valid_ver(2147483648.0));
    CHECK(!e2e_valid_ver(-1));
    CHECK(!e2e_valid_ver(1.5));
    char *f = e2e_fold("NiCk[]\\~");
    CHECK_STR(f, "nick[]\\~"); /* ASCII A-Z only */
    free(f);
    CHECK(e2e_nick_eq("VJT", "vjt"));
    CHECK(!e2e_nick_eq("foo[", "foo{"));
}

/* The numbers are grappa's, as e2eWire.test.ts pins them: a 384-byte line
 * budget, an MSG did -> did head of 50 bytes up to 9/9 and 52 from 10/10. */
static long lines(e2e_verb verb, size_t size, const char *from, const char *to) {
    char *payload = malloc(size + 1);
    memset(payload, 'A', size);
    payload[size] = 0;
    long n = e2e_lines_needed(verb, payload, 384, from, to);
    free(payload);
    return n;
}

TEST(lines_needed_matches_grappa) {
    const long budget = 384;
    const char *A = "If4x36FUomE", *B = "_Uw_z3-OAsk";
    CHECK_LONG(lines(E2E_VERB_MSG, 334, A, B), 1);
    CHECK_LONG(lines(E2E_VERB_MSG, 335, A, B), 2);
    CHECK_LONG(lines(E2E_VERB_MSG, 9 * 334, A, B), 9);
    CHECK_LONG(lines(E2E_VERB_MSG, 9 * 334 + 1, A, B), 10);
    CHECK_LONG(lines(E2E_VERB_MSG, 10 * 332, A, B), 10);
    CHECK_LONG(lines(E2E_VERB_MSG, 10 * 332 + 1, A, B), 11);
    CHECK_LONG(lines(E2E_VERB_MSG, 64 * 332, A, B), 64);
    CHECK_LONG(lines(E2E_VERB_MSG, 64 * 332 + 1, A, B), E2E_TOO_MANY_LINES);
    CHECK_LONG(lines(E2E_VERB_MSG, 354, "*", "*"), 1);
    CHECK_LONG(lines(E2E_VERB_MSG, 355, "*", "*"), 2);
    CHECK_LONG(lines(E2E_VERB_PKMSG, 332, A, B), 1);
    CHECK_LONG(lines(E2E_VERB_PKMSG, 333, A, B), 2);
    CHECK_LONG(e2e_lines_needed(E2E_VERB_KEYREQ, "{\"v\":2}", budget, A, "*"), 1);
    CHECK_LONG(e2e_lines_needed(E2E_VERB_MSG, "A", 50, A, B), E2E_TOO_MANY_LINES);
    /* frame_budget_base less the target, unknown and non-positive alike -1. */
    CHECK_LONG(e2e_line_budget(394, "vjt-claude"), 384);
    CHECK_LONG(e2e_line_budget(-1, "x"), -1);
    CHECK_LONG(e2e_line_budget(3, "abc"), -1);
}

/* ── payload shapes ── */

static bool parses(e2e_verb verb, const char *text, bool *undecodable) {
    e2e_payload p;
    char err[80];
    bool ok = e2e_payload_parse(verb, text, &p, undecodable, err, sizeof(err));
    if (ok) e2e_payload_free(&p);
    return ok;
}

TEST(payload_refuses_what_is_no_object) {
    const char *texts[] = {"[1]", "null", "1", "\"s\"", "{", "{\"v\":NaN}", "{\"v\":Infinity}",
                           "", "x", "{\"v\":2,\"ref\":\"a\",\"ref\":\"b\"}"};
    for (size_t i = 0; i < sizeof(texts) / sizeof(texts[0]); i++) {
        bool undecodable = false;
        CHECK(!parses(E2E_VERB_NACK, texts[i], &undecodable));
        CHECK(undecodable);
    }
    bool u;
    CHECK(parses(E2E_VERB_NACK, "{\"v\":2,\"ref\":\"R\"}", &u));
    CHECK(parses(E2E_VERB_NACK, "{\"v\":2.0,\"ref\":\"R\",\"extra\":[1]}", &u));
    CHECK(!parses(E2E_VERB_NACK, "{\"v\":1,\"ref\":\"R\"}", &u) && !u);
    CHECK(!parses(E2E_VERB_NACK, "{\"ref\":\"R\"}", &u) && !u);
    CHECK(!parses(E2E_VERB_NACK, "{\"v\":2}", &u) && !u);
    CHECK(!parses(E2E_VERB_NACK, "{\"v\":\"2\",\"ref\":\"R\"}", &u));
    CHECK(!parses(E2E_VERB_MSG, "{\"v\":2,\"bodies\":{\"aaaaaaaaaaa\":\"B\"}}", &u));
    CHECK(parses(E2E_VERB_MSG, "{\"v\":2,\"ck\":\"K\",\"bodies\":{\"aaaaaaaaaaa\":\"B\"}}", &u));
    /* A key with \u0000 in it reads as its prefix through strcmp, and as
     * the whole key through JSON.parse: a did "aaaaaaaaaaa\0junk" passed
     * e2e_did_valid here and names no device in cicchetto. Undecodable. */
    u = false;
    CHECK(!parses(E2E_VERB_MSG,
                  "{\"v\":2,\"ck\":\"K\",\"bodies\":{\"aaaaaaaaaaa\\u0000junk\":\"B\"}}", &u));
    CHECK(u);
    u = false;
    CHECK(!parses(E2E_VERB_NACK, "{\"v\":2,\"ref\\u0000x\":\"R\"}", &u));
    CHECK(u);
}

#define ID "{\"curve25519\":\"K\",\"ed25519\":\"E\",\"sig\":\"S\"}"

TEST(pkmsg_ver_is_a_lists_ver) {
    const char *good[] = {"1", "1.0", "2147483647"};
    const char *bad[] = {"0", "2147483648", "-1", "1.5", "true", "\"2\"", "null"};
    for (size_t i = 0; i < 3; i++) {
        char *t = xfmt("{\"v\":2,\"id\":" ID ",\"master\":{\"ed25519\":\"M\",\"cert\":\"C\","
                       "\"ver\":%s},\"bodies\":{\"aaaaaaaaaaa\":\"B\"}}",
                       good[i]);
        e2e_payload p;
        bool u;
        CHECK(e2e_payload_parse(E2E_VERB_PKMSG, t, &p, &u, NULL, 0));
        CHECK(p.cert_ver == (i == 2 ? 2147483647L : 1));
        CHECK_STR(p.id.ed25519, "E");
        CHECK_STR(p.cert, "C");
        e2e_payload_free(&p);
        free(t);
    }
    for (size_t i = 0; i < 7; i++) {
        char *t = xfmt("{\"v\":2,\"id\":" ID ",\"master\":{\"ed25519\":\"M\",\"cert\":\"C\","
                       "\"ver\":%s},\"bodies\":{\"aaaaaaaaaaa\":\"B\"}}",
                       bad[i]);
        bool u;
        CHECK(!parses(E2E_VERB_PKMSG, t, &u));
        free(t);
    }
    bool u;
    CHECK(!parses(E2E_VERB_PKMSG,
                  "{\"v\":2,\"id\":" ID ",\"master\":{\"ed25519\":\"M\",\"cert\":\"C\"},"
                  "\"bodies\":{\"aaaaaaaaaaa\":\"B\"}}",
                  &u));
}

TEST(bodies_are_one_to_four_dids_of_strings) {
    const char *bad[] = {"{}",
                         "{\"aaaaaaaaaaa\":\"B\",\"bbbbbbbbbbb\":\"B\",\"ccccccccccc\":\"B\","
                         "\"ddddddddddd\":\"B\",\"eeeeeeeeeee\":\"B\"}",
                         "{\"a/aaaaaaaaa\":\"B\"}", "{\"aaaaaaaaaaa\":1}", "[]", "\"B\""};
    for (size_t i = 0; i < 6; i++) {
        char *pk = xfmt("{\"v\":2,\"id\":" ID ",\"master\":{\"ed25519\":\"M\",\"cert\":\"C\","
                        "\"ver\":1},\"bodies\":%s}",
                        bad[i]);
        char *m = xfmt("{\"v\":2,\"ck\":\"K\",\"bodies\":%s}", bad[i]);
        bool u;
        CHECK(!parses(E2E_VERB_PKMSG, pk, &u));
        CHECK(!parses(E2E_VERB_MSG, m, &u));
        free(pk);
        free(m);
    }
    e2e_payload p;
    bool u;
    CHECK(e2e_payload_parse(E2E_VERB_MSG,
                            "{\"v\":2,\"ck\":\"K\",\"bodies\":{\"If4x36FUomE\":\"B\","
                            "\"_Uw_z3_OAsk\":\"B2\"}}",
                            &p, &u, NULL, 0));
    CHECK_STR(e2e_payload_body(&p, "_Uw_z3_OAsk"), "B2");
    CHECK(e2e_payload_body(&p, "aaaaaaaaaaa") == NULL);
    e2e_payload_free(&p);
}

#define LIST "{\"ed25519\":\"M\",\"list\":{\"ver\":1,\"devices\":[\"E\"]},\"sig\":\"S\"}"
#define ENTRY "{\"id\":" ID ",\"otk\":{\"key\":\"O\",\"fallback\":true,\"sig\":\"S2\"}}"

TEST(keys_shape) {
    e2e_payload p;
    bool u;
    CHECK(e2e_payload_parse(E2E_VERB_KEYS, "{\"v\":2,\"master\":" LIST ",\"devices\":[" ENTRY "]}",
                            &p, &u, NULL, 0));
    CHECK(p.nentries == 1 && p.entries[0].otk_fallback);
    CHECK_STR(p.entries[0].otk_key, "O");
    CHECK(p.master.ndevices == 1 && p.master.ver == 1);
    e2e_payload_free(&p);
    /* A fallback that is not literally true is false. */
    CHECK(e2e_payload_parse(E2E_VERB_KEYS,
                            "{\"v\":2,\"master\":" LIST ",\"devices\":[{\"id\":" ID
                            ",\"otk\":{\"key\":\"O\",\"fallback\":1,\"sig\":\"S2\"}}]}",
                            &p, &u, NULL, 0));
    CHECK(!p.entries[0].otk_fallback);
    e2e_payload_free(&p);
    CHECK(!parses(E2E_VERB_KEYS,
                  "{\"v\":2,\"master\":" LIST ",\"devices\":[" ENTRY "," ENTRY "," ENTRY "," ENTRY
                  "," ENTRY "]}",
                  &u));
    CHECK(!parses(E2E_VERB_KEYS, "{\"v\":2,\"devices\":[" ENTRY "]}", &u));
    CHECK(!parses(E2E_VERB_KEYS, "{\"v\":2,\"master\":" LIST "}", &u));
    CHECK(!parses(E2E_VERB_KEYS, "{\"v\":1,\"master\":" LIST ",\"devices\":[" ENTRY "]}", &u));
    /* One bad entry refuses the whole. */
    CHECK(!parses(E2E_VERB_KEYS,
                  "{\"v\":2,\"master\":" LIST ",\"devices\":[" ENTRY ",{\"id\":" ID "}]}", &u));
    CHECK(!parses(E2E_VERB_KEYS,
                  "{\"v\":2,\"master\":{\"ed25519\":\"M\",\"list\":{\"ver\":true,\"devices\":["
                  "\"E\"]},\"sig\":\"S\"},\"devices\":[]}",
                  &u));
    CHECK(!parses(E2E_VERB_KEYS,
                  "{\"v\":2,\"master\":{\"ed25519\":\"M\",\"list\":{\"ver\":1,\"devices\":[1]},"
                  "\"sig\":\"S\"},\"devices\":[]}",
                  &u));
}

static int cmp_str(const void *a, const void *b) {
    return strcmp(*(const char *const *)a, *(const char *const *)b);
}

TEST(valid_master_list_rules) {
    vz_account *master = vz_account_new();
    char *mk = vz(vz_account_ed25519_key(master));
    char *keys[6];
    for (int i = 0; i < 6; i++) {
        vz_account *a = vz_account_new();
        keys[i] = vz(vz_account_ed25519_key(a));
        vz_account_free(a);
    }
    qsort(keys, 6, sizeof(char *), cmp_str);
    e2e_master_list m;
    for (size_t n = 1; n <= 4; n++) {
        memset(&m, 0, sizeof(m));
        m.ed25519 = mk;
        m.ver = 3;
        m.ndevices = n;
        for (size_t i = 0; i < n; i++) m.devices[i] = keys[i];
        char *sig = e2e_sign_list(master, 3, m.devices, n);
        m.sig = sig;
        CHECK(e2e_valid_master_list(&m));
        free(sig);
    }
    /* unsorted, duplicated, empty, five */
    const char *pairs[][2] = {{keys[1], keys[0]}, {keys[0], keys[0]}};
    for (int k = 0; k < 2; k++) {
        memset(&m, 0, sizeof(m));
        m.ed25519 = mk;
        m.ver = 1;
        m.ndevices = 2;
        m.devices[0] = pairs[k][0];
        m.devices[1] = pairs[k][1];
        char *sig = e2e_sign_list(master, 1, m.devices, 2);
        m.sig = sig;
        CHECK(!e2e_valid_master_list(&m));
        free(sig);
    }
    memset(&m, 0, sizeof(m));
    m.ed25519 = mk;
    m.ver = 1;
    char *sig = e2e_sign_list(master, 1, m.devices, 0);
    m.sig = sig;
    CHECK(!e2e_valid_master_list(&m));
    m.ndevices = 5; /* only four kept: a fifth is never valid */
    for (int i = 0; i < 4; i++) m.devices[i] = keys[i];
    CHECK(!e2e_valid_master_list(&m));
    free(sig);
    /* bad versions, signed over the very text they spell */
    double vers[] = {0, 2147483648.0, -1, 1.5};
    for (int k = 0; k < 4; k++) {
        memset(&m, 0, sizeof(m));
        m.ed25519 = mk;
        m.ver = vers[k];
        m.ndevices = 1;
        m.devices[0] = keys[0];
        sig = e2e_sign_list(master, (long)vers[k], m.devices, 1);
        m.sig = sig;
        CHECK(!e2e_valid_master_list(&m));
        free(sig);
    }
    /* another master's signature; a padded key the master did sign */
    memset(&m, 0, sizeof(m));
    m.ed25519 = mk;
    m.ver = 2;
    m.ndevices = 1;
    m.devices[0] = keys[0];
    vz_account *other = vz_account_new();
    sig = e2e_sign_list(other, 2, m.devices, 1);
    m.sig = sig;
    CHECK(!e2e_valid_master_list(&m));
    free(sig);
    vz_account_free(other);
    char *padded = xfmt("%s=", keys[0]);
    m.devices[0] = padded;
    sig = e2e_sign_list(master, 2, m.devices, 1);
    m.sig = sig;
    CHECK(!e2e_valid_master_list(&m));
    free(sig);
    free(padded);
    /* A Python sender's `"ver":1.0` reads as 1, signed over "…:1:…". */
    const char *one[] = {keys[0]};
    sig = e2e_sign_list(master, 1, one, 1);
    char *text = xfmt("{\"ed25519\":\"%s\",\"list\":{\"ver\":1.0,\"devices\":[\"%s\"]},"
                      "\"sig\":\"%s\"}",
                      mk, keys[0], sig);
    json_doc *d = json_parse(text, strlen(text), NULL, 0);
    CHECK(e2e_master_list_parse(json_root(d), &m));
    CHECK(e2e_valid_master_list(&m));
    json_free(d);
    free(text);
    free(sig);
    for (int i = 0; i < 6; i++) free(keys[i]);
    free(mk);
    vz_account_free(master);
}

/* ── inner messages ── */

TEST(inner_types_strict) {
    e2e_inner in;
    char *t = e2e_inner_text("ciao \x01" "ACTION waves\x01", 19);
    CHECK(e2e_inner_parse(t, strlen(t), &in));
    CHECK(in.type == E2E_INNER_TEXT && in.body_len == 19);
    CHECK(memcmp(in.body, "ciao \x01" "ACTION waves\x01", 19) == 0);
    e2e_inner_free(&in);
    free(t);
    const char *sha = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    t = e2e_inner_chal("Azzurra", "#chan", "bot!b@h", sha, "bm9uY2U=", 1700000000);
    CHECK(e2e_inner_parse(t, strlen(t), &in));
    CHECK(in.type == E2E_INNER_CHAL && in.expires_at == 1700000000);
    CHECK_STR(in.network, "Azzurra");
    e2e_inner_free(&in);
    free(t);
    const char *bad_chals[] = {
        "{\"t\":\"chal\",\"network\":\"\",\"channel\":\"#c\",\"sender_mask\":\"m\","
        "\"line_sha256\":\"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\","
        "\"nonce\":\"n\",\"expires_at\":1}",
        "{\"t\":\"chal\",\"network\":\"N\",\"channel\":\"#c\",\"sender_mask\":\"m\","
        "\"line_sha256\":\"0123456789ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef\","
        "\"nonce\":\"n\",\"expires_at\":1}",
        "{\"t\":\"chal\",\"network\":\"N\",\"channel\":\"#c\",\"sender_mask\":\"m\","
        "\"line_sha256\":\"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\","
        "\"nonce\":\"n\",\"expires_at\":1.5}",
        "{\"t\":\"chal\",\"network\":\"N\",\"channel\":\"#c\",\"sender_mask\":\"m\","
        "\"line_sha256\":\"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\","
        "\"expires_at\":1}"};
    for (size_t i = 0; i < 4; i++) CHECK(!e2e_inner_parse(bad_chals[i], strlen(bad_chals[i]), &in));
    t = e2e_inner_ack("n1");
    CHECK(e2e_inner_parse(t, strlen(t), &in) && in.type == E2E_INNER_ACK);
    CHECK_STR(in.nonce, "n1");
    e2e_inner_free(&in);
    free(t);
    t = e2e_inner_listreq();
    CHECK_STR(t, "{\"t\":\"listreq\"}");
    CHECK(e2e_inner_parse(t, strlen(t), &in) && in.type == E2E_INNER_LISTREQ);
    e2e_inner_free(&in);
    free(t);
    t = e2e_inner_copy("bob", "hi", 2);
    CHECK_STR(t, "{\"t\":\"copy\",\"peer\":\"bob\",\"body\":\"hi\"}");
    CHECK(e2e_inner_parse(t, strlen(t), &in) && in.type == E2E_INNER_COPY);
    e2e_inner_free(&in);
    free(t);
    CHECK(!e2e_inner_parse("{\"t\":\"copy\",\"peer\":\"\",\"body\":\"x\"}", 33, &in));
    CHECK(e2e_inner_parse("{\"t\":\"list\",\"master\":" LIST "}", strlen("{\"t\":\"list\",\"master\":" LIST "}"), &in));
    CHECK(in.type == E2E_INNER_LIST && in.list.ndevices == 1);
    e2e_inner_free(&in);
    /* SAS: tx 11 base64, keys 43; the cancel reason cut to 64 bytes. */
    const char *k43 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    t = e2e_inner_sas_mac("abcdefghijk", k43, k43);
    CHECK(e2e_inner_parse(t, strlen(t), &in) && in.type == E2E_INNER_SAS_MAC);
    e2e_inner_free(&in);
    free(t);
    t = e2e_inner_sas_accept("abcdefghij", k43);
    CHECK(!e2e_inner_parse(t, strlen(t), &in));
    free(t);
    t = e2e_inner_sas_key("abcdefghijk", "short");
    CHECK(!e2e_inner_parse(t, strlen(t), &in));
    free(t);
    char longreason[100];
    memset(longreason, 'r', 99);
    longreason[99] = 0;
    t = e2e_inner_sas_cancel("abcdefghijk", longreason);
    CHECK(e2e_inner_parse(t, strlen(t), &in) && in.type == E2E_INNER_SAS_CANCEL);
    CHECK(strlen(in.reason) == 64);
    e2e_inner_free(&in);
    free(t);
    t = e2e_inner_sas_start("abcdefghijk");
    CHECK(e2e_inner_parse(t, strlen(t), &in) && in.type == E2E_INNER_SAS_START);
    e2e_inner_free(&in);
    free(t);
    CHECK(!e2e_inner_parse("{\"t\":\"sas.what\",\"tx\":\"abcdefghijk\"}", 35, &in));
    /* An unknown t is still an inner message; no t is none. */
    const char *action = "{\"t\":\"action\",\"body\":\"x\"}";
    CHECK(e2e_inner_parse(action, strlen(action), &in));
    CHECK(in.type == E2E_INNER_UNKNOWN);
    e2e_inner_free(&in);
    CHECK(!e2e_inner_parse("{\"body\":\"x\"}", 12, &in));
    CHECK(!e2e_inner_parse("[]", 2, &in));
}

TEST(consent_and_small_payloads) {
    char *p = e2e_keyreq_payload();
    CHECK_STR(p, "{\"v\":2}");
    free(p);
    p = e2e_nack_payload("AAAAAAAAAAA");
    CHECK_STR(p, "{\"v\":2,\"ref\":\"AAAAAAAAAAA\"}");
    free(p);
    p = e2e_consent_payload(E1);
    char *want = xfmt("{\"v\":2,\"master\":\"%s\"}", E1);
    CHECK_STR(p, want);
    char *m;
    CHECK(e2e_consent_payload_parse(p, &m));
    CHECK_STR(m, E1);
    free(m);
    free(p);
    free(want);
    CHECK(e2e_consent_payload_parse("{\"v\":2}", &m) && m == NULL);
    CHECK(!e2e_consent_payload_parse("{\"v\":2,\"master\":\"nope\"}", &m));
    CHECK(!e2e_consent_payload_parse("{\"v\":1}", &m));
}

/* ── our identity ── */

static size_t count_char(const char *s, const char *needle) {
    size_t n = 0;
    for (const char *p = strstr(s, needle); p; p = strstr(p + 1, needle)) n++;
    return n;
}

TEST(top_up_fills_grappa_and_stops) {
    vz_account *a = vz_account_new();
    char *up = e2e_top_up(a, 0, false);
    CHECK(up != NULL);
    json_doc *d = json_parse(up, strlen(up), NULL, 0);
    const json_value *otks = json_get(json_root(d), "one_time_keys");
    CHECK(json_len(otks) == E2E_MAX_HOSTED_ONE_TIME_KEYS);
    char *ed = vz(vz_account_ed25519_key(a));
    /* Every key carries S2 under the device. */
    const char *k = json_string(json_get(json_at(otks, 0), "key"));
    char *text = e2e_otk_sig_text(k);
    CHECK(vz_verify_ed25519(ed, text, json_string(json_get(json_at(otks, 0), "sig"))) == 1);
    free(text);
    CHECK(json_type_of(json_get(json_get(json_root(d), "fallback"), "key")) == JSON_STRING);
    json_free(d);
    free(up);
    CHECK(vz_account_mark_keys_as_published(a) == 0);
    CHECK(e2e_top_up(a, 50, true) == NULL);
    up = e2e_top_up(a, 48, true);
    CHECK(up && count_char(up, "\"key\"") == 2 && strstr(up, "\"fallback\":null"));
    free(up);
    free(ed);
    vz_account_free(a);
}

TEST(bootstrap_identity_signs_v1) {
    vz_account *dev = vz_account_new(), *m = vz_account_new();
    e2e_own own;
    e2e_own_bootstrap(dev, m, &own);
    char *e = vz(vz_account_ed25519_key(dev));
    CHECK(own.list_ver == 1 && own.cert_ver == 1 && own.list_devices.n == 1);
    CHECK_STR(own.list_devices.v[0], e);
    char did[E2E_DID_LEN + 1];
    e2e_did(e, did);
    CHECK_STR(own.did, did);
    char *cert = e2e_cert_sig_text(1, e);
    CHECK(vz_verify_ed25519(own.master, cert, own.cert) == 1);
    free(cert);
    e2e_master_list ml = {own.master, 1, 1, {e}, own.list_sig};
    CHECK(e2e_valid_master_list(&ml));
    char *put = e2e_list_put_body(&own);
    char *want = xfmt("{\"master\":\"%s\",\"ver\":1,\"devices\":[\"%s\"],\"sig\":\"%s\"}",
                      own.master, e, own.list_sig);
    CHECK_STR(put, want);
    free(put);
    free(want);
    char *reg = e2e_register_body(dev, own.master);
    json_doc *d = json_parse(reg, strlen(reg), NULL, 0);
    e2e_id_block id = {json_string(json_get(json_root(d), "curve25519")),
                       json_string(json_get(json_root(d), "ed25519")),
                       json_string(json_get(json_root(d), "sig"))};
    char *s1 = e2e_id_sig_text(id.curve25519, own.master);
    CHECK(vz_verify_ed25519(id.ed25519, s1, id.sig) == 1);
    free(s1);
    json_free(d);
    free(reg);
    free(e);
    e2e_own_free(&own);
    vz_account_free(dev);
    vz_account_free(m);
}

/* identity.ts runSync's table, branch by branch. */
static e2e_master_list held_of(const e2e_own *own) {
    e2e_master_list m = {.ed25519 = own->master, .ver = (double)own->list_ver,
                         .ndevices = own->list_devices.n, .sig = own->list_sig};
    for (size_t i = 0; i < own->list_devices.n && i < E2E_MAX_DEVICES; i++)
        m.devices[i] = own->list_devices.v[i];
    return m;
}

TEST(sync_decides_as_run_sync) {
    e2e_record r;
    e2e_record_new(&r);
    /* No place here: nothing on grappa is NONE (an init makes one), an
     * identity there is somebody else's device. */
    CHECK(e2e_sync_decide(&r, NULL) == E2E_SYNC_NONE);
    vz_account *other = vz_account_new(), *other_dev = vz_account_new();
    e2e_own theirs;
    e2e_own_bootstrap(other_dev, other, &theirs);
    e2e_master_list held_theirs = held_of(&theirs);
    CHECK(e2e_sync_decide(&r, &held_theirs) == E2E_SYNC_ELSEWHERE_NO_KEYS);
    CHECK(e2e_sync_plan_elsewhere(E2E_SYNC_ELSEWHERE_NO_KEYS));
    CHECK_STR(e2e_sync_plan_name(E2E_SYNC_ELSEWHERE_NO_KEYS), "no-keys");

    /* A first device: the master here. */
    r.master = vz_account_new();
    r.own = calloc(1, sizeof(*r.own));
    e2e_own_bootstrap(r.account, r.master, r.own);
    CHECK(e2e_own_verify(r.own, r.account));
    e2e_master_list held = held_of(r.own);
    CHECK(e2e_sync_decide(&r, &held) == E2E_SYNC_READY);
    CHECK(!e2e_sync_plan_elsewhere(E2E_SYNC_READY));
    /* grappa lost the list: the master lists again, one above. */
    CHECK(e2e_sync_decide(&r, NULL) == E2E_SYNC_RELIST);
    e2e_own re;
    CHECK(e2e_own_relisted(&r, &re));
    CHECK_LONG(re.list_ver, 2);
    CHECK_LONG(re.cert_ver, 1); /* the cert names the FIRST list */
    CHECK_STR(re.cert, r.own->cert);
    CHECK_STR(re.did, r.own->did);
    CHECK(e2e_own_verify(&re, r.account));
    e2e_master_list held2 = held_of(&re);
    CHECK(e2e_valid_master_list(&held2));
    /* grappa took that relist and the answer was lost: adopt it. */
    CHECK(e2e_sync_decide(&r, &held2) == E2E_SYNC_ADOPT);
    e2e_own ad;
    e2e_own_adopted(r.own, &held2, &ad);
    CHECK_LONG(ad.list_ver, 2);
    CHECK_STR(ad.list_sig, re.list_sig);
    CHECK(e2e_own_verify(&ad, r.account));
    e2e_own_free(&ad);
    /* A higher list that does not verify is never adopted. */
    char *bad_sig = strdup(held2.sig);
    bad_sig[0] = bad_sig[0] == 'A' ? 'B' : 'A';
    held2.sig = bad_sig;
    CHECK(e2e_sync_decide(&r, &held2) == E2E_SYNC_READY);
    free(bad_sig);
    e2e_own_free(&re);
    /* Another master's list on grappa: replaced. */
    CHECK(e2e_sync_decide(&r, &held_theirs) == E2E_SYNC_ELSEWHERE_REPLACED);
    /* Our master's list, naming somebody else: left out. */
    e2e_master_list left = held;
    left.devices[0] = theirs.list_devices.v[0];
    CHECK(e2e_sync_decide(&r, &left) == E2E_SYNC_ELSEWHERE_LEFT_OUT);
    /* Without the master here (a paired device), grappa losing the list
     * cannot be repaired here. */
    vz_account_free(r.master);
    r.master = NULL;
    CHECK(e2e_sync_decide(&r, NULL) == E2E_SYNC_ELSEWHERE_NO_LIST);
    CHECK(!e2e_own_relisted(&r, &re));
    /* A tampered certificate fails the self-check. */
    r.own->cert[0] = r.own->cert[0] == 'A' ? 'B' : 'A';
    CHECK(!e2e_own_verify(r.own, r.account));
    e2e_own_free(&theirs);
    vz_account_free(other);
    vz_account_free(other_dev);
    e2e_record_free(&r);
}

/* ── the fake world: devices, a grappa, a network ── */

#define NOW0 1700000000000LL
#define BUDGET 394

typedef struct {
    char *key, *sig;
} signed_key;

typedef struct {
    const char *name; /* for the event log */
    const char *nick; /* the user's nick on the network */
    e2e_record rec;
    char *e, *k;
    /* what grappa holds for this device, from the bodies it uploaded */
    char *reg_curve, *reg_ed, *reg_sig;
    signed_key otks[64];
    size_t notks;
    signed_key fallback;
    /* for KEYS: the list as the device's master last put it */
    int user; /* index of its user: devices of one user share it */
    bool removed;
    /* its SAS secrets, and the rows its SAS steps wrote */
    e2e_sas_host *sas;
    e2e_rows rows;
} device;

#define MAXDEV 6

typedef struct {
    device dev[MAXDEV];
    size_t ndev;
    int64_t now;
    long next_msgid;
    char log[1 << 16];
    /* the payloads the network carried, for replays */
    char *last_pkmsg_payload, *last_pkmsg_from, *last_pkmsg_msgid;
    /* a payload to corrupt on its way (one body of one MSG) */
    bool tamper_next_msg;
    /* a device whose payloads the network loses */
    const device *mute;
    /* the next sas.mac a device reads has one character of `mac` changed */
    bool tamper_sas_mac;
    /* while set, what devices send waits here, in order, for release_one */
    bool hold;
    struct {
        device *from;
        e2e_outbound o;
    } held[32];
    size_t nheld;
    bool through; /* the next carry is release_one's: it goes, what it sets off is held */
} world;

static e2e_ctx ctx_of(world *w, device *d) {
    return (e2e_ctx){&d->rec, d->nick, BUDGET, w->now};
}

static void logf_(world *w, const char *fmt, ...) __attribute__((format(printf, 2, 3)));
static void logf_(world *w, const char *fmt, ...) {
    size_t n = strlen(w->log);
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(w->log + n, sizeof(w->log) - n, fmt, ap);
    va_end(ap);
    n = strlen(w->log);
    if (n + 1 < sizeof(w->log)) {
        w->log[n] = '\n';
        w->log[n + 1] = 0;
    }
}

static bool logged(world *w, const char *line) {
    char *needle = xfmt("%s\n", line);
    bool ok = strstr(w->log, needle) != NULL;
    if (!ok) fprintf(stderr, "  (log lacks \"%s\"; log:\n%s)\n", line, w->log);
    free(needle);
    return ok;
}

/* What grappa keeps of a device: its register body and its key upload,
 * parsed back exactly as grappa would read them. */
static void upload(device *d) {
    char *reg = e2e_register_body(d->rec.account, d->rec.own->master);
    json_doc *rd = json_parse(reg, strlen(reg), NULL, 0);
    free(d->reg_curve);
    free(d->reg_ed);
    free(d->reg_sig);
    d->reg_curve = strdup(json_string(json_get(json_root(rd), "curve25519")));
    d->reg_ed = strdup(json_string(json_get(json_root(rd), "ed25519")));
    d->reg_sig = strdup(json_string(json_get(json_root(rd), "sig")));
    json_free(rd);
    free(reg);
    char *up = e2e_top_up(d->rec.account, (long)d->notks, d->fallback.key != NULL);
    if (!up) return;
    json_doc *ud = json_parse(up, strlen(up), NULL, 0);
    const json_value *otks = json_get(json_root(ud), "one_time_keys");
    for (size_t i = 0; i < json_len(otks) && d->notks < 64; i++) {
        d->otks[d->notks].key = strdup(json_string(json_get(json_at(otks, i), "key")));
        d->otks[d->notks].sig = strdup(json_string(json_get(json_at(otks, i), "sig")));
        d->notks++;
    }
    const json_value *fb = json_get(json_root(ud), "fallback");
    if (!json_is_null(fb)) {
        free(d->fallback.key);
        free(d->fallback.sig);
        d->fallback.key = strdup(json_string(json_get(fb, "key")));
        d->fallback.sig = strdup(json_string(json_get(fb, "sig")));
    }
    json_free(ud);
    free(up);
    vz_account_mark_keys_as_published(d->rec.account);
}

static device *add_device(world *w, const char *name, const char *nick, int user) {
    device *d = &w->dev[w->ndev++];
    memset(d, 0, sizeof(*d));
    d->name = name;
    d->nick = nick;
    d->user = user;
    e2e_record_new(&d->rec);
    d->e = vz(vz_account_ed25519_key(d->rec.account));
    d->k = vz(vz_account_curve25519_key(d->rec.account));
    d->sas = e2e_sas_host_new();
    return d;
}

/* A first device: its own master, list ver 1. */
static device *add_user(world *w, const char *name, const char *nick, int user) {
    device *d = add_device(w, name, nick, user);
    d->rec.master = vz_account_new();
    d->rec.own = calloc(1, sizeof(*d->rec.own));
    e2e_own_bootstrap(d->rec.account, d->rec.master, d->rec.own);
    upload(d);
    return d;
}

/* What pairing ends with (slice C does it over the relay; the outcome is
 * this): the holder's master lists both devices at ver+1 and certifies the
 * new one at that version. Both devices hold the new list. */
static device *pair_device(world *w, device *holder, const char *name) {
    device *d = add_device(w, name, holder->nick, holder->user);
    e2e_own *h = holder->rec.own;
    long ver = h->list_ver + 1;
    const char *devs[2] = {holder->e, d->e};
    if (strcmp(devs[0], devs[1]) > 0) {
        devs[0] = d->e;
        devs[1] = holder->e;
    }
    char *sig = e2e_sign_list(holder->rec.master, ver, devs, 2);
    for (int i = 0; i < 2; i++) {
        e2e_own *o = i == 0 ? h : (d->rec.own = calloc(1, sizeof(*d->rec.own)));
        if (i == 1) {
            o->master = strdup(h->master);
            o->cert_ver = ver;
            o->cert = e2e_sign_cert(holder->rec.master, ver, d->e);
            char did[E2E_DID_LEN + 1];
            e2e_did(d->e, did);
            o->did = strdup(did);
        }
        for (size_t k = 0; k < o->list_devices.n; k++) free(o->list_devices.v[k]);
        free(o->list_devices.v);
        o->list_devices.v = calloc(2, sizeof(char *));
        o->list_devices.v[0] = strdup(devs[0]);
        o->list_devices.v[1] = strdup(devs[1]);
        o->list_devices.n = 2;
        o->list_ver = ver;
        free(o->list_sig);
        o->list_sig = strdup(sig);
    }
    free(sig);
    upload(d);
    return d;
}

static device *holder_of(world *w, int user) {
    for (size_t i = 0; i < w->ndev; i++)
        if (w->dev[i].user == user && w->dev[i].rec.master) return &w->dev[i];
    return NULL;
}


/* grappa's KEYS for `user`, restricted to `only` when set (a claim): each
 * listed device's id block and its OLDEST one-time key (spent), or its
 * fallback (kept). */
static char *grappa_keys(world *w, int user, const device *only) {
    device *h = holder_of(w, user);
    e2e_own *o = h->rec.own;
    e2e_keys_build_entry entries[E2E_MAX_DEVICES] = {{0}};
    size_t n = 0;
    char *spent[E2E_MAX_DEVICES][2];
    size_t nspent = 0;
    for (size_t i = 0; i < o->list_devices.n; i++) {
        device *d = NULL;
        for (size_t k = 0; k < w->ndev; k++)
            if (strcmp(w->dev[k].e, o->list_devices.v[i]) == 0) d = &w->dev[k];
        if (!d || d->removed || (only && d != only)) continue;
        e2e_keys_build_entry *e = &entries[n++];
        e->curve25519 = d->reg_curve;
        e->ed25519 = d->reg_ed;
        e->sig = d->reg_sig;
        if (d->notks > 0) {
            spent[nspent][0] = d->otks[0].key;
            spent[nspent][1] = d->otks[0].sig;
            e->otk_key = spent[nspent][0];
            e->otk_sig = spent[nspent][1];
            nspent++;
            memmove(d->otks, d->otks + 1, (d->notks - 1) * sizeof(d->otks[0]));
            d->notks--;
            e->otk_fallback = false;
        } else {
            e->otk_key = d->fallback.key;
            e->otk_sig = d->fallback.sig;
            e->otk_fallback = true;
        }
    }
    char *keys = e2e_keys_payload(o->master, o->list_ver, (const char *const *)o->list_devices.v,
                                  o->list_devices.n, o->list_sig, entries, n);
    for (size_t i = 0; i < nspent; i++) {
        free(spent[i][0]);
        free(spent[i][1]);
    }
    return keys;
}

static void log_result(world *w, device *d, const e2e_result *r) {
    for (size_t i = 0; i < r->nevents; i++) {
        const e2e_event *e = &r->events[i];
        switch (e->kind) {
        case E2E_EV_RECEIVED:
            logf_(w, "%s received %s from %s%s", d->name, e->inner, e->nick,
                  e->verified ? " verified" : "");
            break;
        case E2E_EV_KEY_ALARM: logf_(w, "%s key_alarm %s", d->name, e->nick); break;
        case E2E_EV_UNDECRYPTABLE:
            logf_(w, "%s undecryptable %s", d->name, e2e_undecryptable_reason_name(e->undecryptable));
            break;
        case E2E_EV_REPLAYED: logf_(w, "%s replayed", d->name); break;
        case E2E_EV_DROPPED:
            logf_(w, "%s dropped %s %s", d->name, e2e_drop_reason_name(e->drop),
                  e2e_verb_name(e->verb));
            break;
        case E2E_EV_SEND_QUEUED: logf_(w, "%s queued %s", d->name, e->tag); break;
        case E2E_EV_SEND_FAILED:
            logf_(w, "%s failed %s %s", d->name, e2e_send_failure_name(e->failure), e->tags.v[0]);
            break;
        case E2E_EV_REKEYING: logf_(w, "%s rekeying %s", d->name, e->nick); break;
        case E2E_EV_KEYS_ASKED: logf_(w, "%s keys_asked", d->name); break;
        case E2E_EV_KEYS_RENEWED: logf_(w, "%s keys_renewed", d->name); break;
        case E2E_EV_KEYS_UNANSWERED: logf_(w, "%s keys_unanswered", d->name); break;
        case E2E_EV_SIBLING_KEYS_NEEDED: logf_(w, "%s sibling_keys_needed", d->name); break;
        case E2E_EV_COPIED:
            logf_(w, "%s copied %.*s to %s", d->name, (int)e->body_len, e->body, e->peer);
            break;
        }
    }
}

static void pump(world *w, device *from, e2e_result *r, int depth);

/* Hands one outbound payload to grappa: it names it, and carries it. */
static void carry(world *w, device *from, const e2e_outbound *o, int depth) {
    bool through = w->through;
    w->through = false;
    if (w->hold && !through && w->nheld < 32) {
        e2e_outbound *h = &w->held[w->nheld].o;
        w->held[w->nheld++].from = from;
        *h = *o;
        h->target = strdup(o->target);
        h->from = strdup(o->from);
        h->to = strdup(o->to);
        h->payload = strdup(o->payload);
        h->tag = o->tag ? strdup(o->tag) : NULL;
        return;
    }
    char msgid[12];
    snprintf(msgid, sizeof(msgid), "m%010ld", w->next_msgid++);
    e2e_ctx fc = ctx_of(w, from);
    if (o->ref) e2e_sent_ok(&fc, o->ref, msgid);
    int target_user = -1;
    for (size_t i = 0; i < w->ndev; i++)
        if (e2e_nick_eq(w->dev[i].nick, o->target)) target_user = w->dev[i].user;
    if (target_user < 0) return;
    if (o->verb == E2E_VERB_KEYREQ) {
        char *keys = grappa_keys(w, target_user, NULL);
        e2e_result res;
        e2e_result_init(&res);
        e2e_receive(&fc, o->target, E2E_VERB_KEYS, msgid, "*", keys, &res);
        free(keys);
        pump(w, from, &res, depth + 1);
        return;
    }
    for (size_t i = 0; i < w->ndev; i++) {
        device *d = &w->dev[i];
        if (d->user != target_user || d->removed) continue;
        if (o->verb == E2E_VERB_NACK && strcmp(o->to, d->rec.own->did) != 0) continue;
        char *payload = strdup(o->payload);
        if (o->verb == E2E_VERB_MSG && w->tamper_next_msg) {
            /* One character of the body, deep inside the ciphertext. */
            char *b = strstr(payload, "\"bodies\":{\"");
            char *v = b ? strchr(b + 11, ':') : NULL;
            if (v) v[20] = v[20] == 'A' ? 'B' : 'A';
            w->tamper_next_msg = false;
        }
        if (o->verb == E2E_VERB_PKMSG) {
            free(w->last_pkmsg_payload);
            free(w->last_pkmsg_from);
            free(w->last_pkmsg_msgid);
            w->last_pkmsg_payload = strdup(payload);
            w->last_pkmsg_from = strdup(o->from);
            w->last_pkmsg_msgid = strdup(msgid);
        }
        e2e_ctx dc = ctx_of(w, d);
        e2e_result res;
        e2e_result_init(&res);
        e2e_receive(&dc, from->nick, o->verb, msgid, o->from, payload, &res);
        free(payload);
        pump(w, d, &res, depth + 1);
    }
}

/* The oldest payload held: carried now (what it sets off may be held). */
static void release_one(world *w) {
    if (w->nheld == 0) return;
    device *from = w->held[0].from;
    e2e_outbound o = w->held[0].o;
    memmove(&w->held[0], &w->held[1], (w->nheld - 1) * sizeof(w->held[0]));
    w->nheld--;
    w->through = true;
    carry(w, from, &o, 0);
    free(o.target);
    free(o.from);
    free(o.to);
    free(o.payload);
    free(o.tag);
}

static void release_all(world *w) {
    w->hold = false;
    while (w->nheld) release_one(w);
}

/* A sas.* the engine delivered to `d`: its verifier reads it, as cic's
 * client hands every received sas.* to the Verifier. */
static void sas_hand(world *w, device *d, const e2e_event *e, int depth) {
    char *inner = strdup(e->inner);
    if (w->tamper_sas_mac && strstr(inner, "\"sas.mac\"")) {
        char *m = strstr(inner, "\"mac\":\"");
        if (m) m[8] = m[8] == 'A' ? 'B' : 'A';
        w->tamper_sas_mac = false;
    }
    e2e_ctx c = ctx_of(w, d);
    e2e_result sr;
    e2e_result_init(&sr);
    size_t before = d->rows.n;
    e2e_sas_receive(&c, d->sas, e->nick, e->master, e->device, inner, NULL, &sr, &d->rows);
    for (size_t i = before; i < d->rows.n; i++) {
        const e2e_row *row = &d->rows.v[i];
        logf_(w, "%s row %s%s%s%s", d->name, e2e_row_kind_name(row->kind),
              row->kind == E2E_ROW_SAS_ASKED || row->kind == E2E_ROW_SAS_CANCELLED
                  ? (row->by_peer ? " by peer" : " by you")
                  : "",
              row->body ? " " : "", row->body ? row->body : "");
    }
    free(inner);
    pump(w, d, &sr, depth + 1);
}

/* Logs what a step said, carries what it sent, and frees it. */
static void pump(world *w, device *from, e2e_result *r, int depth) {
    log_result(w, from, r);
    if (depth > 12) abort(); /* two engines echoing forever is a bug */
    for (size_t i = 0; from == w->mute && i < r->noutbound; i++)
        logf_(w, "%s lost %s", from->name, e2e_verb_name(r->outbound[i].verb));
    for (size_t i = 0; from != w->mute && i < r->noutbound; i++)
        carry(w, from, &r->outbound[i], depth);
    for (size_t i = 0; i < r->nevents; i++)
        if (r->events[i].kind == E2E_EV_RECEIVED && strstr(r->events[i].inner, "\"t\":\"sas."))
            sas_hand(w, from, &r->events[i], depth);
    e2e_result_free(r);
}

static void send_text(world *w, device *d, const char *to, const char *text, const char *tag) {
    e2e_ctx c = ctx_of(w, d);
    e2e_result r;
    e2e_result_init(&r);
    char *inner = e2e_inner_text(text, strlen(text));
    CHECK(e2e_send(&c, to, inner, tag, 0, NULL, &r));
    free(inner);
    pump(w, d, &r, 0);
}

static void world_free(world *w) {
    for (size_t i = 0; i < w->ndev; i++) {
        device *d = &w->dev[i];
        e2e_record_free(&d->rec);
        free(d->e);
        free(d->k);
        free(d->reg_curve);
        free(d->reg_ed);
        free(d->reg_sig);
        for (size_t k = 0; k < d->notks; k++) {
            free(d->otks[k].key);
            free(d->otks[k].sig);
        }
        free(d->fallback.key);
        free(d->fallback.sig);
        e2e_sas_host_free(d->sas);
        e2e_rows_free(&d->rows);
    }
    free(w->last_pkmsg_payload);
    free(w->last_pkmsg_from);
    free(w->last_pkmsg_msgid);
}

static void reload(device *d) {
    char *json = e2e_record_to_json(&d->rec);
    e2e_record_free(&d->rec);
    CHECK(e2e_record_from_json(json, strlen(json), &d->rec));
    char *again = e2e_record_to_json(&d->rec);
    CHECK_STR(again, json); /* the round trip is exact */
    free(again);
    free(json);
}

static size_t outbound_count(const e2e_result *r, e2e_verb verb) {
    size_t n = 0;
    for (size_t i = 0; i < r->noutbound; i++) n += r->outbound[i].verb == verb;
    return n;
}

TEST(two_engines_talk) {
    static world w; /* big log: keep it off the stack */
    memset(&w, 0, sizeof(w));
    w.now = NOW0;
    w.next_msgid = 1;
    device *alice = add_user(&w, "alice", "alice", 0);
    device *bob = add_user(&w, "bob", "Bob", 1);

    /* First contact: queued, keys asked for. */
    e2e_ctx ac = ctx_of(&w, alice);
    e2e_result r;
    e2e_result_init(&r);
    char *inner = e2e_inner_text("hello", 5);
    CHECK(e2e_send(&ac, "bob", inner, "t1", 0, NULL, &r));
    free(inner);
    CHECK(r.nevents == 1 && r.events[0].kind == E2E_EV_SEND_QUEUED);
    CHECK(r.noutbound == 1 && r.outbound[0].verb == E2E_VERB_KEYREQ);
    CHECK_STR(r.outbound[0].to, "*");
    CHECK_STR(r.outbound[0].payload, "{\"v\":2}");
    CHECK(r.outbound[0].priority == E2E_PRIO_CONTROL);
    char *door = e2e_outbound_body(&r.outbound[0]);
    char *want = xfmt("{\"target\":\"bob\",\"verb\":\"keyreq\",\"from\":\"%s\",\"to\":\"*\","
                      "\"payload\":\"{\\\"v\\\":2}\",\"priority\":\"control\"}",
                      alice->rec.own->did);
    CHECK_STR(door, want);
    free(door);
    free(want);
    pump(&w, alice, &r, 0);

    /* KEYS → PKMSG → bob reads it, pins alice on first use, and asks her
     * for her list (he holds none); she answers it. */
    CHECK(logged(&w, "bob received {\"t\":\"text\",\"body\":\"hello\"} from alice"));
    CHECK(strstr(w.log, "failed") == NULL);
    e2e_ctx bc = ctx_of(&w, bob);
    const char *pinned;
    bool verified;
    size_t trusted;
    CHECK(e2e_pinned(&bc, "ALICE", &pinned, &verified, &trusted));
    CHECK_STR(pinned, alice->rec.own->master);
    CHECK(!verified && trusted == 1);
    CHECK(e2e_pinned(&ac, "bob", &pinned, &verified, &trusted));
    CHECK_STR(pinned, bob->rec.own->master);
    e2e_master *am = NULL;
    for (size_t i = 0; i < bob->rec.state.nmasters; i++)
        if (strcmp(bob->rec.state.masters[i].ed25519, alice->rec.own->master) == 0)
            am = &bob->rec.state.masters[i];
    CHECK(am && am->ver == 1); /* the t:list arrived and was applied */
    CHECK(bob->rec.state.seen.n == 1);

    /* Bob answers on the session alice opened: a MSG now. */
    w.now += 1000;
    bc = ctx_of(&w, bob);
    e2e_result_init(&r);
    inner = e2e_inner_text("hi", 2);
    CHECK(e2e_send(&bc, "alice", inner, "b1", 0, NULL, &r));
    free(inner);
    CHECK(outbound_count(&r, E2E_VERB_MSG) == 1 && outbound_count(&r, E2E_VERB_PKMSG) == 0);
    pump(&w, bob, &r, 0);
    CHECK(logged(&w, "alice received {\"t\":\"text\",\"body\":\"hi\"} from Bob"));

    /* The same PKMSG again: its session is held and its key spent — the
     * replay reads nothing and is NACKed. */
    char *replay = strdup(w.last_pkmsg_payload);
    char *replay_from = strdup(w.last_pkmsg_from);
    bc = ctx_of(&w, bob);
    e2e_result_init(&r);
    e2e_receive(&bc, "alice", E2E_VERB_PKMSG, "mREPLAY0001", replay_from, replay, &r);
    CHECK(r.nevents == 1 && r.events[0].kind == E2E_EV_UNDECRYPTABLE);
    CHECK(r.events[0].undecryptable == E2E_UNDEC_DECRYPTION_FAILED);
    CHECK(r.noutbound == 1 && r.outbound[0].verb == E2E_VERB_NACK);
    CHECK_STR(r.outbound[0].payload, "{\"v\":2,\"ref\":\"mREPLAY0001\"}");
    CHECK_STR(r.outbound[0].to, replay_from);
    e2e_result_free(&r);

    /* With the session gone (a lost state), the replay set still knows it. */
    e2e_record copy;
    char *json = e2e_record_to_json(&bob->rec);
    CHECK(e2e_record_from_json(json, strlen(json), &copy));
    free(json);
    for (size_t i = 0; i < copy.state.nsessions; i++) {
        for (size_t k = 0; k < copy.state.sessions[i].pickles.n; k++)
            free(copy.state.sessions[i].pickles.v[k]);
        copy.state.sessions[i].pickles.n = 0;
    }
    e2e_ctx cc = {&copy, "Bob", BUDGET, w.now};
    e2e_result_init(&r);
    e2e_receive(&cc, "alice", E2E_VERB_PKMSG, "mREPLAY0002", replay_from, replay, &r);
    bool replayed = false, nacked = false;
    for (size_t i = 0; i < r.nevents; i++) {
        replayed = replayed || r.events[i].kind == E2E_EV_REPLAYED;
        nacked = nacked || (r.events[i].kind == E2E_EV_UNDECRYPTABLE &&
                            r.events[i].undecryptable == E2E_UNDEC_REPLAYED_SESSION);
        CHECK(r.events[i].kind != E2E_EV_RECEIVED);
    }
    CHECK(replayed && nacked);
    CHECK(outbound_count(&r, E2E_VERB_NACK) == 1);
    e2e_result_free(&r);
    e2e_record_free(&copy);
    free(replay);
    free(replay_from);

    /* A tampered body: bob NACKs it; alice re-keys (after the KEYREQ
     * budget), and the message reaches bob on a fresh session. */
    w.now += 31000;
    w.tamper_next_msg = true;
    send_text(&w, alice, "bob", "secret", "t2");
    CHECK(logged(&w, "bob undecryptable decryption-failed"));
    CHECK(logged(&w, "alice rekeying Bob"));
    CHECK(logged(&w, "bob received {\"t\":\"text\",\"body\":\"secret\"} from alice"));
    CHECK(strstr(w.log, "failed resend") == NULL);

    /* A NACK of the re-send: a message goes out at most twice. */
    {
        const e2e_sent *last = &alice->rec.state.sent[alice->rec.state.nsent - 1];
        CHECK(last->msg.sends == 2 && last->msgid != NULL);
        char *nack = e2e_nack_payload(last->msgid);
        ac = ctx_of(&w, alice);
        e2e_result_init(&r);
        e2e_receive(&ac, "bob", E2E_VERB_NACK, "mNACK000001", bob->rec.own->did, nack, &r);
        CHECK(r.nevents == 1 && r.events[0].kind == E2E_EV_SEND_FAILED &&
              r.events[0].failure == E2E_FAIL_RESEND_FAILED);
        CHECK(r.nevents == 1 && strcmp(r.events[0].tags.v[0], "t2") == 0);
        CHECK(r.noutbound == 0);
        e2e_result_free(&r);
        /* The same NACK again names nothing. */
        e2e_result_init(&r);
        e2e_receive(&ac, "bob", E2E_VERB_NACK, "mNACK000002", bob->rec.own->did, nack, &r);
        CHECK(r.nevents == 1 && r.events[0].drop == E2E_DROP_UNKNOWN_NACK_REF);
        e2e_result_free(&r);
        free(nack);
    }

    /* The state survives a save and a load in the middle of it all. */
    reload(alice);
    reload(bob);
    w.now += 1000;
    send_text(&w, bob, "alice", "after reload", "b2");
    CHECK(logged(&w, "alice received {\"t\":\"text\",\"body\":\"after reload\"} from Bob"));
    send_text(&w, alice, "bob", "and back", "t3");
    CHECK(logged(&w, "bob received {\"t\":\"text\",\"body\":\"and back\"} from alice"));

    /* A KEYS presenting another master on bob's nick: the alarm, nothing
     * stored, nothing sent. */
    device *mallory = add_user(&w, "mallory", "mallory", 2);
    w.now += 31000;
    ac = ctx_of(&w, alice);
    e2e_result_init(&r);
    e2e_ask_keys(&ac, "bob", &r);
    CHECK(outbound_count(&r, E2E_VERB_KEYREQ) == 1);
    e2e_result_free(&r);
    char *fake = grappa_keys(&w, mallory->user, NULL);
    size_t sessions_before = alice->rec.state.nsessions;
    e2e_result_init(&r);
    e2e_receive(&ac, "bob", E2E_VERB_KEYS, "mALARM00001", "*", fake, &r);
    CHECK(r.nevents == 1 && r.events[0].kind == E2E_EV_KEY_ALARM);
    CHECK_STR(r.events[0].pinned, bob->rec.own->master);
    CHECK_STR(r.events[0].presented, mallory->rec.own->master);
    CHECK(r.noutbound == 0 && alice->rec.state.nsessions == sessions_before);
    e2e_result_free(&r);
    free(fake);
    CHECK(e2e_pinned(&ac, "bob", &pinned, &verified, &trusted));
    CHECK_STR(pinned, bob->rec.own->master);

    /* A KEYS whose list signature fails: bad-list. And one nobody asked
     * for: unsolicited. */
    w.now += 31000;
    ac = ctx_of(&w, alice);
    e2e_result_init(&r);
    e2e_ask_keys(&ac, "bob", &r);
    e2e_result_free(&r);
    char *keys = grappa_keys(&w, bob->user, NULL);
    char *sig = strstr(keys, "\"sig\":\"");
    sig[10] = sig[10] == 'A' ? 'B' : 'A'; /* the master block's sig comes first */
    e2e_result_init(&r);
    e2e_receive(&ac, "bob", E2E_VERB_KEYS, "mBADLIST001", "*", keys, &r);
    CHECK(r.nevents == 1 && r.events[0].kind == E2E_EV_DROPPED &&
          r.events[0].drop == E2E_DROP_BAD_LIST);
    e2e_result_free(&r);
    free(keys);
    keys = grappa_keys(&w, bob->user, NULL);
    e2e_result_init(&r);
    e2e_receive(&ac, "carol", E2E_VERB_KEYS, "mUNSOL00001", "*", keys, &r);
    CHECK(r.nevents == 1 && r.events[0].drop == E2E_DROP_UNSOLICITED_KEYS);
    e2e_result_free(&r);
    /* Garbage is reported, never a crash. */
    e2e_result_init(&r);
    e2e_receive(&ac, "bob", E2E_VERB_MSG, "mGARBAGE001", bob->rec.own->did, "{\"v\":2", &r);
    CHECK(r.nevents == 1 && r.events[0].drop == E2E_DROP_UNDECODABLE_PAYLOAD);
    e2e_result_free(&r);
    e2e_result_init(&r);
    e2e_receive(&ac, "bob", E2E_VERB_MSG, "mGARBAGE002", bob->rec.own->did,
                "{\"v\":2,\"ck\":\"nope\",\"bodies\":{\"aaaaaaaaaaa\":\"B\"}}", &r);
    CHECK(r.nevents == 1 && r.events[0].drop == E2E_DROP_BAD_PAYLOAD);
    e2e_result_free(&r);
    free(keys);

    /* The user takes the alarm's key: re-pinned, and bob's sessions go. */
    ac = ctx_of(&w, alice);
    e2e_result_init(&r);
    CHECK(e2e_pin(&ac, "bob", mallory->rec.own->master, false, &r) == E2E_PIN_PINNED);
    e2e_result_free(&r);
    CHECK(e2e_pin(&ac, "bob", alice->rec.own->master, true, &r) == E2E_PIN_OWN_KEY);
    CHECK(e2e_pin(&ac, "bob", "nope", true, &r) == E2E_PIN_BAD_KEY);
    for (size_t i = 0; i < alice->rec.state.nsessions; i++)
        CHECK(strcmp(alice->rec.state.sessions[i].curve, bob->k) != 0);

    world_free(&w);
}

TEST(two_devices_one_message) {
    static world w;
    memset(&w, 0, sizeof(w));
    w.now = NOW0;
    w.next_msgid = 1;
    device *carol = add_user(&w, "carol", "carol", 0);
    device *bob1 = add_user(&w, "bob1", "bob", 1);
    device *bob2 = pair_device(&w, bob1, "bob2");
    upload(bob1); /* bob1's id block still under the same master */

    e2e_ctx c = ctx_of(&w, carol);
    e2e_result r;
    e2e_result_init(&r);
    char *inner = e2e_inner_text("to both", 7);
    CHECK(e2e_send(&c, "bob", inner, "c1", 0, NULL, &r));
    free(inner);
    CHECK(outbound_count(&r, E2E_VERB_KEYREQ) == 1);
    e2e_result_free(&r);
    /* The KEYS names both; one PKMSG with two bodies, to "*". */
    char *keys = grappa_keys(&w, 1, NULL);
    e2e_result_init(&r);
    e2e_receive(&c, "bob", E2E_VERB_KEYS, "mKEYS000001", "*", keys, &r);
    free(keys);
    CHECK(outbound_count(&r, E2E_VERB_PKMSG) == 1);
    const e2e_outbound *pk = NULL;
    for (size_t i = 0; i < r.noutbound; i++)
        if (r.outbound[i].verb == E2E_VERB_PKMSG) pk = &r.outbound[i];
    CHECK(pk && strcmp(pk->to, "*") == 0);
    e2e_payload p;
    bool u;
    CHECK(pk && e2e_payload_parse(E2E_VERB_PKMSG, pk->payload, &p, &u, NULL, 0));
    CHECK(p.nbodies == 2);
    CHECK(e2e_payload_body(&p, bob1->rec.own->did) && e2e_payload_body(&p, bob2->rec.own->did));
    e2e_payload_free(&p);
    /* What bob2 says back is lost: carol's session to it stays pre-key. */
    w.mute = bob2;
    pump(&w, carol, &r, 0);
    CHECK(logged(&w, "bob2 lost msg")); /* its listreq */
    CHECK(logged(&w, "bob1 received {\"t\":\"text\",\"body\":\"to both\"} from carol"));
    CHECK(logged(&w, "bob2 received {\"t\":\"text\",\"body\":\"to both\"} from carol"));

    /* bob1 answers, bob2 does not: carol's next message is a MSG for bob1
     * and a PKMSG for bob2 — never both kinds in one, the MSG first. */
    w.now += 1000;
    send_text(&w, bob1, "carol", "only me", "b1");
    CHECK(logged(&w, "carol received {\"t\":\"text\",\"body\":\"only me\"} from bob"));
    w.now += 1000;
    c = ctx_of(&w, carol);
    e2e_result_init(&r);
    inner = e2e_inner_text("mixed", 5);
    CHECK(e2e_send(&c, "bob", inner, "c2", 0, NULL, &r));
    free(inner);
    CHECK(r.noutbound == 2);
    if (r.noutbound == 2) {
        CHECK(r.outbound[0].verb == E2E_VERB_MSG && r.outbound[1].verb == E2E_VERB_PKMSG);
        CHECK_STR(r.outbound[0].to, bob1->rec.own->did);
        CHECK_STR(r.outbound[1].to, bob2->rec.own->did);
        CHECK(r.outbound[0].ref != r.outbound[1].ref && r.outbound[0].ref && r.outbound[1].ref);
    }
    pump(&w, carol, &r, 0);
    w.mute = NULL;
    CHECK(logged(&w, "bob1 received {\"t\":\"text\",\"body\":\"mixed\"} from carol"));
    CHECK(logged(&w, "bob2 received {\"t\":\"text\",\"body\":\"mixed\"} from carol"));

    /* A body for a sibling only: bob1 says nothing, the sibling reads it. */
    e2e_ctx b1 = ctx_of(&w, bob1);
    e2e_body only2 = {bob2->rec.own->did, "AAAA"};
    char *msg = e2e_msg_payload(carol->k, &only2, 1);
    e2e_result_init(&r);
    e2e_receive(&b1, "carol", E2E_VERB_MSG, "mSIB0000001", carol->rec.own->did, msg, &r);
    CHECK(r.nevents == 1 && r.events[0].drop == E2E_DROP_NOT_FOR_US && r.noutbound == 0);
    e2e_result_free(&r);
    free(msg);
    /* A body for none of bob's devices: NACKed not-for-our-devices. */
    e2e_body stranger = {"aaaaaaaaaaa", "AAAA"};
    msg = e2e_msg_payload(carol->k, &stranger, 1);
    e2e_result_init(&r);
    e2e_receive(&b1, "carol", E2E_VERB_MSG, "mSTR0000001", carol->rec.own->did, msg, &r);
    CHECK(r.nevents == 1 && r.events[0].undecryptable == E2E_UNDEC_NOT_FOR_OUR_DEVICES);
    CHECK(outbound_count(&r, E2E_VERB_NACK) == 1);
    e2e_result_free(&r);
    free(msg);

    /* bob1 copies what it sent to its sibling: keys claimed, copy read. */
    e2e_id_block blk = {bob2->reg_curve, bob2->reg_ed, bob2->reg_sig};
    e2e_result_init(&r);
    e2e_set_siblings(&b1, &blk, 1, &r);
    CHECK(r.nevents == 0);
    e2e_result_free(&r);
    e2e_result_init(&r);
    e2e_copy(&b1, "carol", "my words", 8, &r);
    CHECK(r.nevents == 1 && r.events[0].kind == E2E_EV_SIBLING_KEYS_NEEDED);
    CHECK_STR(r.events[0].did, bob2->rec.own->did);
    e2e_result_free(&r);
    char *claim = grappa_keys(&w, 1, bob2);
    e2e_result_init(&r);
    e2e_sibling_keys(&b1, bob2->rec.own->did, claim, &r);
    free(claim);
    CHECK(r.ncopies == 1 && r.copies[0].verb == E2E_VERB_PKMSG);
    CHECK_STR(r.copies[0].to, bob2->rec.own->did);
    e2e_ctx b2 = ctx_of(&w, bob2);
    e2e_result r2;
    e2e_result_init(&r2);
    e2e_receive_copy(&b2, bob1->rec.own->did, r.copies[0].verb, r.copies[0].payload, &r2);
    log_result(&w, bob2, &r2);
    CHECK(logged(&w, "bob2 copied my words to carol"));
    e2e_result_free(&r2);
    e2e_result_free(&r);
    /* A copy is never read on the peer path: our own master is refused. */
    e2e_result_init(&r);
    e2e_copy(&b1, "carol", "again", 5, &r);
    CHECK(r.ncopies == 1);
    e2e_result_init(&r2);
    e2e_receive(&b2, "bob", r.copies[0].verb, "mCOPY000001", bob1->rec.own->did,
                r.copies[0].payload, &r2);
    bool refused = false;
    for (size_t i = 0; i < r2.nevents; i++) {
        CHECK(r2.events[i].kind != E2E_EV_RECEIVED);
        refused = refused || r2.events[i].kind == E2E_EV_UNDECRYPTABLE ||
                  (r2.events[i].kind == E2E_EV_DROPPED &&
                   r2.events[i].drop == E2E_DROP_OWN_IDENTITY);
    }
    CHECK(refused);
    e2e_result_free(&r2);
    e2e_result_free(&r);
    world_free(&w);
}

/* The first message to bob, built but not carried. */
static char *first_pkmsg(world *w, device *from, device *to, const char *keys) {
    e2e_ctx c = ctx_of(w, from);
    e2e_result r;
    e2e_result_init(&r);
    char *inner = e2e_inner_text("x", 1);
    e2e_send(&c, to->nick, inner, "p", 0, NULL, &r);
    free(inner);
    e2e_result_free(&r);
    e2e_result_init(&r);
    e2e_receive(&c, to->nick, E2E_VERB_KEYS, "mKEYS000001", "*", keys, &r);
    char *out = NULL;
    for (size_t i = 0; i < r.noutbound; i++)
        if (r.outbound[i].verb == E2E_VERB_PKMSG) out = strdup(r.outbound[i].payload);
    e2e_result_free(&r);
    return out;
}

static void receive1(world *w, device *d, const char *nick, e2e_verb verb, const char *from_did,
                     const char *payload, e2e_result *r) {
    e2e_ctx c = ctx_of(w, d);
    e2e_result_init(r);
    e2e_receive(&c, nick, verb, "mTEST000001", from_did, payload, r);
}

TEST(receiver_checks) {
    static world w;
    memset(&w, 0, sizeof(w));
    w.now = NOW0;
    device *alice = add_user(&w, "alice", "alice", 0);
    device *bob = add_user(&w, "bob", "bob", 1);
    e2e_result r;

    /* A KEYS whose one-time key is not signed by its device: no session. */
    char *keys = grappa_keys(&w, 1, NULL);
    char *otk = strstr(keys, "\"otk\":{\"key\":\"");
    char *osig = strstr(otk, "\"sig\":\"") + 7;
    osig[5] = osig[5] == 'A' ? 'B' : 'A';
    e2e_ctx ac = ctx_of(&w, alice);
    e2e_result_init(&r);
    e2e_ask_keys(&ac, "bob", &r);
    e2e_result_free(&r);
    receive1(&w, alice, "bob", E2E_VERB_KEYS, "*", keys, &r);
    CHECK(r.nevents == 1 && r.events[0].drop == E2E_DROP_BAD_OTK_SIGNATURE);
    CHECK(alice->rec.state.nsessions == 0);
    e2e_result_free(&r);
    free(keys);

    /* A PKMSG whose certificate fails: dropped, no NACK, no pin. */
    w.now += 31000;
    keys = grappa_keys(&w, 1, NULL);
    char *pk = first_pkmsg(&w, alice, bob, keys);
    free(keys);
    CHECK(pk != NULL);
    if (!pk) {
        world_free(&w);
        return;
    }
    char *bad = strdup(pk);
    char *cert = strstr(bad, "\"cert\":\"") + 8;
    cert[3] = cert[3] == 'A' ? 'B' : 'A';
    receive1(&w, bob, "alice", E2E_VERB_PKMSG, alice->rec.own->did, bad, &r);
    CHECK(r.nevents == 1 && r.events[0].drop == E2E_DROP_BAD_CERT && r.noutbound == 0);
    e2e_result_free(&r);
    e2e_ctx bc = ctx_of(&w, bob);
    const char *pinned;
    bool verified;
    size_t trusted;
    CHECK(!e2e_pinned(&bc, "alice", &pinned, &verified, &trusted));
    free(bad);
    /* From another did than its id block's: bad-from. */
    receive1(&w, bob, "alice", E2E_VERB_PKMSG, "aaaaaaaaaaa", pk, &r);
    CHECK(r.nevents == 1 && r.events[0].drop == E2E_DROP_BAD_FROM && r.noutbound == 0);
    e2e_result_free(&r);
    free(pk);

    /* An inner whose fb binds another pair: the session is discarded, its
     * id stays seen, nothing is delivered. Built by hand, as an attacker
     * holding alice's keys for another recipient would. */
    vz_session *ss = vz_account_create_outbound_session(alice->rec.account, bob->reg_curve,
                                                        bob->fallback.key);
    CHECK(ss != NULL);
    char wrong[E2E_FB_LEN + 1];
    e2e_fb(alice->e, alice->e, wrong);
    char *inner = xfmt("{\"t\":\"text\",\"body\":\"forged\",\"lv\":1,\"fb\":\"%s\"}", wrong);
    size_t type;
    vz_buf body;
    CHECK(vz_session_encrypt(ss, (const uint8_t *)inner, strlen(inner), &type, &body) == 0);
    char *b64 = e2e_base64(body.ptr, body.len);
    char *sid = vz(vz_pre_key_session_id(body.ptr, body.len));
    vz_buf_free(body);
    vz_session_free(ss);
    free(inner);
    e2e_body one = {bob->rec.own->did, b64};
    pk = e2e_pkmsg_payload(alice->rec.account, alice->rec.own->master, alice->rec.own->cert,
                           alice->rec.own->cert_ver, &one, 1);
    size_t seen_before = bob->rec.state.seen.n;
    receive1(&w, bob, "alice", E2E_VERB_PKMSG, alice->rec.own->did, pk, &r);
    bool mismatch = false;
    for (size_t i = 0; i < r.nevents; i++) {
        CHECK(r.events[i].kind != E2E_EV_RECEIVED);
        mismatch = mismatch || r.events[i].drop == E2E_DROP_INNER_KEY_MISMATCH;
    }
    CHECK(mismatch && r.noutbound == 0);
    CHECK(bob->rec.state.seen.n == seen_before + 1);
    CHECK_STR(bob->rec.state.seen.v[bob->rec.state.seen.n - 1], sid);
    CHECK(bob->rec.state.nsessions == 0);
    e2e_result_free(&r);
    free(pk);
    free(b64);
    free(sid);
    world_free(&w);
}

TEST(sending_refusals) {
    static world w;
    memset(&w, 0, sizeof(w));
    w.now = NOW0;
    device *a = add_user(&w, "a", "a", 0);
    e2e_ctx c = ctx_of(&w, a);
    e2e_result r;
    e2e_result_init(&r);
    char *inner = e2e_inner_text("x", 1);
    CHECK(e2e_send(&c, "A", inner, "own", 0, NULL, &r));
    CHECK(r.nevents == 1 && r.events[0].failure == E2E_FAIL_OWN_NICK && r.noutbound == 0);
    e2e_result_free(&r);
    c.frame_budget_base = -1;
    e2e_result_init(&r);
    CHECK(e2e_send(&c, "b", inner, "nb", 0, NULL, &r));
    CHECK(r.nevents == 1 && r.events[0].failure == E2E_FAIL_NO_BUDGET && r.noutbound == 0);
    e2e_result_free(&r);
    c.frame_budget_base = BUDGET;
    CHECK(!e2e_send(&c, "b", inner, E2E_LIST_TAG, 0, NULL, &r));
    e2e_result_init(&r);
    CHECK(e2e_send(&c, "b", "[1]", "bad", 0, NULL, &r));
    CHECK(r.nevents == 1 && r.events[0].failure == E2E_FAIL_UNENCODABLE);
    e2e_result_free(&r);
    /* Queued, then the nick is gone: no-such-nick. */
    e2e_result_init(&r);
    CHECK(e2e_send(&c, "b", inner, "q1", 0, NULL, &r));
    CHECK(e2e_waits_on_the_clock(&c));
    e2e_result_free(&r);
    e2e_result_init(&r);
    e2e_absent(&c, "B", &r);
    CHECK(r.nevents == 1 && r.events[0].failure == E2E_FAIL_NO_SUCH_NICK);
    CHECK_STR(r.events[0].tags.v[0], "q1");
    e2e_result_free(&r);
    CHECK(!e2e_waits_on_the_clock(&c));
    /* Queued, then nothing answers: keys-timeout from the tick. */
    e2e_result_init(&r);
    CHECK(e2e_send(&c, "b", inner, "q2", 0, NULL, &r));
    CHECK(outbound_count(&r, E2E_VERB_KEYREQ) == 1); /* the budget went with the 401 */
    e2e_result_free(&r);
    c.now_ms += E2E_OUTQ_TTL_MS + 1;
    e2e_result_init(&r);
    e2e_tick(&c, &r);
    CHECK(r.nevents == 1 && r.events[0].failure == E2E_FAIL_KEYS_TIMEOUT);
    e2e_result_free(&r);
    free(inner);
    world_free(&w);
}

/* ── the store ── */

static bool child_cannot_lock(const char *dir) {
    pid_t pid = fork();
    if (pid == 0) {
        e2e_store *st;
        e2e_store_status s = e2e_store_open(dir, &st, NULL, 0);
        _exit(s == E2E_STORE_BUSY ? 0 : 1);
    }
    int status;
    waitpid(pid, &status, 0);
    return WIFEXITED(status) && WEXITSTATUS(status) == 0;
}

static const uint8_t KEY[AR_KEY_LEN] = {9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 9, 8, 7, 6, 5, 4,
                                        3, 2, 1, 0, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 9, 8};

static char *slurp_file(const char *path, size_t *len) {
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    char *buf = malloc(1 << 20);
    *len = fread(buf, 1, (1 << 20) - 1, f);
    buf[*len] = 0;
    fclose(f);
    return buf;
}

static bool file_has(const char *path, const char *needle) {
    size_t n = 0;
    char *b = slurp_file(path, &n);
    bool has = false;
    for (size_t i = 0; b && i + strlen(needle) <= n; i++)
        if (memcmp(b + i, needle, strlen(needle)) == 0) has = true;
    free(b);
    return has;
}

static void put_file(const char *path, const char *text, size_t len) {
    FILE *f = fopen(path, "wb");
    CHECK(f && fwrite(text, 1, len, f) == len);
    if (f) fclose(f);
}

static void new_holder_record(e2e_record *rec) {
    e2e_record_new(rec);
    rec->master = vz_account_new();
    rec->own = calloc(1, sizeof(*rec->own));
    e2e_own_bootstrap(rec->account, rec->master, rec->own);
    rec->state.inbox = 42;
}

TEST(store_atomic_locked_private) {
    char base[] = "/tmp/shottino-e2e-XXXXXX";
    CHECK(mkdtemp(base) != NULL);
    char *dir = xfmt("%s/e2e-abc/7", base);
    e2e_store *st;
    char err[256];
    CHECK(e2e_store_open(dir, &st, err, sizeof(err)) == E2E_STORE_OK);
    struct stat sb;
    CHECK(stat(dir, &sb) == 0 && (sb.st_mode & 0777) == 0700);
    char *parent = xfmt("%s/e2e-abc", base);
    CHECK(stat(parent, &sb) == 0 && (sb.st_mode & 0777) == 0700);
    free(parent);
    /* A second process on the same directory is refused, not made to wait. */
    CHECK(child_cannot_lock(dir));

    e2e_record rec, back;
    CHECK(e2e_store_load(st, KEY, &back, err, sizeof(err)) == E2E_LOAD_NONE);
    CHECK(e2e_store_load(st, NULL, &back, err, sizeof(err)) == E2E_LOAD_NONE);
    CHECK(!e2e_store_has_record(dir));
    new_holder_record(&rec);
    e2e_record_set_encrypted(&rec, "Alice", true);
    /* No key, nothing written. */
    CHECK(!e2e_store_save(st, NULL, &rec, err, sizeof(err)));
    CHECK(!e2e_store_has_record(dir));
    CHECK(e2e_store_save(st, KEY, &rec, err, sizeof(err)));
    CHECK(e2e_store_has_record(dir));
    char *path = xfmt("%s/record.sealed", dir);
    char *plain = xfmt("%s/record.json", dir);
    CHECK(stat(path, &sb) == 0 && (sb.st_mode & 0777) == 0600);
    CHECK(stat(plain, &sb) != 0);
    /* Sealed: no byte of the pickle, nor of the nick, in the clear. */
    char *pickle = vz_account_pickle(rec.account);
    CHECK(!file_has(path, pickle) && !file_has(path, "alice") && !file_has(path, "account"));
    vz_str_free(pickle);
    CHECK(e2e_store_load(st, KEY, &back, err, sizeof(err)) == E2E_LOAD_OK);
    char *j1 = e2e_record_to_json(&rec), *j2 = e2e_record_to_json(&back);
    CHECK_STR(j2, j1);
    CHECK(back.state.inbox == 42 && back.master != NULL && back.own != NULL);
    free(j1);
    free(j2);
    e2e_record_free(&back);
    /* Without the key, or with another, nothing is read. */
    CHECK(e2e_store_load(st, NULL, &back, err, sizeof(err)) == E2E_LOAD_LOCKED);
    uint8_t other[AR_KEY_LEN];
    memcpy(other, KEY, sizeof(other));
    other[0] ^= 1;
    CHECK(e2e_store_load(st, other, &back, err, sizeof(err)) == E2E_LOAD_REFUSED);
    /* The clear index names the query by its digest only. */
    char *idx = xfmt("%s/" E2E_INDEX_FILE, dir);
    CHECK(stat(idx, &sb) == 0 && (sb.st_mode & 0777) == 0600);
    CHECK(!file_has(idx, "alice"));
    e2e_strv dg = {0};
    CHECK(e2e_store_read_index(dir, &dg));
    char want[E2E_DIGEST_SZ];
    e2e_nick_digest("ALICE", want);
    CHECK(dg.n == 1 && dg.n && strcmp(dg.v[0], want) == 0);
    CHECK(strncmp(want, "sha256:", 7) == 0 && strlen(want) == 7 + 64);
    e2e_strv_free(&dg);
    put_file(idx, "junk\n", 5);
    CHECK(!e2e_store_read_index(dir, &dg));
    free(idx);
    /* No temp file left behind. */
    char *tmp = xfmt("%s/record.sealed.tmp.%ld", dir, (long)getpid());
    CHECK(access(tmp, F_OK) != 0);
    free(tmp);
    /* A changed byte is refused, never half-loaded. */
    size_t n = 0;
    char *sealed = slurp_file(path, &n);
    sealed[n / 2] ^= 0x20;
    put_file(path, sealed, n);
    CHECK(e2e_store_load(st, KEY, &back, err, sizeof(err)) == E2E_LOAD_REFUSED);
    sealed[n / 2] ^= 0x20;
    put_file(path, sealed, n);
    CHECK(e2e_store_load(st, KEY, &back, err, sizeof(err)) == E2E_LOAD_OK);
    e2e_record_free(&back);
    e2e_store_close(st);
    /* Another network's record, swapped in under this one's name. */
    char *dir8 = xfmt("%s/e2e-abc/8", base);
    CHECK(e2e_store_open(dir8, &st, err, sizeof(err)) == E2E_STORE_OK);
    char *path8 = xfmt("%s/record.sealed", dir8);
    put_file(path8, sealed, n);
    CHECK(e2e_store_load(st, KEY, &back, err, sizeof(err)) == E2E_LOAD_REFUSED);
    e2e_store_close(st);
    free(path8);
    free(dir8);
    free(sealed);
    /* Closed, the lock is free again. */
    CHECK(e2e_store_open(dir, &st, err, sizeof(err)) == E2E_STORE_OK);
    e2e_store_close(st);
    e2e_record_free(&rec);
    free(path);
    free(plain);
    free(dir);
    char *rm = xfmt("rm -rf '%s'", base);
    CHECK(system(rm) == 0);
    free(rm);
}

/* The plaintext record a run before sealing wrote: read, sealed at once,
 * removed — and a crash between the rename and the removal still loads,
 * from the sealed one. A plaintext file that is no record stays CORRUPT. */
TEST(store_seals_a_plaintext_record_on_load) {
    char base[] = "/tmp/shottino-e2e-XXXXXX";
    CHECK(mkdtemp(base) != NULL);
    char *dir = xfmt("%s/e2e-abc/7", base);
    char *path = xfmt("%s/record.sealed", dir), *plain = xfmt("%s/record.json", dir);
    e2e_store *st;
    char err[256];
    CHECK(e2e_store_open(dir, &st, err, sizeof(err)) == E2E_STORE_OK);
    e2e_record rec, back;
    new_holder_record(&rec);
    e2e_record_set_encrypted(&rec, "bob", true);
    char *json = e2e_record_to_json(&rec);
    put_file(plain, json, strlen(json));
    CHECK(e2e_store_has_record(dir));
    /* Without a key the plaintext is not read either. */
    CHECK(e2e_store_load(st, NULL, &back, err, sizeof(err)) == E2E_LOAD_LOCKED);
    CHECK(e2e_store_load(st, KEY, &back, err, sizeof(err)) == E2E_LOAD_OK);
    char *j2 = e2e_record_to_json(&back);
    CHECK_STR(j2, json);
    free(j2);
    e2e_record_free(&back);
    struct stat sb;
    CHECK(stat(plain, &sb) != 0);
    CHECK(stat(path, &sb) == 0 && !file_has(path, "bob"));
    e2e_strv dg = {0};
    CHECK(e2e_store_read_index(dir, &dg) && dg.n == 1);
    e2e_strv_free(&dg);
    /* Half-migrated: the sealed record in, the plaintext not yet gone. */
    put_file(plain, "{\"stale\":true}", 14);
    CHECK(e2e_store_load(st, KEY, &back, err, sizeof(err)) == E2E_LOAD_OK);
    CHECK(back.state.inbox == 42);
    e2e_record_free(&back);
    CHECK(stat(plain, &sb) != 0);
    /* A sealed file that opens under the key but is no record this shottino
     * reads (a newer one's, say): never CORRUPT, which starts over. */
    {
        size_t sn = 0;
        const char *future = "{\"v\":99,\"account\":\"from a newer shottino\"}";
        uint8_t *sb2 = ar_seal(KEY, "record", "7/record.sealed", future, strlen(future), &sn);
        put_file(path, (const char *)sb2, sn);
        free(sb2);
        CHECK(e2e_store_load(st, KEY, &back, err, sizeof(err)) == E2E_LOAD_UNREADABLE);
        CHECK(strstr(err, "record.sealed") != NULL);
    }
    /* Only a plaintext non-record: CORRUPT, and the next save replaces it. */
    CHECK(unlink(path) == 0);
    put_file(plain, "{\"v\":1,\"account\":\"x\"}", 22);
    CHECK(e2e_store_load(st, KEY, &back, err, sizeof(err)) == E2E_LOAD_CORRUPT);
    CHECK(e2e_store_save(st, KEY, &rec, err, sizeof(err)));
    CHECK(stat(plain, &sb) != 0);
    CHECK(e2e_store_load(st, KEY, &back, err, sizeof(err)) == E2E_LOAD_OK);
    e2e_record_free(&back);
    e2e_store_close(st);
    free(json);
    e2e_record_free(&rec);
    free(path);
    free(plain);
    free(dir);
    char *rm = xfmt("rm -rf '%s'", base);
    CHECK(system(rm) == 0);
    free(rm);
}

TEST(record_refuses_what_it_did_not_write) {
    e2e_record r;
    const char *bad[] = {"", "{}", "{\"v\":2}", "[]",
                         "{\"v\":1,\"account\":\"{}\",\"master\":null,\"own\":null,\"state\":{}}"};
    for (size_t i = 0; i < 5; i++) CHECK(!e2e_record_from_json(bad[i], strlen(bad[i]), &r));
    /* A fresh record round-trips. */
    e2e_record_new(&r);
    char *j = e2e_record_to_json(&r);
    e2e_record back;
    CHECK(e2e_record_from_json(j, strlen(j), &back));
    CHECK(back.own == NULL && back.master == NULL && back.state.next_ref == 1);
    e2e_record_free(&back);
    /* One field of the wrong type refuses the whole. */
    char *broken = strdup(j);
    char *at = strstr(broken, "\"next_ref\":1");
    memcpy(at, "\"next_ref\":\"", 12);
    CHECK(!e2e_record_from_json(broken, strlen(broken), &back));
    free(broken);
    free(j);
    e2e_record_free(&r);
}

/* The encrypted mode of a query: folded, saved with the record, and
 * absent from a record written before it existed (read as none). */
TEST(record_keeps_the_encrypted_queries) {
    e2e_record r;
    e2e_record_new(&r);
    CHECK(!e2e_record_encrypted(&r, "Alice"));
    CHECK(e2e_record_set_encrypted(&r, "Alice", true));
    CHECK(!e2e_record_set_encrypted(&r, "ALICE", true));
    CHECK(e2e_record_encrypted(&r, "alice"));
    CHECK(e2e_record_set_encrypted(&r, "bob", true));
    char *j = e2e_record_to_json(&r);
    CHECK(strstr(j, "\"encrypted\":[\"alice\",\"bob\"]") != NULL);
    e2e_record back;
    CHECK(e2e_record_from_json(j, strlen(j), &back));
    CHECK(e2e_record_encrypted(&back, "Alice") && e2e_record_encrypted(&back, "BOB"));
    CHECK(e2e_record_set_encrypted(&back, "alice", false));
    CHECK(!e2e_record_encrypted(&back, "alice") && e2e_record_encrypted(&back, "bob"));
    e2e_record_free(&back);
    /* Older: no member at all. A wrong type still refuses the whole. */
    char *old = strdup(j);
    char *at = strstr(old, ",\"encrypted\":");
    strcpy(at, "}");
    CHECK(e2e_record_from_json(old, strlen(old), &back));
    CHECK(back.encrypted.n == 0);
    e2e_record_free(&back);
    strcpy(strstr(old, "}") ? old + strlen(old) - 1 : old, ",\"encrypted\":7}");
    CHECK(!e2e_record_from_json(old, strlen(old), &back));
    free(old);
    free(j);
    e2e_record_free(&r);
}

/* ── pairing (pairingMessages.ts) ── */

static bool pair_decodes(const char *json, e2e_pair_msg *m) {
    return e2e_pair_decode((const uint8_t *)json, strlen(json), m);
}

static bool pair_refused(const char *json) {
    e2e_pair_msg m;
    bool ok = pair_decodes(json, &m);
    if (ok) e2e_pair_msg_free(&m);
    return !ok;
}

/* The two ends of the channel, as cic's two roles open it: the joiner's
 * first payload travels base64url (the relay refuses its `|`), opens on
 * the holder, and both derive the same 2-digit code. */
TEST(pair_initial_payload_crosses_the_relay) {
    vz_ecies *holder = vz_ecies_new(E2E_PAIRING_INFO);
    char *curve = vz(vz_ecies_public_key(holder));
    char *hello = e2e_pair_hello();
    CHECK_STR(hello, "{\"v\":1,\"t\":\"hello\"}");
    char *initial = NULL;
    vz_established_ecies *out = vz_ecies_establish_outbound(
        vz_ecies_new(E2E_PAIRING_INFO), curve, (const uint8_t *)hello, strlen(hello), &initial);
    CHECK(out && initial && strchr(initial, '|'));
    char *wrapped = e2e_pair_wrap_initial(initial);
    CHECK(strspn(wrapped, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_") ==
          strlen(wrapped));
    char *back = e2e_pair_unwrap_initial(wrapped);
    CHECK_STR(back, initial);
    vz_buf plain;
    vz_established_ecies *in = vz_ecies_establish_inbound(holder, back, &plain);
    CHECK(in != NULL);
    e2e_pair_msg m;
    CHECK(in && e2e_pair_decode(plain.ptr, plain.len, &m) && m.kind == E2E_PAIR_HELLO);
    if (in) e2e_pair_msg_free(&m);
    CHECK(in && vz_established_ecies_check_code(in) == vz_established_ecies_check_code(out));
    CHECK(in && vz_established_ecies_check_code(in) >= 0 && vz_established_ecies_check_code(in) <= 99);
    /* After the initial, both ways are the ECIES message as is. */
    char *done = e2e_pair_done(NULL, 0);
    char *ct = vz(vz_established_ecies_encrypt(out, (const uint8_t *)done, strlen(done)));
    vz_buf p2;
    CHECK(in && vz_established_ecies_decrypt(in, ct, &p2) == 0 && p2.len == strlen(done) &&
          memcmp(p2.ptr, done, p2.len) == 0);
    vz_buf_free(p2);
    vz_buf_free(plain);
    /* What the relay charset or UTF-8 refuses. */
    CHECK(e2e_pair_unwrap_initial("") == NULL);
    CHECK(e2e_pair_unwrap_initial("abc+def") == NULL);
    CHECK(e2e_pair_unwrap_initial("abc/def") == NULL);
    CHECK(e2e_pair_unwrap_initial("abcd==") == NULL);
    CHECK(e2e_pair_unwrap_initial("A") == NULL);
    const uint8_t bad[] = {0xff, 0xfe, 0x41};
    char *badw = e2e_base64url(bad, sizeof(bad));
    CHECK(e2e_pair_unwrap_initial(badw) == NULL);
    free(badw);
    const uint8_t nul[] = {'a', 0, 'b'};
    char *nulw = e2e_base64url(nul, sizeof(nul));
    CHECK(e2e_pair_unwrap_initial(nulw) == NULL);
    free(nulw);
    free(ct);
    free(done);
    free(back);
    free(wrapped);
    vz_str_free(initial);
    vz_established_ecies_free(in);
    vz_established_ecies_free(out);
    free(hello);
    free(curve);
}

TEST(pair_messages_decode_strictly) {
    vz_account *a = vz_account_new(), *b = vz_account_new();
    char *ea = vz(vz_account_ed25519_key(a)), *ca = vz(vz_account_curve25519_key(a));
    char *eb = vz(vz_account_ed25519_key(b));
    e2e_pair_msg m;

    char *offer = xfmt("{\"v\":1,\"t\":\"offer\",\"networks\":[{\"network\":\"azzurra\",\"master\":"
                       "\"%s\",\"extra\":1}],\"full\":[\"libera\"],\"ignored\":true}",
                       ea);
    CHECK(pair_decodes(offer, &m));
    CHECK(m.kind == E2E_PAIR_OFFER && m.nnetworks == 1 && m.nfull == 1);
    CHECK_STR(m.networks[0].network, "azzurra");
    CHECK_STR(m.networks[0].master, ea);
    CHECK_STR(m.full[0], "libera");
    e2e_pair_msg_free(&m);
    /* JSON.parse reads 1.0 as 1. */
    CHECK(!pair_refused("{\"v\":1.0,\"t\":\"hello\"}"));
    CHECK(pair_refused("{\"v\":2,\"t\":\"hello\"}"));
    CHECK(pair_refused("{\"t\":\"hello\"}"));
    CHECK(pair_refused("{\"v\":\"1\",\"t\":\"hello\"}"));
    CHECK(pair_refused("{\"v\":1,\"t\":\"howdy\"}"));
    CHECK(pair_refused("{\"v\":1}"));
    CHECK(pair_refused("[1]"));
    CHECK(pair_refused("not json"));
    CHECK(pair_refused("{\"v\":1,\"v\":1,\"t\":\"hello\"}"));
    CHECK(pair_refused("{\"v\":1,\"t\":\"offer\",\"networks\":[]}"));
    /* A key that is not vodozemac's one spelling: the last character of
     * 32 bytes carries two zero bits, and one past it sets them. */
    static const char B64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    char skew[64];
    snprintf(skew, sizeof(skew), "%s", ea);
    skew[42] = B64[(strchr(B64, ea[42]) - B64) + 1];
    CHECK(!e2e_ed25519_canonical(skew));
    char *noncanon = xfmt("{\"v\":1,\"t\":\"offer\",\"networks\":[{\"network\":\"x\",\"master\":"
                          "\"%s\"}],\"full\":[]}",
                          skew);
    CHECK(pair_refused(noncanon));
    free(noncanon);
    CHECK(pair_refused("{\"v\":1,\"t\":\"offer\",\"networks\":[{\"network\":\"x\",\"master\":"
                       "\"nokey\"}],\"full\":[]}"));
    CHECK(pair_refused("{\"v\":1,\"t\":\"offer\",\"networks\":[],\"full\":[\"\"]}"));
    CHECK(pair_refused("{\"v\":1,\"t\":\"offer\",\"networks\":[7],\"full\":[]}"));
    CHECK(pair_refused("{\"v\":1,\"t\":\"done\",\"paired\":[\"a\",3]}"));
    CHECK(!pair_refused("{\"v\":1,\"t\":\"done\",\"paired\":[]}"));
    CHECK(pair_refused("{\"v\":1,\"t\":\"join\",\"devices\":[],\"skipped\":[{\"network\":\"a\","
                       "\"reason\":\"nope\"}]}"));
    CHECK(!pair_refused("{\"v\":1,\"t\":\"join\",\"devices\":[],\"skipped\":[{\"network\":\"a\","
                        "\"reason\":\"list-changed\"}]}"));
    char *join_nosig = xfmt("{\"v\":1,\"t\":\"join\",\"devices\":[{\"network\":\"a\",\"id\":{"
                            "\"curve25519\":\"%s\",\"ed25519\":\"%s\"}}],\"skipped\":[]}",
                            ca, ea);
    CHECK(pair_refused(join_nosig));
    free(join_nosig);
    /* A curve in the ed25519 slot is still a 32-byte key; the swap of the
     * two is caught by S1, not here. A signed list's ver must be a number. */
    char *signed_badver = xfmt("{\"v\":1,\"t\":\"signed\",\"devices\":[{\"network\":\"a\",\"cert\":"
                               "\"c\",\"list\":{\"ver\":\"2\",\"devices\":[\"%s\"],\"sig\":\"s\"}}],"
                               "\"refused\":[]}",
                               ea);
    CHECK(pair_refused(signed_badver));
    free(signed_badver);
    const uint8_t bad_utf8[] = "{\"v\":1,\"t\":\"hello\",\"x\":\"\xff\"}";
    CHECK(!e2e_pair_decode(bad_utf8, sizeof(bad_utf8) - 1, &m));

    /* The builders' output decodes to what went in. */
    char *eaj = NULL, *caj = NULL, *sig = NULL;
    CHECK(e2e_pair_id_block(a, eb, &caj, &eaj, &sig));
    e2e_pair_device dev = {"azzurra", {caj, eaj, sig}};
    e2e_pair_refused skip = {"libera", E2E_PAIR_FULL};
    char *join = e2e_pair_join(&dev, 1, &skip, 1);
    char *want = xfmt("{\"v\":1,\"t\":\"join\",\"devices\":[{\"network\":\"azzurra\",\"id\":{"
                      "\"curve25519\":\"%s\",\"ed25519\":\"%s\",\"sig\":\"%s\"}}],\"skipped\":[{"
                      "\"network\":\"libera\",\"reason\":\"full\"}]}",
                      caj, eaj, sig);
    CHECK_STR(join, want);
    CHECK(pair_decodes(join, &m) && m.kind == E2E_PAIR_JOIN && m.ndevices == 1 &&
          m.nrefused == 1 && m.refused[0].reason == E2E_PAIR_FULL);
    CHECK_STR(m.devices[0].id.sig, sig);
    e2e_pair_msg_free(&m);
    e2e_pair_offered on = {"azzurra", eb};
    const char *full[] = {"libera"};
    char *built = e2e_pair_offer(&on, 1, full, 1);
    CHECK(pair_decodes(built, &m) && m.kind == E2E_PAIR_OFFER && m.nnetworks == 1);
    e2e_pair_msg_free(&m);
    const char *paired[] = {"azzurra"};
    char *done = e2e_pair_done(paired, 1);
    CHECK_STR(done, "{\"v\":1,\"t\":\"done\",\"paired\":[\"azzurra\"]}");
    free(done);
    free(built);
    free(join);
    free(want);
    free(eaj);
    free(caj);
    free(sig);
    free(offer);
    free(ea);
    free(ca);
    free(eb);
    vz_account_free(a);
    vz_account_free(b);
}

/* issueDevice on the holder, acceptSigned on the joiner: what one signs
 * the other takes, and what either refuses. */
TEST(pair_issue_and_accept) {
    vz_account *hdev = vz_account_new(), *master = vz_account_new(), *jdev = vz_account_new();
    e2e_own own;
    e2e_own_bootstrap(hdev, master, &own);
    char *je = vz(vz_account_ed25519_key(jdev));
    char *curve, *ed, *sig;
    CHECK(e2e_pair_id_block(jdev, own.master, &curve, &ed, &sig));
    CHECK_STR(ed, je);
    e2e_id_block id = {curve, ed, sig};
    e2e_pair_issued is;
    e2e_pair_refusal why;
    CHECK(e2e_pair_issue(master, &own, &id, &is, &why));
    CHECK_LONG(is.ver, 2);
    CHECK_LONG(is.devices.n, 2);
    CHECK(strcmp(is.devices.v[0], is.devices.v[1]) < 0);

    e2e_pair_signed_entry entry = {"azzurra", is.cert, {NULL, (double)is.ver, is.devices.n,
                                                        {is.devices.v[0], is.devices.v[1]}, is.sig}};
    /* Through the wire and back, as the joiner reads it. */
    char *msg = e2e_pair_signed(&entry, 1, NULL, 0);
    e2e_pair_msg m;
    CHECK(e2e_pair_decode((const uint8_t *)msg, strlen(msg), &m) && m.kind == E2E_PAIR_SIGNED &&
          m.nsigned == 1);
    e2e_own placed;
    CHECK(e2e_pair_accept_signed(own.master, jdev, &m.signed_[0], &placed));
    CHECK_LONG(placed.cert_ver, 2);
    CHECK_LONG(placed.list_ver, 2);
    CHECK_STR(placed.master, own.master);
    CHECK(e2e_own_verify(&placed, jdev));
    e2e_own_free(&placed);
    /* Another master, a list not naming this device, a cert at another
     * version or over another key: refused. */
    CHECK(!e2e_pair_accept_signed(je, jdev, &m.signed_[0], &placed));
    CHECK(!e2e_pair_accept_signed(own.master, hdev, &m.signed_[0], &placed));
    e2e_pair_signed_entry forged = m.signed_[0];
    char *cert1 = e2e_sign_cert(master, 1, je);
    forged.cert = cert1;
    CHECK(!e2e_pair_accept_signed(own.master, jdev, &forged, &placed));
    forged = m.signed_[0];
    forged.list.ver = 3;
    CHECK(!e2e_pair_accept_signed(own.master, jdev, &forged, &placed));
    free(cert1);
    e2e_pair_msg_free(&m);
    free(msg);

    /* Already listed; an S1 over another master; a full list. */
    e2e_own two;
    memset(&two, 0, sizeof(two));
    two.master = strdup(own.master);
    two.list_ver = is.ver;
    for (size_t i = 0; i < is.devices.n; i++) {
        two.list_devices.v = realloc(two.list_devices.v, (two.list_devices.n + 1) * sizeof(char *));
        two.list_devices.v[two.list_devices.n++] = strdup(is.devices.v[i]);
    }
    e2e_pair_issued again;
    CHECK(!e2e_pair_issue(master, &two, &id, &again, &why) && why == E2E_PAIR_PAIRED);
    char *c2, *e2, *s2;
    vz_account *other = vz_account_new();
    CHECK(e2e_pair_id_block(other, je, &c2, &e2, &s2));
    e2e_id_block wrong = {c2, e2, s2};
    CHECK(!e2e_pair_issue(master, &own, &wrong, &again, &why) && why == E2E_PAIR_FAILED);
    e2e_id_block swapped = {ed, curve, sig};
    CHECK(!e2e_pair_issue(master, &own, &swapped, &again, &why) && why == E2E_PAIR_FAILED);
    free(c2);
    free(e2);
    free(s2);
    vz_account *third = vz_account_new();
    char *e3 = vz(vz_account_ed25519_key(third));
    two.list_devices.v = realloc(two.list_devices.v, 3 * sizeof(char *));
    two.list_devices.v[two.list_devices.n++] = e3;
    vz_account *fourth = vz_account_new();
    char *c4, *e4, *s4;
    CHECK(e2e_pair_id_block(fourth, own.master, &c4, &e4, &s4));
    e2e_id_block id4 = {c4, e4, s4};
    CHECK(!e2e_pair_issue(master, &two, &id4, &again, &why) && why == E2E_PAIR_FULL);
    free(c4);
    free(e4);
    free(s4);
    e2e_own_free(&two);
    e2e_pair_issued_free(&is);
    vz_account_free(fourth);
    vz_account_free(third);
    vz_account_free(other);
    free(curve);
    free(ed);
    free(sig);
    free(je);
    e2e_own_free(&own);
    vz_account_free(hdev);
    vz_account_free(master);
    vz_account_free(jdev);
}

/* startOver: a new device account, no place, no master; the trust placed
 * in others (masters, devices, pins) stays, nothing bound to the old
 * device account does. */
TEST(record_start_over_keeps_only_trust) {
    e2e_record r;
    e2e_record_new(&r);
    char *old = vz(vz_account_ed25519_key(r.account));
    r.master = vz_account_new();
    r.own = calloc(1, sizeof(*r.own));
    e2e_own_bootstrap(r.account, r.master, r.own);
    e2e_ctx c = {&r, "me", -1, 1000};
    vz_account *peer = vz_account_new();
    char *pm = vz(vz_account_ed25519_key(peer));
    e2e_result res;
    e2e_result_init(&res);
    CHECK(e2e_pin(&c, "Alice", pm, true, &res) == E2E_PIN_PINNED);
    e2e_result_free(&res);
    r.state.inbox = 42;
    r.state.next_ref = 7;
    size_t masters = r.state.nmasters;
    e2e_record_start_over(&r);
    char *fresh = vz(vz_account_ed25519_key(r.account));
    CHECK(strcmp(old, fresh) != 0);
    CHECK(r.master == NULL && r.own == NULL);
    CHECK_LONG(r.state.inbox, 0);
    CHECK_LONG(r.state.nmasters, masters);
    CHECK_LONG(r.state.npeers, 1);
    CHECK_STR(r.state.peers[0].key, "alice");
    CHECK_STR(r.state.peers[0].pin, pm);
    /* It still writes and reads back as a record. */
    char *json = e2e_record_to_json(&r);
    e2e_record back;
    CHECK(json && e2e_record_from_json(json, strlen(json), &back));
    if (json) e2e_record_free(&back);
    free(json);
    free(fresh);
    free(old);
    free(pm);
    vz_account_free(peer);
    e2e_record_free(&r);
}

TEST(iso8601_instants) {
    int64_t t;
    CHECK(e2e_iso8601_seconds("1970-01-01T00:00:00Z", &t) && t == 0);
    CHECK(e2e_iso8601_seconds("2026-11-07T10:05:00Z", &t) && t == 1794045900LL);
    CHECK(e2e_iso8601_seconds("2026-11-07T10:05:00.123456Z", &t) && t == 1794045900LL);
    CHECK(e2e_iso8601_seconds("2026-11-07T12:05:00+02:00", &t) && t == 1794045900LL);
    CHECK(e2e_iso8601_seconds("2000-02-29T00:00:00Z", &t) && t == 951782400LL);
    CHECK(!e2e_iso8601_seconds("2026-11-07", &t));
    CHECK(!e2e_iso8601_seconds("2026-13-07T10:05:00Z", &t));
    CHECK(!e2e_iso8601_seconds("2026-11-07T10:05:00", &t));
    CHECK(!e2e_iso8601_seconds("2026-11-07T10:05:00Zjunk", &t));
    CHECK(!e2e_iso8601_seconds(NULL, &t));
}

static e2e_row mkrow(const char *id, e2e_row_kind kind, int64_t at, const char *nick,
                     const char *body, const char *key) {
    e2e_row r = {0};
    r.id = (char *)id;
    r.kind = kind;
    r.at = at;
    r.nick = (char *)nick;
    r.body = (char *)body;
    r.body_len = body ? strlen(body) : 0;
    r.key = (char *)key;
    return r;
}

/* Each kind round-trips with exactly its fields, a NUL inside a body
 * included; anything else is refused as a unit. */
TEST(history_rows_round_trip) {
    const char nul_body[] = "a\0b";
    e2e_row in = mkrow("in:7:0", E2E_ROW_IN, 1700000000123, "Alice", "ciao \"tu\"", E1);
    e2e_row out = mkrow("copy:8:1", E2E_ROW_OUT, 1700000000124, "alice", NULL, NULL);
    out.body = (char *)nul_body;
    out.body_len = 3;
    e2e_row und = mkrow("in:9:0", E2E_ROW_UNDECRYPTABLE, 5, "bob", "no-session", NULL);
    e2e_row alarm = mkrow("in:10:0", E2E_ROW_KEY_ALARM, 6, "bob", NULL, E2);
    e2e_row all[] = {in, out, und, alarm};
    for (size_t i = 0; i < 4; i++) {
        char *json = e2e_row_to_json(&all[i]);
        CHECK(strchr(json, '\n') == NULL);
        e2e_row back;
        CHECK(e2e_row_from_json(json, strlen(json), &back));
        CHECK_STR(back.id, all[i].id);
        CHECK(back.kind == all[i].kind);
        CHECK(back.at == all[i].at);
        CHECK_STR(back.nick, all[i].nick);
        CHECK(back.body_len == all[i].body_len);
        CHECK((back.body == NULL) == (all[i].body == NULL));
        if (back.body) CHECK(memcmp(back.body, all[i].body, back.body_len) == 0);
        if (all[i].key) CHECK_STR(back.key, all[i].key);
        else CHECK(back.key == NULL);
        e2e_row_free(&back);
        free(json);
    }
    const char *bad[] = {"", "{}", "[]",
                         "{\"v\":2,\"id\":\"x\",\"kind\":\"in\",\"at\":1,\"nick\":\"a\",\"body\":\"b\",\"key\":\"k\"}",
                         "{\"v\":1,\"id\":\"x\",\"kind\":\"in\",\"at\":1,\"nick\":\"a\",\"body\":\"b\"}",
                         "{\"v\":1,\"id\":\"x\",\"kind\":\"key_alarm\",\"at\":1,\"nick\":\"a\"}",
                         "{\"v\":1,\"id\":\"x\",\"kind\":\"spam\",\"at\":1,\"nick\":\"a\",\"body\":\"b\"}",
                         "{\"v\":1,\"id\":\"\",\"kind\":\"out\",\"at\":1,\"nick\":\"a\",\"body\":\"b\"}",
                         "{\"v\":1,\"id\":\"x\",\"kind\":\"out\",\"at\":1.5,\"nick\":\"a\",\"body\":\"b\"}"};
    for (size_t i = 0; i < sizeof(bad) / sizeof(bad[0]); i++) {
        e2e_row r;
        CHECK(!e2e_row_from_json(bad[i], strlen(bad[i]), &r));
    }
    /* SHA-256 of the folded nick (vector: Python's hashlib over
     * "al/ice[]"): a fixed length whatever the nick, and no byte of it
     * reaches the filesystem's syntax. */
    char *name = e2e_chat_file_name("Al/ice[]");
    CHECK_STR(name, "chat-sha256-32c6e69b6886b227b30ec01f74b196c896eeb7a5df33119a7018ce1e19031db0"
                    ".sealed");
    free(name);
}

static size_t count_lines(const char *path) {
    FILE *f = fopen(path, "r");
    if (!f) return 0;
    size_t n = 0;
    int c;
    while ((c = fgetc(f)) != EOF) n += c == '\n';
    fclose(f);
    return n;
}

/* Appended and private; one file per folded nick; a repeated id and a
 * torn tail are both survived; the load is oldest first across chats. */
TEST(history_appends_dedupes_and_survives_a_torn_tail) {
    char base[] = "/tmp/shottino-hist-XXXXXX";
    CHECK(mkdtemp(base) != NULL);
    char *dir = xfmt("%s/7/chats", base);
    char err[256];
    e2e_rows rows;
    CHECK(e2e_chat_load(dir, "7/chats", KEY, &rows, err, sizeof(err)));
    CHECK(rows.n == 0);

    e2e_row a1 = mkrow("in:1:0", E2E_ROW_IN, 100, "Alice", "one", E1);
    e2e_row b1 = mkrow("in:2:0", E2E_ROW_IN, 150, "bob", "bee", E2);
    e2e_row a2 = mkrow("in:3:0", E2E_ROW_IN, 200, "alice", "two", E1);
    CHECK(e2e_chat_append(dir, "7/chats", KEY, &a1, err, sizeof(err)));
    CHECK(e2e_chat_append(dir, "7/chats", KEY, &b1, err, sizeof(err)));
    CHECK(e2e_chat_append(dir, "7/chats", KEY, &a2, err, sizeof(err)));
    /* The crash between the row and the record: the same message read
     * again writes the same row again. */
    CHECK(e2e_chat_append(dir, "7/chats", KEY, &a2, err, sizeof(err)));
    struct stat sb;
    CHECK(stat(dir, &sb) == 0 && (sb.st_mode & 0777) == 0700);
    char *name = e2e_chat_file_name("alice");
    char *path = xfmt("%s/%s", dir, name);
    free(name);
    CHECK(stat(path, &sb) == 0 && (sb.st_mode & 0777) == 0600);
    CHECK_LONG((long)count_lines(path), 3);

    /* A crash inside a write: half a line, no newline. */
    int fd = open(path, O_WRONLY | O_APPEND);
    CHECK(fd >= 0 && write(fd, "{\"v\":1,\"id\":\"in:4:0\",\"ki", 24) == 24);
    close(fd);
    e2e_row a3 = mkrow("in:5:0", E2E_ROW_IN, 300, "ALICE", "three", E1);
    CHECK(e2e_chat_append(dir, "7/chats", KEY, &a3, err, sizeof(err)));
    CHECK_LONG((long)count_lines(path), 4);

    CHECK(e2e_chat_load(dir, "7/chats", KEY, &rows, err, sizeof(err)));
    CHECK_LONG((long)rows.n, 4);
    const char *want[] = {"in:1:0", "in:2:0", "in:3:0", "in:5:0"};
    for (size_t i = 0; i < rows.n && i < 4; i++) CHECK_STR(rows.v[i].id, want[i]);
    e2e_rows_free(&rows);
    /* The load compacted the repeat away. */
    CHECK_LONG((long)count_lines(path), 3);

    /* A torn tail with nothing appended after it: skipped, then cut. */
    fd = open(path, O_WRONLY | O_APPEND);
    CHECK(fd >= 0 && write(fd, "{\"v\":1", 6) == 6);
    close(fd);
    CHECK(e2e_chat_load(dir, "7/chats", KEY, &rows, err, sizeof(err)));
    CHECK_LONG((long)rows.n, 4);
    e2e_rows_free(&rows);
    CHECK_LONG((long)count_lines(path), 3);

    /* Past twice the cap a load keeps the newest E2E_CHAT_ROWS_MAX. */
    for (int i = 0; i < 2 * E2E_CHAT_ROWS_MAX; i++) {
        char id[32];
        snprintf(id, sizeof(id), "in:%d:0", 1000 + i);
        e2e_row r = mkrow(id, E2E_ROW_IN, 1000 + i, "carol", "x", E1);
        CHECK(e2e_chat_append(dir, "7/chats", KEY, &r, err, sizeof(err)));
    }
    CHECK(e2e_chat_load(dir, "7/chats", KEY, &rows, err, sizeof(err)));
    CHECK_LONG((long)rows.n, 4 + E2E_CHAT_ROWS_MAX);
    CHECK_STR(rows.v[rows.n - 1].id, "in:2999:0");
    CHECK_STR(rows.v[4].id, "in:2000:0");
    e2e_rows_free(&rows);
    char *cname = e2e_chat_file_name("carol");
    char *cpath = xfmt("%s/%s", dir, cname);
    free(cname);
    CHECK_LONG((long)count_lines(cpath), 2 * E2E_CHAT_ROWS_MAX);
    e2e_row r = mkrow("in:9999:0", E2E_ROW_IN, 9999, "carol", "x", E1);
    CHECK(e2e_chat_append(dir, "7/chats", KEY, &r, err, sizeof(err)));
    CHECK(e2e_chat_load(dir, "7/chats", KEY, &rows, err, sizeof(err)));
    e2e_rows_free(&rows);
    CHECK_LONG((long)count_lines(cpath), E2E_CHAT_ROWS_MAX);
    free(cpath);
    free(path);
    free(dir);
    char *rm = xfmt("rm -rf '%s'", base);
    CHECK(system(rm) == 0);
    free(rm);
}

/* A chat file's name has a fixed length: the hex of the folded nick it
 * used to be grew two bytes a nick byte, so a peer nick past ~120 bytes
 * (grappa takes what the network takes) named a file the filesystem
 * refuses, and the history of that chat could not be kept at all. A file
 * of the old shape is renamed on load — merged into the new one when
 * both exist — and read like any other. */
TEST(history_names_are_fixed_length_and_old_names_migrate) {
    char base[] = "/tmp/shottino-hist-XXXXXX";
    CHECK(mkdtemp(base) != NULL);
    char *dir = xfmt("%s/7/chats", base);
    char err[256];
    char nick[301];
    memset(nick, 'n', 300);
    nick[300] = 0;
    char *name = e2e_chat_file_name(nick);
    CHECK(strlen(name) <= NAME_MAX);
    CHECK_LONG((long)strlen(name), (long)strlen("chat-sha256-.sealed") + 64);
    free(name);
    e2e_row lng = mkrow("in:1:0", E2E_ROW_IN, 100, nick, "long", E1);
    CHECK(e2e_chat_append(dir, "7/chats", KEY, &lng, err, sizeof(err)));

    /* Two chats written under the old names; bob's new file exists too. */
    char *old_a = xfmt("%s/chat-616c696365.jsonl", dir);
    char *old_b = xfmt("%s/chat-626f62.jsonl", dir);
    e2e_row a = mkrow("in:2:0", E2E_ROW_IN, 200, "alice", "old alice", E1);
    e2e_row b_old = mkrow("in:3:0", E2E_ROW_IN, 300, "bob", "old bob", E2);
    e2e_row b_new = mkrow("in:4:0", E2E_ROW_IN, 400, "bob", "new bob", E2);
    char *ja = e2e_row_to_json(&a), *jb = e2e_row_to_json(&b_old);
    FILE *f = fopen(old_a, "w");
    CHECK(f && fprintf(f, "%s\n", ja) > 0);
    if (f) fclose(f);
    f = fopen(old_b, "w");
    CHECK(f && fprintf(f, "%s\n", jb) > 0);
    if (f) fclose(f);
    free(ja);
    free(jb);
    CHECK(e2e_chat_append(dir, "7/chats", KEY, &b_new, err, sizeof(err)));

    e2e_rows rows;
    CHECK(e2e_chat_load(dir, "7/chats", KEY, &rows, err, sizeof(err)));
    CHECK_LONG((long)rows.n, 4);
    const char *want[] = {"in:1:0", "in:2:0", "in:3:0", "in:4:0"};
    for (size_t i = 0; i < rows.n && i < 4; i++) CHECK_STR(rows.v[i].id, want[i]);
    e2e_rows_free(&rows);
    struct stat sb;
    CHECK(stat(old_a, &sb) != 0);
    CHECK(stat(old_b, &sb) != 0);
    char *na = e2e_chat_file_name("alice"), *nb = e2e_chat_file_name("BOB");
    char *pa = xfmt("%s/%s", dir, na), *pb = xfmt("%s/%s", dir, nb);
    CHECK(stat(pa, &sb) == 0 && (sb.st_mode & 0777) == 0600);
    CHECK_LONG((long)count_lines(pb), 2);
    /* A second load finds nothing left to move and reads the same. */
    CHECK(e2e_chat_load(dir, "7/chats", KEY, &rows, err, sizeof(err)));
    CHECK_LONG((long)rows.n, 4);
    e2e_rows_free(&rows);
    CHECK_LONG((long)count_lines(pb), 2);
    free(na);
    free(nb);
    free(pa);
    free(pb);
    free(old_a);
    free(old_b);
    free(dir);
    char *rm = xfmt("rm -rf '%s'", base);
    CHECK(system(rm) == 0);
    free(rm);
}

/* Every line sealed on its own: no body reaches the disk in the clear; a
 * line changed, or moved from another chat, is refused and said, and its
 * file is left as it is; without the key nothing is read or written. A
 * plaintext chat of the shape before sealing is sealed by the load that
 * finds it — merged when a sealed one exists too (a crash after the
 * rename) — and removed. */
TEST(history_is_sealed_and_refuses_what_does_not_open) {
    char base[] = "/tmp/shottino-hist-XXXXXX";
    CHECK(mkdtemp(base) != NULL);
    char *dir = xfmt("%s/7/chats", base);
    char err[256];
    e2e_rows rows;
    e2e_row a1 = mkrow("in:1:0", E2E_ROW_IN, 100, "alice", "a very private sentence", E1);
    CHECK(!e2e_chat_append(dir, "7/chats", NULL, &a1, err, sizeof(err)));
    CHECK(e2e_chat_load(dir, "7/chats", NULL, &rows, err, sizeof(err)) && rows.n == 0);
    CHECK(e2e_chat_append(dir, "7/chats", KEY, &a1, err, sizeof(err)));
    char *na = e2e_chat_file_name("alice"), *nb = e2e_chat_file_name("bob");
    char *pa = xfmt("%s/%s", dir, na), *pb = xfmt("%s/%s", dir, nb);
    CHECK(!file_has(pa, "private") && !file_has(pa, "in:1:0") && file_has(pa, "e1:"));
    /* Locked: there is something to read, and it is not read. */
    CHECK(!e2e_chat_load(dir, "7/chats", NULL, &rows, err, sizeof(err)));
    CHECK(rows.n == 0);
    /* Under another network's name it does not open. */
    CHECK(!e2e_chat_load(dir, "8/chats", KEY, &rows, err, sizeof(err)));
    CHECK(rows.n == 0);
    e2e_rows_free(&rows);

    /* Alice's line moved into bob's chat; then a changed one appended. */
    size_t n = 0;
    char *line = slurp_file(pa, &n);
    put_file(pb, line, n);
    line[5] = line[5] == 'A' ? 'B' : 'A';
    FILE *f = fopen(pa, "ab");
    CHECK(f && fwrite(line, 1, n, f) == n);
    if (f) fclose(f);
    free(line);
    CHECK(!e2e_chat_load(dir, "7/chats", KEY, &rows, err, sizeof(err)));
    CHECK(strstr(err, "do not open") != NULL);
    CHECK_LONG((long)rows.n, 1);
    if (rows.n) CHECK_STR(rows.v[0].body, "a very private sentence");
    e2e_rows_free(&rows);
    CHECK_LONG((long)count_lines(pa), 2); /* left for someone to look at */
    CHECK_LONG((long)count_lines(pb), 1);
    CHECK(unlink(pa) == 0 && unlink(pb) == 0);

    /* The plaintext shape: carol's alone, bob's beside a sealed one. */
    char *nc = e2e_chat_file_name("carol");
    nc[strlen(nc) - strlen(".sealed")] = 0;
    char *plain_c = xfmt("%s/%s.jsonl", dir, nc);
    nb[strlen(nb) - strlen(".sealed")] = 0;
    char *plain_b = xfmt("%s/%s.jsonl", dir, nb);
    e2e_row c1 = mkrow("in:2:0", E2E_ROW_IN, 200, "carol", "carol said this in clear", E1);
    e2e_row b1 = mkrow("in:3:0", E2E_ROW_IN, 300, "bob", "bob said this in clear", E2);
    e2e_row b2 = mkrow("in:4:0", E2E_ROW_IN, 400, "bob", "bob said this sealed", E2);
    char *jc = e2e_row_to_json(&c1), *jb = e2e_row_to_json(&b1);
    char *tc = xfmt("%s\n", jc), *tb = xfmt("%s\n", jb);
    put_file(plain_c, tc, strlen(tc));
    put_file(plain_b, tb, strlen(tb));
    CHECK(e2e_chat_append(dir, "7/chats", KEY, &b2, err, sizeof(err)));
    /* No key: the plaintext is neither read nor moved. */
    CHECK(!e2e_chat_load(dir, "7/chats", NULL, &rows, err, sizeof(err)));
    struct stat sb;
    CHECK(stat(plain_c, &sb) == 0);
    CHECK(e2e_chat_load(dir, "7/chats", KEY, &rows, err, sizeof(err)));
    CHECK_LONG((long)rows.n, 3);
    const char *want[] = {"in:2:0", "in:3:0", "in:4:0"};
    for (size_t i = 0; i < rows.n && i < 3; i++) CHECK_STR(rows.v[i].id, want[i]);
    e2e_rows_free(&rows);
    CHECK(stat(plain_c, &sb) != 0 && stat(plain_b, &sb) != 0);
    char *sc = xfmt("%s/%s.sealed", dir, nc);
    CHECK(stat(sc, &sb) == 0 && (sb.st_mode & 0777) == 0600);
    CHECK(!file_has(sc, "clear") && !file_has(pb, "clear") && !file_has(pb, "sealed"));
    CHECK_LONG((long)count_lines(pb), 2);
    /* Nothing left to seal: the same rows again. */
    CHECK(e2e_chat_load(dir, "7/chats", KEY, &rows, err, sizeof(err)));
    CHECK_LONG((long)rows.n, 3);
    e2e_rows_free(&rows);
    free(jc);
    free(jb);
    free(tc);
    free(tb);
    free(sc);
    free(plain_c);
    free(plain_b);
    free(na);
    free(nb);
    free(nc);
    free(pa);
    free(pb);
    free(dir);
    char *rm = xfmt("rm -rf '%s'", base);
    CHECK(system(rm) == 0);
    free(rm);
}

/* ── SAS (slice F) ── */

/* The pure halves both sides compute: the commitment is SHA-256 over
 * "key|tx" (vector from Python's hashlib, not this code), the info
 * strings exactly sas.ts's, the table Matrix's. */
TEST(sas_pure_halves) {
    char *c = e2e_sas_commitment(E1, "q83vEjRWeJA");
    CHECK_STR(c, "XIFb95Im3c4aW857Wot8m7a5x0P6G65tGzhwThYCi04");
    free(c);
    char *info = e2e_sas_info("AK", "Akey", "BK", "Bkey", "q83vEjRWeJA");
    CHECK_STR(info, "irc-e2e:v1:sas:AK|Akey|BK|Bkey|q83vEjRWeJA");
    free(info);
    char *mac = e2e_sas_mac_info(false, "own", "peer", "tx");
    CHECK_STR(mac, "irc-e2e:v1:sas-mac:own|peer|tx");
    free(mac);
    char *mmac = e2e_sas_mac_info(true, "peer", "own", "tx");
    CHECK_STR(mmac, "irc-e2e:v2:sas-mmac:peer|own|tx");
    free(mmac);
    CHECK_STR(e2e_sas_emoji_glyph(0), "\xF0\x9F\x90\xB6");
    CHECK_STR(e2e_sas_emoji_name(0), "Dog");
    CHECK_STR(e2e_sas_emoji_glyph(21), "\xE2\x98\x81\xEF\xB8\x8F"); /* ☁️ with its U+FE0F */
    CHECK_STR(e2e_sas_emoji_name(36), "Thumbs Up");
    CHECK_STR(e2e_sas_emoji_name(41), "Light Bulb");
    CHECK_STR(e2e_sas_emoji_name(63), "Pin");
    CHECK(e2e_sas_emoji_glyph(64) == NULL && e2e_sas_emoji_name(64) == NULL);
    const uint8_t seven[7] = {0, 1, 21, 36, 46, 53, 63};
    char line[256];
    e2e_sas_emoji_line(seven, line, sizeof(line));
    CHECK_STR(line, "\xF0\x9F\x90\xB6 Dog  \xF0\x9F\x90\xB1 Cat  \xE2\x98\x81\xEF\xB8\x8F Cloud  "
                    "\xF0\x9F\x91\x8D Thumbs Up  \xF0\x9F\x94\x92 Lock  \xE2\x9C\x88\xEF\xB8\x8F "
                    "Aeroplane  \xF0\x9F\x93\x8C Pin");
    CHECK_STR(e2e_sas_reason_text("mismatch"), "the emoji did not match");
    CHECK_STR(e2e_sas_reason_text("other-device"), "answered on another device");
    CHECK(e2e_sas_reason_text("because") == NULL);
    CHECK_STR(e2e_sas_phase_name(E2E_SAS_COMPARE), "compare");
}

static void log_rows(world *w, device *d, size_t from) {
    for (size_t i = from; i < d->rows.n; i++) {
        const e2e_row *row = &d->rows.v[i];
        logf_(w, "%s row %s%s%s%s", d->name, e2e_row_kind_name(row->kind),
              row->kind == E2E_ROW_SAS_ASKED || row->kind == E2E_ROW_SAS_CANCELLED
                  ? (row->by_peer ? " by peer" : " by you")
                  : "",
              row->body ? " " : "", row->body ? row->body : "");
    }
}

static void sas_user(world *w, device *d, const char *nick, e2e_sas_step step,
                     e2e_sas_outcome want) {
    e2e_ctx c = ctx_of(w, d);
    e2e_result r;
    e2e_result_init(&r);
    size_t before = d->rows.n;
    e2e_sas_outcome got = e2e_sas_user(&c, d->sas, nick, step, &r, &d->rows);
    CHECK(got == want);
    log_rows(w, d, before);
    pump(w, d, &r, 0);
}

static bool sas_view(world *w, device *d, const char *nick, e2e_sas_view *v) {
    e2e_ctx c = ctx_of(w, d);
    e2e_result r;
    e2e_result_init(&r);
    size_t before = d->rows.n;
    bool got = e2e_sas_view_of(&c, d->sas, nick, v, &r, &d->rows);
    log_rows(w, d, before);
    pump(w, d, &r, 0);
    return got;
}

static bool verified_by(world *w, device *d, const char *nick) {
    e2e_ctx c = ctx_of(w, d);
    const char *m;
    bool verified = false;
    size_t trusted;
    return e2e_pinned(&c, nick, &m, &verified, &trusted) && verified;
}

/* Both know each other: a text each way, so both hold sessions and pins. */
static void sas_meet(world *w, device *a, const char *a_to, device *b, const char *b_to) {
    send_text(w, a, a_to, "hi", "m1");
    send_text(w, b, b_to, "hello", "m2");
}

static void sas_world(world *w, device **alice, device **bob) {
    memset(w, 0, sizeof(*w));
    w->now = NOW0;
    w->next_msgid = 1;
    *alice = add_user(w, "alice", "alice", 0);
    *bob = add_user(w, "bob", "Bob", 1);
    sas_meet(w, *alice, "bob", *bob, "alice");
}

/* A starts, B accepts, both see the same 7 emoji, both match: each
 * verifies the other's MASTER, and nothing runs after. */
TEST(sas_full_run_verifies_both_masters) {
    static world w;
    device *alice, *bob;
    sas_world(&w, &alice, &bob);
    CHECK(!verified_by(&w, alice, "bob") && !verified_by(&w, bob, "alice"));
    e2e_ctx ac = ctx_of(&w, alice);
    bool clock_before = e2e_waits_on_the_clock(&ac);

    sas_user(&w, alice, "bob", E2E_SAS_STEP_START, E2E_SAS_DONE);
    CHECK(logged(&w, "alice row sas_asked by you"));
    CHECK(logged(&w, "bob row sas_asked by peer"));
    CHECK(alice->rec.state.nsas == 1 && bob->rec.state.nsas == 1);
    CHECK_STR(alice->rec.state.sas[0].tx, bob->rec.state.sas[0].tx);
    CHECK_STR(bob->rec.state.sas[0].master, alice->rec.own->master);
    CHECK_STR(bob->rec.state.sas[0].device, alice->e);
    ac = ctx_of(&w, alice);
    CHECK(e2e_waits_on_the_clock(&ac)); /* the 600 s are on the clock */
    /* One SAS per master. */
    sas_user(&w, alice, "bob", E2E_SAS_STEP_START, E2E_SAS_RUNNING);
    sas_user(&w, alice, "nobody", E2E_SAS_STEP_START, E2E_SAS_NO_PIN);
    sas_user(&w, bob, "alice", E2E_SAS_STEP_MATCH, E2E_SAS_NOT_NOW);
    e2e_sas_view v;
    CHECK(sas_view(&w, bob, "alice", &v) && v.phase == E2E_SAS_ASKED && !v.here && !v.role_a);
    CHECK(sas_view(&w, alice, "bob", &v) && v.phase == E2E_SAS_STARTED && v.here && v.role_a);

    sas_user(&w, bob, "alice", E2E_SAS_STEP_ACCEPT, E2E_SAS_DONE);
    /* accept → A's key → B's key: both compare now. */
    CHECK(alice->rec.state.sas[0].phase == E2E_SAS_COMPARE);
    CHECK(bob->rec.state.sas[0].phase == E2E_SAS_COMPARE);
    /* What B committed to is what B then showed. */
    char *want = e2e_sas_commitment(bob->rec.state.sas[0].our_key, bob->rec.state.sas[0].tx);
    CHECK_STR(alice->rec.state.sas[0].commitment, want);
    free(want);
    e2e_sas_view va, vb;
    CHECK(sas_view(&w, alice, "bob", &va) && va.has_emoji && va.phase == E2E_SAS_COMPARE);
    CHECK(sas_view(&w, bob, "alice", &vb) && vb.has_emoji && vb.here);
    CHECK(memcmp(va.emoji, vb.emoji, 7) == 0);
    for (int i = 0; i < 7; i++) CHECK(va.emoji[i] < 64);

    sas_user(&w, alice, "bob", E2E_SAS_STEP_MATCH, E2E_SAS_DONE);
    CHECK(sas_view(&w, alice, "bob", &va) && va.confirmed);
    sas_user(&w, alice, "bob", E2E_SAS_STEP_MATCH, E2E_SAS_NOT_NOW); /* once */
    CHECK(!verified_by(&w, alice, "bob") && !verified_by(&w, bob, "alice"));
    CHECK(bob->rec.state.sas[0].their_mac != NULL); /* kept until bob's human says */
    sas_user(&w, bob, "alice", E2E_SAS_STEP_MATCH, E2E_SAS_DONE);
    CHECK(verified_by(&w, alice, "bob") && verified_by(&w, bob, "alice"));
    CHECK(logged(&w, "alice row verified") && logged(&w, "bob row verified"));
    CHECK(alice->rec.state.nsas == 0 && bob->rec.state.nsas == 0);
    CHECK(!sas_view(&w, alice, "bob", &va));
    ac = ctx_of(&w, alice);
    CHECK(e2e_waits_on_the_clock(&ac) == clock_before);
    /* The verified row names the peer MASTER. */
    CHECK_STR(alice->rows.v[alice->rows.n - 1].key, bob->rec.own->master);
    world_free(&w);
}

/* They do not match: a cancel `mismatch`, and nobody is verified. */
TEST(sas_mismatch_cancels_and_verifies_nobody) {
    static world w;
    device *alice, *bob;
    sas_world(&w, &alice, &bob);
    sas_user(&w, alice, "bob", E2E_SAS_STEP_START, E2E_SAS_DONE);
    sas_user(&w, bob, "alice", E2E_SAS_STEP_ACCEPT, E2E_SAS_DONE);
    sas_user(&w, alice, "bob", E2E_SAS_STEP_MATCH, E2E_SAS_DONE);
    sas_user(&w, bob, "alice", E2E_SAS_STEP_MISMATCH, E2E_SAS_DONE);
    CHECK(logged(&w, "bob row sas_cancelled by you mismatch"));
    CHECK(logged(&w, "alice row sas_cancelled by peer mismatch"));
    CHECK(!verified_by(&w, alice, "bob") && !verified_by(&w, bob, "alice"));
    CHECK(alice->rec.state.nsas == 0 && bob->rec.state.nsas == 0);
    /* A declined request ends it the same way, `user`. */
    sas_user(&w, alice, "bob", E2E_SAS_STEP_START, E2E_SAS_DONE);
    sas_user(&w, bob, "alice", E2E_SAS_STEP_CANCEL, E2E_SAS_DONE);
    CHECK(logged(&w, "alice row sas_cancelled by peer user"));
    CHECK(alice->rec.state.nsas == 0);
    world_free(&w);
}

/* A MAC that is not the one expected: refused (`mac-mismatch`), and the
 * side that read it verifies nothing. */
TEST(sas_tampered_mac_is_refused) {
    static world w;
    device *alice, *bob;
    sas_world(&w, &alice, &bob);
    sas_user(&w, alice, "bob", E2E_SAS_STEP_START, E2E_SAS_DONE);
    sas_user(&w, bob, "alice", E2E_SAS_STEP_ACCEPT, E2E_SAS_DONE);
    w.tamper_sas_mac = true; /* what alice sends bob */
    sas_user(&w, alice, "bob", E2E_SAS_STEP_MATCH, E2E_SAS_DONE);
    sas_user(&w, bob, "alice", E2E_SAS_STEP_MATCH, E2E_SAS_DONE);
    CHECK(logged(&w, "bob row sas_cancelled by you mac-mismatch"));
    CHECK(!verified_by(&w, bob, "alice"));
    CHECK(bob->rec.state.nsas == 0);
    world_free(&w);
}

/* 600 s after the start, a cancel `timeout`; a step out of order ends it
 * `unexpected-message`. */
TEST(sas_times_out_and_refuses_steps_out_of_order) {
    static world w;
    device *alice, *bob;
    sas_world(&w, &alice, &bob);
    sas_user(&w, alice, "bob", E2E_SAS_STEP_START, E2E_SAS_DONE);
    w.now += E2E_SAS_TIMEOUT_MS - 1;
    e2e_ctx ac = ctx_of(&w, alice);
    e2e_result r;
    e2e_result_init(&r);
    e2e_sas_tick(&ac, alice->sas, &r, &alice->rows);
    CHECK(r.noutbound == 0 && alice->rec.state.nsas == 1);
    e2e_result_free(&r);
    w.now += 1;
    ac = ctx_of(&w, alice);
    e2e_result_init(&r);
    size_t before = alice->rows.n;
    e2e_sas_tick(&ac, alice->sas, &r, &alice->rows);
    log_rows(&w, alice, before);
    pump(&w, alice, &r, 0);
    CHECK(logged(&w, "alice row sas_cancelled by you timeout"));
    CHECK(logged(&w, "bob row sas_cancelled by peer timeout"));
    CHECK(alice->rec.state.nsas == 0 && bob->rec.state.nsas == 0);

    /* Bob sends a key before accepting anything. */
    sas_user(&w, alice, "bob", E2E_SAS_STEP_START, E2E_SAS_DONE);
    e2e_ctx bc = ctx_of(&w, bob);
    e2e_result_init(&r);
    char *inner = e2e_inner_sas_key(bob->rec.state.sas[0].tx, alice->k);
    CHECK(e2e_send(&bc, "alice", inner, E2E_SAS_TAG, 0, NULL, &r));
    free(inner);
    pump(&w, bob, &r, 0);
    CHECK(logged(&w, "alice row sas_cancelled by you unexpected-message"));
    CHECK(alice->rec.state.nsas == 0);
    world_free(&w);
}

/* Both ask at once: the smaller tx wins on both sides, and the one SAS
 * left runs to the end. */
TEST(sas_both_asking_keep_the_smaller_tx) {
    static world w;
    device *alice, *bob;
    sas_world(&w, &alice, &bob);
    w.hold = true;
    sas_user(&w, alice, "bob", E2E_SAS_STEP_START, E2E_SAS_DONE);
    sas_user(&w, bob, "alice", E2E_SAS_STEP_START, E2E_SAS_DONE);
    char ta[12], tb[12];
    snprintf(ta, sizeof(ta), "%s", alice->rec.state.sas[0].tx);
    snprintf(tb, sizeof(tb), "%s", bob->rec.state.sas[0].tx);
    /* The two starts cross: each is read before either answer leaves. */
    release_one(&w);
    release_one(&w);
    release_all(&w);
    const char *win = strcmp(ta, tb) < 0 ? ta : tb;
    CHECK(alice->rec.state.nsas == 1 && bob->rec.state.nsas == 1);
    CHECK_STR(alice->rec.state.sas[0].tx, win);
    CHECK_STR(bob->rec.state.sas[0].tx, win);
    CHECK(alice->rec.state.sas[0].phase == E2E_SAS_COMPARE);
    CHECK(bob->rec.state.sas[0].phase == E2E_SAS_COMPARE);
    CHECK(alice->rec.state.sas[0].role_a != bob->rec.state.sas[0].role_a);
    e2e_sas_view va, vb;
    CHECK(sas_view(&w, alice, "bob", &va) && sas_view(&w, bob, "alice", &vb));
    CHECK(va.has_emoji && vb.has_emoji && memcmp(va.emoji, vb.emoji, 7) == 0);
    sas_user(&w, alice, "bob", E2E_SAS_STEP_MATCH, E2E_SAS_DONE);
    sas_user(&w, bob, "alice", E2E_SAS_STEP_MATCH, E2E_SAS_DONE);
    CHECK(verified_by(&w, alice, "bob") && verified_by(&w, bob, "alice"));
    world_free(&w);
}

/* The record keeps the public half (cic's choice); the secret is memory
 * only, so a restart mid-SAS ends it `page-gone` at the next tick. A
 * request not accepted yet needs no secret and survives a restart. */
TEST(sas_survives_a_reload_only_without_its_secret) {
    static world w;
    device *alice, *bob;
    sas_world(&w, &alice, &bob);
    sas_user(&w, alice, "bob", E2E_SAS_STEP_START, E2E_SAS_DONE);
    reload(bob); /* asked: public only */
    e2e_sas_host_free(bob->sas);
    bob->sas = e2e_sas_host_new();
    e2e_ctx bc = ctx_of(&w, bob);
    e2e_result r;
    e2e_result_init(&r);
    e2e_sas_tick(&bc, bob->sas, &r, &bob->rows);
    CHECK(r.noutbound == 0 && bob->rec.state.nsas == 1);
    e2e_result_free(&r);
    sas_user(&w, bob, "alice", E2E_SAS_STEP_ACCEPT, E2E_SAS_DONE);
    CHECK(alice->rec.state.sas[0].phase == E2E_SAS_COMPARE);
    reload(alice); /* the record round-trips exactly, SAS included */
    e2e_sas_host_free(alice->sas);
    alice->sas = e2e_sas_host_new(); /* a restart */
    e2e_ctx ac = ctx_of(&w, alice);
    e2e_result_init(&r);
    size_t before = alice->rows.n;
    e2e_sas_tick(&ac, alice->sas, &r, &alice->rows);
    log_rows(&w, alice, before);
    pump(&w, alice, &r, 0);
    CHECK(logged(&w, "alice row sas_cancelled by you page-gone"));
    CHECK(logged(&w, "bob row sas_cancelled by peer page-gone"));
    CHECK(alice->rec.state.nsas == 0 && bob->rec.state.nsas == 0);
    world_free(&w);
}

/* A start reaches every device of the master; the first to accept is the
 * one it runs with, and the others are told `other-device`. */
TEST(sas_releases_the_other_devices) {
    static world w;
    memset(&w, 0, sizeof(w));
    w.now = NOW0;
    w.next_msgid = 1;
    device *carol = add_user(&w, "carol", "carol", 0);
    device *bob1 = add_user(&w, "bob1", "bob", 1);
    device *bob2 = pair_device(&w, bob1, "bob2");
    upload(bob1);
    send_text(&w, carol, "bob", "to both", "c1");
    send_text(&w, bob1, "carol", "from 1", "b1");
    send_text(&w, bob2, "carol", "from 2", "b2");
    sas_user(&w, carol, "bob", E2E_SAS_STEP_START, E2E_SAS_DONE);
    CHECK(bob1->rec.state.nsas == 1 && bob2->rec.state.nsas == 1);
    sas_user(&w, bob2, "carol", E2E_SAS_STEP_ACCEPT, E2E_SAS_DONE);
    CHECK(logged(&w, "bob1 row sas_cancelled by peer other-device"));
    CHECK(bob1->rec.state.nsas == 0);
    CHECK_STR(carol->rec.state.sas[0].device, bob2->e);
    sas_user(&w, carol, "bob", E2E_SAS_STEP_MATCH, E2E_SAS_DONE);
    sas_user(&w, bob2, "carol", E2E_SAS_STEP_MATCH, E2E_SAS_DONE);
    CHECK(verified_by(&w, carol, "bob") && verified_by(&w, bob2, "carol"));
    /* bob1 shares the master: carol's verification covers it too. */
    world_free(&w);
}

/* A pin by hand to another master ends the SAS on the nick, nothing sent. */
TEST(sas_ends_when_the_nick_is_repinned) {
    static world w;
    device *alice, *bob;
    sas_world(&w, &alice, &bob);
    sas_user(&w, alice, "bob", E2E_SAS_STEP_START, E2E_SAS_DONE);
    e2e_ctx ac = ctx_of(&w, alice);
    e2e_result r;
    e2e_result_init(&r);
    CHECK(e2e_pin(&ac, "bob", E1, false, &r) == E2E_PIN_PINNED);
    e2e_result_free(&r);
    size_t before = alice->rows.n;
    e2e_sas_repinned(&ac, alice->sas, "bob", &alice->rows);
    log_rows(&w, alice, before);
    CHECK(logged(&w, "alice row sas_cancelled by you key-changed"));
    CHECK(alice->rec.state.nsas == 0);
    world_free(&w);
}

/* The holder signs a device out (identity.ts revokeDevice): one version
 * up, the rest still listed, its own device never. */
TEST(own_revoked_signs_the_rest_one_up) {
    static world w;
    memset(&w, 0, sizeof(w));
    w.now = NOW0;
    device *h = add_user(&w, "h", "vjt", 0);
    device *p = pair_device(&w, h, "p");
    e2e_own out;
    bool unlisted;
    CHECK(e2e_own_revoked(&h->rec, p->e, &out, &unlisted));
    CHECK(out.list_ver == h->rec.own->list_ver + 1);
    CHECK(out.list_devices.n == 1);
    CHECK_STR(out.list_devices.v[0], h->e);
    CHECK_STR(out.cert, h->rec.own->cert); /* the certificate stays */
    e2e_master_list m = {.ed25519 = out.master, .ver = (double)out.list_ver, .ndevices = 1,
                         .sig = out.list_sig};
    m.devices[0] = out.list_devices.v[0];
    CHECK(e2e_valid_master_list(&m));
    e2e_own_free(&out);
    CHECK(!e2e_own_revoked(&h->rec, h->e, &out, &unlisted) && !unlisted);
    CHECK(!e2e_own_revoked(&h->rec, E1, &out, &unlisted) && unlisted);
    CHECK(!e2e_own_revoked(&p->rec, h->e, &out, &unlisted)); /* no master here */
    world_free(&w);
}

/* openAlarm / lastComparison over the history rows; the new kinds
 * round-trip with their fields. */
TEST(trust_rows_read_as_cic_reads_them) {
    e2e_row rows_v[] = {
        mkrow("1", E2E_ROW_IN, 1, "bob", "hi", E1),
        mkrow("2", E2E_ROW_KEY_ALARM, 2, "Bob", NULL, E2),
        mkrow("3", E2E_ROW_KEY_ALARM, 3, "carol", NULL, E1),
    };
    e2e_rows rows = {rows_v, 3};
    CHECK_STR(e2e_open_alarm(&rows, "BOB"), E2);
    CHECK_STR(e2e_open_alarm(&rows, "carol"), E1);
    CHECK(e2e_open_alarm(&rows, "dave") == NULL);
    e2e_row more_v[] = {
        mkrow("1", E2E_ROW_KEY_ALARM, 1, "bob", NULL, E2),
        mkrow("2", E2E_ROW_ACCEPTED, 2, "bob", NULL, E2),
        mkrow("3", E2E_ROW_SAS_CANCELLED, 3, "bob", "mismatch", NULL),
    };
    more_v[2].by_peer = true;
    e2e_rows more = {more_v, 3};
    CHECK(e2e_open_alarm(&more, "bob") == NULL);
    const e2e_row *last = e2e_last_comparison(&more, "bob");
    CHECK(last && last->kind == E2E_ROW_SAS_CANCELLED);
    more.n = 2;
    CHECK(e2e_last_comparison(&more, "bob") == NULL); /* a key chosen since */

    e2e_row kinds[] = {
        mkrow("p", E2E_ROW_PINNED, 1, "bob", NULL, E1),
        mkrow("a", E2E_ROW_ACCEPTED, 2, "bob", NULL, E2),
        mkrow("v", E2E_ROW_VERIFIED, 3, "bob", NULL, E1),
        mkrow("s", E2E_ROW_SAS_ASKED, 4, "bob", NULL, NULL),
        mkrow("c", E2E_ROW_SAS_CANCELLED, 5, "bob", "timeout", NULL),
    };
    kinds[3].by_peer = true;
    for (size_t i = 0; i < 5; i++) {
        char *json = e2e_row_to_json(&kinds[i]);
        e2e_row back;
        CHECK(e2e_row_from_json(json, strlen(json), &back));
        CHECK(back.kind == kinds[i].kind && back.by_peer == kinds[i].by_peer);
        CHECK((back.key == NULL) == (kinds[i].key == NULL));
        CHECK((back.body == NULL) == (kinds[i].body == NULL));
        if (back.key) CHECK_STR(back.key, kinds[i].key);
        if (back.body) CHECK_STR(back.body, kinds[i].body);
        e2e_row_free(&back);
        free(json);
    }
    const char *bad = "{\"v\":1,\"id\":\"x\",\"kind\":\"sas_asked\",\"at\":1,\"nick\":\"a\",\"by\":\"them\"}";
    e2e_row r;
    CHECK(!e2e_row_from_json(bad, strlen(bad), &r));
}

/* ── order challenges (orders.ts SendLog) ────────────────────────────── */

/* A CHAL as the bot builds it, parsed as the drain parses it. */
static bool chal_of(e2e_inner *in, const char *network, const char *channel, const char *body,
                    const char *nonce, int64_t expires_at) {
    char sha[65];
    e2e_line_sha256(body, strlen(body), sha);
    char *t = e2e_inner_chal(network, channel, "vjt!v@host", sha, nonce, expires_at);
    bool ok = e2e_inner_parse(t, strlen(t), in);
    free(t);
    return ok;
}

TEST(line_sha256_is_lowercase_hex_of_the_bytes) {
    char out[65];
    e2e_line_sha256("abc", 3, out);
    CHECK_STR(out, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    /* The bytes as sent: a CTCP ACTION hashes with its \x01s, UTF-8 raw. */
    char act[65], plain[65];
    e2e_line_sha256("\001ACTION waves\001", 14, act);
    e2e_line_sha256("ACTION waves", 12, plain);
    CHECK(strcmp(act, plain) != 0);
}

TEST(order_check_confirms_only_what_this_device_sent) {
    const int64_t t0 = 1700000000000;           /* ms */
    const int64_t live = 1700000000 + 60;       /* the CHAL's expires_at, s */
    const e2e_order_scope sc = {"azzurra", "Azzurra", "#&+!"};
    e2e_send_log log = {0};
    e2e_send_log_record(&log, "azzurra", "#Grappa", "!op vjt", 7, t0);
    e2e_inner in;

    /* Exactly that line, that channel (folded), that network: confirmed —
     * once per nonce; the same CHAL again is answered again; another
     * nonce for the same line is not. */
    CHECK(chal_of(&in, "Azzurra", "#grappa", "!op vjt", "n1", live));
    CHECK(e2e_order_check(&log, &in, "bot", true, &sc, t0 + 1000) == E2E_ORDER_CONFIRMED);
    CHECK(e2e_order_check(&log, &in, "bot", true, &sc, t0 + 2000) == E2E_ORDER_CONFIRMED);
    e2e_inner_free(&in);
    CHECK(chal_of(&in, "Azzurra", "#grappa", "!op vjt", "n2", live));
    CHECK(e2e_order_check(&log, &in, "bot", true, &sc, t0 + 2000) == E2E_ORDER_NOT_SENT);
    e2e_inner_free(&in);

    /* Unverified master: never, whatever was sent (checked first). */
    e2e_send_log_record(&log, "azzurra", "#grappa", "!kick x", 7, t0);
    CHECK(chal_of(&in, "Azzurra", "#grappa", "!kick x", "n3", live));
    CHECK(e2e_order_check(&log, &in, "bot", false, &sc, t0 + 1) == E2E_ORDER_UNVERIFIED);
    /* Another channel, another network slug: not sent. */
    const e2e_order_scope other_slug = {"libera", "Azzurra", "#&+!"};
    CHECK(e2e_order_check(&log, &in, "bot", true, &other_slug, t0 + 1) == E2E_ORDER_NOT_SENT);
    e2e_inner_free(&in);
    CHECK(chal_of(&in, "Azzurra", "#other", "!kick x", "n3", live));
    CHECK(e2e_order_check(&log, &in, "bot", true, &sc, t0 + 1) == E2E_ORDER_NOT_SENT);
    e2e_inner_free(&in);
    /* The NETWORK= token, exactly: case and escapes are not folded. */
    CHECK(chal_of(&in, "azzurra", "#grappa", "!kick x", "n3", live));
    CHECK(e2e_order_check(&log, &in, "bot", true, &sc, t0 + 1) == E2E_ORDER_OTHER_NETWORK);
    e2e_inner_free(&in);
    CHECK(chal_of(&in, "Azzurra", "#grappa", "!kick x", "n3", live));
    const e2e_order_scope unnamed = {"azzurra", "", "#&+!"};
    CHECK(e2e_order_check(&log, &in, "bot", true, &unnamed, t0 + 1) == E2E_ORDER_UNNAMED_NETWORK);
    const e2e_order_scope null_net = {"azzurra", NULL, "#&+!"};
    CHECK(e2e_order_check(&log, &in, "bot", true, &null_net, t0 + 1) == E2E_ORDER_UNNAMED_NETWORK);
    /* Outside the window by our clock: forgotten. */
    CHECK(e2e_order_check(&log, &in, "bot", true, &sc, t0 + E2E_SENT_WINDOW_MS + 1) ==
          E2E_ORDER_NOT_SENT);
    e2e_inner_free(&in);

    /* Past expires_at by our clock: expired, the line still there. */
    e2e_send_log_record(&log, "azzurra", "#grappa", "!voice y", 8, t0 + 40000);
    CHECK(chal_of(&in, "Azzurra", "#grappa", "!voice y", "n4", (t0 + 40000) / 1000));
    CHECK(e2e_order_check(&log, &in, "bot", true, &sc, t0 + 40000) == E2E_ORDER_EXPIRED);
    e2e_inner_free(&in);
    CHECK(chal_of(&in, "Azzurra", "#grappa", "!voice y", "n4", (t0 + 40000) / 1000 + 1));
    CHECK(e2e_order_check(&log, &in, "bot", true, &sc, t0 + 40000) == E2E_ORDER_CONFIRMED);
    e2e_inner_free(&in);

    /* A line sent after the CHAL's moment confirms nothing before it. */
    e2e_send_log_record(&log, "azzurra", "#grappa", "!later", 6, t0 + 50000);
    CHECK(chal_of(&in, "Azzurra", "#grappa", "!later", "n5", live + 100));
    CHECK(e2e_order_check(&log, &in, "bot", true, &sc, t0 + 49000) == E2E_ORDER_NOT_SENT);
    e2e_inner_free(&in);

    e2e_send_log_free(&log);
}

TEST(order_check_reads_a_private_message_to_the_bot_only) {
    const int64_t t0 = 1700000000000;
    const e2e_order_scope sc = {"azzurra", "Azzurra", "#&"};
    e2e_send_log log = {0};
    e2e_send_log_record(&log, "azzurra", "OrderBot", "status", 6, t0);
    e2e_send_log_record(&log, "azzurra", "alice", "status", 6, t0);
    e2e_inner in;
    /* To the bot asking: its own nick (folded) is the CHAL's channel. */
    CHECK(chal_of(&in, "Azzurra", "orderbot", "status", "p1", 1700000060));
    CHECK(e2e_order_check(&log, &in, "OrderBot", true, &sc, t0 + 5) == E2E_ORDER_CONFIRMED);
    e2e_inner_free(&in);
    /* A PM to somebody else is never the bot's to confirm. */
    CHECK(chal_of(&in, "Azzurra", "alice", "status", "p2", 1700000060));
    CHECK(e2e_order_check(&log, &in, "OrderBot", true, &sc, t0 + 5) == E2E_ORDER_PM_TO_ANOTHER);
    e2e_inner_free(&in);
    /* With "+" outside this network's CHANTYPES, +chan is a nick. */
    e2e_send_log_record(&log, "azzurra", "+modeless", "x", 1, t0);
    CHECK(chal_of(&in, "Azzurra", "+modeless", "x", "p3", 1700000060));
    CHECK(e2e_order_check(&log, &in, "OrderBot", true, &sc, t0 + 5) == E2E_ORDER_PM_TO_ANOTHER);
    e2e_inner_free(&in);
    e2e_send_log_free(&log);
}

TEST(send_log_forgets_a_failed_send_and_never_the_echo) {
    const int64_t t0 = 1700000000000;
    const e2e_order_scope sc = {"azzurra", "Azzurra", "#"};
    e2e_send_log log = {0};
    /* Sent, then the POST failed: forgotten, so it confirms nothing. */
    e2e_send_log_record(&log, "azzurra", "#c", "!op me", 6, t0);
    e2e_send_log_forget(&log, "azzurra", "#c", "!op me", 6, t0);
    CHECK_LONG(log.n, 0);
    e2e_inner in;
    CHECK(chal_of(&in, "Azzurra", "#c", "!op me", "f1", 1700000060));
    CHECK(e2e_order_check(&log, &in, "bot", true, &sc, t0 + 5) == E2E_ORDER_NOT_SENT);
    e2e_inner_free(&in);
    /* The bound: the oldest goes first. */
    for (int i = 0; i < E2E_SENT_LOG_MAX + 3; i++) {
        char b[16];
        snprintf(b, sizeof(b), "l%d", i);
        e2e_send_log_record(&log, "azzurra", "#c", b, strlen(b), t0);
    }
    CHECK_LONG(log.n, E2E_SENT_LOG_MAX);
    CHECK(chal_of(&in, "Azzurra", "#c", "l0", "f2", 1700000060));
    CHECK(e2e_order_check(&log, &in, "bot", true, &sc, t0 + 5) == E2E_ORDER_NOT_SENT);
    e2e_inner_free(&in);
    CHECK(chal_of(&in, "Azzurra", "#c", "l514", "f3", 1700000060));
    CHECK(e2e_order_check(&log, &in, "bot", true, &sc, t0 + 5) == E2E_ORDER_CONFIRMED);
    e2e_inner_free(&in);
    CHECK_STR(e2e_order_verdict_name(E2E_ORDER_PM_TO_ANOTHER), "pm-to-another");
    e2e_send_log_free(&log);
}

int main(void) {
    RUN(did_vectors);
    RUN(fb_vectors_are_cicchettos);
    RUN(signed_strings);
    RUN(base64_both_spellings_and_refusals);
    RUN(valid_ver_and_fold);
    RUN(lines_needed_matches_grappa);
    RUN(payload_refuses_what_is_no_object);
    RUN(pkmsg_ver_is_a_lists_ver);
    RUN(bodies_are_one_to_four_dids_of_strings);
    RUN(keys_shape);
    RUN(valid_master_list_rules);
    RUN(inner_types_strict);
    RUN(consent_and_small_payloads);
    RUN(top_up_fills_grappa_and_stops);
    RUN(bootstrap_identity_signs_v1);
    RUN(sync_decides_as_run_sync);
    RUN(two_engines_talk);
    RUN(two_devices_one_message);
    RUN(receiver_checks);
    RUN(sending_refusals);
    RUN(store_atomic_locked_private);
    RUN(store_seals_a_plaintext_record_on_load);
    RUN(record_refuses_what_it_did_not_write);
    RUN(record_keeps_the_encrypted_queries);
    RUN(pair_initial_payload_crosses_the_relay);
    RUN(pair_messages_decode_strictly);
    RUN(pair_issue_and_accept);
    RUN(record_start_over_keeps_only_trust);
    RUN(iso8601_instants);
    RUN(history_rows_round_trip);
    RUN(history_appends_dedupes_and_survives_a_torn_tail);
    RUN(history_names_are_fixed_length_and_old_names_migrate);
    RUN(history_is_sealed_and_refuses_what_does_not_open);
    RUN(sas_pure_halves);
    RUN(sas_full_run_verifies_both_masters);
    RUN(sas_mismatch_cancels_and_verifies_nobody);
    RUN(sas_tampered_mac_is_refused);
    RUN(sas_times_out_and_refuses_steps_out_of_order);
    RUN(sas_both_asking_keep_the_smaller_tx);
    RUN(sas_survives_a_reload_only_without_its_secret);
    RUN(sas_releases_the_other_devices);
    RUN(sas_ends_when_the_nick_is_repinned);
    RUN(own_revoked_signs_the_rest_one_up);
    RUN(trust_rows_read_as_cic_reads_them);
    RUN(line_sha256_is_lowercase_hex_of_the_bytes);
    RUN(order_check_confirms_only_what_this_device_sent);
    RUN(order_check_reads_a_private_message_to_the_bot_only);
    RUN(send_log_forgets_a_failed_send_and_never_the_echo);
    return test_report();
}
