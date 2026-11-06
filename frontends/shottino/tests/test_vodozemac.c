/* test_vodozemac.c — the C binding over vodozemac, end to end.
 *
 * Two of everything talk to each other through the binding exactly as two
 * clients would: Olm both ways (pre-key, then normal messages), SAS from
 * both sides, ECIES from both sides, pickles that survive a round trip.
 * And the binding's own promise is checked: malformed input from the wire
 * comes back as an error, never as a crash — including the 33-byte key
 * that makes vodozemac itself panic.
 */
#include "../e2e/vodozemac-c/include/vodozemac.h"
#include "test.h"

#include <stdlib.h>
#include <string.h>

static char *first_otk(vz_account *a) {
    char *json = vz_account_one_time_keys(a);
    CHECK(json != NULL && json[0] == '[' && json[1] == '"');
    if (!json) return NULL;
    char *start = strchr(json, '"') + 1;
    char *end = strchr(start, '"');
    char *key = strndup(start, (size_t)(end - start));
    vz_str_free(json);
    return key;
}

TEST(olm_both_ways) {
    vz_account *alice = vz_account_new(), *bob = vz_account_new();
    CHECK(alice && bob);
    CHECK(vz_account_generate_one_time_keys(bob, 1) == 0);
    char *bob_curve = vz_account_curve25519_key(bob);
    char *bob_otk = first_otk(bob);
    CHECK(bob_curve && strlen(bob_curve) == 43);
    CHECK(bob_otk && strlen(bob_otk) == 43);

    vz_session *out = vz_account_create_outbound_session(alice, bob_curve, bob_otk);
    CHECK(out != NULL);
    CHECK(vz_session_has_received_message(out) == 0);
    size_t type = 9;
    vz_buf body;
    CHECK(vz_session_encrypt(out, (const uint8_t *)"ciao", 4, &type, &body) == 0);
    CHECK(type == 0); /* pre-key until the peer answers */

    char *sid = vz_pre_key_session_id(body.ptr, body.len);
    char *out_id = vz_session_id(out);
    CHECK(sid && out_id && strcmp(sid, out_id) == 0);

    char *alice_curve = vz_account_curve25519_key(alice);
    vz_buf plain;
    vz_session *in = vz_account_create_inbound_session(bob, alice_curve, body.ptr, body.len, &plain);
    CHECK(in != NULL);
    CHECK(plain.len == 4 && memcmp(plain.ptr, "ciao", 4) == 0);
    vz_buf_free(plain);
    vz_buf_free(body);

    /* Bob answers with a normal message; after reading it, Alice's session
     * stops sending pre-key messages. */
    CHECK(vz_session_encrypt(in, (const uint8_t *)"perché", 7, &type, &body) == 0);
    CHECK(type == 1);
    CHECK(vz_session_decrypt(out, type, body.ptr, body.len, &plain) == 0);
    CHECK(plain.len == 7 && memcmp(plain.ptr, "perché", 7) == 0);
    vz_buf_free(plain);
    vz_buf_free(body);
    CHECK(vz_session_has_received_message(out) == 1);

    /* A pickled session picks up where it left off. */
    char *pickle = vz_session_pickle(out);
    CHECK(pickle != NULL);
    vz_session *again = vz_session_from_pickle(pickle);
    CHECK(again != NULL);
    CHECK(vz_session_encrypt(again, (const uint8_t *)"x", 1, &type, &body) == 0);
    CHECK(type == 1);
    CHECK(vz_session_decrypt(in, type, body.ptr, body.len, &plain) == 0);
    CHECK(plain.len == 1 && plain.ptr[0] == 'x');
    vz_buf_free(plain);
    vz_buf_free(body);

    /* A tampered message fails, and the binding says why. */
    CHECK(vz_session_encrypt(again, (const uint8_t *)"y", 1, &type, &body) == 0);
    body.ptr[body.len - 1] ^= 1;
    CHECK(vz_session_decrypt(in, type, body.ptr, body.len, &plain) == -1);
    CHECK(vz_last_error()[0] != '\0');
    vz_buf_free(body);

    vz_str_free(pickle);
    vz_str_free(sid);
    vz_str_free(out_id);
    vz_str_free(alice_curve);
    vz_str_free(bob_curve);
    free(bob_otk);
    vz_session_free(again);
    vz_session_free(out);
    vz_session_free(in);
    vz_account_free(alice);
    vz_account_free(bob);
}

TEST(account_keys_publish_and_pickle) {
    vz_account *a = vz_account_new();
    CHECK(vz_account_max_one_time_keys(a) >= 50);
    CHECK(vz_account_generate_one_time_keys(a, 3) == 0);
    char *json = vz_account_one_time_keys(a);
    int n = 0;
    for (char *p = json; p && *p; p++) n += *p == '"';
    CHECK(n == 6); /* three quoted keys */
    vz_str_free(json);

    /* No fallback until generated: NULL, and NOT an error. */
    CHECK(vz_account_fallback_key(a) == NULL);
    CHECK(vz_last_error()[0] == '\0');
    CHECK(vz_account_generate_fallback_key(a) == 0);
    char *fb = vz_account_fallback_key(a);
    CHECK(fb && strlen(fb) == 43);
    vz_str_free(fb);

    CHECK(vz_account_mark_keys_as_published(a) == 0);
    json = vz_account_one_time_keys(a);
    CHECK(json && strcmp(json, "[]") == 0);
    vz_str_free(json);
    CHECK(vz_account_fallback_key(a) == NULL);

    char *ed = vz_account_ed25519_key(a);
    char *sig = vz_account_sign(a, "irc-e2e:v2:list:1:x");
    CHECK(sig && strlen(sig) == 86);
    CHECK(vz_verify_ed25519(ed, "irc-e2e:v2:list:1:x", sig) == 1);
    CHECK(vz_verify_ed25519(ed, "irc-e2e:v2:list:2:x", sig) == 0);
    CHECK(vz_verify_ed25519("garbage", "m", sig) == 0);

    char *pickle = vz_account_pickle(a);
    vz_account *b = vz_account_from_pickle(pickle);
    CHECK(b != NULL);
    char *ed2 = vz_account_ed25519_key(b);
    CHECK(ed2 && strcmp(ed, ed2) == 0);
    CHECK(vz_account_from_pickle("{not json") == NULL);
    CHECK(vz_last_error()[0] != '\0');

    vz_str_free(ed);
    vz_str_free(ed2);
    vz_str_free(sig);
    vz_str_free(pickle);
    vz_account_free(a);
    vz_account_free(b);
}

TEST(sas_from_both_sides) {
    vz_sas *a = vz_sas_new(), *b = vz_sas_new();
    char *ka = vz_sas_public_key(a), *kb = vz_sas_public_key(b);
    vz_established_sas *ea = vz_sas_diffie_hellman(a, kb);
    vz_established_sas *eb = vz_sas_diffie_hellman(b, ka);
    CHECK(ea && eb);
    uint8_t ia[7], ib[7];
    CHECK(vz_established_sas_emoji_indices(ea, "irc-e2e:v1:sas:info", ia) == 0);
    CHECK(vz_established_sas_emoji_indices(eb, "irc-e2e:v1:sas:info", ib) == 0);
    CHECK(memcmp(ia, ib, 7) == 0);
    for (int i = 0; i < 7; i++) CHECK(ia[i] < 64);
    char *ma = vz_established_sas_calculate_mac(ea, "key", "irc-e2e:v1:sas-mac:x");
    char *mb = vz_established_sas_calculate_mac(eb, "key", "irc-e2e:v1:sas-mac:x");
    CHECK(ma && mb && strcmp(ma, mb) == 0);
    vz_str_free(ma);
    vz_str_free(mb);
    vz_str_free(ka);
    vz_str_free(kb);
    vz_established_sas_free(ea);
    vz_established_sas_free(eb);

    /* A bad key consumes the SAS and fails cleanly. */
    vz_sas *c = vz_sas_new();
    CHECK(vz_sas_diffie_hellman(c, "nope") == NULL);
}

TEST(ecies_from_both_sides) {
    vz_ecies *holder = vz_ecies_new("irc-e2e:v2:pair");
    vz_ecies *joiner = vz_ecies_new("irc-e2e:v2:pair");
    char *hk = vz_ecies_public_key(holder);
    char *initial = NULL;
    vz_established_ecies *j = vz_ecies_establish_outbound(joiner, hk, (const uint8_t *)"hello", 5, &initial);
    CHECK(j && initial);
    vz_buf plain;
    vz_established_ecies *h = vz_ecies_establish_inbound(holder, initial, &plain);
    CHECK(h != NULL);
    CHECK(plain.len == 5 && memcmp(plain.ptr, "hello", 5) == 0);
    vz_buf_free(plain);
    int cj = vz_established_ecies_check_code(j), ch = vz_established_ecies_check_code(h);
    CHECK(cj >= 0 && cj <= 99 && cj == ch);

    char *m = vz_established_ecies_encrypt(h, (const uint8_t *)"offer", 5);
    CHECK(vz_established_ecies_decrypt(j, m, &plain) == 0);
    CHECK(plain.len == 5 && memcmp(plain.ptr, "offer", 5) == 0);
    vz_buf_free(plain);
    /* Read once: the same message again is refused. */
    CHECK(vz_established_ecies_decrypt(j, m, &plain) == -1);
    vz_str_free(m);
    vz_str_free(hk);
    vz_str_free(initial);
    vz_established_ecies_free(j);
    vz_established_ecies_free(h);
}

/* The panic vodozemac itself has: a 44-character key that decodes to 33
 * bytes. The binding checks first, so this is an error, not an abort. */
TEST(wire_garbage_is_an_error_not_a_crash) {
    const char *k33 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"; /* 44 chars, 33 bytes */
    vz_account *a = vz_account_new();
    CHECK(vz_account_create_outbound_session(a, k33, k33) == NULL);
    CHECK(strstr(vz_last_error(), "32 bytes") != NULL);
    CHECK(vz_canonical_curve25519(k33) == NULL);
    CHECK(vz_verify_ed25519(k33, "m", "s") == 0);
    vz_buf plain;
    CHECK(vz_account_create_inbound_session(a, k33, (const uint8_t *)"zz", 2, &plain) == NULL);
    CHECK(plain.ptr == NULL);
    CHECK(vz_pre_key_session_id((const uint8_t *)"zz", 2) == NULL);
    CHECK(vz_account_create_outbound_session(NULL, k33, k33) == NULL);
    vz_account_free(a);
}

TEST(hash_and_base64) {
    uint8_t d[32];
    CHECK(vz_sha256((const uint8_t *)"abc", 3, d) == 0);
    CHECK(d[0] == 0xba && d[31] == 0xad); /* FIPS 180-2 "abc" */
    char *e = vz_base64_encode((const uint8_t *)"ab", 2);
    CHECK(e && strcmp(e, "YWI") == 0); /* unpadded */
    vz_buf b;
    CHECK(vz_base64_decode("YWI=", &b) == 0);
    CHECK(b.len == 2 && memcmp(b.ptr, "ab", 2) == 0);
    vz_buf_free(b);
    vz_str_free(e);
    /* The canonical spelling drops padding. */
    char *c = vz_canonical_ed25519("11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=");
    CHECK(c && strcmp(c, "11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo") == 0);
    vz_str_free(c);
}

int main(void) {
    RUN(olm_both_ways);
    RUN(account_keys_publish_and_pickle);
    RUN(sas_from_both_sides);
    RUN(ecies_from_both_sides);
    RUN(wire_garbage_is_an_error_not_a_crash);
    RUN(hash_and_base64);
    return test_report();
}
