/* vodozemac.h — shottino's C binding over vodozemac (Olm, SAS, ECIES).
 *
 * The native twin of cicchetto's wasm binding: same vodozemac version, same
 * surface, function for function. Source: ../src/lib.rs, which documents
 * each function; this header only declares them.
 *
 * Conventions:
 *   - Handles are opaque and freed by their vz_*_free. A function marked
 *     CONSUMES frees its handle argument, failed or not.
 *   - A returned char * is caller-owned UTF-8, freed with vz_str_free; a
 *     vz_buf with vz_buf_free.
 *   - Failure is NULL or -1, and vz_last_error() says why (this thread,
 *     until the next call). Nothing aborts: a panic inside vodozemac comes
 *     back as an error.
 *   - Keys and signatures are standard base64, unpadded.
 */
#ifndef SHOTTINO_VODOZEMAC_H
#define SHOTTINO_VODOZEMAC_H

#include <stddef.h>
#include <stdint.h>

typedef struct VzAccount vz_account;
typedef struct VzSession vz_session;
typedef struct VzSas vz_sas;
typedef struct VzEstablishedSas vz_established_sas;
typedef struct VzEcies vz_ecies;
typedef struct VzEstablishedEcies vz_established_ecies;

typedef struct {
    uint8_t *ptr;
    size_t len;
} vz_buf;

const char *vz_last_error(void);
void vz_str_free(char *s);
void vz_buf_free(vz_buf buf);

/* Account */
vz_account *vz_account_new(void);
vz_account *vz_account_from_pickle(const char *json);
char *vz_account_pickle(const vz_account *a);
void vz_account_free(vz_account *a);
char *vz_account_ed25519_key(const vz_account *a);
char *vz_account_curve25519_key(const vz_account *a);
char *vz_account_sign(const vz_account *a, const char *message);
size_t vz_account_max_one_time_keys(const vz_account *a);
int vz_account_generate_one_time_keys(vz_account *a, size_t count);
char *vz_account_one_time_keys(const vz_account *a); /* JSON array, oldest first */
int vz_account_generate_fallback_key(vz_account *a);
char *vz_account_fallback_key(const vz_account *a); /* NULL + empty error: none */
int vz_account_mark_keys_as_published(vz_account *a);
vz_session *vz_account_create_outbound_session(const vz_account *a, const char *identity_key,
                                               const char *one_time_key);
vz_session *vz_account_create_inbound_session(vz_account *a, const char *identity_key,
                                              const uint8_t *message, size_t message_len,
                                              vz_buf *plaintext);

/* Session */
vz_session *vz_session_from_pickle(const char *json);
char *vz_session_pickle(const vz_session *s);
void vz_session_free(vz_session *s);
char *vz_session_id(const vz_session *s);
int vz_session_has_received_message(const vz_session *s);
int vz_session_encrypt(vz_session *s, const uint8_t *plaintext, size_t plaintext_len,
                       size_t *message_type, vz_buf *body);
int vz_session_decrypt(vz_session *s, size_t message_type, const uint8_t *body, size_t body_len,
                       vz_buf *plaintext);

/* SAS */
vz_sas *vz_sas_new(void);
char *vz_sas_public_key(const vz_sas *s);
void vz_sas_free(vz_sas *s);
vz_established_sas *vz_sas_diffie_hellman(vz_sas *s, const char *their_key); /* CONSUMES s */
int vz_established_sas_emoji_indices(const vz_established_sas *s, const char *info,
                                     uint8_t out[7]);
char *vz_established_sas_calculate_mac(const vz_established_sas *s, const char *input,
                                       const char *info);
void vz_established_sas_free(vz_established_sas *s);

/* ECIES (MSC4108 shape) */
vz_ecies *vz_ecies_new(const char *info);
char *vz_ecies_public_key(const vz_ecies *e);
void vz_ecies_free(vz_ecies *e);
vz_established_ecies *vz_ecies_establish_outbound(vz_ecies *e, const char *their_key,
                                                  const uint8_t *plaintext, size_t plaintext_len,
                                                  char **message); /* CONSUMES e */
vz_established_ecies *vz_ecies_establish_inbound(vz_ecies *e, const char *initial,
                                                 vz_buf *plaintext); /* CONSUMES e */
int vz_established_ecies_check_code(const vz_established_ecies *e);
char *vz_established_ecies_encrypt(vz_established_ecies *e, const uint8_t *plaintext,
                                   size_t plaintext_len);
int vz_established_ecies_decrypt(vz_established_ecies *e, const char *message, vz_buf *plaintext);
void vz_established_ecies_free(vz_established_ecies *e);

/* Free functions */
char *vz_pre_key_session_id(const uint8_t *message, size_t message_len);
int vz_verify_ed25519(const char *key, const char *message, const char *signature);
int vz_sha256(const uint8_t *data, size_t data_len, uint8_t out[32]);
char *vz_canonical_ed25519(const char *key);
char *vz_canonical_curve25519(const char *key);
char *vz_base64_encode(const uint8_t *data, size_t data_len);
int vz_base64_decode(const char *text, vz_buf *out);

#endif
