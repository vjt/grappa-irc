/* test_atrest — the seal around the E2E state at rest.
 *
 * What a sealed file must refuse is the whole value of sealing it: a byte
 * changed anywhere, a file moved to another name or role, another key, a
 * wrong passphrase. Each of those is a case here, under ASan/UBSan. */
#include "../atrest.h"
#include "../keyring.h"

#include <limits.h>
#include <signal.h>
#include <time.h>
#include "test.h"

static const uint8_t KEY[AR_KEY_LEN] = {1,  2,  3,  4,  5,  6,  7,  8,  9,  10, 11,
                                        12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22,
                                        23, 24, 25, 26, 27, 28, 29, 30, 31, 32};

static const char BODY[] = "{\"v\":1,\"account\":\"pickle\",\"secret\":\"the body\"}";

static bool contains(const uint8_t *hay, size_t n, const char *needle) {
    size_t k = strlen(needle);
    for (size_t i = 0; i + k <= n; i++)
        if (memcmp(hay + i, needle, k) == 0) return true;
    return false;
}

TEST(a_sealed_file_opens_to_what_was_sealed) {
    size_t n = 0;
    uint8_t *sealed = ar_seal(KEY, "record", "1/record.sealed", BODY, strlen(BODY), &n);
    CHECK(sealed != NULL);
    CHECK_LONG(n, AR_MAGIC_LEN + AR_NONCE_LEN + strlen(BODY) + AR_TAG_LEN);
    CHECK(ar_is_sealed(sealed, n));
    CHECK(!ar_is_sealed(BODY, strlen(BODY)));
    CHECK(!contains(sealed, n, "the body"));
    char *pt = NULL;
    size_t pt_len = 0;
    CHECK(ar_open(KEY, "record", "1/record.sealed", sealed, n, &pt, &pt_len) == AR_OK);
    CHECK_LONG(pt_len, strlen(BODY));
    CHECK_STR(pt, BODY);
    ar_free_secret(pt, pt_len);
    free(sealed);
}

TEST(two_seals_of_one_body_differ) {
    size_t a_n, b_n;
    uint8_t *a = ar_seal(KEY, "record", "1/record.sealed", BODY, strlen(BODY), &a_n);
    uint8_t *b = ar_seal(KEY, "record", "1/record.sealed", BODY, strlen(BODY), &b_n);
    CHECK(a_n == b_n && memcmp(a, b, a_n) != 0);
    free(a);
    free(b);
}

TEST(every_tampered_byte_is_refused) {
    size_t n = 0;
    uint8_t *sealed = ar_seal(KEY, "record", "1/record.sealed", BODY, strlen(BODY), &n);
    size_t refused = 0;
    for (size_t i = 0; i < n; i++) {
        sealed[i] ^= 0x01;
        char *pt = NULL;
        size_t pt_len = 0;
        ar_status st = ar_open(KEY, "record", "1/record.sealed", sealed, n, &pt, &pt_len);
        if (st != AR_OK) refused++;
        else ar_free_secret(pt, pt_len);
        sealed[i] ^= 0x01;
    }
    CHECK_LONG(refused, n);
    /* Cut short, or grown by a byte. */
    char *pt = NULL;
    size_t pt_len = 0;
    CHECK(ar_open(KEY, "record", "1/record.sealed", sealed, n - 1, &pt, &pt_len) != AR_OK);
    CHECK(ar_open(KEY, "record", "1/record.sealed", sealed, AR_MAGIC_LEN, &pt, &pt_len) ==
          AR_MALFORMED);
    free(sealed);
}

TEST(a_file_under_another_name_role_or_key_is_refused) {
    size_t n = 0;
    uint8_t *sealed = ar_seal(KEY, "record", "1/record.sealed", BODY, strlen(BODY), &n);
    char *pt = NULL;
    size_t pt_len = 0;
    /* Swapped to another network's directory. */
    CHECK(ar_open(KEY, "record", "2/record.sealed", sealed, n, &pt, &pt_len) == AR_REFUSED);
    /* Read as another role. */
    CHECK(ar_open(KEY, "chat", "1/record.sealed", sealed, n, &pt, &pt_len) == AR_REFUSED);
    uint8_t other[AR_KEY_LEN];
    memcpy(other, KEY, sizeof(other));
    other[31] ^= 0x80;
    CHECK(ar_open(other, "record", "1/record.sealed", sealed, n, &pt, &pt_len) == AR_REFUSED);
    CHECK(pt == NULL);
    free(sealed);
}

TEST(a_sealed_line_round_trips_and_binds_its_file) {
    const char *row = "{\"id\":\"in:1:0\",\"kind\":\"in\",\"body\":\"hello there\"}";
    const char *name = "1/chats/chat-sha256-ab.sealed";
    char *line = ar_seal_line(KEY, "chat", name, row, strlen(row));
    CHECK(line != NULL);
    CHECK(strncmp(line, AR_LINE_PREFIX, 3) == 0);
    CHECK(strchr(line, '\n') == NULL);
    CHECK(strstr(line, "hello") == NULL);
    char *pt = NULL;
    size_t pt_len = 0;
    CHECK(ar_open_line(KEY, "chat", name, line, strlen(line), &pt, &pt_len) == AR_OK);
    CHECK_STR(pt, row);
    ar_free_secret(pt, pt_len);
    /* The line of one peer's chat, moved into another's. */
    CHECK(ar_open_line(KEY, "chat", "1/chats/chat-sha256-cd.sealed", line, strlen(line), &pt,
                       &pt_len) == AR_REFUSED);
    /* A changed character. */
    line[10] = line[10] == 'A' ? 'B' : 'A';
    CHECK(ar_open_line(KEY, "chat", name, line, strlen(line), &pt, &pt_len) != AR_OK);
    /* No prefix: a plaintext row is not a sealed one. */
    CHECK(ar_open_line(KEY, "chat", name, row, strlen(row), &pt, &pt_len) == AR_MALFORMED);
    free(line);
}

TEST(a_wrapped_key_opens_with_its_passphrase_only) {
    size_t n = 0;
    uint8_t *w = ar_wrap("correct horse", KEY, &n);
    CHECK(w != NULL);
    CHECK_LONG(n, AR_MAGIC_LEN + AR_SALT_LEN + AR_NONCE_LEN + AR_KEY_LEN + AR_TAG_LEN);
    uint8_t got[AR_KEY_LEN] = {0};
    CHECK(ar_unwrap("correct horse", w, n, got) == AR_OK);
    CHECK(memcmp(got, KEY, AR_KEY_LEN) == 0);
    uint8_t none[AR_KEY_LEN] = {0};
    memset(got, 0, sizeof(got));
    CHECK(ar_unwrap("correct horsf", w, n, got) == AR_REFUSED);
    CHECK(memcmp(got, none, AR_KEY_LEN) == 0);
    CHECK(ar_unwrap("", w, n, got) == AR_REFUSED);
    w[AR_MAGIC_LEN] ^= 1; /* the salt */
    CHECK(ar_unwrap("correct horse", w, n, got) == AR_REFUSED);
    CHECK(ar_unwrap("correct horse", w, n - 1, got) == AR_MALFORMED);
    free(w);
}

TEST(base64_round_trips_and_refuses_junk) {
    uint8_t raw[40];
    for (size_t i = 0; i < sizeof(raw); i++) raw[i] = (uint8_t)(i * 37);
    for (size_t n = 0; n <= sizeof(raw); n++) {
        char *s = ar_b64(raw, n);
        uint8_t *back = NULL;
        size_t back_n = 0;
        CHECK(ar_unb64(s, strlen(s), &back, &back_n));
        CHECK(back_n == n && (n == 0 || memcmp(back, raw, n) == 0));
        free(back);
        free(s);
    }
    uint8_t *out = NULL;
    size_t out_n = 0;
    CHECK(!ar_unb64("abc", 3, &out, &out_n));
    CHECK(!ar_unb64("ab!d", 4, &out, &out_n));
    CHECK(!ar_unb64("a===", 4, &out, &out_n));
    CHECK(!ar_unb64("ab=d", 4, &out, &out_n));
}


/* A name derived under the key: stable for one key, label and input,
 * different for any other of the three, and no plain digest of the input. */
TEST(a_keyed_name_needs_the_key) {
    char a[65], b[65], c[65], d[65];
    ar_name_mac(KEY, "chat-name", "alice", 5, a);
    ar_name_mac(KEY, "chat-name", "alice", 5, b);
    CHECK_STR(a, b);
    CHECK_LONG(strlen(a), 64);
    uint8_t other[AR_KEY_LEN];
    memcpy(other, KEY, sizeof(other));
    other[7] ^= 1;
    ar_name_mac(other, "chat-name", "alice", 5, c);
    CHECK(strcmp(a, c) != 0);
    ar_name_mac(KEY, "other-use", "alice", 5, d);
    CHECK(strcmp(a, d) != 0);
    /* RFC 4231-style shape: HMAC-SHA256(KEY, "chat-name" || "alice"),
     * computed independently with Python's hmac module. */
    CHECK_STR(a, "ae642c92c30be49b28f0c9ef37f64809bad78fefacfa677c4aab20250e9732dc");
}

/* ── the keyring, through a fake secret-tool ──────────────────────────── */

static char keyring_dir[PATH_MAX];

static void keyring_use_fake(const char *mode) {
    char cwd[PATH_MAX], tool[PATH_MAX + 32];
    if (!getcwd(cwd, sizeof(cwd))) {
        FAIL("getcwd");
        return;
    }
    snprintf(tool, sizeof(tool), "%s/tests/fake-secret-tool", cwd);
    if (access(tool, X_OK) != 0) FAIL("tests/fake-secret-tool is missing (run from frontends/shottino)");
    setenv("SHOTTINO_SECRET_TOOL", tool, 1);
    setenv("FAKE_KEYRING", keyring_dir, 1);
    if (mode) setenv("FAKE_KEYRING_MODE", mode, 1);
    else unsetenv("FAKE_KEYRING_MODE");
}

static bool keyring_log_has(const char *needle) {
    char path[PATH_MAX + 8];
    snprintf(path, sizeof(path), "%s/log", keyring_dir);
    FILE *f = fopen(path, "r");
    if (!f) return false;
    char line[512];
    bool found = false;
    while (fgets(line, sizeof(line), f))
        if (strstr(line, needle)) found = true;
    fclose(f);
    return found;
}

TEST(the_keyring_stores_and_hands_back_the_key) {
    keyring_use_fake(NULL);
    uint8_t got[AR_KEY_LEN];
    CHECK(!kr_lookup("idhash1", got));
    CHECK(kr_store("idhash1", KEY));
    memset(got, 0, sizeof(got));
    CHECK(kr_lookup("idhash1", got));
    CHECK(memcmp(got, KEY, AR_KEY_LEN) == 0);
    /* Its own item: another identity has nothing there. */
    CHECK(!kr_lookup("idhash2", got));
    CHECK(keyring_log_has("store application shottino purpose e2e-data-key identity idhash1"));
    CHECK(keyring_log_has("lookup application shottino purpose e2e-data-key identity idhash1"));
}

TEST(a_keyring_that_refuses_or_forgets_is_no_keyring) {
    keyring_use_fake("fail");
    uint8_t got[AR_KEY_LEN];
    CHECK(!kr_store("idhash3", KEY));
    CHECK(!kr_lookup("idhash1", got));
    /* A store that cannot be read back is not one. */
    keyring_use_fake("forget");
    CHECK(!kr_store("idhash3", KEY));
    CHECK(!kr_lookup("idhash3", got));
    keyring_use_fake(NULL);
}

TEST(no_secret_tool_is_no_keyring) {
    setenv("SHOTTINO_SECRET_TOOL", "/nonexistent/secret-tool", 1);
    uint8_t got[AR_KEY_LEN];
    CHECK(!kr_store("idhash4", KEY));
    CHECK(!kr_lookup("idhash4", got));
    /* On PATH, and not there. */
    unsetenv("SHOTTINO_SECRET_TOOL");
    char *path = getenv("PATH") ? strdup(getenv("PATH")) : NULL;
    setenv("PATH", keyring_dir, 1);
    CHECK(!kr_lookup("idhash4", got));
    if (path) setenv("PATH", path, 1);
    free(path);
}

/* What the keyring answers that is not a key is not taken for one. */
TEST(a_keyring_answer_that_is_no_key_is_refused) {
    keyring_use_fake(NULL);
    char path[PATH_MAX + 80];
    snprintf(path, sizeof(path), "%s/application.shottino.purpose.e2e-data-key.identity.junk.",
             keyring_dir);
    FILE *f = fopen(path, "w");
    CHECK(f != NULL);
    if (f) {
        fputs("bm90IGEga2V5", f); /* "not a key" */
        fclose(f);
    }
    uint8_t got[AR_KEY_LEN];
    CHECK(!kr_lookup("junk", got));
}

/* A tool that closes its stdout and then never exits is killed at the
 * deadline: the wait for it cannot hang the client. */
TEST(a_secret_tool_that_hangs_is_killed_at_the_deadline) {
    keyring_use_fake("linger");
    kr_set_timeout_ms(300);
    struct timespec a, b;
    clock_gettime(CLOCK_MONOTONIC, &a);
    uint8_t got[AR_KEY_LEN];
    CHECK(!kr_lookup("idhash5", got));
    clock_gettime(CLOCK_MONOTONIC, &b);
    long ms = (long)(b.tv_sec - a.tv_sec) * 1000 + (b.tv_nsec - a.tv_nsec) / 1000000;
    CHECK(ms < 2000);
    kr_set_timeout_ms(KR_TIMEOUT_MS);
    keyring_use_fake(NULL);
}

int main(void) {
    RUN(a_sealed_file_opens_to_what_was_sealed);
    RUN(two_seals_of_one_body_differ);
    RUN(every_tampered_byte_is_refused);
    RUN(a_file_under_another_name_role_or_key_is_refused);
    RUN(a_sealed_line_round_trips_and_binds_its_file);
    RUN(a_wrapped_key_opens_with_its_passphrase_only);
    RUN(base64_round_trips_and_refuses_junk);
    RUN(a_keyed_name_needs_the_key);
    signal(SIGPIPE, SIG_IGN); /* as shottino's main does */
    char tmpl[] = "/tmp/shottino-keyring-XXXXXX";
    if (!mkdtemp(tmpl)) {
        FAIL("mkdtemp");
        return test_report();
    }
    snprintf(keyring_dir, sizeof(keyring_dir), "%s", tmpl);
    RUN(the_keyring_stores_and_hands_back_the_key);
    RUN(a_keyring_that_refuses_or_forgets_is_no_keyring);
    RUN(no_secret_tool_is_no_keyring);
    RUN(a_keyring_answer_that_is_no_key_is_refused);
    RUN(a_secret_tool_that_hangs_is_killed_at_the_deadline);
    char rm[PATH_MAX + 16];
    snprintf(rm, sizeof(rm), "rm -rf '%s'", keyring_dir);
    if (system(rm) != 0) FAIL("rm");
    return test_report();
}
