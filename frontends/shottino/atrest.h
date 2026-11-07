/* atrest — the E2E state, sealed at rest.
 *
 * One random 256-bit data key per identity (`<state>/e2e-<hash>`) seals
 * every file under it with AES-256-GCM: a fresh 12-byte nonce per seal, and
 * an AAD naming the format, the file's ROLE and its NAME relative to the
 * identity directory, so a sealed file moved to another name, another
 * network or another role does not open. Pure: bytes in, bytes out, no
 * file is touched here (e2e.c and shottino.c own the paths).
 *
 *   a sealed file  AR_FILE_MAGIC (16: "SHOTTINO-SEALED" + version 1),
 *                  nonce (12), ciphertext, tag (16). The magic is in the AAD.
 *   a sealed line  "e1:" + base64(nonce || ciphertext || tag), no newline:
 *                  one per history row, so an append stays an append.
 *   a wrapped key  AR_WRAP_MAGIC (16: "SHOTTINO-KEYWRP" + version 1), salt
 *                  (16), nonce (12), the key sealed (32 + tag 16) under
 *                  scrypt(passphrase, salt, N=2^17, r=8, p=1). Version 1
 *                  IS those parameters: none is read off the file, so a
 *                  file cannot talk the derivation down.
 *
 * A wrong key, a tampered byte, a file under another name and a wrong
 * passphrase all fail the tag the same way: AR_REFUSED. Every plaintext
 * handed back is the caller's, to free with ar_free_secret. */
#ifndef SHOTTINO_ATREST_H
#define SHOTTINO_ATREST_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define AR_KEY_LEN 32
#define AR_NONCE_LEN 12
#define AR_TAG_LEN 16
#define AR_SALT_LEN 16
#define AR_MAGIC_LEN 16
#define AR_FILE_MAGIC "SHOTTINO-SEALED\x01"
#define AR_WRAP_MAGIC "SHOTTINO-KEYWRP\x01"
#define AR_LINE_PREFIX "e1:"
/* The scrypt cost of version 1. */
#define AR_SCRYPT_N (1UL << 17)
#define AR_SCRYPT_R 8UL
#define AR_SCRYPT_P 1UL

typedef enum {
    AR_OK,
    AR_REFUSED,  /* the tag did not verify: wrong key or passphrase, tampered, swapped */
    AR_MALFORMED /* not this format at all (too short, wrong magic, not base64) */
} ar_status;

/* `n` random bytes (RAND_bytes); false when the generator refuses. */
bool ar_random(uint8_t *out, size_t n);
/* OPENSSL_cleanse, then free. NULL is fine. */
void ar_free_secret(void *p, size_t n);

/* Whether `data` starts with AR_FILE_MAGIC: a sealed file, as opposed to
 * one of the plaintext ones it replaces. */
bool ar_is_sealed(const void *data, size_t len);
/* `pt` sealed as a whole file (magic, nonce, ciphertext, tag), malloc'd;
 * NULL only when the generator or the cipher refuses. */
uint8_t *ar_seal(const uint8_t key[AR_KEY_LEN], const char *role, const char *name,
                 const void *pt, size_t pt_len, size_t *out_len);
/* The plaintext of a sealed file (NUL-terminated past `pt_len`). */
ar_status ar_open(const uint8_t key[AR_KEY_LEN], const char *role, const char *name,
                  const void *data, size_t len, char **pt, size_t *pt_len);

/* One sealed line, "e1:…" (NUL-terminated, no newline), malloc'd. */
char *ar_seal_line(const uint8_t key[AR_KEY_LEN], const char *role, const char *name,
                   const void *pt, size_t pt_len);
/* The plaintext of one sealed line (`line` without its newline). */
ar_status ar_open_line(const uint8_t key[AR_KEY_LEN], const char *role, const char *name,
                       const char *line, size_t len, char **pt, size_t *pt_len);

/* `key` wrapped under `passphrase` (a fresh salt and nonce), malloc'd. */
uint8_t *ar_wrap(const char *passphrase, const uint8_t key[AR_KEY_LEN], size_t *out_len);
/* The key out of a wrapped one: AR_REFUSED for a wrong passphrase. */
ar_status ar_unwrap(const char *passphrase, const void *data, size_t len,
                    uint8_t key[AR_KEY_LEN]);

/* Base64 (standard alphabet, padded) of `n` bytes, malloc'd; and back,
 * false for anything that is not. `out` is the caller's to free. */
char *ar_b64(const uint8_t *p, size_t n);
bool ar_unb64(const char *s, size_t len, uint8_t **out, size_t *out_len);

#endif
