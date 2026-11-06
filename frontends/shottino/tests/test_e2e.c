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

/* Logs what a step said, carries what it sent, and frees it. */
static void pump(world *w, device *from, e2e_result *r, int depth) {
    log_result(w, from, r);
    if (depth > 12) abort(); /* two engines echoing forever is a bug */
    for (size_t i = 0; from == w->mute && i < r->noutbound; i++)
        logf_(w, "%s lost %s", from->name, e2e_verb_name(r->outbound[i].verb));
    for (size_t i = 0; from != w->mute && i < r->noutbound; i++)
        carry(w, from, &r->outbound[i], depth);
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
    CHECK(e2e_store_load(st, &back, err, sizeof(err)) == E2E_LOAD_NONE);
    e2e_record_new(&rec);
    rec.master = vz_account_new();
    rec.own = calloc(1, sizeof(*rec.own));
    e2e_own_bootstrap(rec.account, rec.master, rec.own);
    rec.state.inbox = 42;
    CHECK(e2e_store_save(st, &rec, err, sizeof(err)));
    char *path = xfmt("%s/record.json", dir);
    CHECK(stat(path, &sb) == 0 && (sb.st_mode & 0777) == 0600);
    CHECK(e2e_store_load(st, &back, err, sizeof(err)) == E2E_LOAD_OK);
    char *j1 = e2e_record_to_json(&rec), *j2 = e2e_record_to_json(&back);
    CHECK_STR(j2, j1);
    CHECK(back.state.inbox == 42 && back.master != NULL && back.own != NULL);
    free(j1);
    free(j2);
    e2e_record_free(&back);
    /* No temp file left behind. */
    char *tmp = xfmt("%s/record.json.tmp.%ld", dir, (long)getpid());
    CHECK(access(tmp, F_OK) != 0);
    free(tmp);
    /* A file that is not a record is CORRUPT, never half-loaded. */
    int fd = open(path, O_WRONLY | O_TRUNC);
    CHECK(fd >= 0 && write(fd, "{\"v\":1,\"account\":\"x\"}", 22) == 22);
    close(fd);
    CHECK(e2e_store_load(st, &back, err, sizeof(err)) == E2E_LOAD_CORRUPT);
    e2e_store_close(st);
    /* Closed, the lock is free again. */
    CHECK(e2e_store_open(dir, &st, err, sizeof(err)) == E2E_STORE_OK);
    e2e_store_close(st);
    e2e_record_free(&rec);
    free(path);
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
    RUN(two_engines_talk);
    RUN(two_devices_one_message);
    RUN(receiver_checks);
    RUN(sending_refusals);
    RUN(store_atomic_locked_private);
    RUN(record_refuses_what_it_did_not_write);
    return test_report();
}
