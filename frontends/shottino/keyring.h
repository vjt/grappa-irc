/* keyring — the E2E data key in the OS keyring, through the Secret Service.
 *
 * GNOME Keyring and recent KWallet both answer the Secret Service, and
 * `secret-tool` (libsecret-tools / libsecret) is its command line. It is
 * RUN, never linked: fork + execvp with no shell, the key in base64 on its
 * stdin and read back from its stdout, stderr to /dev/null so nothing it
 * says reaches the terminal. The item's attributes are
 *
 *   application shottino  purpose e2e-data-key  identity <token_key_hash>
 *
 * The binary is looked up on PATH; SHOTTINO_SECRET_TOOL names another one
 * (the tests' fake). A binary that is missing, exits non-zero, outlives
 * KR_TIMEOUT_MS or answers something that is not a key all read as "the
 * keyring has nothing for us": the caller cannot tell a locked keyring from
 * an empty one, and must never take the second for the first (see
 * shottino.c, "E2E: the data key"). */
#ifndef SHOTTINO_KEYRING_H
#define SHOTTINO_KEYRING_H

#include <stdbool.h>
#include <stdint.h>

#include "atrest.h"

#define KR_TIMEOUT_MS 30000

/* The deadline of every run of the tool, KR_TIMEOUT_MS unless set. */
void kr_set_timeout_ms(long ms);

/* The key stored for `identity`, or false. */
bool kr_lookup(const char *identity, uint8_t key[AR_KEY_LEN]);
/* Stores `key` for `identity` (replacing any) and reads it back: true only
 * when what comes back is `key`. */
bool kr_store(const char *identity, const uint8_t key[AR_KEY_LEN]);

#endif
