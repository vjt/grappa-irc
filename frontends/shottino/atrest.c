/* atrest — see atrest.h. */
#include "atrest.h"

#include <stdlib.h>
#include <string.h>

#include <openssl/crypto.h>
#include <openssl/evp.h>
#include <openssl/hmac.h>
#include <openssl/rand.h>

#define FMT_FILE "file1"
#define FMT_LINE "line1"
#define FMT_WRAP "wrap1"
/* scrypt at N=2^17, r=8 needs 128 MiB; OpenSSL's default cap is 32. */
#define SCRYPT_MAXMEM (256UL * 1024 * 1024)

static void *xmalloc(size_t n) {
    void *p = malloc(n ? n : 1);
    if (!p) abort();
    return p;
}

bool ar_random(uint8_t *out, size_t n) { return RAND_bytes(out, (int)n) == 1; }

void ar_free_secret(void *p, size_t n) {
    if (!p) return;
    OPENSSL_cleanse(p, n);
    free(p);
}

bool ar_is_sealed(const void *data, size_t len) {
    return len >= AR_MAGIC_LEN && memcmp(data, AR_FILE_MAGIC, AR_MAGIC_LEN) == 0;
}

/* format \0 role \0 name [\0 extra]: what the tag binds besides the bytes. */
static uint8_t *aad_of(const char *fmt, const char *role, const char *name, const void *extra,
                       size_t extra_len, size_t *len) {
    size_t f = strlen(fmt) + 1, r = strlen(role) + 1, n = strlen(name) + 1;
    uint8_t *a = xmalloc(f + r + n + extra_len);
    memcpy(a, fmt, f);
    memcpy(a + f, role, r);
    memcpy(a + f + r, name, n);
    if (extra_len) memcpy(a + f + r + n, extra, extra_len);
    *len = f + r + n + extra_len;
    return a;
}

/* AES-256-GCM of `pt` into `ct` (same length) and `tag`. */
static bool gcm_seal(const uint8_t key[AR_KEY_LEN], const uint8_t nonce[AR_NONCE_LEN],
                     const uint8_t *aad, size_t aad_len, const void *pt, size_t pt_len,
                     uint8_t *ct, uint8_t tag[AR_TAG_LEN]) {
    EVP_CIPHER_CTX *c = EVP_CIPHER_CTX_new();
    int n = 0;
    bool ok = c && EVP_EncryptInit_ex(c, EVP_aes_256_gcm(), NULL, NULL, NULL) == 1 &&
              EVP_CIPHER_CTX_ctrl(c, EVP_CTRL_GCM_SET_IVLEN, AR_NONCE_LEN, NULL) == 1 &&
              EVP_EncryptInit_ex(c, NULL, NULL, key, nonce) == 1 &&
              EVP_EncryptUpdate(c, NULL, &n, aad, (int)aad_len) == 1 &&
              (pt_len == 0 || EVP_EncryptUpdate(c, ct, &n, pt, (int)pt_len) == 1) &&
              EVP_EncryptFinal_ex(c, ct + (pt_len ? (size_t)n : 0), &n) == 1 &&
              EVP_CIPHER_CTX_ctrl(c, EVP_CTRL_GCM_GET_TAG, AR_TAG_LEN, tag) == 1;
    EVP_CIPHER_CTX_free(c);
    return ok;
}

static bool gcm_open(const uint8_t key[AR_KEY_LEN], const uint8_t nonce[AR_NONCE_LEN],
                     const uint8_t *aad, size_t aad_len, const uint8_t *ct, size_t ct_len,
                     const uint8_t tag[AR_TAG_LEN], uint8_t *pt) {
    EVP_CIPHER_CTX *c = EVP_CIPHER_CTX_new();
    int n = 0;
    uint8_t t[AR_TAG_LEN];
    memcpy(t, tag, sizeof(t));
    bool ok = c && EVP_DecryptInit_ex(c, EVP_aes_256_gcm(), NULL, NULL, NULL) == 1 &&
              EVP_CIPHER_CTX_ctrl(c, EVP_CTRL_GCM_SET_IVLEN, AR_NONCE_LEN, NULL) == 1 &&
              EVP_DecryptInit_ex(c, NULL, NULL, key, nonce) == 1 &&
              EVP_DecryptUpdate(c, NULL, &n, aad, (int)aad_len) == 1 &&
              (ct_len == 0 || EVP_DecryptUpdate(c, pt, &n, ct, (int)ct_len) == 1) &&
              EVP_CIPHER_CTX_ctrl(c, EVP_CTRL_GCM_SET_TAG, AR_TAG_LEN, t) == 1 &&
              EVP_DecryptFinal_ex(c, pt + (ct_len ? (size_t)n : 0), &n) == 1;
    EVP_CIPHER_CTX_free(c);
    return ok;
}

/* nonce || ct || tag of `pt`, under `aad`. */
static uint8_t *seal_body(const uint8_t key[AR_KEY_LEN], const uint8_t *aad, size_t aad_len,
                          const void *pt, size_t pt_len, size_t prefix, size_t *out_len) {
    size_t n = prefix + AR_NONCE_LEN + pt_len + AR_TAG_LEN;
    uint8_t *out = xmalloc(n);
    uint8_t *nonce = out + prefix;
    if (!ar_random(nonce, AR_NONCE_LEN) ||
        !gcm_seal(key, nonce, aad, aad_len, pt, pt_len, nonce + AR_NONCE_LEN,
                  nonce + AR_NONCE_LEN + pt_len)) {
        free(out);
        return NULL;
    }
    *out_len = n;
    return out;
}

/* The plaintext of nonce || ct || tag, NUL-terminated. */
static ar_status open_body(const uint8_t key[AR_KEY_LEN], const uint8_t *aad, size_t aad_len,
                           const uint8_t *body, size_t len, char **pt, size_t *pt_len) {
    *pt = NULL;
    *pt_len = 0;
    if (len < AR_NONCE_LEN + AR_TAG_LEN) return AR_MALFORMED;
    size_t ct_len = len - AR_NONCE_LEN - AR_TAG_LEN;
    uint8_t *out = xmalloc(ct_len + 1);
    if (!gcm_open(key, body, aad, aad_len, body + AR_NONCE_LEN, ct_len, body + len - AR_TAG_LEN,
                  out)) {
        ar_free_secret(out, ct_len + 1);
        return AR_REFUSED;
    }
    out[ct_len] = 0;
    *pt = (char *)out;
    *pt_len = ct_len;
    return AR_OK;
}

uint8_t *ar_seal(const uint8_t key[AR_KEY_LEN], const char *role, const char *name,
                 const void *pt, size_t pt_len, size_t *out_len) {
    size_t aad_len;
    uint8_t *aad = aad_of(FMT_FILE, role, name, AR_FILE_MAGIC, AR_MAGIC_LEN, &aad_len);
    uint8_t *out = seal_body(key, aad, aad_len, pt, pt_len, AR_MAGIC_LEN, out_len);
    free(aad);
    if (out) memcpy(out, AR_FILE_MAGIC, AR_MAGIC_LEN);
    return out;
}

ar_status ar_open(const uint8_t key[AR_KEY_LEN], const char *role, const char *name,
                  const void *data, size_t len, char **pt, size_t *pt_len) {
    *pt = NULL;
    *pt_len = 0;
    if (!ar_is_sealed(data, len)) return AR_MALFORMED;
    size_t aad_len;
    uint8_t *aad = aad_of(FMT_FILE, role, name, AR_FILE_MAGIC, AR_MAGIC_LEN, &aad_len);
    ar_status st = open_body(key, aad, aad_len, (const uint8_t *)data + AR_MAGIC_LEN,
                             len - AR_MAGIC_LEN, pt, pt_len);
    free(aad);
    return st;
}

char *ar_seal_line(const uint8_t key[AR_KEY_LEN], const char *role, const char *name,
                   const void *pt, size_t pt_len) {
    size_t aad_len, n;
    uint8_t *aad = aad_of(FMT_LINE, role, name, NULL, 0, &aad_len);
    uint8_t *body = seal_body(key, aad, aad_len, pt, pt_len, 0, &n);
    free(aad);
    if (!body) return NULL;
    char *b = ar_b64(body, n);
    free(body);
    size_t bl = strlen(b);
    char *line = xmalloc(3 + bl + 1);
    memcpy(line, AR_LINE_PREFIX, 3);
    memcpy(line + 3, b, bl + 1);
    free(b);
    return line;
}

ar_status ar_open_line(const uint8_t key[AR_KEY_LEN], const char *role, const char *name,
                       const char *line, size_t len, char **pt, size_t *pt_len) {
    *pt = NULL;
    *pt_len = 0;
    uint8_t *body = NULL;
    size_t n = 0;
    if (len < 3 || memcmp(line, AR_LINE_PREFIX, 3) != 0 || !ar_unb64(line + 3, len - 3, &body, &n))
        return AR_MALFORMED;
    size_t aad_len;
    uint8_t *aad = aad_of(FMT_LINE, role, name, NULL, 0, &aad_len);
    ar_status st = open_body(key, aad, aad_len, body, n, pt, pt_len);
    free(aad);
    free(body);
    return st;
}

/* scrypt(passphrase, salt) at version 1's cost. */
static bool kek_of(const char *passphrase, const uint8_t salt[AR_SALT_LEN],
                   uint8_t kek[AR_KEY_LEN]) {
    return EVP_PBE_scrypt(passphrase, strlen(passphrase), salt, AR_SALT_LEN, AR_SCRYPT_N,
                          AR_SCRYPT_R, AR_SCRYPT_P, SCRYPT_MAXMEM, kek, AR_KEY_LEN) == 1;
}

#define WRAP_LEN (AR_MAGIC_LEN + AR_SALT_LEN + AR_NONCE_LEN + AR_KEY_LEN + AR_TAG_LEN)

uint8_t *ar_wrap(const char *passphrase, const uint8_t key[AR_KEY_LEN], size_t *out_len) {
    uint8_t *out = xmalloc(WRAP_LEN);
    memcpy(out, AR_WRAP_MAGIC, AR_MAGIC_LEN);
    uint8_t *salt = out + AR_MAGIC_LEN, *nonce = salt + AR_SALT_LEN;
    uint8_t kek[AR_KEY_LEN];
    size_t aad_len = 0;
    uint8_t *aad = NULL;
    bool ok = ar_random(salt, AR_SALT_LEN) && ar_random(nonce, AR_NONCE_LEN);
    if (ok) {
        /* The magic and the salt are bound too: the salt is what the key
         * the tag checks was derived from. */
        aad = aad_of(FMT_WRAP, "key", "key.wrapped", out, AR_MAGIC_LEN + AR_SALT_LEN, &aad_len);
        ok = kek_of(passphrase, salt, kek) &&
             gcm_seal(kek, nonce, aad, aad_len, key, AR_KEY_LEN, nonce + AR_NONCE_LEN,
                      nonce + AR_NONCE_LEN + AR_KEY_LEN);
    }
    OPENSSL_cleanse(kek, sizeof(kek));
    free(aad);
    if (!ok) {
        free(out);
        return NULL;
    }
    *out_len = WRAP_LEN;
    return out;
}

ar_status ar_unwrap(const char *passphrase, const void *data, size_t len,
                    uint8_t key[AR_KEY_LEN]) {
    const uint8_t *d = data;
    if (len != WRAP_LEN || memcmp(d, AR_WRAP_MAGIC, AR_MAGIC_LEN) != 0) return AR_MALFORMED;
    const uint8_t *salt = d + AR_MAGIC_LEN, *nonce = salt + AR_SALT_LEN;
    uint8_t kek[AR_KEY_LEN], got[AR_KEY_LEN];
    size_t aad_len;
    uint8_t *aad = aad_of(FMT_WRAP, "key", "key.wrapped", d, AR_MAGIC_LEN + AR_SALT_LEN, &aad_len);
    bool ok = kek_of(passphrase, salt, kek) &&
              gcm_open(kek, nonce, aad, aad_len, nonce + AR_NONCE_LEN, AR_KEY_LEN,
                       nonce + AR_NONCE_LEN + AR_KEY_LEN, got);
    free(aad);
    OPENSSL_cleanse(kek, sizeof(kek));
    if (ok) memcpy(key, got, AR_KEY_LEN);
    OPENSSL_cleanse(got, sizeof(got));
    return ok ? AR_OK : AR_REFUSED;
}

void ar_name_mac(const uint8_t key[AR_KEY_LEN], const char *label, const void *data, size_t len,
                 char out[65]) {
    size_t ll = strlen(label);
    uint8_t *msg = xmalloc(ll + len);
    memcpy(msg, label, ll);
    if (len) memcpy(msg + ll, data, len);
    uint8_t mac[32];
    unsigned int mac_len = 0;
    if (!HMAC(EVP_sha256(), key, AR_KEY_LEN, msg, ll + len, mac, &mac_len) || mac_len != 32)
        abort();
    ar_free_secret(msg, ll + len);
    static const char hex[] = "0123456789abcdef";
    for (size_t i = 0; i < 32; i++) {
        out[2 * i] = hex[mac[i] >> 4];
        out[2 * i + 1] = hex[mac[i] & 15];
    }
    out[64] = 0;
}

char *ar_b64(const uint8_t *p, size_t n) {
    char *out = xmalloc(4 * ((n + 2) / 3) + 1);
    EVP_EncodeBlock((unsigned char *)out, p, (int)n);
    return out;
}

bool ar_unb64(const char *s, size_t len, uint8_t **out, size_t *out_len) {
    *out = NULL;
    *out_len = 0;
    if (len % 4) return false;
    size_t pad = 0;
    for (size_t i = 0; i < len; i++) {
        char c = s[i];
        bool alpha = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
                     c == '+' || c == '/';
        if (c == '=') {
            if (i < len - 2) return false;
            pad++;
        } else if (!alpha || pad) {
            return false;
        }
    }
    uint8_t *buf = xmalloc(len / 4 * 3 + 1);
    int n = len ? EVP_DecodeBlock(buf, (const unsigned char *)s, (int)len) : 0;
    if (n < 0) {
        free(buf);
        return false;
    }
    *out = buf;
    *out_len = (size_t)n - pad;
    return true;
}
