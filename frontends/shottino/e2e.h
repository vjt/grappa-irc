/* e2e.h — cicchetto-compatible end-to-end encrypted queries, the pure core.
 *
 * What this is
 * ------------
 * A port of cicchetto's E2E wire (`cicchetto/src/lib/e2e/wire.ts`) and
 * engine (`engine.ts`), for one (subject, network): peers, pins, sessions,
 * and what each wire verb does to them. Pure in the IRC sense, like
 * wire.c: no socket, no HTTP, no ncurses, no app state, no globals. A step
 * takes a whole message grappa delivered (`e2e_receive`) or an inner
 * message for a peer (`e2e_send`) and answers, in an `e2e_result`, the
 * events for the application and the payloads to hand to grappa's send
 * door. The application (later slices) adds the doors around it.
 *
 * Interop is the contract. Every field name, signed string and check
 * order follows the cicchetto CODE, which is what interoperates today
 * (docs/plans/shottino-e2e-spec.md §16). Where this port differs, the
 * comment at the definition says why. All crypto goes through vodozemac
 * (e2e/vodozemac-c): nothing here is hand-rolled.
 *
 * Ownership
 * ---------
 * Every `char *` in a struct defined here is owned by that struct and
 * freed by its *_free function. `const char *` parameters are borrowed for
 * the call. Strings returned by a function are malloc'd: free(). Nothing
 * here returns a vodozemac string: those are copied and vz_str_free'd
 * inside. Allocation failure aborts (a terminal client has no better
 * answer); wire input never does — malformed input from the wire is
 * reported, never a crash.
 *
 * Time is passed in, as `now_ms` (unix milliseconds), never read here.
 */
#ifndef SHOTTINO_E2E_H
#define SHOTTINO_E2E_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "e2e/vodozemac-c/include/vodozemac.h"
#include "json.h"

/* ── Constants (wire.ts, engine.ts, keyBundle.ts) ─────────────────────── */

#define E2E_WIRE_VERSION 2
/* The most devices a list on the wire may name, and the most bodies one
 * message carries: what a receiver takes. */
#define E2E_MAX_DEVICES 4
/* The most devices one identity holds: what a list signed HERE names. */
#define E2E_DEVICE_CAP 3
#define E2E_MAX_FRAGMENTS 64
#define E2E_MAX_VER 2147483647L
/* A did is 11 characters of base64url; a key 43 of standard base64. */
#define E2E_DID_LEN 11
#define E2E_FB_LEN 22
#define E2E_MAX_HOSTED_ONE_TIME_KEYS 50

#define E2E_KEYREQ_RETRY_MS 30000
#define E2E_OUTQ_TTL_MS 90000
#define E2E_OUTQ_MAX 16
#define E2E_REKEY_INTERVAL_MS 60000
#define E2E_LISTREQ_INTERVAL_MS 60000
#define E2E_SENT_MEMORY_MS 1800000
#define E2E_SENT_MAX 1200
#define E2E_MAX_SENDS 2
#define E2E_MAX_SESSIONS_PER_PEER 5
#define E2E_SEEN_SESSIONS_MAX 10000

/* The tag of the engine's own list traffic (`t:list`, `t:listreq`): never
 * reported, and refused to a caller. */
#define E2E_LIST_TAG "list"

#define E2E_ID_SIG_PREFIX "irc-e2e:v2:id:"
#define E2E_OTK_SIG_PREFIX "irc-e2e:v1:otk:"
#define E2E_LIST_SIG_PREFIX "irc-e2e:v2:list:"
#define E2E_CERT_PREFIX "irc-e2e:v2:dev:"
#define E2E_BIND_PREFIX "irc-e2e:v2:bind:"

/* ── Closed sets ──────────────────────────────────────────────────────── */

/* E2E_VERB_NONE is "no verb": a `dropped` event about an inner message. */
typedef enum {
    E2E_VERB_NONE = 0,
    E2E_VERB_KEYREQ,
    E2E_VERB_KEYS,
    E2E_VERB_PKMSG,
    E2E_VERB_MSG,
    E2E_VERB_NACK
} e2e_verb;

/* The lane of grappa's send door. */
typedef enum { E2E_PRIO_CONTROL, E2E_PRIO_REACTIVE, E2E_PRIO_TEXT } e2e_priority;

typedef enum {
    E2E_DROP_UNDECODABLE_PAYLOAD,
    E2E_DROP_BAD_PAYLOAD,
    E2E_DROP_UNSOLICITED_KEYS,
    E2E_DROP_BAD_OTK_SIGNATURE,
    E2E_DROP_BAD_IDENTITY_SIGNATURE,
    E2E_DROP_OWN_IDENTITY,
    E2E_DROP_UNPINNED_KEY,
    E2E_DROP_IDENTITY_CURVE_MISMATCH,
    E2E_DROP_CURVE_ALREADY_BOUND,
    E2E_DROP_NON_CANONICAL_KEY,
    E2E_DROP_UNDECODABLE_INNER,
    E2E_DROP_INNER_WITHOUT_TYPE,
    E2E_DROP_UNKNOWN_NACK_REF,
    E2E_DROP_BAD_LIST,
    E2E_DROP_LISTREQ_RATE_LIMITED,
    E2E_DROP_REVOKED_DEVICE,
    E2E_DROP_UNLISTED_DEVICE,
    E2E_DROP_STALE_CERTIFICATE,
    E2E_DROP_BAD_CERT,
    E2E_DROP_NOT_FOR_US,
    E2E_DROP_INNER_KEY_MISMATCH,
    E2E_DROP_BAD_FROM,
    E2E_DROP_SIBLING_GONE,
    E2E_DROP_SIBLING_NO_KEYS,
    E2E_DROP_SIBLING_NOT_OURS,
    E2E_DROP_SIBLING_BAD_SIGNATURE,
    E2E_DROP_SIBLING_UNKNOWN,
    E2E_DROP_SIBLING_LIST_BEHIND,
    E2E_DROP_SIBLING_UNDECRYPTABLE,
    E2E_DROP_SIBLING_NOT_A_COPY
} e2e_drop_reason;

/* E2E_FAIL_INTERNAL is this port's own: vodozemac refused OUR stored
 * state (a session pickle that no longer loads or encrypts). cic throws
 * there; a C client reports the message failed instead of crashing. */
typedef enum {
    E2E_FAIL_OWN_NICK,
    E2E_FAIL_UNENCODABLE,
    E2E_FAIL_QUEUE_FULL,
    E2E_FAIL_KEYS_TIMEOUT,
    E2E_FAIL_TOO_LONG,
    E2E_FAIL_NO_BUDGET,
    E2E_FAIL_KEY_MISMATCH,
    E2E_FAIL_NACK_FROM_ANOTHER_NICK,
    E2E_FAIL_UNPINNED_KEY,
    E2E_FAIL_REPINNED,
    E2E_FAIL_RESEND_FAILED,
    E2E_FAIL_REKEY_THROTTLED,
    E2E_FAIL_UNREADABLE,
    E2E_FAIL_NO_SUCH_NICK,
    E2E_FAIL_INTERNAL
} e2e_send_failure;

typedef enum {
    E2E_UNDEC_REPLAYED_SESSION,
    E2E_UNDEC_SESSION_CREATION,
    E2E_UNDEC_NO_SESSION,
    E2E_UNDEC_DECRYPTION_FAILED,
    E2E_UNDEC_NOT_FOR_OUR_DEVICES
} e2e_undecryptable_reason;

/* The wire spelling of each (cic's string), for logs and the UI. */
const char *e2e_verb_name(e2e_verb v);
/* The verb grappa spells `name` ("keys", "pkmsg", "msg", "nack", "keyreq"); NONE if not one. */
e2e_verb e2e_verb_parse(const char *name);
const char *e2e_priority_name(e2e_priority p);
const char *e2e_drop_reason_name(e2e_drop_reason r);
const char *e2e_send_failure_name(e2e_send_failure f);
const char *e2e_undecryptable_reason_name(e2e_undecryptable_reason r);

/* ── Encodings (wire.ts) ──────────────────────────────────────────────── */

/* Standard base64, unpadded, as vodozemac prints it. */
char *e2e_base64(const uint8_t *data, size_t len);
/* Base64url (RFC 4648 §5), unpadded: the spelling of a did. */
char *e2e_base64url(const uint8_t *data, size_t len);
/* The bytes of standard base64, padded or not (malloc'd into *out, never
 * NULL on success, even for ""); false for anything else. */
bool e2e_unbase64(const char *text, uint8_t **out, size_t *out_len);
/* The device id of an Ed25519 key: base64url of the first 8 bytes of
 * SHA-256 over the RAW 32 key bytes. False when `ed25519` is not a key. */
bool e2e_did(const char *ed25519, char out[E2E_DID_LEN + 1]);
/* Whether `s` is spelled as a did: ^[A-Za-z0-9_-]{11}$. */
bool e2e_did_valid(const char *s);
/* The PKMSG `fb` binding: the first 16 bytes of SHA-256 over
 * BIND_PREFIX + fromE + ":" + toE, standard base64 unpadded. */
void e2e_fb(const char *from_e, const char *to_e, char out[E2E_FB_LEN + 1]);
/* The signed strings, as the code signs them. */
char *e2e_id_sig_text(const char *curve25519, const char *master);            /* S1 */
char *e2e_otk_sig_text(const char *key);                                      /* S2 */
char *e2e_list_sig_text(long ver, const char *const *devices, size_t n);      /* list */
char *e2e_cert_sig_text(long ver, const char *ed25519);                       /* cert */
/* Whether a parsed number is a version as the wire takes one: an integer
 * value in 1..2^31-1 (so 1.0 is 1). */
bool e2e_valid_ver(double ver);
/* The ASCII case fold of a nick (A-Z only, grappa's canonical_target). */
char *e2e_fold(const char *nick);
bool e2e_nick_eq(const char *a, const char *b);
/* Whether `key` is an Ed25519 / Curve25519 key in vodozemac's one
 * spelling (the canonical form equals the string itself). */
bool e2e_ed25519_canonical(const char *key);
bool e2e_curve25519_canonical(const char *key);
/* What one relayed line leaves for a payload: frame_budget_base less the
 * target's UTF-8 length; -1 when the base is unknown (< 0) or that is <= 0. */
long e2e_line_budget(long frame_budget_base, const char *target);
/* The lines `payload` takes as `verb` from `from` to `to` (a did or "*")
 * with `line_budget` bytes per line; E2E_TOO_MANY_LINES when no n up to
 * E2E_MAX_FRAGMENTS fits (grappa's 413). */
#define E2E_TOO_MANY_LINES 1000000L
long e2e_lines_needed(e2e_verb verb, const char *payload, long line_budget, const char *from,
                      const char *to);

/* ── Parsed payloads ──────────────────────────────────────────────────────
 * A parsed payload owns its JSON document: every `const char *` in it is
 * borrowed from that document, valid until the *_free. A parser answers
 * false — with a one-line reason in `err` — for anything that is not the
 * payload, as a unit: a wrong type or a missing field anywhere refuses
 * the whole (wire.ts's PayloadError). Unknown fields are ignored. */

typedef struct {
    const char *curve25519;
    const char *ed25519;
    const char *sig;
} e2e_id_block;

/* The master block of KEYS and `t:list`. Shape only: e2e_valid_master_list
 * judges it. `ndevices` is the count on the wire; only the first
 * E2E_MAX_DEVICES are kept, and a longer list is never valid. */
typedef struct {
    const char *ed25519;
    double ver;
    size_t ndevices;
    const char *devices[E2E_MAX_DEVICES];
    const char *sig;
} e2e_master_list;

typedef struct {
    e2e_id_block id;
    const char *otk_key;
    bool otk_fallback; /* `=== true` */
    const char *otk_sig;
} e2e_keys_entry;

typedef struct {
    const char *did;
    const char *body;
} e2e_body;

typedef struct {
    json_doc *doc;
    e2e_verb verb;
    /* KEYS */
    e2e_master_list master;
    size_t nentries;
    e2e_keys_entry entries[E2E_MAX_DEVICES];
    /* PKMSG: `id`, the certificate block; and the bodies (PKMSG, MSG) */
    e2e_id_block id;
    const char *cert_master;
    const char *cert;
    long cert_ver;
    const char *ck; /* MSG */
    size_t nbodies;
    e2e_body bodies[E2E_MAX_DEVICES];
    const char *ref; /* NACK */
} e2e_payload;

/* Decodes `text` (a JSON object, compact or not) as a payload of `verb`
 * (KEYS, PKMSG, MSG or NACK). `*undecodable` says the text is no JSON
 * object at all (cic's `undecodable-payload`) rather than the wrong shape
 * (`bad-payload`). Duplicate member names refuse the document: JSON.parse
 * would keep the last and this reader the first, so a document that reads
 * two ways reads no way. */
bool e2e_payload_parse(e2e_verb verb, const char *text, e2e_payload *out, bool *undecodable,
                       char *err, size_t err_sz);
void e2e_payload_free(e2e_payload *p);
/* The master block of a KEYS or a `t:list`, shape only (parseMasterList). */
bool e2e_master_list_parse(const json_value *master, e2e_master_list *out);
/* The list rules and the master's own signature (validMasterList): 1..4
 * canonical keys sorted strictly ascending by bytes, no two dids alike,
 * `ver` valid, and `sig` the master's over the list text. */
bool e2e_valid_master_list(const e2e_master_list *m);
/* The body for `did` in a parsed PKMSG/MSG, or NULL. */
const char *e2e_payload_body(const e2e_payload *p, const char *did);

/* ── Payload builders (compact JSON, malloc'd) ─────────────────────────── */

char *e2e_keyreq_payload(void);                    /* {"v":2} */
char *e2e_nack_payload(const char *ref);           /* {"v":2,"ref":…} */
/* The consent verbs' payload cic sends ({"v":2,"master":M}); grappa's own
 * refusal is {"v":2}, which e2e_consent_payload_parse reads as no master. */
char *e2e_consent_payload(const char *master);
/* `*master` NULL when the payload names none; false when it is no v2
 * object, or names a master that is no canonical key. */
bool e2e_consent_payload_parse(const char *text, char **master);
/* A PKMSG / MSG payload from bodies (did → body). The id block is signed
 * here: `device` is this device's account. */
char *e2e_pkmsg_payload(vz_account *device, const char *master, const char *cert, long cert_ver,
                        const e2e_body *bodies, size_t n);
char *e2e_msg_payload(const char *ck, const e2e_body *bodies, size_t n);
/* A KEYS payload as grappa composes one (lib/grappa/e2e_keys.ex): shottino
 * never sends KEYS, so this is the fake grappa of the tests, and the shape
 * a claim answer is checked against. */
typedef struct {
    const char *curve25519, *ed25519, *sig; /* the device's id block (S1) */
    const char *otk_key, *otk_sig;          /* S2 */
    bool otk_fallback;
} e2e_keys_build_entry;
char *e2e_keys_payload(const char *master, long ver, const char *const *devices, size_t ndevices,
                       const char *list_sig, const e2e_keys_build_entry *entries, size_t nentries);

/* ── Inner plaintexts (the Olm plaintext, a JSON object with string `t`) ─ */

typedef enum {
    E2E_INNER_UNKNOWN = 0, /* a typed object of a `t` cic does not show */
    E2E_INNER_TEXT,
    E2E_INNER_CHAL,
    E2E_INNER_ACK,
    E2E_INNER_LIST,
    E2E_INNER_LISTREQ,
    E2E_INNER_COPY,
    E2E_INNER_SAS_START,
    E2E_INNER_SAS_ACCEPT,
    E2E_INNER_SAS_KEY,
    E2E_INNER_SAS_MAC,
    E2E_INNER_SAS_CANCEL
} e2e_inner_type;

/* Every pointer borrowed from `doc`. Only the fields of `type` are set. */
typedef struct {
    json_doc *doc;
    e2e_inner_type type;
    const char *t;
    /* text, copy */
    const char *body;
    size_t body_len;
    const char *peer;
    /* chal / ack */
    const char *network, *channel, *sender_mask, *line_sha256, *nonce;
    int64_t expires_at;
    /* list */
    e2e_master_list list;
    /* sas.* */
    const char *tx, *commitment, *key, *mac, *mmac;
    char reason[65]; /* sas.cancel, cut to 64 bytes on a UTF-8 boundary */
} e2e_inner;

/* Parses an inner message. False when it is not a JSON object with a
 * string `t`, or when a known `t` misses or mistypes one of its fields
 * (orders.ts parseChallenge, sas.ts parse, engine.ts readCopy): such an
 * inner is ignored, as cic ignores it. An unknown `t` is E2E_INNER_UNKNOWN. */
bool e2e_inner_parse(const char *json, size_t len, e2e_inner *out);
void e2e_inner_free(e2e_inner *in);
/* Inner builders, compact JSON, malloc'd. The engine adds `lv` (and `fb`
 * on a pre-key body); a caller never writes either. */
char *e2e_inner_text(const char *body, size_t len);
char *e2e_inner_ack(const char *nonce);
char *e2e_inner_chal(const char *network, const char *channel, const char *sender_mask,
                     const char *line_sha256, const char *nonce, int64_t expires_at);
char *e2e_inner_listreq(void);
char *e2e_inner_copy(const char *peer, const char *body, size_t len);
char *e2e_inner_sas_start(const char *tx);
char *e2e_inner_sas_accept(const char *tx, const char *commitment);
char *e2e_inner_sas_key(const char *tx, const char *key);
char *e2e_inner_sas_mac(const char *tx, const char *mac, const char *mmac);
char *e2e_inner_sas_cancel(const char *tx, const char *reason);

/* ── Our identity (accountStore.ts OwnIdentity, identity.ts, keyBundle.ts) ─ */

typedef struct {
    char **v;
    size_t n;
} e2e_strv;

/* This device's place in the identity: the master peers pin, the
 * master's certificate for this device at the list version that first
 * held it, the list the master last put on grappa, and this device's did. */
typedef struct {
    char *master;
    char *cert;
    long cert_ver;
    long list_ver;
    e2e_strv list_devices;
    char *list_sig;
    char *did;
} e2e_own;

void e2e_own_free(e2e_own *own);
/* A first device's place (identity.ts bootstrap): `master_acct` signs
 * list ver 1 naming `device` alone, and its certificate at 1. */
void e2e_own_bootstrap(vz_account *device, vz_account *master_acct, e2e_own *out);
/* A list signed by `master_acct` at `ver` over `devices`, sorted here by
 * bytes; the master's signature, malloc'd. NULL when vodozemac refuses. */
char *e2e_sign_list(vz_account *master_acct, long ver, const char *const *sorted_devices,
                    size_t n);
char *e2e_sign_cert(vz_account *master_acct, long ver, const char *ed25519);
/* The body of `POST …/e2e/devices` (the id block, S1 over `master`). */
char *e2e_register_body(vz_account *device, const char *master);
/* The body of `PUT …/e2e/list` for `own`'s list. */
char *e2e_list_put_body(const e2e_own *own);
/* keyBundle.ts topUp: what to upload (`POST …/devices/:did/keys` body) so
 * grappa, holding `held_otks` one-time keys and `held_fallback`, ends with
 * every key it has room for and a fallback; NULL when nothing is to go.
 * Generates the keys on `device`: PERSIST THE ACCOUNT BEFORE UPLOADING,
 * then vz_account_mark_keys_as_published. */
char *e2e_top_up(vz_account *device, long held_otks, bool held_fallback);

/* ── State (engine.ts E2eState) ────────────────────────────────────────── */

/* A peer's device as a master's list names it. `cert_ver` 0 = no
 * certificate seen (bound from a KEYS). */
typedef struct {
    char *ed25519, *curve25519, *master, *did;
    bool proven;
    long cert_ver;
} e2e_device;

/* A peer's master: the trust placed in it, the highest list accepted. */
typedef struct {
    char *ed25519;
    char *nick; /* first pinned to: a hint for a human only */
    bool verified;
    long ver; /* 0 before a list is accepted */
    e2e_strv devices, revoked, revoked_curves;
} e2e_master;

typedef struct {
    char *curve;
    e2e_strv pickles; /* newest first, <= E2E_MAX_SESSIONS_PER_PEER */
} e2e_session_set;

/* A message on its way: the inner JSON Olm encrypts (`lv` in it), the
 * caller's tag, its lane. `id` names the message across every copy and
 * re-send. `expires_at` 0 = none (unix seconds otherwise). */
typedef struct {
    long id;
    char *plaintext;
    e2e_priority priority;
    int sends;
    char *tag;
    int64_t expires_at;
} e2e_outgoing;

/* Waiting for keys. `master` "" = whatever master answers; `only` NULL =
 * every device; `except` NULL = none; `done` the devices it went to. */
typedef struct {
    char *nick, *master, *only, *except;
    e2e_strv done;
    e2e_outgoing msg;
    int64_t at;
} e2e_queued;

typedef struct {
    char *did, *ed25519, *session_id;
} e2e_sent_device;

/* Handed to grappa; `msgid` once grappa named it (NULL before). */
typedef struct {
    long ref;
    char *msgid;
    char *nick, *master;
    e2e_sent_device *devices;
    size_t ndevices;
    e2e_outgoing msg;
    int64_t at;
} e2e_sent;

/* Everything the engine keys by folded nick, in one record per nick (cic
 * keeps one ByNick map per field: one record is the C shape of the same
 * data). `has_*` flags say a field is set. */
typedef struct {
    char *key; /* the folded nick */
    char *pin; /* master pinned to it, NULL none */
    e2e_queued *outq;
    size_t noutq;
    bool has_keyreq_at;
    int64_t keyreq_sent_at;
    bool keys_awaited;
    bool has_rekey_at;
    int64_t rekey_at;
    bool has_listreq;
    int64_t listreq_at;
    long *listreq_lv;
    size_t nlistreq_lv;
    char *listreq_held;    /* the nick, NULL none */
    char *keys_asked_nick; /* NULL none */
    int64_t keys_asked_at;
} e2e_peer;

typedef struct {
    char *key; /* "<folded nick> <did>" */
    int64_t at;
} e2e_answered;

typedef struct {
    char *ed25519, *did, *curve25519;
} e2e_sibling;

typedef struct {
    char *peer, *body;
    size_t body_len;
    int64_t at;
} e2e_waiting_copy;

typedef struct {
    char *ed25519;
    e2e_waiting_copy *copies;
    size_t ncopies;
} e2e_copy_queue;

typedef struct {
    e2e_master *masters;
    size_t nmasters;
    e2e_device *devices;
    size_t ndevices;
    e2e_peer *peers;
    size_t npeers;
    e2e_session_set *sessions;
    size_t nsessions;
    e2e_strv seen; /* the replay set: session ids opened from a PKMSG, oldest first */
    e2e_strv rekeying;
    e2e_answered *answered;
    size_t nanswered;
    e2e_sent *sent;
    size_t nsent;
    long next_ref;
    long inbox; /* the drain watermark: the last inbox id processed */
    e2e_sibling *siblings;
    size_t nsiblings;
    e2e_copy_queue *copyq;
    size_t ncopyq;
} e2e_state;

void e2e_state_init(e2e_state *s);
void e2e_state_free(e2e_state *s);

/* One record per (subject, network) slot: this device's account, the
 * master (only on the device that made the identity), this device's place
 * (NULL before it has one), and the state. ONE record because they change
 * together: an OTK spent and the session it opened. */
typedef struct {
    vz_account *account;
    vz_account *master;
    e2e_own *own;
    e2e_state state;
} e2e_record;

/* A new record: a fresh device account, no master, no place, empty state. */
void e2e_record_new(e2e_record *r);
void e2e_record_free(e2e_record *r);
/* The record as JSON text (pickles are plain vodozemac JSON: §1.3). */
char *e2e_record_to_json(const e2e_record *r);
/* False (and *out untouched) for anything but a record this writer wrote. */
bool e2e_record_from_json(const char *json, size_t len, e2e_record *out);

/* ── Identity sync (identity.ts runSync) ─────────────────────────────────
 * What to do about this device's place, given the record and the list
 * grappa holds (`held`, NULL on its 404). The decision only: the doors
 * around it are the application's. An identity is NEVER replaced
 * silently (vjt 6344779758): every ELSEWHERE blocks E2E on the network
 * until the user pairs, or explicitly starts over. */
typedef enum {
    E2E_SYNC_NONE,               /* no place here, no list on grappa */
    E2E_SYNC_ELSEWHERE_NO_KEYS,  /* no place here; grappa holds an identity */
    E2E_SYNC_ELSEWHERE_NO_LIST,  /* grappa lost the list, and the master is not here */
    E2E_SYNC_ELSEWHERE_REPLACED, /* grappa holds another master's list */
    E2E_SYNC_ELSEWHERE_LEFT_OUT, /* our master's list no longer names this device */
    E2E_SYNC_RELIST,             /* grappa lost the list; the master is here: list again */
    E2E_SYNC_ADOPT,              /* our master's list above ours, naming us, verified */
    E2E_SYNC_READY
} e2e_sync_plan;

/* cic's spelling of each: "none", "no-keys", "no-list", "replaced",
 * "left-out", "relist", "adopt", "ready". */
const char *e2e_sync_plan_name(e2e_sync_plan p);
bool e2e_sync_plan_elsewhere(e2e_sync_plan p);
e2e_sync_plan e2e_sync_decide(const e2e_record *r, const e2e_master_list *held);
/* This device's place after a relist: `r->own` with the list the master
 * signs at own.list_ver + 1 naming this device alone; the certificate
 * stays (it names the first list that held the device). False when the
 * record holds no master or no place. `out` is the caller's to free. */
bool e2e_own_relisted(const e2e_record *r, e2e_own *out);
/* This device's place with `held` (ADOPT) as its list; `out` is the
 * caller's to free. */
void e2e_own_adopted(const e2e_own *own, const e2e_master_list *held, e2e_own *out);
/* Whether `own`'s list (as stored) carries the master's signature and
 * names this device, and its certificate verifies over this device's key
 * at cert_ver: the self-check of a record read back from disk. */
bool e2e_own_verify(const e2e_own *own, vz_account *device);

/* ── Store: one record in a directory, atomic, locked ──────────────────────
 * `dir` is the caller's (the app computes <state>/e2e-<hash>/<network_id>);
 * it and any missing parent are made 0700. The record is `record.json`,
 * 0600, written to a temp file in the same directory (pid in its name),
 * fsync'd, renamed over, and the directory fsync'd. `lock` in the same
 * directory carries an exclusive flock held from open to close: two
 * shottino processes on one directory are ONE device and must not
 * interleave, so the second is refused rather than made to wait. */
typedef struct e2e_store e2e_store;

typedef enum { E2E_STORE_OK, E2E_STORE_BUSY, E2E_STORE_ERROR } e2e_store_status;
typedef enum { E2E_LOAD_OK, E2E_LOAD_NONE, E2E_LOAD_CORRUPT, E2E_LOAD_ERROR } e2e_load_status;

e2e_store_status e2e_store_open(const char *dir, e2e_store **out, char *err, size_t err_sz);
void e2e_store_close(e2e_store *st);
/* CORRUPT is a file that is not a record: the caller decides (cic starts
 * over, which makes the next sync read grappa's identity as elsewhere). */
e2e_load_status e2e_store_load(e2e_store *st, e2e_record *out, char *err, size_t err_sz);
bool e2e_store_save(e2e_store *st, const e2e_record *r, char *err, size_t err_sz);

/* ── Engine (engine.ts Engine) ─────────────────────────────────────────── */

typedef enum {
    E2E_EV_RECEIVED,
    E2E_EV_KEY_ALARM,
    E2E_EV_UNDECRYPTABLE,
    E2E_EV_REPLAYED,
    E2E_EV_DROPPED,
    E2E_EV_SEND_QUEUED,
    E2E_EV_SEND_FAILED,
    E2E_EV_REKEYING,
    E2E_EV_KEYS_ASKED,
    E2E_EV_KEYS_RENEWED,
    E2E_EV_KEYS_UNANSWERED,
    E2E_EV_SIBLING_KEYS_NEEDED,
    E2E_EV_COPIED
} e2e_event_kind;

/* What happened; only the fields of `kind` are set (others NULL/0).
 *   RECEIVED        nick, master, device (its E), verified, inner (JSON, no lv/fb: PLAINTEXT, never log)
 *   KEY_ALARM       nick, pinned, presented
 *   UNDECRYPTABLE   nick, msgid, undecryptable
 *   REPLAYED        nick, session_id
 *   DROPPED         nick, drop, verb (NONE: an inner), detail (may be NULL)
 *   SEND_QUEUED     nick, queued, tag
 *   SEND_FAILED     nick, failure, tags
 *   REKEYING        nick, master, device
 *   KEYS_*          nick
 *   SIBLING_KEYS_NEEDED did
 *   COPIED          peer, body/body_len (PLAINTEXT), device */
typedef struct {
    e2e_event_kind kind;
    char *nick;
    char *master, *device, *inner;
    bool verified;
    char *pinned, *presented;
    char *msgid;
    e2e_undecryptable_reason undecryptable;
    char *session_id;
    e2e_drop_reason drop;
    e2e_verb verb;
    char *detail;
    long queued;
    char *tag;
    e2e_send_failure failure;
    e2e_strv tags;
    char *did;
    char *peer, *body;
    size_t body_len;
} e2e_event;

/* A payload for grappa's send door, `from` this device's did `to` a did
 * or "*". `ref` (0 none) and `tag` are set on a PKMSG/MSG that carries a
 * message: report grappa's msgid with e2e_sent, or e2e_discard it when
 * grappa refused. `expires_at` (0 none) is an ACK's door deadline. */
typedef struct {
    char *target;
    e2e_verb verb;
    char *from, *to, *payload;
    e2e_priority priority;
    long ref;
    char *tag;
    int64_t expires_at;
} e2e_outbound;

/* A copy for grappa's copy door: a PKMSG/MSG with one body, for sibling `to`. */
typedef struct {
    char *to;
    e2e_verb verb;
    char *payload;
} e2e_sibling_copy;

typedef struct {
    e2e_event *events;
    size_t nevents;
    e2e_outbound *outbound;
    size_t noutbound;
    e2e_sibling_copy *copies;
    size_t ncopies;
} e2e_result;

void e2e_result_init(e2e_result *r);
void e2e_result_free(e2e_result *r);
/* The send door's request body for `o` (CLIENT_PROTOCOL §4f). */
char *e2e_outbound_body(const e2e_outbound *o);
/* The copy door's request body for `c` from our did. */
char *e2e_copy_body(const e2e_sibling_copy *c, const char *from_did);

/* One locked operation. `record->own` must be set. `frame_budget_base`
 * is the network's as grappa published it, < 0 while unknown. The engine
 * changes `record->state` in place: persist the record BEFORE any
 * outbound payload leaves (a ratchet step is never sent twice). */
typedef struct {
    e2e_record *record;
    const char *own_nick;
    long frame_budget_base;
    int64_t now_ms;
} e2e_ctx;

/* Receiving. `from_did` is the frame's from: a did, or "*" (grappa
 * speaks for the user: a KEYS, or a NACK nobody could read). */
void e2e_receive(const e2e_ctx *c, const char *nick, e2e_verb verb, const char *msgid,
                 const char *from_did, const char *payload, e2e_result *res);
/* A copy a sibling of ours sent (an inbox item flagged `own`). */
void e2e_receive_copy(const e2e_ctx *c, const char *from_did, e2e_verb verb, const char *payload,
                      e2e_result *res);

/* Sending. `inner_json` is an inner message (an object with `t`); any
 * `lv`/`fb` in it is replaced. `only` NULL = every device of the master
 * pinned to `nick`. `tag` names the message in every later event; the
 * list tag is refused (false, nothing done). `expires_at` 0 = none. */
bool e2e_send(const e2e_ctx *c, const char *nick, const char *inner_json, const char *tag,
              int64_t expires_at, const char *only, e2e_result *res);
/* To every device of the master pinned to `nick` but `except`. */
bool e2e_send_except(const e2e_ctx *c, const char *nick, const char *inner_json, const char *tag,
                     const char *except, e2e_result *res);
/* grappa accepted `ref` as `msgid`. */
void e2e_sent_ok(const e2e_ctx *c, long ref, const char *msgid);
/* grappa refused `ref`, or dropped `msgid` after accepting it: true (with
 * the nick and tag, malloc'd) once nothing of that message is on its way
 * or waiting, so the caller marks it failed. */
bool e2e_discard(const e2e_ctx *c, long ref, char **nick, char **tag);
bool e2e_dropped(const e2e_ctx *c, const char *msgid, char **nick, char **tag);
/* Who `msgid` was for and its tag, even while other payloads of it are pending. */
bool e2e_sent_as(const e2e_ctx *c, const char *msgid, char **nick, char **tag);
/* The user deleted the chat: queued plaintexts and sent records go; trust stays. */
void e2e_forget(const e2e_ctx *c, const char *nick);
/* The user asks `nick` for its keys again (after `unreadable`). */
void e2e_rekey(const e2e_ctx *c, const char *nick, e2e_result *res);
/* A KEYREQ after a consent accept. */
void e2e_ask_keys(const e2e_ctx *c, const char *nick, e2e_result *res);
/* grappa's no_such_nick: what waits for `nick`'s keys fails now. */
void e2e_absent(const e2e_ctx *c, const char *nick, e2e_result *res);
/* Every 5 s, and whenever e2e_waits_on_the_clock says so. */
void e2e_tick(const e2e_ctx *c, e2e_result *res);
bool e2e_waits_on_the_clock(const e2e_ctx *c);

/* Trust. */
typedef enum { E2E_PIN_PINNED, E2E_PIN_BAD_KEY, E2E_PIN_OWN_KEY } e2e_pin_outcome;
/* The user pins `master` to `nick` (verified: compared out of band). */
e2e_pin_outcome e2e_pin(const e2e_ctx *c, const char *nick, const char *master, bool verified,
                        e2e_result *res);
/* A SAS confirmed `master`. */
void e2e_verify(const e2e_ctx *c, const char *nick, const char *master, e2e_result *res);
/* The master pinned to `nick` (borrowed from the state), whether verified,
 * and how many of its devices are trusted; false when no pin. */
bool e2e_pinned(const e2e_ctx *c, const char *nick, const char **master, bool *verified,
                size_t *trusted);

/* Siblings (our own other devices: copies of each text we send). */
/* From `GET …/e2e/devices`: each {ed25519, curve25519, sig}. */
void e2e_set_siblings(const e2e_ctx *c, const e2e_id_block *blocks, size_t n, e2e_result *res);
/* A copy of the text `body` this device sent `peer`, for every sibling.
 * Call only once grappa took the text. */
void e2e_copy(const e2e_ctx *c, const char *peer, const char *body, size_t body_len,
              e2e_result *res);
/* What the claim door brought for sibling `did`: its KEYS text, or NULL. */
void e2e_sibling_keys(const e2e_ctx *c, const char *did, const char *keys, e2e_result *res);

/* ── Pairing (pairingMessages.ts, identity.ts prepareJoin/completeJoin) ──
 * What two devices of one account say over the ECIES channel grappa's
 * relay carries blind (CLIENT_PROTOCOL §4g). The roles: the HOLDER holds
 * the master (rendezvous creator, ECIES inbound side) and signs; the
 * JOINER is the new device (ECIES outbound side, speaks first). Only
 * public keys and signatures cross; the master never leaves the holder.
 * Pure like the rest of this file: the relay doors are the app's. */

#define E2E_PAIRING_INFO "irc-e2e:v2:pair"
/* grappa's lifetime of a rendezvous, for a client that lost its expires_at. */
#define E2E_PAIRING_LIFETIME_S 300

/* Why a network was left out of a pairing (cic's PairRefusal). */
typedef enum { E2E_PAIR_FULL, E2E_PAIR_PAIRED, E2E_PAIR_LIST_CHANGED, E2E_PAIR_FAILED } e2e_pair_refusal;
const char *e2e_pair_refusal_name(e2e_pair_refusal r); /* "full", "paired", "list-changed", "failed" */

typedef enum {
    E2E_PAIR_HELLO = 1,
    E2E_PAIR_OFFER,
    E2E_PAIR_JOIN,
    E2E_PAIR_SIGNED,
    E2E_PAIR_DONE
} e2e_pair_kind;

typedef struct {
    const char *network, *master;
} e2e_pair_offered;

typedef struct {
    const char *network;
    e2e_id_block id;
} e2e_pair_device;

/* `list.ed25519` is not on the wire (the offer named the master);
 * `list.ndevices` is the count on the wire, the first E2E_MAX_DEVICES kept. */
typedef struct {
    const char *network, *cert;
    e2e_master_list list;
} e2e_pair_signed_entry;

typedef struct {
    const char *network;
    e2e_pair_refusal reason;
} e2e_pair_refused;

/* One decoded message; every pointer borrowed from `doc`. Only the
 * fields of `kind` are set: offer (networks, full), join (devices,
 * refused = `skipped`), signed (signed_, refused), done (paired). */
typedef struct {
    json_doc *doc;
    e2e_pair_kind kind;
    e2e_pair_offered *networks;
    size_t nnetworks;
    const char **full;
    size_t nfull;
    e2e_pair_device *devices;
    size_t ndevices;
    e2e_pair_refused *refused;
    size_t nrefused;
    e2e_pair_signed_entry *signed_;
    size_t nsigned;
    const char **paired;
    size_t npaired;
} e2e_pair_msg;

/* decodePairMessage: strict UTF-8, a JSON object with `v` 1 and one of
 * the five `t`, every field present and well typed, every key canonical,
 * every `network` a non-empty string, every `reason` one of the four.
 * Unknown extra fields are ignored; anything else is false (the pairing
 * fails). Duplicate member names refuse the document. */
bool e2e_pair_decode(const uint8_t *bytes, size_t len, e2e_pair_msg *out);
void e2e_pair_msg_free(e2e_pair_msg *m);
/* The five messages as compact JSON, in cic's member order. */
char *e2e_pair_hello(void);
char *e2e_pair_offer(const e2e_pair_offered *networks, size_t n, const char *const *full,
                     size_t nfull);
char *e2e_pair_join(const e2e_pair_device *devices, size_t n, const e2e_pair_refused *skipped,
                    size_t nskipped);
char *e2e_pair_signed(const e2e_pair_signed_entry *devices, size_t n,
                      const e2e_pair_refused *refused, size_t nrefused);
char *e2e_pair_done(const char *const *paired, size_t n);
/* The joiner's first payload: vodozemac's InitialMessage.encode() holds a
 * `|` the relay refuses, so it travels as base64url of its UTF-8,
 * unpadded. Every later payload is the ECIES message as is. */
char *e2e_pair_wrap_initial(const char *message);
/* The inverse; NULL for anything but ^[A-Za-z0-9_-]+$ that decodes to
 * UTF-8 (without NUL). */
char *e2e_pair_unwrap_initial(const char *payload);
/* The joiner's id block for `master` (S1), malloc'd; false when vodozemac refuses. */
bool e2e_pair_id_block(vz_account *device, const char *master, char **curve25519, char **ed25519,
                       char **sig);

/* issueDevice — the HOLDER: the list at own.list_ver + 1 with the joiner's
 * device added (sorted by bytes) and its certificate at that version.
 * `joiner` comes off the channel, so it is judged first: canonical keys
 * and its S1 vouching for own->master. False with `why`: FAILED (either
 * check), PAIRED (already listed), FULL (E2E_DEVICE_CAP reached). */
typedef struct {
    long ver;
    e2e_strv devices;
    char *sig, *cert;
} e2e_pair_issued;
bool e2e_pair_issue(vz_account *master_acct, const e2e_own *own, const e2e_id_block *joiner,
                    e2e_pair_issued *out, e2e_pair_refusal *why);
void e2e_pair_issued_free(e2e_pair_issued *i);
/* acceptSigned — the JOINER: this device's place from what the holder
 * signed, or false: the list must be a valid one signed by `master` and
 * name `device`, and the certificate the master's over the device at that
 * list's version. `out` (cert_ver = list ver) is the caller's to free. */
bool e2e_pair_accept_signed(const char *master, vz_account *device,
                            const e2e_pair_signed_entry *entry, e2e_own *out);
/* identity.ts startOver: a new device account and no place, no master;
 * of the state only the trust placed in others stays (their masters,
 * devices and the pins). */
void e2e_record_start_over(e2e_record *r);

/* An ISO-8601 UTC instant as grappa writes one ("2026-11-07T10:05:00Z",
 * fractional seconds and a +hh:mm offset allowed) in unix seconds. */
bool e2e_iso8601_seconds(const char *s, int64_t *out);

#endif /* SHOTTINO_E2E_H */
