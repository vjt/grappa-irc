/* e2e.c — see e2e.h for the why. A port of cicchetto/src/lib/e2e/wire.ts
 * and engine.ts; function names follow cic's (snake_cased) so the two can
 * be read side by side. */
#include "e2e.h"

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <math.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>

/* ── Memory ──────────────────────────────────────────────────────────── */

static void *xmalloc(size_t n) {
    void *p = malloc(n ? n : 1);
    if (!p) abort();
    return p;
}

static void *xrealloc(void *p, size_t n) {
    void *q = realloc(p, n ? n : 1);
    if (!q) abort();
    return q;
}

static char *xstrdup(const char *s) {
    size_t n = strlen(s);
    char *p = xmalloc(n + 1);
    memcpy(p, s, n + 1);
    return p;
}

static char *xstrndup(const char *s, size_t n) {
    char *p = xmalloc(n + 1);
    memcpy(p, s, n);
    p[n] = 0;
    return p;
}

static char *opt_dup(const char *s) { return s ? xstrdup(s) : NULL; }

/* A vodozemac string as one of ours: copied, the original vz_str_free'd. */
static char *vzs(char *s) {
    if (!s) return NULL;
    char *out = xstrdup(s);
    vz_str_free(s);
    return out;
}

static char *xprintf(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
static char *xprintf(const char *fmt, ...) {
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

static char *take(json_buf *b) {
    char *s = jb_take(b);
    if (!s) abort();
    return s;
}

static bool streq(const char *a, const char *b) { return a && b && strcmp(a, b) == 0; }

/* ── String vectors ──────────────────────────────────────────────────── */

static void strv_push(e2e_strv *v, const char *s) {
    v->v = xrealloc(v->v, (v->n + 1) * sizeof(*v->v));
    v->v[v->n++] = xstrdup(s);
}

static bool strv_has(const e2e_strv *v, const char *s) {
    for (size_t i = 0; i < v->n; i++)
        if (strcmp(v->v[i], s) == 0) return true;
    return false;
}

static void strv_free(e2e_strv *v) {
    for (size_t i = 0; i < v->n; i++) free(v->v[i]);
    free(v->v);
    v->v = NULL;
    v->n = 0;
}

static void strv_remove_at(e2e_strv *v, size_t i) {
    free(v->v[i]);
    memmove(v->v + i, v->v + i + 1, (v->n - i - 1) * sizeof(*v->v));
    v->n--;
}

static void strv_remove(e2e_strv *v, const char *s) {
    for (size_t i = 0; i < v->n;) {
        if (strcmp(v->v[i], s) == 0) strv_remove_at(v, i);
        else i++;
    }
}

static e2e_strv strv_dup(const e2e_strv *v) {
    e2e_strv out = {0};
    for (size_t i = 0; i < v->n; i++) strv_push(&out, v->v[i]);
    return out;
}

/* ── Names ───────────────────────────────────────────────────────────── */

const char *e2e_verb_name(e2e_verb v) {
    switch (v) {
    case E2E_VERB_KEYREQ: return "keyreq";
    case E2E_VERB_KEYS: return "keys";
    case E2E_VERB_PKMSG: return "pkmsg";
    case E2E_VERB_MSG: return "msg";
    case E2E_VERB_NACK: return "nack";
    case E2E_VERB_NONE: break;
    }
    return "";
}

e2e_verb e2e_verb_parse(const char *name) {
    if (!name) return E2E_VERB_NONE;
    static const e2e_verb all[] = {E2E_VERB_KEYREQ, E2E_VERB_KEYS, E2E_VERB_PKMSG, E2E_VERB_MSG,
                                   E2E_VERB_NACK};
    for (size_t i = 0; i < sizeof(all) / sizeof(all[0]); i++)
        if (strcmp(name, e2e_verb_name(all[i])) == 0) return all[i];
    return E2E_VERB_NONE;
}

const char *e2e_priority_name(e2e_priority p) {
    switch (p) {
    case E2E_PRIO_CONTROL: return "control";
    case E2E_PRIO_REACTIVE: return "reactive";
    case E2E_PRIO_TEXT: return "text";
    }
    return "text";
}

static const char *const drop_names[] = {
    "undecodable-payload", "bad-payload", "unsolicited-keys", "bad-otk-signature",
    "bad-identity-signature", "own-identity", "unpinned-key", "identity-curve-mismatch",
    "curve-already-bound", "non-canonical-key", "undecodable-inner", "inner-without-type",
    "unknown-nack-ref", "bad-list", "listreq-rate-limited", "revoked-device", "unlisted-device",
    "stale-certificate", "bad-cert", "not-for-us", "inner-key-mismatch", "bad-from",
    "sibling-gone", "sibling-no-keys", "sibling-not-ours", "sibling-bad-signature",
    "sibling-unknown", "sibling-list-behind", "sibling-undecryptable", "sibling-not-a-copy"};

const char *e2e_drop_reason_name(e2e_drop_reason r) {
    size_t i = (size_t)r;
    return i < sizeof(drop_names) / sizeof(drop_names[0]) ? drop_names[i] : "";
}

static const char *const failure_names[] = {
    "own-nick", "unencodable", "queue-full", "keys-timeout", "too-long",
    "no-budget", "key-mismatch", "nack-from-another-nick", "unpinned-key", "repinned",
    "resend-failed", "rekey-throttled", "unreadable", "no-such-nick", "internal"};

const char *e2e_send_failure_name(e2e_send_failure f) {
    size_t i = (size_t)f;
    return i < sizeof(failure_names) / sizeof(failure_names[0]) ? failure_names[i] : "";
}

static const char *const undec_names[] = {"replayed-session", "session-creation", "no-session",
                                          "decryption-failed", "not-for-our-devices"};

const char *e2e_undecryptable_reason_name(e2e_undecryptable_reason r) {
    size_t i = (size_t)r;
    return i < sizeof(undec_names) / sizeof(undec_names[0]) ? undec_names[i] : "";
}

/* ── Encodings ───────────────────────────────────────────────────────── */

char *e2e_base64(const uint8_t *data, size_t len) {
    static const uint8_t none = 0;
    char *s = vzs(vz_base64_encode(len ? data : &none, len));
    if (!s) abort();
    return s;
}

char *e2e_base64url(const uint8_t *data, size_t len) {
    char *s = e2e_base64(data, len);
    for (char *p = s; *p; p++) {
        if (*p == '+') *p = '-';
        else if (*p == '/') *p = '_';
    }
    return s;
}

static bool b64_char(char c) {
    return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
           c == '+' || c == '/';
}

/* wire.ts unbase64: ^[A-Za-z0-9+/]*={0,2}$, then a decode that must
 * succeed (a length of 1 mod 4 does not). */
bool e2e_unbase64(const char *text, uint8_t **out, size_t *out_len) {
    *out = NULL;
    *out_len = 0;
    if (!text) return false;
    size_t n = strlen(text), bare = 0;
    while (bare < n && b64_char(text[bare])) bare++;
    size_t pad = n - bare;
    if (pad > 2) return false;
    for (size_t i = bare; i < n; i++)
        if (text[i] != '=') return false;
    if (bare % 4 == 1) return false;
    if (bare == 0) {
        *out = xmalloc(1);
        return true;
    }
    char *trimmed = xstrndup(text, bare);
    vz_buf b;
    int rc = vz_base64_decode(trimmed, &b);
    free(trimmed);
    if (rc != 0) return false;
    *out = xmalloc(b.len);
    if (b.len) memcpy(*out, b.ptr, b.len);
    *out_len = b.len;
    vz_buf_free(b);
    return true;
}

bool e2e_did(const char *ed25519, char out[E2E_DID_LEN + 1]) {
    out[0] = 0;
    char *canon = vzs(vz_canonical_ed25519(ed25519));
    if (!canon) return false;
    uint8_t *raw;
    size_t len;
    bool ok = e2e_unbase64(canon, &raw, &len);
    free(canon);
    if (!ok) return false;
    uint8_t digest[32];
    if (vz_sha256(raw, len, digest) != 0) {
        free(raw);
        return false;
    }
    free(raw);
    char *url = e2e_base64url(digest, 8);
    snprintf(out, E2E_DID_LEN + 1, "%s", url);
    free(url);
    return true;
}

bool e2e_did_valid(const char *s) {
    if (!s || strlen(s) != E2E_DID_LEN) return false;
    for (size_t i = 0; i < E2E_DID_LEN; i++) {
        char c = s[i];
        if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
              c == '_' || c == '-'))
            return false;
    }
    return true;
}

void e2e_fb(const char *from_e, const char *to_e, char out[E2E_FB_LEN + 1]) {
    char *text = xprintf("%s%s:%s", E2E_BIND_PREFIX, from_e, to_e);
    uint8_t digest[32];
    if (vz_sha256((const uint8_t *)text, strlen(text), digest) != 0) abort();
    free(text);
    char *b = e2e_base64(digest, 16);
    snprintf(out, E2E_FB_LEN + 1, "%s", b);
    free(b);
}

char *e2e_id_sig_text(const char *curve25519, const char *master) {
    return xprintf("%s%s:%s", E2E_ID_SIG_PREFIX, curve25519, master);
}

char *e2e_otk_sig_text(const char *key) { return xprintf("%s%s", E2E_OTK_SIG_PREFIX, key); }

char *e2e_list_sig_text(long ver, const char *const *devices, size_t n) {
    char *head = xprintf("%s%ld:", E2E_LIST_SIG_PREFIX, ver);
    size_t len = strlen(head);
    for (size_t i = 0; i < n; i++) len += strlen(devices[i]) + 1;
    char *out = xmalloc(len + 1);
    strcpy(out, head);
    free(head);
    for (size_t i = 0; i < n; i++) {
        if (i) strcat(out, ",");
        strcat(out, devices[i]);
    }
    return out;
}

char *e2e_cert_sig_text(long ver, const char *ed25519) {
    return xprintf("%s%ld:%s", E2E_CERT_PREFIX, ver, ed25519);
}

bool e2e_valid_ver(double ver) {
    return isfinite(ver) && ver == floor(ver) && ver >= 1 && ver <= (double)E2E_MAX_VER;
}

char *e2e_fold(const char *nick) {
    char *out = xstrdup(nick);
    for (char *p = out; *p; p++)
        if (*p >= 'A' && *p <= 'Z') *p = (char)(*p - 'A' + 'a');
    return out;
}

bool e2e_nick_eq(const char *a, const char *b) {
    if (!a || !b) return false;
    for (;; a++, b++) {
        char x = (*a >= 'A' && *a <= 'Z') ? (char)(*a - 'A' + 'a') : *a;
        char y = (*b >= 'A' && *b <= 'Z') ? (char)(*b - 'A' + 'a') : *b;
        if (x != y) return false;
        if (!x) return true;
    }
}

bool e2e_ed25519_canonical(const char *key) {
    if (!key) return false;
    char *c = vzs(vz_canonical_ed25519(key));
    bool ok = c && strcmp(c, key) == 0;
    free(c);
    return ok;
}

bool e2e_curve25519_canonical(const char *key) {
    if (!key) return false;
    char *c = vzs(vz_canonical_curve25519(key));
    bool ok = c && strcmp(c, key) == 0;
    free(c);
    return ok;
}

long e2e_line_budget(long frame_budget_base, const char *target) {
    if (frame_budget_base < 0) return -1;
    long budget = frame_budget_base - (long)strlen(target);
    return budget <= 0 ? -1 : budget;
}

static void upper(const char *s, char *out, size_t out_sz) {
    size_t i = 0;
    for (; s[i] && i + 1 < out_sz; i++)
        out[i] = (s[i] >= 'a' && s[i] <= 'z') ? (char)(s[i] - 'a' + 'A') : s[i];
    out[i] = 0;
}

long e2e_lines_needed(e2e_verb verb, const char *payload, long line_budget, const char *from,
                      const char *to) {
    long size = (long)strlen(payload);
    char vu[16];
    upper(e2e_verb_name(verb), vu, sizeof(vu));
    for (long n = 1; n <= E2E_MAX_FRAGMENTS; n++) {
        /* "\x01E2E " VERB " " + 11 x + " " n "/" n " " from " " to " " */
        char *head = xprintf("\x01" "E2E %s xxxxxxxxxxx %ld/%ld %s %s ", vu, n, n, from, to);
        long room = line_budget - (long)strlen(head) - 1;
        free(head);
        if (room > 0 && room * n >= size) return n;
    }
    return E2E_TOO_MANY_LINES;
}

/* Strict UTF-8, as a fatal TextDecoder reads it: no overlongs, no
 * surrogates, nothing past U+10FFFF. */
static bool utf8_valid(const uint8_t *s, size_t n) {
    size_t i = 0;
    while (i < n) {
        uint8_t c = s[i];
        if (c < 0x80) {
            i++;
            continue;
        }
        size_t len;
        uint32_t cp;
        if ((c & 0xe0) == 0xc0) len = 2, cp = c & 0x1f;
        else if ((c & 0xf0) == 0xe0) len = 3, cp = c & 0x0f;
        else if ((c & 0xf8) == 0xf0) len = 4, cp = c & 0x07;
        else return false;
        if (i + len > n) return false;
        for (size_t k = 1; k < len; k++) {
            if ((s[i + k] & 0xc0) != 0x80) return false;
            cp = (cp << 6) | (s[i + k] & 0x3f);
        }
        if ((len == 2 && cp < 0x80) || (len == 3 && cp < 0x800) || (len == 4 && cp < 0x10000))
            return false;
        if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return false;
        i += len;
    }
    return true;
}

/* ── JSON reading ────────────────────────────────────────────────────── */

/* Whether any object in `v` names a member twice: JSON.parse keeps the
 * last, json_get the first, so such a document reads two ways. */
static bool dup_keys(const json_value *v) {
    json_type t = json_type_of(v);
    if (t == JSON_ARRAY) {
        for (size_t i = 0; i < json_len(v); i++)
            if (dup_keys(json_at(v, i))) return true;
    } else if (t == JSON_OBJECT) {
        size_t n = json_len(v);
        for (size_t i = 0; i < n; i++) {
            for (size_t k = i + 1; k < n; k++)
                if (strcmp(json_key_at(v, i), json_key_at(v, k)) == 0) return true;
            if (dup_keys(json_value_at(v, i))) return true;
        }
    }
    return false;
}

/* A JSON object document, or NULL (wire.ts decodePayload). */
static json_doc *decode_object(const char *text, size_t len) {
    json_doc *d = json_parse(text, len, NULL, 0);
    if (!d) return NULL;
    if (json_type_of(json_root(d)) != JSON_OBJECT || dup_keys(json_root(d))) {
        json_free(d);
        return NULL;
    }
    return d;
}

/* A string member with no NUL inside it, or NULL. */
static const char *str_of(const json_value *v) {
    const char *s = json_string(v);
    if (!s || strlen(s) != json_string_len(v)) return NULL;
    return s;
}

static const char *str_field(const json_value *obj, const char *key) {
    return str_of(json_get(obj, key));
}

static const json_value *obj_field(const json_value *obj, const char *key) {
    const json_value *v = json_get(obj, key);
    return json_type_of(v) == JSON_OBJECT ? v : NULL;
}

static bool number_field(const json_value *obj, const char *key, double *out) {
    return json_number(json_get(obj, key), out);
}

static bool version_ok(const json_value *root) {
    double v;
    return number_field(root, "v", &v) && v == E2E_WIRE_VERSION;
}

/* ── Payloads ────────────────────────────────────────────────────────── */

#define SETERR(...)                                                                                \
    do {                                                                                           \
        if (err && err_sz) snprintf(err, err_sz, __VA_ARGS__);                                     \
    } while (0)

static bool id_block_of(const json_value *parent, e2e_id_block *out) {
    const json_value *id = obj_field(parent, "id");
    if (!id) return false;
    out->curve25519 = str_field(id, "curve25519");
    out->ed25519 = str_field(id, "ed25519");
    out->sig = str_field(id, "sig");
    return out->curve25519 && out->ed25519 && out->sig;
}

bool e2e_master_list_parse(const json_value *master, e2e_master_list *out) {
    memset(out, 0, sizeof(*out));
    const json_value *list = obj_field(master, "list");
    if (!list) return false;
    if (!number_field(list, "ver", &out->ver)) return false;
    const json_value *devices = json_get(list, "devices");
    if (json_type_of(devices) != JSON_ARRAY) return false;
    out->ndevices = json_len(devices);
    for (size_t i = 0; i < out->ndevices; i++) {
        const char *d = str_of(json_at(devices, i));
        if (!d) return false;
        if (i < E2E_MAX_DEVICES) out->devices[i] = d;
    }
    out->ed25519 = str_field(master, "ed25519");
    out->sig = str_field(master, "sig");
    return out->ed25519 && out->sig;
}

bool e2e_valid_master_list(const e2e_master_list *m) {
    if (m->ndevices < 1 || m->ndevices > E2E_MAX_DEVICES) return false;
    if (!e2e_valid_ver(m->ver)) return false;
    for (size_t i = 1; i < m->ndevices; i++)
        if (!(strcmp(m->devices[i - 1], m->devices[i]) < 0)) return false;
    char dids[E2E_MAX_DEVICES][E2E_DID_LEN + 1];
    for (size_t i = 0; i < m->ndevices; i++) {
        if (!e2e_ed25519_canonical(m->devices[i])) return false;
        if (!e2e_did(m->devices[i], dids[i])) return false;
        for (size_t k = 0; k < i; k++)
            if (strcmp(dids[k], dids[i]) == 0) return false;
    }
    if (!e2e_ed25519_canonical(m->ed25519)) return false;
    char *text = e2e_list_sig_text((long)m->ver, m->devices, m->ndevices);
    bool ok = vz_verify_ed25519(m->ed25519, text, m->sig) == 1;
    free(text);
    return ok;
}

static bool bodies_of(const json_value *root, e2e_payload *out) {
    const json_value *b = obj_field(root, "bodies");
    if (!b) return false;
    size_t n = json_len(b);
    if (n < 1 || n > E2E_MAX_DEVICES) return false;
    for (size_t i = 0; i < n; i++) {
        const char *did = json_key_at(b, i);
        const char *body = str_of(json_value_at(b, i));
        if (!e2e_did_valid(did) || !body) return false;
        out->bodies[i].did = did;
        out->bodies[i].body = body;
    }
    out->nbodies = n;
    return true;
}

/* The payload of `verb` in the decoded object `root` (wire.ts parse*). */
static bool parse_on(e2e_verb verb, const json_value *root, e2e_payload *out, char *err,
                     size_t err_sz) {
    if (!version_ok(root)) {
        SETERR("unsupported version");
        return false;
    }
    switch (verb) {
    case E2E_VERB_KEYS: {
        const json_value *devices = json_get(root, "devices");
        if (json_type_of(devices) != JSON_ARRAY || json_len(devices) > E2E_MAX_DEVICES) {
            SETERR("missing devices");
            return false;
        }
        const json_value *master = obj_field(root, "master");
        if (!master || !e2e_master_list_parse(master, &out->master)) {
            SETERR("missing master");
            return false;
        }
        out->nentries = json_len(devices);
        for (size_t i = 0; i < out->nentries; i++) {
            const json_value *e = json_at(devices, i);
            e2e_keys_entry *k = &out->entries[i];
            const json_value *otk = obj_field(e, "otk");
            if (json_type_of(e) != JSON_OBJECT || !id_block_of(e, &k->id) || !otk) {
                SETERR("bad device entry");
                return false;
            }
            k->otk_key = str_field(otk, "key");
            k->otk_sig = str_field(otk, "sig");
            const json_value *f = json_get(otk, "fallback");
            k->otk_fallback = json_type_of(f) == JSON_BOOL && json_bool(f, false);
            if (!k->otk_key || !k->otk_sig) {
                SETERR("bad device entry");
                return false;
            }
        }
        return true;
    }
    case E2E_VERB_PKMSG: {
        const json_value *master = obj_field(root, "master");
        double ver;
        if (!master || !number_field(master, "ver", &ver) || !e2e_valid_ver(ver)) {
            SETERR("bad ver");
            return false;
        }
        out->cert_ver = (long)ver;
        if (!id_block_of(root, &out->id)) {
            SETERR("missing id");
            return false;
        }
        out->cert_master = str_field(master, "ed25519");
        out->cert = str_field(master, "cert");
        if (!out->cert_master || !out->cert) {
            SETERR("missing master");
            return false;
        }
        if (!bodies_of(root, out)) {
            SETERR("bad bodies");
            return false;
        }
        return true;
    }
    case E2E_VERB_MSG:
        out->ck = str_field(root, "ck");
        if (!out->ck) {
            SETERR("missing ck");
            return false;
        }
        if (!bodies_of(root, out)) {
            SETERR("bad bodies");
            return false;
        }
        return true;
    case E2E_VERB_NACK:
        out->ref = str_field(root, "ref");
        if (!out->ref) {
            SETERR("missing ref");
            return false;
        }
        return true;
    case E2E_VERB_KEYREQ:
        return true;
    case E2E_VERB_NONE:
        break;
    }
    SETERR("unknown verb");
    return false;
}

bool e2e_payload_parse(e2e_verb verb, const char *text, e2e_payload *out, bool *undecodable,
                       char *err, size_t err_sz) {
    memset(out, 0, sizeof(*out));
    *undecodable = false;
    if (err && err_sz) err[0] = 0;
    json_doc *d = text ? decode_object(text, strlen(text)) : NULL;
    if (!d) {
        *undecodable = true;
        SETERR("undecodable payload");
        return false;
    }
    out->doc = d;
    out->verb = verb;
    if (!parse_on(verb, json_root(d), out, err, err_sz)) {
        e2e_payload_free(out);
        return false;
    }
    return true;
}

void e2e_payload_free(e2e_payload *p) {
    json_free(p->doc);
    memset(p, 0, sizeof(*p));
}

const char *e2e_payload_body(const e2e_payload *p, const char *did) {
    for (size_t i = 0; i < p->nbodies; i++)
        if (strcmp(p->bodies[i].did, did) == 0) return p->bodies[i].body;
    return NULL;
}

char *e2e_keyreq_payload(void) { return xstrdup("{\"v\":2}"); }

char *e2e_nack_payload(const char *ref) {
    json_buf b;
    jb_init(&b);
    jb_obj_open(&b);
    jb_key(&b, "v");
    jb_num(&b, E2E_WIRE_VERSION);
    jb_key(&b, "ref");
    jb_str(&b, ref);
    jb_obj_close(&b);
    return take(&b);
}

char *e2e_consent_payload(const char *master) {
    json_buf b;
    jb_init(&b);
    jb_obj_open(&b);
    jb_key(&b, "v");
    jb_num(&b, E2E_WIRE_VERSION);
    jb_key(&b, "master");
    jb_str(&b, master);
    jb_obj_close(&b);
    return take(&b);
}

bool e2e_consent_payload_parse(const char *text, char **master) {
    *master = NULL;
    json_doc *d = text ? decode_object(text, strlen(text)) : NULL;
    if (!d) return false;
    const json_value *root = json_root(d);
    bool ok = version_ok(root);
    const json_value *m = json_get(root, "master");
    if (ok && m && !json_is_null(m)) {
        const char *s = str_of(m);
        if (s && e2e_ed25519_canonical(s)) *master = xstrdup(s);
        else ok = false;
    }
    json_free(d);
    return ok;
}

static void write_bodies(json_buf *b, const e2e_body *bodies, size_t n) {
    jb_key(b, "bodies");
    jb_obj_open(b);
    for (size_t i = 0; i < n; i++) {
        jb_key(b, bodies[i].did);
        jb_str(b, bodies[i].body);
    }
    jb_obj_close(b);
}

static void write_id_block(json_buf *b, const char *curve, const char *ed, const char *sig) {
    jb_key(b, "id");
    jb_obj_open(b);
    jb_key(b, "curve25519");
    jb_str(b, curve);
    jb_key(b, "ed25519");
    jb_str(b, ed);
    jb_key(b, "sig");
    jb_str(b, sig);
    jb_obj_close(b);
}

/* keyBundle.ts idBlock: the device's keys and its S1 over `master`. */
static bool id_block_sign(vz_account *device, const char *master, char **curve, char **ed,
                          char **sig) {
    *curve = vzs(vz_account_curve25519_key(device));
    *ed = vzs(vz_account_ed25519_key(device));
    *sig = NULL;
    if (*curve && *ed) {
        char *text = e2e_id_sig_text(*curve, master);
        *sig = vzs(vz_account_sign(device, text));
        free(text);
    }
    if (*curve && *ed && *sig) return true;
    free(*curve);
    free(*ed);
    free(*sig);
    *curve = *ed = *sig = NULL;
    return false;
}

char *e2e_pkmsg_payload(vz_account *device, const char *master, const char *cert, long cert_ver,
                        const e2e_body *bodies, size_t n) {
    char *curve, *ed, *sig;
    if (!id_block_sign(device, master, &curve, &ed, &sig)) return NULL;
    json_buf b;
    jb_init(&b);
    jb_obj_open(&b);
    jb_key(&b, "v");
    jb_num(&b, E2E_WIRE_VERSION);
    write_id_block(&b, curve, ed, sig);
    jb_key(&b, "master");
    jb_obj_open(&b);
    jb_key(&b, "ed25519");
    jb_str(&b, master);
    jb_key(&b, "cert");
    jb_str(&b, cert);
    jb_key(&b, "ver");
    jb_num(&b, (double)cert_ver);
    jb_obj_close(&b);
    write_bodies(&b, bodies, n);
    jb_obj_close(&b);
    free(curve);
    free(ed);
    free(sig);
    return take(&b);
}

char *e2e_msg_payload(const char *ck, const e2e_body *bodies, size_t n) {
    json_buf b;
    jb_init(&b);
    jb_obj_open(&b);
    jb_key(&b, "v");
    jb_num(&b, E2E_WIRE_VERSION);
    jb_key(&b, "ck");
    jb_str(&b, ck);
    write_bodies(&b, bodies, n);
    jb_obj_close(&b);
    return take(&b);
}

/* The master block {ed25519, list{ver, devices}, sig} of KEYS and t:list. */
static void write_master_list(json_buf *b, const char *master, long ver,
                              const char *const *devices, size_t n, const char *sig) {
    jb_obj_open(b);
    jb_key(b, "ed25519");
    jb_str(b, master);
    jb_key(b, "list");
    jb_obj_open(b);
    jb_key(b, "ver");
    jb_num(b, (double)ver);
    jb_key(b, "devices");
    jb_arr_open(b);
    for (size_t i = 0; i < n; i++) jb_str(b, devices[i]);
    jb_arr_close(b);
    jb_obj_close(b);
    jb_key(b, "sig");
    jb_str(b, sig);
    jb_obj_close(b);
}

char *e2e_keys_payload(const char *master, long ver, const char *const *devices, size_t ndevices,
                       const char *list_sig, const e2e_keys_build_entry *entries,
                       size_t nentries) {
    json_buf b;
    jb_init(&b);
    jb_obj_open(&b);
    jb_key(&b, "v");
    jb_num(&b, E2E_WIRE_VERSION);
    jb_key(&b, "master");
    write_master_list(&b, master, ver, devices, ndevices, list_sig);
    jb_key(&b, "devices");
    jb_arr_open(&b);
    for (size_t i = 0; i < nentries; i++) {
        const e2e_keys_build_entry *e = &entries[i];
        jb_obj_open(&b);
        write_id_block(&b, e->curve25519, e->ed25519, e->sig);
        jb_key(&b, "otk");
        jb_obj_open(&b);
        jb_key(&b, "key");
        jb_str(&b, e->otk_key);
        jb_key(&b, "fallback");
        jb_bool(&b, e->otk_fallback);
        jb_key(&b, "sig");
        jb_str(&b, e->otk_sig);
        jb_obj_close(&b);
        jb_obj_close(&b);
    }
    jb_arr_close(&b);
    jb_obj_close(&b);
    return take(&b);
}

/* ── Inner plaintexts ────────────────────────────────────────────────── */

static bool non_empty(const char *s) { return s && s[0]; }

static bool matches_b64(const char *s, size_t len) {
    if (!s || strlen(s) != len) return false;
    for (size_t i = 0; i < len; i++)
        if (!b64_char(s[i])) return false;
    return true;
}

static bool hex64(const char *s) {
    if (!s || strlen(s) != 64) return false;
    for (size_t i = 0; i < 64; i++)
        if (!((s[i] >= '0' && s[i] <= '9') || (s[i] >= 'a' && s[i] <= 'f'))) return false;
    return true;
}

/* A sas.* field: 43 characters of standard base64 (sas.ts KEY). */
static const char *sas_field(const json_value *root, const char *key) {
    const char *s = str_field(root, key);
    return matches_b64(s, 43) ? s : NULL;
}

/* `s` cut to at most `max` bytes, never inside a UTF-8 sequence. */
static void cut_utf8(const char *s, size_t max, char *out) {
    size_t n = strlen(s);
    if (n > max) {
        n = max;
        while (n > 0 && ((unsigned char)s[n] & 0xc0) == 0x80) n--;
    }
    memcpy(out, s, n);
    out[n] = 0;
}

static bool inner_fields(const json_value *root, e2e_inner *out) {
    const char *t = out->t;
    if (strcmp(t, "text") == 0) {
        const json_value *body = json_get(root, "body");
        if (json_type_of(body) != JSON_STRING) return false;
        out->type = E2E_INNER_TEXT;
        out->body = json_string(body);
        out->body_len = json_string_len(body);
        return true;
    }
    if (strcmp(t, "chal") == 0) {
        double exp;
        out->network = str_field(root, "network");
        out->channel = str_field(root, "channel");
        out->sender_mask = str_field(root, "sender_mask");
        out->line_sha256 = str_field(root, "line_sha256");
        out->nonce = str_field(root, "nonce");
        if (!non_empty(out->network) || !non_empty(out->channel) || !out->sender_mask ||
            !hex64(out->line_sha256) || !non_empty(out->nonce) ||
            !number_field(root, "expires_at", &exp) || exp != floor(exp) ||
            fabs(exp) > 9007199254740991.0)
            return false;
        out->expires_at = (int64_t)exp;
        out->type = E2E_INNER_CHAL;
        return true;
    }
    if (strcmp(t, "ack") == 0) {
        out->nonce = str_field(root, "nonce");
        out->type = E2E_INNER_ACK;
        return non_empty(out->nonce);
    }
    if (strcmp(t, "list") == 0) {
        const json_value *m = obj_field(root, "master");
        out->type = E2E_INNER_LIST;
        return m && e2e_master_list_parse(m, &out->list);
    }
    if (strcmp(t, "listreq") == 0) {
        out->type = E2E_INNER_LISTREQ;
        return true;
    }
    if (strcmp(t, "copy") == 0) {
        const json_value *body = json_get(root, "body");
        out->peer = str_field(root, "peer");
        if (!non_empty(out->peer) || json_type_of(body) != JSON_STRING) return false;
        out->body = json_string(body);
        out->body_len = json_string_len(body);
        out->type = E2E_INNER_COPY;
        return true;
    }
    if (strncmp(t, "sas.", 4) == 0) {
        out->tx = str_field(root, "tx");
        if (!matches_b64(out->tx, 11)) return false;
        if (strcmp(t, "sas.start") == 0) {
            out->type = E2E_INNER_SAS_START;
            return true;
        }
        if (strcmp(t, "sas.accept") == 0) {
            out->type = E2E_INNER_SAS_ACCEPT;
            return (out->commitment = sas_field(root, "commitment")) != NULL;
        }
        if (strcmp(t, "sas.key") == 0) {
            out->type = E2E_INNER_SAS_KEY;
            return (out->key = sas_field(root, "key")) != NULL;
        }
        if (strcmp(t, "sas.mac") == 0) {
            out->type = E2E_INNER_SAS_MAC;
            out->mac = sas_field(root, "mac");
            out->mmac = sas_field(root, "mmac");
            return out->mac && out->mmac;
        }
        if (strcmp(t, "sas.cancel") == 0) {
            const char *reason = str_field(root, "reason");
            if (!reason) return false;
            cut_utf8(reason, 64, out->reason);
            out->type = E2E_INNER_SAS_CANCEL;
            return true;
        }
        return false; /* an unknown sas.* is no SAS step (sas.ts parse) */
    }
    out->type = E2E_INNER_UNKNOWN;
    return true;
}

bool e2e_inner_parse(const char *json, size_t len, e2e_inner *out) {
    memset(out, 0, sizeof(*out));
    json_doc *d = json ? decode_object(json, len) : NULL;
    if (!d) return false;
    const json_value *root = json_root(d);
    out->doc = d;
    out->t = str_field(root, "t");
    if (!out->t || !inner_fields(root, out)) {
        e2e_inner_free(out);
        return false;
    }
    return true;
}

void e2e_inner_free(e2e_inner *in) {
    json_free(in->doc);
    memset(in, 0, sizeof(*in));
}

static void inner_open(json_buf *b, const char *t) {
    jb_init(b);
    jb_obj_open(b);
    jb_key(b, "t");
    jb_str(b, t);
}

static char *inner_close(json_buf *b) {
    jb_obj_close(b);
    return take(b);
}

char *e2e_inner_text(const char *body, size_t len) {
    json_buf b;
    inner_open(&b, "text");
    jb_key(&b, "body");
    jb_strn(&b, body, len);
    return inner_close(&b);
}

char *e2e_inner_ack(const char *nonce) {
    json_buf b;
    inner_open(&b, "ack");
    jb_key(&b, "nonce");
    jb_str(&b, nonce);
    return inner_close(&b);
}

char *e2e_inner_chal(const char *network, const char *channel, const char *sender_mask,
                     const char *line_sha256, const char *nonce, int64_t expires_at) {
    json_buf b;
    inner_open(&b, "chal");
    jb_key(&b, "network");
    jb_str(&b, network);
    jb_key(&b, "channel");
    jb_str(&b, channel);
    jb_key(&b, "sender_mask");
    jb_str(&b, sender_mask);
    jb_key(&b, "line_sha256");
    jb_str(&b, line_sha256);
    jb_key(&b, "nonce");
    jb_str(&b, nonce);
    jb_key(&b, "expires_at");
    jb_num(&b, (double)expires_at);
    return inner_close(&b);
}

char *e2e_inner_listreq(void) {
    json_buf b;
    inner_open(&b, "listreq");
    return inner_close(&b);
}

char *e2e_inner_copy(const char *peer, const char *body, size_t len) {
    json_buf b;
    inner_open(&b, "copy");
    jb_key(&b, "peer");
    jb_str(&b, peer);
    jb_key(&b, "body");
    jb_strn(&b, body, len);
    return inner_close(&b);
}

static char *sas_inner(const char *t, const char *tx, const char *k1, const char *v1,
                       const char *k2, const char *v2) {
    json_buf b;
    inner_open(&b, t);
    jb_key(&b, "tx");
    jb_str(&b, tx);
    if (k1) {
        jb_key(&b, k1);
        jb_str(&b, v1);
    }
    if (k2) {
        jb_key(&b, k2);
        jb_str(&b, v2);
    }
    return inner_close(&b);
}

char *e2e_inner_sas_start(const char *tx) {
    return sas_inner("sas.start", tx, NULL, NULL, NULL, NULL);
}

char *e2e_inner_sas_accept(const char *tx, const char *commitment) {
    return sas_inner("sas.accept", tx, "commitment", commitment, NULL, NULL);
}

char *e2e_inner_sas_key(const char *tx, const char *key) {
    return sas_inner("sas.key", tx, "key", key, NULL, NULL);
}

char *e2e_inner_sas_mac(const char *tx, const char *mac, const char *mmac) {
    return sas_inner("sas.mac", tx, "mac", mac, "mmac", mmac);
}

char *e2e_inner_sas_cancel(const char *tx, const char *reason) {
    return sas_inner("sas.cancel", tx, "reason", reason, NULL, NULL);
}

/* ── Our identity ────────────────────────────────────────────────────── */

void e2e_own_free(e2e_own *own) {
    if (!own) return;
    free(own->master);
    free(own->cert);
    strv_free(&own->list_devices);
    free(own->list_sig);
    free(own->did);
    memset(own, 0, sizeof(*own));
}

char *e2e_sign_list(vz_account *master_acct, long ver, const char *const *sorted_devices,
                    size_t n) {
    char *text = e2e_list_sig_text(ver, sorted_devices, n);
    char *sig = vzs(vz_account_sign(master_acct, text));
    free(text);
    return sig;
}

char *e2e_sign_cert(vz_account *master_acct, long ver, const char *ed25519) {
    char *text = e2e_cert_sig_text(ver, ed25519);
    char *sig = vzs(vz_account_sign(master_acct, text));
    free(text);
    return sig;
}

void e2e_own_bootstrap(vz_account *device, vz_account *master_acct, e2e_own *out) {
    memset(out, 0, sizeof(*out));
    char *e = vzs(vz_account_ed25519_key(device));
    out->master = vzs(vz_account_ed25519_key(master_acct));
    if (!e || !out->master) abort();
    out->list_ver = 1;
    strv_push(&out->list_devices, e);
    out->list_sig = e2e_sign_list(master_acct, 1, (const char *const *)out->list_devices.v, 1);
    out->cert_ver = 1;
    out->cert = e2e_sign_cert(master_acct, 1, e);
    char did[E2E_DID_LEN + 1];
    if (!out->list_sig || !out->cert || !e2e_did(e, did)) abort();
    out->did = xstrdup(did);
    free(e);
}

char *e2e_register_body(vz_account *device, const char *master) {
    char *curve, *ed, *sig;
    if (!id_block_sign(device, master, &curve, &ed, &sig)) return NULL;
    json_buf b;
    jb_init(&b);
    jb_obj_open(&b);
    jb_key(&b, "ed25519");
    jb_str(&b, ed);
    jb_key(&b, "curve25519");
    jb_str(&b, curve);
    jb_key(&b, "sig");
    jb_str(&b, sig);
    jb_obj_close(&b);
    free(curve);
    free(ed);
    free(sig);
    return take(&b);
}

char *e2e_list_put_body(const e2e_own *own) {
    json_buf b;
    jb_init(&b);
    jb_obj_open(&b);
    jb_key(&b, "master");
    jb_str(&b, own->master);
    jb_key(&b, "ver");
    jb_num(&b, (double)own->list_ver);
    jb_key(&b, "devices");
    jb_arr_open(&b);
    for (size_t i = 0; i < own->list_devices.n; i++) jb_str(&b, own->list_devices.v[i]);
    jb_arr_close(&b);
    jb_key(&b, "sig");
    jb_str(&b, own->list_sig);
    jb_obj_close(&b);
    return take(&b);
}

/* The account's unpublished one-time keys, oldest first. */
static bool unpublished_otks(vz_account *device, e2e_strv *out) {
    *out = (e2e_strv){0};
    char *json = vzs(vz_account_one_time_keys(device));
    if (!json) return false;
    json_doc *d = json_parse(json, strlen(json), NULL, 0);
    free(json);
    if (!d || json_type_of(json_root(d)) != JSON_ARRAY) {
        json_free(d);
        return false;
    }
    for (size_t i = 0; i < json_len(json_root(d)); i++) {
        const char *k = str_of(json_at(json_root(d), i));
        if (k) strv_push(out, k);
    }
    json_free(d);
    return true;
}

static void write_signed_key(json_buf *b, vz_account *device, const char *key) {
    char *text = e2e_otk_sig_text(key);
    char *sig = vzs(vz_account_sign(device, text));
    free(text);
    if (!sig) abort();
    jb_obj_open(b);
    jb_key(b, "key");
    jb_str(b, key);
    jb_key(b, "sig");
    jb_str(b, sig);
    jb_obj_close(b);
    free(sig);
}

/* ── Identity sync ───────────────────────────────────────────────────── */

const char *e2e_sync_plan_name(e2e_sync_plan p) {
    switch (p) {
    case E2E_SYNC_NONE: return "none";
    case E2E_SYNC_ELSEWHERE_NO_KEYS: return "no-keys";
    case E2E_SYNC_ELSEWHERE_NO_LIST: return "no-list";
    case E2E_SYNC_ELSEWHERE_REPLACED: return "replaced";
    case E2E_SYNC_ELSEWHERE_LEFT_OUT: return "left-out";
    case E2E_SYNC_RELIST: return "relist";
    case E2E_SYNC_ADOPT: return "adopt";
    case E2E_SYNC_READY: return "ready";
    }
    return "unknown";
}

bool e2e_sync_plan_elsewhere(e2e_sync_plan p) {
    return p == E2E_SYNC_ELSEWHERE_NO_KEYS || p == E2E_SYNC_ELSEWHERE_NO_LIST ||
           p == E2E_SYNC_ELSEWHERE_REPLACED || p == E2E_SYNC_ELSEWHERE_LEFT_OUT;
}

static bool list_names(const e2e_master_list *m, const char *key) {
    for (size_t i = 0; i < m->ndevices && i < E2E_MAX_DEVICES; i++)
        if (strcmp(m->devices[i], key) == 0) return true;
    return false;
}

/* runSync's branches, in its order. `held` is taken as grappa sent it:
 * only an ADOPT, the one branch that stores what it read, checks the
 * master's signature first (an adopt that does not verify keeps ours). */
e2e_sync_plan e2e_sync_decide(const e2e_record *r, const e2e_master_list *held) {
    if (!r->own) return held ? E2E_SYNC_ELSEWHERE_NO_KEYS : E2E_SYNC_NONE;
    if (!held) return r->master ? E2E_SYNC_RELIST : E2E_SYNC_ELSEWHERE_NO_LIST;
    if (!held->ed25519 || strcmp(held->ed25519, r->own->master) != 0)
        return E2E_SYNC_ELSEWHERE_REPLACED;
    char *e = vzs(vz_account_ed25519_key(r->account));
    if (!e) abort();
    bool named = list_names(held, e);
    free(e);
    if (!named || held->ndevices > E2E_MAX_DEVICES) return E2E_SYNC_ELSEWHERE_LEFT_OUT;
    if (held->ver > (double)r->own->list_ver && e2e_valid_master_list(held)) return E2E_SYNC_ADOPT;
    return E2E_SYNC_READY;
}

static void own_copy(const e2e_own *own, e2e_own *out) {
    memset(out, 0, sizeof(*out));
    out->master = xstrdup(own->master);
    out->cert = xstrdup(own->cert);
    out->cert_ver = own->cert_ver;
    out->list_ver = own->list_ver;
    out->list_devices = strv_dup(&own->list_devices);
    out->list_sig = xstrdup(own->list_sig);
    out->did = xstrdup(own->did);
}

bool e2e_own_relisted(const e2e_record *r, e2e_own *out) {
    if (!r->own || !r->master) return false;
    char *e = vzs(vz_account_ed25519_key(r->account));
    if (!e) abort();
    long ver = r->own->list_ver + 1;
    if (ver > E2E_MAX_VER) {
        free(e);
        return false;
    }
    const char *const devices[] = {e};
    char *sig = e2e_sign_list(r->master, ver, devices, 1);
    if (!sig) {
        free(e);
        return false;
    }
    own_copy(r->own, out);
    strv_free(&out->list_devices);
    strv_push(&out->list_devices, e);
    free(out->list_sig);
    out->list_sig = sig;
    out->list_ver = ver;
    char did[E2E_DID_LEN + 1];
    if (!e2e_did(e, did)) abort();
    free(out->did);
    out->did = xstrdup(did);
    free(e);
    return true;
}

void e2e_own_adopted(const e2e_own *own, const e2e_master_list *held, e2e_own *out) {
    own_copy(own, out);
    strv_free(&out->list_devices);
    for (size_t i = 0; i < held->ndevices && i < E2E_MAX_DEVICES; i++)
        strv_push(&out->list_devices, held->devices[i]);
    free(out->list_sig);
    out->list_sig = xstrdup(held->sig);
    out->list_ver = (long)held->ver;
}

bool e2e_own_verify(const e2e_own *own, vz_account *device) {
    if (own->list_devices.n == 0 || own->list_devices.n > E2E_MAX_DEVICES) return false;
    e2e_master_list m = {.ed25519 = own->master,
                         .ver = (double)own->list_ver,
                         .ndevices = own->list_devices.n,
                         .sig = own->list_sig};
    for (size_t i = 0; i < own->list_devices.n; i++) m.devices[i] = own->list_devices.v[i];
    if (!e2e_valid_master_list(&m)) return false;
    char *e = vzs(vz_account_ed25519_key(device));
    if (!e) abort();
    bool ok = list_names(&m, e);
    char did[E2E_DID_LEN + 1];
    ok = ok && e2e_did(e, did) && strcmp(did, own->did) == 0;
    char *text = e2e_cert_sig_text(own->cert_ver, e);
    ok = ok && vz_verify_ed25519(own->master, text, own->cert) == 1;
    free(text);
    free(e);
    return ok;
}

char *e2e_top_up(vz_account *device, long held_otks, bool held_fallback) {
    long room = E2E_MAX_HOSTED_ONE_TIME_KEYS - held_otks;
    if (room < 0) room = 0;
    e2e_strv otks;
    if (!unpublished_otks(device, &otks)) return NULL;
    long missing = room - (long)otks.n;
    strv_free(&otks);
    if (missing > 0 && vz_account_generate_one_time_keys(device, (size_t)missing) != 0)
        return NULL;
    char *fallback = vzs(vz_account_fallback_key(device));
    if (!held_fallback && !fallback) {
        if (vz_account_generate_fallback_key(device) != 0) return NULL;
        fallback = vzs(vz_account_fallback_key(device));
    }
    if (!unpublished_otks(device, &otks)) {
        free(fallback);
        return NULL;
    }
    size_t send = otks.n < (size_t)room ? otks.n : (size_t)room;
    char *out = NULL;
    if (send > 0 || fallback) {
        json_buf b;
        jb_init(&b);
        jb_obj_open(&b);
        jb_key(&b, "one_time_keys");
        jb_arr_open(&b);
        for (size_t i = 0; i < send; i++) write_signed_key(&b, device, otks.v[i]);
        jb_arr_close(&b);
        jb_key(&b, "fallback");
        if (fallback) write_signed_key(&b, device, fallback);
        else jb_null(&b);
        jb_obj_close(&b);
        out = take(&b);
    }
    strv_free(&otks);
    free(fallback);
    return out;
}

/* ── State ───────────────────────────────────────────────────────────── */

void e2e_state_init(e2e_state *s) {
    memset(s, 0, sizeof(*s));
    s->next_ref = 1;
}

static void outgoing_free(e2e_outgoing *m) {
    free(m->plaintext);
    free(m->tag);
    memset(m, 0, sizeof(*m));
}

static e2e_outgoing outgoing_dup(const e2e_outgoing *m) {
    e2e_outgoing o = *m;
    o.plaintext = xstrdup(m->plaintext);
    o.tag = xstrdup(m->tag);
    return o;
}

static void queued_free(e2e_queued *q) {
    free(q->nick);
    free(q->master);
    free(q->only);
    free(q->except);
    strv_free(&q->done);
    outgoing_free(&q->msg);
}

static void sent_free(e2e_sent *s) {
    free(s->msgid);
    free(s->nick);
    free(s->master);
    for (size_t i = 0; i < s->ndevices; i++) {
        free(s->devices[i].did);
        free(s->devices[i].ed25519);
        free(s->devices[i].session_id);
    }
    free(s->devices);
    outgoing_free(&s->msg);
}

static void device_free(e2e_device *d) {
    free(d->ed25519);
    free(d->curve25519);
    free(d->master);
    free(d->did);
}

static void master_free(e2e_master *m) {
    free(m->ed25519);
    free(m->nick);
    strv_free(&m->devices);
    strv_free(&m->revoked);
    strv_free(&m->revoked_curves);
}

static void peer_clear_outq(e2e_peer *p) {
    for (size_t i = 0; i < p->noutq; i++) queued_free(&p->outq[i]);
    free(p->outq);
    p->outq = NULL;
    p->noutq = 0;
}

static void peer_free(e2e_peer *p) {
    free(p->key);
    free(p->pin);
    peer_clear_outq(p);
    free(p->listreq_lv);
    free(p->listreq_held);
    free(p->keys_asked_nick);
}

static void sibling_free(e2e_sibling *s) {
    free(s->ed25519);
    free(s->did);
    free(s->curve25519);
}

static void sas_free(e2e_sas *r) {
    free(r->master);
    free(r->tx);
    free(r->nick);
    free(r->device);
    free(r->our_key);
    free(r->their_key);
    free(r->commitment);
    free(r->expected);
    free(r->expected_mmac);
    free(r->their_mac);
    free(r->their_mmac);
    memset(r, 0, sizeof(*r));
}

static void copy_queue_free(e2e_copy_queue *q) {
    free(q->ed25519);
    for (size_t i = 0; i < q->ncopies; i++) {
        free(q->copies[i].peer);
        free(q->copies[i].body);
    }
    free(q->copies);
}

void e2e_state_free(e2e_state *s) {
    for (size_t i = 0; i < s->nmasters; i++) master_free(&s->masters[i]);
    free(s->masters);
    for (size_t i = 0; i < s->ndevices; i++) device_free(&s->devices[i]);
    free(s->devices);
    for (size_t i = 0; i < s->npeers; i++) peer_free(&s->peers[i]);
    free(s->peers);
    for (size_t i = 0; i < s->nsessions; i++) {
        free(s->sessions[i].curve);
        strv_free(&s->sessions[i].pickles);
    }
    free(s->sessions);
    strv_free(&s->seen);
    strv_free(&s->rekeying);
    for (size_t i = 0; i < s->nanswered; i++) free(s->answered[i].key);
    free(s->answered);
    for (size_t i = 0; i < s->nsent; i++) sent_free(&s->sent[i]);
    free(s->sent);
    for (size_t i = 0; i < s->nsiblings; i++) sibling_free(&s->siblings[i]);
    free(s->siblings);
    for (size_t i = 0; i < s->ncopyq; i++) copy_queue_free(&s->copyq[i]);
    free(s->copyq);
    for (size_t i = 0; i < s->nsas; i++) sas_free(&s->sas[i]);
    free(s->sas);
    e2e_state_init(s);
}

/* Lookups. Pointers into the state's arrays are good until the next call
 * that adds to the same array: callers re-look-up across such calls. */

static e2e_master *master_get(e2e_state *s, const char *ed25519) {
    for (size_t i = 0; i < s->nmasters; i++)
        if (strcmp(s->masters[i].ed25519, ed25519) == 0) return &s->masters[i];
    return NULL;
}

static e2e_master *master_add(e2e_state *s, const char *ed25519, const char *nick, bool verified) {
    s->masters = xrealloc(s->masters, (s->nmasters + 1) * sizeof(*s->masters));
    e2e_master *m = &s->masters[s->nmasters++];
    memset(m, 0, sizeof(*m));
    m->ed25519 = xstrdup(ed25519);
    m->nick = xstrdup(nick);
    m->verified = verified;
    return m;
}

static e2e_device *device_get(e2e_state *s, const char *ed25519) {
    for (size_t i = 0; i < s->ndevices; i++)
        if (strcmp(s->devices[i].ed25519, ed25519) == 0) return &s->devices[i];
    return NULL;
}

static e2e_device *device_by_curve(e2e_state *s, const char *curve) {
    for (size_t i = 0; i < s->ndevices; i++)
        if (strcmp(s->devices[i].curve25519, curve) == 0) return &s->devices[i];
    return NULL;
}

/* Sets the device of `ed25519` (a new one, or the one bound before). */
static void device_put(e2e_state *s, const char *ed25519, const char *curve, const char *master,
                       const char *did, bool proven, long cert_ver) {
    e2e_device *d = device_get(s, ed25519);
    if (d) {
        device_free(d);
    } else {
        s->devices = xrealloc(s->devices, (s->ndevices + 1) * sizeof(*s->devices));
        d = &s->devices[s->ndevices++];
    }
    d->ed25519 = xstrdup(ed25519);
    d->curve25519 = xstrdup(curve);
    d->master = xstrdup(master);
    d->did = xstrdup(did);
    d->proven = proven;
    d->cert_ver = cert_ver;
}

static void device_remove(e2e_state *s, const char *ed25519) {
    for (size_t i = 0; i < s->ndevices; i++) {
        if (strcmp(s->devices[i].ed25519, ed25519) != 0) continue;
        device_free(&s->devices[i]);
        memmove(s->devices + i, s->devices + i + 1, (s->ndevices - i - 1) * sizeof(*s->devices));
        s->ndevices--;
        return;
    }
}

/* The record of `nick` (folded), created when `create`; NULL otherwise. */
static e2e_peer *peer_get(e2e_state *s, const char *nick, bool create) {
    char *key = e2e_fold(nick);
    for (size_t i = 0; i < s->npeers; i++) {
        if (strcmp(s->peers[i].key, key) == 0) {
            free(key);
            return &s->peers[i];
        }
    }
    if (!create) {
        free(key);
        return NULL;
    }
    s->peers = xrealloc(s->peers, (s->npeers + 1) * sizeof(*s->peers));
    e2e_peer *p = &s->peers[s->npeers++];
    memset(p, 0, sizeof(*p));
    p->key = key;
    return p;
}

static bool peer_empty(const e2e_peer *p) {
    return !p->pin && p->noutq == 0 && !p->has_keyreq_at && !p->keys_awaited && !p->has_rekey_at &&
           !p->has_listreq && !p->listreq_held && !p->keys_asked_nick;
}

static const char *pin_of(e2e_state *s, const char *nick) {
    e2e_peer *p = peer_get(s, nick, false);
    return p ? p->pin : NULL;
}

static e2e_session_set *sessions_get(e2e_state *s, const char *curve) {
    for (size_t i = 0; i < s->nsessions; i++)
        if (strcmp(s->sessions[i].curve, curve) == 0) return &s->sessions[i];
    return NULL;
}

static size_t sessions_count(e2e_state *s, const char *curve) {
    e2e_session_set *set = sessions_get(s, curve);
    return set ? set->pickles.n : 0;
}

static void sessions_delete(e2e_state *s, const char *curve) {
    for (size_t i = 0; i < s->nsessions; i++) {
        if (strcmp(s->sessions[i].curve, curve) != 0) continue;
        free(s->sessions[i].curve);
        strv_free(&s->sessions[i].pickles);
        memmove(s->sessions + i, s->sessions + i + 1,
                (s->nsessions - i - 1) * sizeof(*s->sessions));
        s->nsessions--;
        return;
    }
}

static e2e_session_set *sessions_make(e2e_state *s, const char *curve) {
    e2e_session_set *set = sessions_get(s, curve);
    if (set) return set;
    s->sessions = xrealloc(s->sessions, (s->nsessions + 1) * sizeof(*s->sessions));
    set = &s->sessions[s->nsessions++];
    set->curve = xstrdup(curve);
    set->pickles = (e2e_strv){0};
    return set;
}

/* engine.ts addSession: `pickle` the newest to `curve`, at most five kept. */
static void add_session(e2e_state *s, const char *curve, const char *pickle) {
    e2e_session_set *set = sessions_make(s, curve);
    set->pickles.v = xrealloc(set->pickles.v, (set->pickles.n + 1) * sizeof(char *));
    memmove(set->pickles.v + 1, set->pickles.v, set->pickles.n * sizeof(char *));
    set->pickles.v[0] = xstrdup(pickle);
    set->pickles.n++;
    while (set->pickles.n > E2E_MAX_SESSIONS_PER_PEER) strv_remove_at(&set->pickles, set->pickles.n - 1);
}

static e2e_sibling *sibling_get(e2e_state *s, const char *ed25519) {
    for (size_t i = 0; i < s->nsiblings; i++)
        if (strcmp(s->siblings[i].ed25519, ed25519) == 0) return &s->siblings[i];
    return NULL;
}

static e2e_copy_queue *copyq_get(e2e_state *s, const char *ed25519) {
    for (size_t i = 0; i < s->ncopyq; i++)
        if (strcmp(s->copyq[i].ed25519, ed25519) == 0) return &s->copyq[i];
    return NULL;
}

static void copyq_delete(e2e_state *s, const char *ed25519) {
    for (size_t i = 0; i < s->ncopyq; i++) {
        if (strcmp(s->copyq[i].ed25519, ed25519) != 0) continue;
        copy_queue_free(&s->copyq[i]);
        memmove(s->copyq + i, s->copyq + i + 1, (s->ncopyq - i - 1) * sizeof(*s->copyq));
        s->ncopyq--;
        return;
    }
}

static void sent_remove_at(e2e_state *s, size_t i) {
    sent_free(&s->sent[i]);
    memmove(s->sent + i, s->sent + i + 1, (s->nsent - i - 1) * sizeof(*s->sent));
    s->nsent--;
}

/* ── Record ──────────────────────────────────────────────────────────── */

void e2e_record_new(e2e_record *r) {
    r->account = vz_account_new();
    if (!r->account) abort();
    r->master = NULL;
    r->own = NULL;
    e2e_state_init(&r->state);
    r->encrypted = (e2e_strv){0};
}

void e2e_record_free(e2e_record *r) {
    vz_account_free(r->account);
    vz_account_free(r->master);
    if (r->own) {
        e2e_own_free(r->own);
        free(r->own);
    }
    e2e_state_free(&r->state);
    strv_free(&r->encrypted);
    r->account = NULL;
    r->master = NULL;
    r->own = NULL;
}

bool e2e_record_encrypted(const e2e_record *r, const char *nick) {
    char *key = e2e_fold(nick);
    bool on = strv_has(&r->encrypted, key);
    free(key);
    return on;
}

bool e2e_record_set_encrypted(e2e_record *r, const char *nick, bool on) {
    char *key = e2e_fold(nick);
    bool was = strv_has(&r->encrypted, key);
    if (on && !was) strv_push(&r->encrypted, key);
    if (!on && was) strv_remove(&r->encrypted, key);
    free(key);
    return on != was;
}

#define RECORD_VERSION 1

static void w_strv(json_buf *b, const char *key, const e2e_strv *v) {
    jb_key(b, key);
    jb_arr_open(b);
    for (size_t i = 0; i < v->n; i++) jb_str(b, v->v[i]);
    jb_arr_close(b);
}

static void w_str_or_null(json_buf *b, const char *key, const char *s) {
    jb_key(b, key);
    if (s) jb_str(b, s);
    else jb_null(b);
}

static void w_num(json_buf *b, const char *key, double v) {
    jb_key(b, key);
    jb_num(b, v);
}

static void w_outgoing(json_buf *b, const e2e_outgoing *m) {
    jb_key(b, "msg");
    jb_obj_open(b);
    w_num(b, "id", (double)m->id);
    jb_key(b, "plaintext");
    jb_str(b, m->plaintext);
    jb_key(b, "priority");
    jb_str(b, e2e_priority_name(m->priority));
    w_num(b, "sends", m->sends);
    jb_key(b, "tag");
    jb_str(b, m->tag);
    w_num(b, "expires_at", (double)m->expires_at);
    jb_obj_close(b);
}

static void w_state(json_buf *b, const e2e_state *s) {
    jb_obj_open(b);
    w_num(b, "v", 2);
    jb_key(b, "masters");
    jb_arr_open(b);
    for (size_t i = 0; i < s->nmasters; i++) {
        const e2e_master *m = &s->masters[i];
        jb_obj_open(b);
        jb_key(b, "ed25519");
        jb_str(b, m->ed25519);
        jb_key(b, "nick");
        jb_str(b, m->nick);
        jb_key(b, "verified");
        jb_bool(b, m->verified);
        w_num(b, "ver", (double)m->ver);
        w_strv(b, "devices", &m->devices);
        w_strv(b, "revoked", &m->revoked);
        w_strv(b, "revoked_curves", &m->revoked_curves);
        jb_obj_close(b);
    }
    jb_arr_close(b);
    jb_key(b, "devices");
    jb_arr_open(b);
    for (size_t i = 0; i < s->ndevices; i++) {
        const e2e_device *d = &s->devices[i];
        jb_obj_open(b);
        jb_key(b, "ed25519");
        jb_str(b, d->ed25519);
        jb_key(b, "curve25519");
        jb_str(b, d->curve25519);
        jb_key(b, "master");
        jb_str(b, d->master);
        jb_key(b, "did");
        jb_str(b, d->did);
        jb_key(b, "proven");
        jb_bool(b, d->proven);
        w_num(b, "cert_ver", (double)d->cert_ver);
        jb_obj_close(b);
    }
    jb_arr_close(b);
    jb_key(b, "peers");
    jb_arr_open(b);
    for (size_t i = 0; i < s->npeers; i++) {
        const e2e_peer *p = &s->peers[i];
        if (peer_empty(p)) continue;
        jb_obj_open(b);
        jb_key(b, "key");
        jb_str(b, p->key);
        w_str_or_null(b, "pin", p->pin);
        jb_key(b, "outq");
        jb_arr_open(b);
        for (size_t k = 0; k < p->noutq; k++) {
            const e2e_queued *q = &p->outq[k];
            jb_obj_open(b);
            jb_key(b, "nick");
            jb_str(b, q->nick);
            jb_key(b, "master");
            jb_str(b, q->master);
            w_str_or_null(b, "only", q->only);
            w_str_or_null(b, "except", q->except);
            w_strv(b, "done", &q->done);
            w_outgoing(b, &q->msg);
            w_num(b, "at", (double)q->at);
            jb_obj_close(b);
        }
        jb_arr_close(b);
        jb_key(b, "keyreq_sent_at");
        if (p->has_keyreq_at) jb_num(b, (double)p->keyreq_sent_at);
        else jb_null(b);
        jb_key(b, "keys_awaited");
        jb_bool(b, p->keys_awaited);
        jb_key(b, "rekey_at");
        if (p->has_rekey_at) jb_num(b, (double)p->rekey_at);
        else jb_null(b);
        jb_key(b, "listreq");
        if (p->has_listreq) {
            jb_obj_open(b);
            w_num(b, "at", (double)p->listreq_at);
            jb_key(b, "lv");
            jb_arr_open(b);
            for (size_t k = 0; k < p->nlistreq_lv; k++) jb_num(b, (double)p->listreq_lv[k]);
            jb_arr_close(b);
            jb_obj_close(b);
        } else {
            jb_null(b);
        }
        w_str_or_null(b, "listreq_held", p->listreq_held);
        jb_key(b, "keys_asked");
        if (p->keys_asked_nick) {
            jb_obj_open(b);
            jb_key(b, "nick");
            jb_str(b, p->keys_asked_nick);
            w_num(b, "at", (double)p->keys_asked_at);
            jb_obj_close(b);
        } else {
            jb_null(b);
        }
        jb_obj_close(b);
    }
    jb_arr_close(b);
    jb_key(b, "sessions");
    jb_arr_open(b);
    for (size_t i = 0; i < s->nsessions; i++) {
        jb_obj_open(b);
        jb_key(b, "curve");
        jb_str(b, s->sessions[i].curve);
        w_strv(b, "pickles", &s->sessions[i].pickles);
        jb_obj_close(b);
    }
    jb_arr_close(b);
    w_strv(b, "seen", &s->seen);
    w_strv(b, "rekeying", &s->rekeying);
    jb_key(b, "list_answered_at");
    jb_arr_open(b);
    for (size_t i = 0; i < s->nanswered; i++) {
        jb_obj_open(b);
        jb_key(b, "key");
        jb_str(b, s->answered[i].key);
        w_num(b, "at", (double)s->answered[i].at);
        jb_obj_close(b);
    }
    jb_arr_close(b);
    jb_key(b, "sent");
    jb_arr_open(b);
    for (size_t i = 0; i < s->nsent; i++) {
        const e2e_sent *r = &s->sent[i];
        jb_obj_open(b);
        w_num(b, "ref", (double)r->ref);
        w_str_or_null(b, "msgid", r->msgid);
        jb_key(b, "nick");
        jb_str(b, r->nick);
        jb_key(b, "master");
        jb_str(b, r->master);
        jb_key(b, "devices");
        jb_arr_open(b);
        for (size_t k = 0; k < r->ndevices; k++) {
            jb_obj_open(b);
            jb_key(b, "did");
            jb_str(b, r->devices[k].did);
            jb_key(b, "ed25519");
            jb_str(b, r->devices[k].ed25519);
            jb_key(b, "session_id");
            jb_str(b, r->devices[k].session_id);
            jb_obj_close(b);
        }
        jb_arr_close(b);
        w_outgoing(b, &r->msg);
        w_num(b, "at", (double)r->at);
        jb_obj_close(b);
    }
    jb_arr_close(b);
    w_num(b, "next_ref", (double)s->next_ref);
    w_num(b, "inbox", (double)s->inbox);
    jb_key(b, "siblings");
    jb_arr_open(b);
    for (size_t i = 0; i < s->nsiblings; i++) {
        jb_obj_open(b);
        jb_key(b, "ed25519");
        jb_str(b, s->siblings[i].ed25519);
        jb_key(b, "did");
        jb_str(b, s->siblings[i].did);
        jb_key(b, "curve25519");
        jb_str(b, s->siblings[i].curve25519);
        jb_obj_close(b);
    }
    jb_arr_close(b);
    jb_key(b, "copyq");
    jb_arr_open(b);
    for (size_t i = 0; i < s->ncopyq; i++) {
        const e2e_copy_queue *q = &s->copyq[i];
        jb_obj_open(b);
        jb_key(b, "ed25519");
        jb_str(b, q->ed25519);
        jb_key(b, "copies");
        jb_arr_open(b);
        for (size_t k = 0; k < q->ncopies; k++) {
            jb_obj_open(b);
            jb_key(b, "peer");
            jb_str(b, q->copies[k].peer);
            jb_key(b, "body");
            jb_strn(b, q->copies[k].body, q->copies[k].body_len);
            w_num(b, "at", (double)q->copies[k].at);
            jb_obj_close(b);
        }
        jb_arr_close(b);
        jb_obj_close(b);
    }
    jb_arr_close(b);
    jb_key(b, "sas");
    jb_arr_open(b);
    for (size_t i = 0; i < s->nsas; i++) {
        const e2e_sas *r = &s->sas[i];
        jb_obj_open(b);
        jb_key(b, "master");
        jb_str(b, r->master);
        jb_key(b, "tx");
        jb_str(b, r->tx);
        jb_key(b, "nick");
        jb_str(b, r->nick);
        jb_key(b, "role");
        jb_str(b, r->role_a ? "a" : "b");
        jb_key(b, "phase");
        jb_str(b, e2e_sas_phase_name(r->phase));
        w_num(b, "at", (double)r->at);
        w_str_or_null(b, "device", r->device);
        jb_key(b, "held");
        jb_bool(b, r->held);
        w_str_or_null(b, "our_key", r->our_key);
        w_str_or_null(b, "their_key", r->their_key);
        w_str_or_null(b, "commitment", r->commitment);
        w_str_or_null(b, "expected", r->expected);
        w_str_or_null(b, "expected_mmac", r->expected_mmac);
        w_str_or_null(b, "their_mac", r->their_mac);
        w_str_or_null(b, "their_mmac", r->their_mmac);
        jb_obj_close(b);
    }
    jb_arr_close(b);
    jb_obj_close(b);
}

char *e2e_record_to_json(const e2e_record *r) {
    char *account = vzs(vz_account_pickle(r->account));
    char *master = r->master ? vzs(vz_account_pickle(r->master)) : NULL;
    if (!account || (r->master && !master)) abort();
    json_buf b;
    jb_init(&b);
    jb_obj_open(&b);
    w_num(&b, "v", RECORD_VERSION);
    jb_key(&b, "account");
    jb_str(&b, account);
    w_str_or_null(&b, "master", master);
    jb_key(&b, "own");
    if (r->own) {
        const e2e_own *o = r->own;
        jb_obj_open(&b);
        jb_key(&b, "master");
        jb_str(&b, o->master);
        jb_key(&b, "cert");
        jb_str(&b, o->cert);
        w_num(&b, "cert_ver", (double)o->cert_ver);
        jb_key(&b, "list");
        jb_obj_open(&b);
        w_num(&b, "ver", (double)o->list_ver);
        w_strv(&b, "devices", &o->list_devices);
        jb_key(&b, "sig");
        jb_str(&b, o->list_sig);
        jb_obj_close(&b);
        jb_key(&b, "did");
        jb_str(&b, o->did);
        jb_obj_close(&b);
    } else {
        jb_null(&b);
    }
    jb_key(&b, "state");
    w_state(&b, &r->state);
    w_strv(&b, "encrypted", &r->encrypted);
    jb_obj_close(&b);
    free(account);
    free(master);
    return take(&b);
}

/* Reading the record back: every field required, every type checked. A
 * failure anywhere refuses the whole record. */

static bool r_str(const json_value *o, const char *key, char **out) {
    const char *s = str_field(o, key);
    if (!s) return false;
    *out = xstrdup(s);
    return true;
}

static bool r_str_or_null(const json_value *o, const char *key, char **out) {
    const json_value *v = json_get(o, key);
    *out = NULL;
    if (json_type_of(v) == JSON_NULL && v) return true;
    const char *s = str_of(v);
    if (!s) return false;
    *out = xstrdup(s);
    return true;
}

static bool r_i64(const json_value *o, const char *key, int64_t *out) {
    double d;
    if (!number_field(o, key, &d) || d != floor(d) || fabs(d) > 9007199254740991.0) return false;
    *out = (int64_t)d;
    return true;
}

static bool r_long(const json_value *o, const char *key, long *out) {
    int64_t v;
    if (!r_i64(o, key, &v) || v < 0 || v > E2E_MAX_VER) return false;
    *out = (long)v;
    return true;
}

static bool r_bool(const json_value *o, const char *key, bool *out) {
    const json_value *v = json_get(o, key);
    if (json_type_of(v) != JSON_BOOL) return false;
    *out = json_bool(v, false);
    return true;
}

static bool r_strv(const json_value *o, const char *key, e2e_strv *out) {
    *out = (e2e_strv){0};
    const json_value *a = json_get(o, key);
    if (json_type_of(a) != JSON_ARRAY) return false;
    for (size_t i = 0; i < json_len(a); i++) {
        const char *s = str_of(json_at(a, i));
        if (!s) return false;
        strv_push(out, s);
    }
    return true;
}

static const json_value *r_arr(const json_value *o, const char *key) {
    const json_value *a = json_get(o, key);
    return json_type_of(a) == JSON_ARRAY ? a : NULL;
}

static bool priority_parse(const char *s, e2e_priority *out) {
    static const e2e_priority all[] = {E2E_PRIO_CONTROL, E2E_PRIO_REACTIVE, E2E_PRIO_TEXT};
    for (size_t i = 0; i < 3; i++) {
        if (streq(s, e2e_priority_name(all[i]))) {
            *out = all[i];
            return true;
        }
    }
    return false;
}

static bool r_outgoing(const json_value *o, e2e_outgoing *m) {
    memset(m, 0, sizeof(*m));
    const json_value *v = obj_field(o, "msg");
    long sends = 0;
    int64_t id = 0;
    if (!v || !r_i64(v, "id", &id) || !r_long(v, "sends", &sends) ||
        !priority_parse(str_field(v, "priority"), &m->priority) ||
        !r_i64(v, "expires_at", &m->expires_at))
        return false;
    m->id = (long)id;
    m->sends = (int)sends;
    if (!r_str(v, "plaintext", &m->plaintext) || !r_str(v, "tag", &m->tag)) {
        outgoing_free(m);
        return false;
    }
    return true;
}

static bool r_master(const json_value *o, e2e_master *m) {
    memset(m, 0, sizeof(*m));
    return r_str(o, "ed25519", &m->ed25519) && r_str(o, "nick", &m->nick) &&
           r_bool(o, "verified", &m->verified) && r_long(o, "ver", &m->ver) &&
           r_strv(o, "devices", &m->devices) && r_strv(o, "revoked", &m->revoked) &&
           r_strv(o, "revoked_curves", &m->revoked_curves);
}

static bool r_device(const json_value *o, e2e_device *d) {
    memset(d, 0, sizeof(*d));
    return r_str(o, "ed25519", &d->ed25519) && r_str(o, "curve25519", &d->curve25519) &&
           r_str(o, "master", &d->master) && r_str(o, "did", &d->did) &&
           r_bool(o, "proven", &d->proven) && r_long(o, "cert_ver", &d->cert_ver);
}

static bool r_queued(const json_value *o, e2e_queued *q) {
    memset(q, 0, sizeof(*q));
    if (!r_str(o, "nick", &q->nick) || !r_str(o, "master", &q->master) ||
        !r_str_or_null(o, "only", &q->only) || !r_str_or_null(o, "except", &q->except) ||
        !r_strv(o, "done", &q->done) || !r_i64(o, "at", &q->at))
        return false;
    return r_outgoing(o, &q->msg);
}

static bool r_opt_i64(const json_value *o, const char *key, bool *has, int64_t *out) {
    const json_value *v = json_get(o, key);
    *has = false;
    if (v && json_type_of(v) == JSON_NULL) return true;
    if (!r_i64(o, key, out)) return false;
    *has = true;
    return true;
}

static bool r_peer(const json_value *o, e2e_peer *p) {
    memset(p, 0, sizeof(*p));
    if (!r_str(o, "key", &p->key) || !r_str_or_null(o, "pin", &p->pin) ||
        !r_bool(o, "keys_awaited", &p->keys_awaited) ||
        !r_opt_i64(o, "keyreq_sent_at", &p->has_keyreq_at, &p->keyreq_sent_at) ||
        !r_opt_i64(o, "rekey_at", &p->has_rekey_at, &p->rekey_at) ||
        !r_str_or_null(o, "listreq_held", &p->listreq_held))
        return false;
    const json_value *outq = r_arr(o, "outq");
    if (!outq) return false;
    for (size_t i = 0; i < json_len(outq); i++) {
        p->outq = xrealloc(p->outq, (p->noutq + 1) * sizeof(*p->outq));
        bool ok = r_queued(json_at(outq, i), &p->outq[p->noutq]);
        p->noutq++;
        if (!ok) return false;
    }
    const json_value *lr = json_get(o, "listreq");
    if (!lr) return false;
    if (json_type_of(lr) != JSON_NULL) {
        const json_value *lv = r_arr(lr, "lv");
        if (!lv || !r_i64(lr, "at", &p->listreq_at)) return false;
        p->has_listreq = true;
        for (size_t i = 0; i < json_len(lv); i++) {
            double d;
            if (!json_number(json_at(lv, i), &d) || !e2e_valid_ver(d)) return false;
            p->listreq_lv = xrealloc(p->listreq_lv, (p->nlistreq_lv + 1) * sizeof(long));
            p->listreq_lv[p->nlistreq_lv++] = (long)d;
        }
    }
    const json_value *ka = json_get(o, "keys_asked");
    if (!ka) return false;
    if (json_type_of(ka) != JSON_NULL) {
        if (!r_str(ka, "nick", &p->keys_asked_nick) || !r_i64(ka, "at", &p->keys_asked_at))
            return false;
    }
    return true;
}

static bool r_sent(const json_value *o, e2e_sent *r) {
    memset(r, 0, sizeof(*r));
    int64_t ref;
    if (!r_i64(o, "ref", &ref) || !r_str_or_null(o, "msgid", &r->msgid) ||
        !r_str(o, "nick", &r->nick) || !r_str(o, "master", &r->master) ||
        !r_i64(o, "at", &r->at))
        return false;
    r->ref = (long)ref;
    const json_value *devs = r_arr(o, "devices");
    if (!devs) return false;
    for (size_t i = 0; i < json_len(devs); i++) {
        const json_value *d = json_at(devs, i);
        r->devices = xrealloc(r->devices, (r->ndevices + 1) * sizeof(*r->devices));
        e2e_sent_device *sd = &r->devices[r->ndevices++];
        memset(sd, 0, sizeof(*sd));
        if (!r_str(d, "did", &sd->did) || !r_str(d, "ed25519", &sd->ed25519) ||
            !r_str(d, "session_id", &sd->session_id))
            return false;
    }
    return r_outgoing(o, &r->msg);
}

/* Grows `*arr` by one zeroed element of `size` bytes; the new one. */
static void *grow(void **arr, size_t *n, size_t size) {
    *arr = xrealloc(*arr, (*n + 1) * size);
    char *item = (char *)*arr + *n * size;
    memset(item, 0, size);
    (*n)++;
    return item;
}

static bool sas_phase_parse(const char *s, e2e_sas_phase *out) {
    for (int p = E2E_SAS_STARTED; p <= E2E_SAS_COMPARE; p++)
        if (streq(s, e2e_sas_phase_name((e2e_sas_phase)p))) {
            *out = (e2e_sas_phase)p;
            return true;
        }
    return false;
}

static bool r_sas(const json_value *o, e2e_sas *r) {
    const char *role = str_field(o, "role");
    if (!streq(role, "a") && !streq(role, "b")) return false;
    r->role_a = streq(role, "a");
    return r_str(o, "master", &r->master) && r_str(o, "tx", &r->tx) &&
           r_str(o, "nick", &r->nick) && sas_phase_parse(str_field(o, "phase"), &r->phase) && r_i64(o, "at", &r->at) &&
           r_str_or_null(o, "device", &r->device) && r_bool(o, "held", &r->held) &&
           r_str_or_null(o, "our_key", &r->our_key) &&
           r_str_or_null(o, "their_key", &r->their_key) &&
           r_str_or_null(o, "commitment", &r->commitment) &&
           r_str_or_null(o, "expected", &r->expected) &&
           r_str_or_null(o, "expected_mmac", &r->expected_mmac) &&
           r_str_or_null(o, "their_mac", &r->their_mac) &&
           r_str_or_null(o, "their_mmac", &r->their_mmac);
}

static bool r_state(const json_value *o, e2e_state *s) {
    double v;
    if (!o || !number_field(o, "v", &v) || v != 2) return false;
    const json_value *a;
    if (!(a = r_arr(o, "masters"))) return false;
    for (size_t i = 0; i < json_len(a); i++)
        if (!r_master(json_at(a, i), grow((void **)&s->masters, &s->nmasters, sizeof(e2e_master))))
            return false;
    if (!(a = r_arr(o, "devices"))) return false;
    for (size_t i = 0; i < json_len(a); i++)
        if (!r_device(json_at(a, i), grow((void **)&s->devices, &s->ndevices, sizeof(e2e_device))))
            return false;
    if (!(a = r_arr(o, "peers"))) return false;
    for (size_t i = 0; i < json_len(a); i++)
        if (!r_peer(json_at(a, i), grow((void **)&s->peers, &s->npeers, sizeof(e2e_peer))))
            return false;
    if (!(a = r_arr(o, "sessions"))) return false;
    for (size_t i = 0; i < json_len(a); i++) {
        e2e_session_set *set = grow((void **)&s->sessions, &s->nsessions, sizeof(*set));
        if (!r_str(json_at(a, i), "curve", &set->curve) ||
            !r_strv(json_at(a, i), "pickles", &set->pickles))
            return false;
    }
    if (!r_strv(o, "seen", &s->seen) || !r_strv(o, "rekeying", &s->rekeying)) return false;
    if (!(a = r_arr(o, "list_answered_at"))) return false;
    for (size_t i = 0; i < json_len(a); i++) {
        e2e_answered *an = grow((void **)&s->answered, &s->nanswered, sizeof(*an));
        if (!r_str(json_at(a, i), "key", &an->key) || !r_i64(json_at(a, i), "at", &an->at))
            return false;
    }
    if (!(a = r_arr(o, "sent"))) return false;
    for (size_t i = 0; i < json_len(a); i++)
        if (!r_sent(json_at(a, i), grow((void **)&s->sent, &s->nsent, sizeof(e2e_sent))))
            return false;
    int64_t next_ref, inbox;
    if (!r_i64(o, "next_ref", &next_ref) || !r_i64(o, "inbox", &inbox)) return false;
    s->next_ref = (long)next_ref;
    s->inbox = (long)inbox;
    if (!(a = r_arr(o, "siblings"))) return false;
    for (size_t i = 0; i < json_len(a); i++) {
        e2e_sibling *sb = grow((void **)&s->siblings, &s->nsiblings, sizeof(*sb));
        const json_value *e = json_at(a, i);
        if (!r_str(e, "ed25519", &sb->ed25519) || !r_str(e, "did", &sb->did) ||
            !r_str(e, "curve25519", &sb->curve25519))
            return false;
    }
    if (!(a = r_arr(o, "copyq"))) return false;
    for (size_t i = 0; i < json_len(a); i++) {
        e2e_copy_queue *q = grow((void **)&s->copyq, &s->ncopyq, sizeof(*q));
        const json_value *e = json_at(a, i);
        const json_value *copies = r_arr(e, "copies");
        if (!r_str(e, "ed25519", &q->ed25519) || !copies) return false;
        for (size_t k = 0; k < json_len(copies); k++) {
            e2e_waiting_copy *c = grow((void **)&q->copies, &q->ncopies, sizeof(*c));
            const json_value *ce = json_at(copies, k);
            const json_value *body = json_get(ce, "body");
            if (!r_str(ce, "peer", &c->peer) || json_type_of(body) != JSON_STRING ||
                !r_i64(ce, "at", &c->at))
                return false;
            c->body = xstrndup(json_string(body), json_string_len(body));
            c->body_len = json_string_len(body);
        }
    }
    /* `sas` came with slice F: a record written before it has none. */
    if (!json_get(o, "sas")) return true;
    if (!(a = r_arr(o, "sas"))) return false;
    for (size_t i = 0; i < json_len(a); i++)
        if (!r_sas(json_at(a, i), grow((void **)&s->sas, &s->nsas, sizeof(e2e_sas)))) return false;
    return true;
}

static bool r_own(const json_value *o, e2e_own *own) {
    memset(own, 0, sizeof(*own));
    const json_value *list = obj_field(o, "list");
    return list && r_str(o, "master", &own->master) && r_str(o, "cert", &own->cert) &&
           r_long(o, "cert_ver", &own->cert_ver) && own->cert_ver >= 1 &&
           r_long(list, "ver", &own->list_ver) && r_strv(list, "devices", &own->list_devices) &&
           r_str(list, "sig", &own->list_sig) && r_str(o, "did", &own->did);
}

bool e2e_record_from_json(const char *json, size_t len, e2e_record *out) {
    json_doc *d = decode_object(json, len);
    if (!d) return false;
    const json_value *root = json_root(d);
    e2e_record r = {0};
    e2e_state_init(&r.state);
    double v;
    bool ok = number_field(root, "v", &v) && v == RECORD_VERSION;
    const char *account = ok ? str_field(root, "account") : NULL;
    if (account) r.account = vz_account_from_pickle(account);
    ok = ok && r.account;
    const json_value *master = json_get(root, "master");
    if (ok && json_type_of(master) == JSON_STRING) {
        r.master = vz_account_from_pickle(json_string(master));
        ok = r.master != NULL;
    } else if (ok) {
        ok = master && json_type_of(master) == JSON_NULL;
    }
    const json_value *own = json_get(root, "own");
    if (ok && json_type_of(own) == JSON_OBJECT) {
        r.own = xmalloc(sizeof(*r.own));
        ok = r_own(own, r.own);
    } else if (ok) {
        ok = own && json_type_of(own) == JSON_NULL;
    }
    ok = ok && r_state(obj_field(root, "state"), &r.state);
    /* Optional: a record written before the encrypted mode had none. */
    if (ok && json_get(root, "encrypted")) ok = r_strv(root, "encrypted", &r.encrypted);
    json_free(d);
    if (!ok) {
        e2e_record_free(&r);
        return false;
    }
    *out = r;
    return true;
}

/* ── Store ───────────────────────────────────────────────────────────── */

struct e2e_store {
    char *dir;
    int lock_fd;
};

/* `dir` and each missing parent, 0700. */
static bool mkdir_p(const char *dir) {
    char *path = xstrdup(dir);
    bool ok = true;
    for (char *p = path + 1; ok; p++) {
        if (*p != '/' && *p != 0) continue;
        char saved = *p;
        *p = 0;
        if (mkdir(path, 0700) != 0 && errno != EEXIST) ok = false;
        *p = saved;
        if (!saved) break;
    }
    if (ok) {
        struct stat stbuf;
        ok = stat(path, &stbuf) == 0 && S_ISDIR(stbuf.st_mode) && chmod(path, 0700) == 0;
    }
    free(path);
    return ok;
}

e2e_store_status e2e_store_open(const char *dir, e2e_store **out, char *err, size_t err_sz) {
    *out = NULL;
    if (!dir || !dir[0] || !mkdir_p(dir)) {
        SETERR("cannot make %s: %s", dir ? dir : "(null)", strerror(errno));
        return E2E_STORE_ERROR;
    }
    char *lock = xprintf("%s/lock", dir);
    int fd = open(lock, O_RDWR | O_CREAT | O_CLOEXEC, 0600);
    free(lock);
    if (fd < 0) {
        SETERR("cannot open the lock in %s: %s", dir, strerror(errno));
        return E2E_STORE_ERROR;
    }
    if (flock(fd, LOCK_EX | LOCK_NB) != 0) {
        int e = errno;
        close(fd);
        if (e == EWOULDBLOCK) {
            SETERR("%s is in use by another shottino", dir);
            return E2E_STORE_BUSY;
        }
        SETERR("cannot lock %s: %s", dir, strerror(e));
        return E2E_STORE_ERROR;
    }
    e2e_store *st = xmalloc(sizeof(*st));
    st->dir = xstrdup(dir);
    st->lock_fd = fd;
    *out = st;
    return E2E_STORE_OK;
}

void e2e_store_close(e2e_store *st) {
    if (!st) return;
    close(st->lock_fd); /* releases the flock */
    free(st->dir);
    free(st);
}

e2e_load_status e2e_store_load(e2e_store *st, e2e_record *out, char *err, size_t err_sz) {
    char *path = xprintf("%s/record.json", st->dir);
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    if (fd < 0) {
        int e = errno;
        SETERR("%s: %s", path, strerror(e));
        free(path);
        return e == ENOENT ? E2E_LOAD_NONE : E2E_LOAD_ERROR;
    }
    size_t len = 0, cap = 4096;
    char *buf = xmalloc(cap);
    for (;;) {
        if (len == cap) buf = xrealloc(buf, cap *= 2);
        ssize_t n = read(fd, buf + len, cap - len);
        if (n < 0 && errno == EINTR) continue;
        if (n < 0) {
            SETERR("%s: %s", path, strerror(errno));
            close(fd);
            free(buf);
            free(path);
            return E2E_LOAD_ERROR;
        }
        if (n == 0) break;
        len += (size_t)n;
    }
    close(fd);
    bool ok = e2e_record_from_json(buf, len, out);
    free(buf);
    if (!ok) SETERR("%s is not a record", path);
    free(path);
    return ok ? E2E_LOAD_OK : E2E_LOAD_CORRUPT;
}

static bool write_all(int fd, const char *p, size_t n) {
    while (n > 0) {
        ssize_t w = write(fd, p, n);
        if (w < 0 && errno == EINTR) continue;
        if (w <= 0) return false;
        p += w;
        n -= (size_t)w;
    }
    return true;
}

bool e2e_store_save(e2e_store *st, const e2e_record *r, char *err, size_t err_sz) {
    char *json = e2e_record_to_json(r);
    char *path = xprintf("%s/record.json", st->dir);
    char *tmp = xprintf("%s/record.json.tmp.%ld", st->dir, (long)getpid());
    bool ok = false;
    int fd = open(tmp, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
    if (fd >= 0) {
        ok = fchmod(fd, 0600) == 0 && write_all(fd, json, strlen(json)) && fsync(fd) == 0;
        ok = close(fd) == 0 && ok;
        if (ok) ok = rename(tmp, path) == 0;
        if (!ok) {
            SETERR("cannot write %s: %s", path, strerror(errno));
            unlink(tmp);
        }
    } else {
        SETERR("cannot create %s: %s", tmp, strerror(errno));
    }
    if (ok) {
        /* The rename is durable only once the directory is. */
        int dfd = open(st->dir, O_RDONLY | O_CLOEXEC);
        if (dfd >= 0) {
            fsync(dfd);
            close(dfd);
        }
    }
    free(json);
    free(path);
    free(tmp);
    return ok;
}

/* ── Results ─────────────────────────────────────────────────────────── */

void e2e_result_init(e2e_result *r) { memset(r, 0, sizeof(*r)); }

static void event_free(e2e_event *e) {
    free(e->nick);
    free(e->master);
    free(e->device);
    free(e->inner);
    free(e->pinned);
    free(e->presented);
    free(e->msgid);
    free(e->session_id);
    free(e->detail);
    free(e->tag);
    strv_free(&e->tags);
    free(e->did);
    free(e->peer);
    free(e->body);
}

void e2e_result_free(e2e_result *r) {
    for (size_t i = 0; i < r->nevents; i++) event_free(&r->events[i]);
    free(r->events);
    for (size_t i = 0; i < r->noutbound; i++) {
        e2e_outbound *o = &r->outbound[i];
        free(o->target);
        free(o->from);
        free(o->to);
        free(o->payload);
        free(o->tag);
    }
    free(r->outbound);
    for (size_t i = 0; i < r->ncopies; i++) {
        free(r->copies[i].to);
        free(r->copies[i].payload);
    }
    free(r->copies);
    e2e_result_init(r);
}

char *e2e_outbound_body(const e2e_outbound *o) {
    json_buf b;
    jb_init(&b);
    jb_obj_open(&b);
    jb_key(&b, "target");
    jb_str(&b, o->target);
    jb_key(&b, "verb");
    jb_str(&b, e2e_verb_name(o->verb));
    jb_key(&b, "from");
    jb_str(&b, o->from);
    jb_key(&b, "to");
    jb_str(&b, o->to);
    jb_key(&b, "payload");
    jb_str(&b, o->payload);
    jb_key(&b, "priority");
    jb_str(&b, e2e_priority_name(o->priority));
    if (o->expires_at > 0) {
        jb_key(&b, "expires_at");
        jb_num(&b, (double)o->expires_at);
    }
    jb_obj_close(&b);
    return take(&b);
}

char *e2e_copy_body(const e2e_sibling_copy *c, const char *from_did) {
    json_buf b;
    jb_init(&b);
    jb_obj_open(&b);
    jb_key(&b, "from_did");
    jb_str(&b, from_did);
    jb_key(&b, "verb");
    jb_str(&b, e2e_verb_name(c->verb));
    jb_key(&b, "payload");
    jb_str(&b, c->payload);
    jb_obj_close(&b);
    return take(&b);
}

/* ── Engine ──────────────────────────────────────────────────────────── */

/* A message a step could not send, judged once the step is done (`end`). */
typedef struct {
    char *nick;
    e2e_send_failure reason;
    long msg_id;
    char *tag;
} loss;

/* One public call: the context, the state it changes, the result it
 * fills, and what it found it could not send. */
typedef struct {
    const e2e_ctx *c;
    e2e_state *st;
    const e2e_own *own;
    vz_account *account;
    e2e_result *res;
    char *own_e; /* this device's Ed25519 key */
    char *own_k; /* this device's Curve25519 key */
    loss *losses;
    size_t nlosses;
} step;

static void step_begin(step *s, const e2e_ctx *c, e2e_result *res) {
    memset(s, 0, sizeof(*s));
    s->c = c;
    s->st = &c->record->state;
    s->own = c->record->own;
    s->account = c->record->account;
    s->res = res;
    s->own_e = vzs(vz_account_ed25519_key(s->account));
    s->own_k = vzs(vz_account_curve25519_key(s->account));
    if (!s->own_e || !s->own_k || !s->own) abort();
}

static int64_t now_of(const step *s) { return s->c->now_ms; }

static e2e_event *ev(step *s, e2e_event_kind kind, const char *nick) {
    e2e_event *e = grow((void **)&s->res->events, &s->res->nevents, sizeof(*e));
    e->kind = kind;
    e->nick = opt_dup(nick);
    return e;
}

static void dropped(step *s, const char *nick, e2e_drop_reason reason, e2e_verb verb,
                    const char *detail) {
    e2e_event *e = ev(s, E2E_EV_DROPPED, nick);
    e->drop = reason;
    e->verb = verb;
    e->detail = opt_dup(detail);
}

static void outbound(step *s, const char *target, e2e_verb verb, const char *to, char *payload,
                     e2e_priority priority, long ref, const char *tag, int64_t expires_at) {
    e2e_outbound *o = grow((void **)&s->res->outbound, &s->res->noutbound, sizeof(*o));
    o->target = xstrdup(target);
    o->verb = verb;
    o->from = xstrdup(s->own->did);
    o->to = xstrdup(to);
    o->payload = payload;
    o->priority = priority;
    o->ref = ref;
    o->tag = opt_dup(tag);
    o->expires_at = expires_at;
}

static bool sig_ok(const char *ed25519, const char *text, const char *sig) {
    return vz_verify_ed25519(ed25519, text, sig) == 1;
}

static bool id_signed(const e2e_id_block *id, const char *master) {
    char *text = e2e_id_sig_text(id->curve25519, master);
    bool ok = sig_ok(id->ed25519, text, id->sig);
    free(text);
    return ok;
}

static bool otk_signed(const e2e_keys_entry *e) {
    char *text = e2e_otk_sig_text(e->otk_key);
    bool ok = sig_ok(e->id.ed25519, text, e->otk_sig);
    free(text);
    return ok;
}

static bool canonical_id(const e2e_id_block *id) {
    return e2e_ed25519_canonical(id->ed25519) && e2e_curve25519_canonical(id->curve25519);
}

static char *session_id_of(const char *pickle) {
    vz_session *ss = vz_session_from_pickle(pickle);
    if (!ss) return NULL;
    char *id = vzs(vz_session_id(ss));
    vz_session_free(ss);
    return id;
}

static void drop_session(step *s, const char *curve, const char *session_id) {
    e2e_session_set *set = sessions_get(s->st, curve);
    if (!set) return;
    for (size_t i = 0; i < set->pickles.n;) {
        char *id = session_id_of(set->pickles.v[i]);
        if (id && strcmp(id, session_id) == 0) strv_remove_at(&set->pickles, i);
        else i++;
        free(id);
    }
    if (set->pickles.n == 0) sessions_delete(s->st, curve);
}

/* Every session of the device, and its re-key with them. */
static void drop_sessions(step *s, const char *ed25519, const char *curve) {
    sessions_delete(s->st, curve);
    strv_remove(&s->st->rekeying, ed25519);
}

/* ── trust (rules 1-6) ── */

/* -1 when `master` vouches for `ed25519` now; else why not (standing). */
static int standing(step *s, const char *master, const char *ed25519, long cert_ver) {
    e2e_master *m = master_get(s->st, master);
    if (!m) return E2E_DROP_UNLISTED_DEVICE; /* cic throws: no pin names it */
    if (strv_has(&m->devices, ed25519)) return -1;
    if (cert_ver > 0 && cert_ver > m->ver && !strv_has(&m->revoked, ed25519)) return -1;
    if (strv_has(&m->revoked, ed25519)) return E2E_DROP_REVOKED_DEVICE;
    return cert_ver == 0 ? E2E_DROP_UNLISTED_DEVICE : E2E_DROP_STALE_CERTIFICATE;
}

typedef struct {
    e2e_device **v;
    size_t n;
} devlist;

/* The devices bound under `master` it still vouches for. Pointers into the
 * state: good until a device is added or removed. */
static devlist trusted_devices(step *s, const char *master) {
    devlist out = {0};
    if (!master_get(s->st, master)) return out;
    for (size_t i = 0; i < s->st->ndevices; i++) {
        e2e_device *d = &s->st->devices[i];
        if (strcmp(d->master, master) == 0 && standing(s, master, d->ed25519, d->cert_ver) < 0) {
            out.v = xrealloc(out.v, (out.n + 1) * sizeof(*out.v));
            out.v[out.n++] = d;
        }
    }
    return out;
}

static e2e_device *trusted_by_curve(step *s, const char *master, const char *curve) {
    devlist t = trusted_devices(s, master);
    e2e_device *found = NULL;
    for (size_t i = 0; i < t.n && !found; i++)
        if (strcmp(t.v[i]->curve25519, curve) == 0) found = t.v[i];
    free(t.v);
    return found;
}

/* engine.ts curveRefusal. */
static int curve_refusal(step *s, const e2e_id_block *id, bool proving) {
    if (!canonical_id(id)) return E2E_DROP_NON_CANONICAL_KEY;
    if (strcmp(id->curve25519, s->own_k) == 0) return E2E_DROP_OWN_IDENTITY;
    for (size_t i = 0; i < s->st->nsiblings; i++)
        if (strcmp(s->st->siblings[i].curve25519, id->curve25519) == 0)
            return E2E_DROP_OWN_IDENTITY;
    e2e_device *known = device_get(s->st, id->ed25519);
    if (known && strcmp(known->curve25519, id->curve25519) != 0)
        return E2E_DROP_IDENTITY_CURVE_MISMATCH;
    e2e_device *owner = device_by_curve(s->st, id->curve25519);
    if (owner && strcmp(owner->ed25519, id->ed25519) != 0 && (owner->proven || !proving))
        return E2E_DROP_CURVE_ALREADY_BOUND;
    return -1;
}

/* engine.ts refusal: S1 over this master, then standing with no cert. */
static int refusal(step *s, const char *master, const e2e_id_block *id) {
    if (!id_signed(id, master)) return E2E_DROP_BAD_IDENTITY_SIGNATURE;
    return standing(s, master, id->ed25519, 0);
}

typedef enum { MASTER_OK, MASTER_ALARM } master_verdict;

/* engine.ts checkMaster: call only once the block's own signature held. */
static master_verdict check_master(step *s, const char *nick, const char *master) {
    if (strcmp(master, s->own->master) == 0) {
        dropped(s, nick, E2E_DROP_OWN_IDENTITY, E2E_VERB_NONE, NULL);
        return MASTER_ALARM;
    }
    const char *pinned = pin_of(s->st, nick);
    if (pinned && strcmp(pinned, master) == 0) return MASTER_OK;
    if (pinned) {
        e2e_event *e = ev(s, E2E_EV_KEY_ALARM, nick);
        e->pinned = xstrdup(pinned);
        e->presented = xstrdup(master);
        return MASTER_ALARM;
    }
    if (!master_get(s->st, master)) master_add(s->st, master, nick, false);
    e2e_peer *p = peer_get(s->st, nick, true);
    free(p->pin);
    p->pin = xstrdup(master);
    return MASTER_OK;
}

/* engine.ts applyList: rule 3 (a higher ver replaces) and rule 5. */
static void apply_list(step *s, const char *master, long ver, const char *const *devices,
                       size_t n) {
    e2e_master *m = master_get(s->st, master);
    if (!m || ver <= m->ver) return;
    e2e_strv next = {0}, leaving = {0}, back = {0};
    for (size_t i = 0; i < n; i++) strv_push(&next, devices[i]);
    for (size_t i = 0; i < m->devices.n; i++)
        if (!strv_has(&next, m->devices.v[i])) strv_push(&leaving, m->devices.v[i]);
    for (size_t i = 0; i < m->revoked.n; i++)
        if (strv_has(&next, m->revoked.v[i])) strv_push(&back, m->revoked.v[i]);
    for (size_t i = 0; i < back.n; i++) {
        strv_remove(&m->revoked, back.v[i]);
        e2e_device *d = device_get(s->st, back.v[i]);
        if (d && strcmp(d->master, master) == 0) strv_remove(&m->revoked_curves, d->curve25519);
    }
    for (size_t i = 0; i < leaving.n; i++) {
        strv_push(&m->revoked, leaving.v[i]);
        e2e_device *d = device_get(s->st, leaving.v[i]);
        if (d && strcmp(d->master, master) == 0) strv_push(&m->revoked_curves, d->curve25519);
    }
    m->ver = ver;
    strv_free(&m->devices);
    m->devices = next;
    strv_free(&leaving);
    strv_free(&back);
    for (size_t i = 0; i < s->st->ndevices; i++) {
        e2e_device *d = &s->st->devices[i];
        if (strcmp(d->master, master) == 0 && standing(s, master, d->ed25519, d->cert_ver) >= 0) {
            char *e = xstrdup(d->ed25519), *k = xstrdup(d->curve25519);
            drop_sessions(s, e, k);
            free(e);
            free(k);
        }
    }
}

/* Unbinds another device than `ed25519` bound to `curve`, with its sessions. */
static void evict_claimant(step *s, const char *curve, const char *ed25519) {
    e2e_device *c = device_by_curve(s->st, curve);
    if (!c || strcmp(c->ed25519, ed25519) == 0) return;
    char *e = xstrdup(c->ed25519), *k = xstrdup(c->curve25519);
    device_remove(s->st, e);
    drop_sessions(s, e, k);
    free(e);
    free(k);
}

static void bind_proven(step *s, const char *master, const e2e_id_block *id, long cert_ver) {
    evict_claimant(s, id->curve25519, id->ed25519);
    char did[E2E_DID_LEN + 1];
    e2e_did(id->ed25519, did);
    device_put(s->st, id->ed25519, id->curve25519, master, did, true, cert_ver);
}

/* ── losses and the end of a step ── */

static bool went_out(step *s, long id) {
    for (size_t i = 0; i < s->st->nsent; i++)
        if (s->st->sent[i].msg.id == id) return true;
    return false;
}

static bool pending(step *s, long id) {
    if (went_out(s, id)) return true;
    for (size_t i = 0; i < s->st->npeers; i++)
        for (size_t k = 0; k < s->st->peers[i].noutq; k++)
            if (s->st->peers[i].outq[k].msg.id == id) return true;
    return false;
}

static void lost(step *s, const char *nick, e2e_send_failure reason, const e2e_outgoing *msg) {
    for (size_t i = 0; i < s->nlosses; i++)
        if (s->losses[i].msg_id == msg->id) return;
    loss *l = grow((void **)&s->losses, &s->nlosses, sizeof(*l));
    l->nick = xstrdup(nick);
    l->reason = reason;
    l->msg_id = msg->id;
    l->tag = xstrdup(msg->tag);
}

static void failed(step *s, const char *nick, e2e_send_failure reason, const e2e_strv *tags) {
    e2e_strv theirs = {0};
    for (size_t i = 0; i < tags->n; i++)
        if (strcmp(tags->v[i], E2E_LIST_TAG) != 0) strv_push(&theirs, tags->v[i]);
    if (theirs.n == 0) return;
    e2e_event *e = ev(s, E2E_EV_SEND_FAILED, nick);
    e->failure = reason;
    e->tags = theirs;
}

static void failed1(step *s, const char *nick, e2e_send_failure reason, const char *tag) {
    e2e_strv tags = {0};
    strv_push(&tags, tag);
    failed(s, nick, reason, &tags);
    strv_free(&tags);
}

/* engine.ts trimSent: older than SENT_MEMORY_MS, then the oldest past
 * SENT_MAX, keeping any whose message still waits for keys. */
static void trim_sent(step *s) {
    int64_t cutoff = now_of(s) - E2E_SENT_MEMORY_MS;
    bool *waiting = xmalloc(s->st->nsent * sizeof(bool));
    for (size_t i = 0; i < s->st->nsent; i++) {
        waiting[i] = false;
        for (size_t p = 0; p < s->st->npeers && !waiting[i]; p++)
            for (size_t k = 0; k < s->st->peers[p].noutq; k++)
                if (s->st->peers[p].outq[k].msg.id == s->st->sent[i].msg.id) waiting[i] = true;
    }
    size_t w = 0;
    bool *keep_waiting = xmalloc(s->st->nsent * sizeof(bool));
    for (size_t i = 0; i < s->st->nsent; i++) {
        if (s->st->sent[i].at >= cutoff || waiting[i]) {
            keep_waiting[w] = waiting[i];
            s->st->sent[w++] = s->st->sent[i];
        } else {
            sent_free(&s->st->sent[i]);
        }
    }
    s->st->nsent = w;
    long excess = (long)w - E2E_SENT_MAX;
    size_t out = 0;
    for (size_t i = 0; i < w; i++) {
        if (excess > 0 && !keep_waiting[i]) {
            sent_free(&s->st->sent[i]);
            excess--;
        } else {
            s->st->sent[out++] = s->st->sent[i];
        }
    }
    s->st->nsent = out;
    free(waiting);
    free(keep_waiting);
}

/* engine.ts end: one send_failed per (reason, nick) for every message
 * noted lost of which nothing is pending; then old plaintexts go. */
static void step_end(step *s) {
    bool *done = xmalloc(s->nlosses * sizeof(bool));
    for (size_t i = 0; i < s->nlosses; i++) done[i] = pending(s, s->losses[i].msg_id);
    for (size_t i = 0; i < s->nlosses; i++) {
        if (done[i]) continue;
        e2e_strv tags = {0};
        for (size_t k = i; k < s->nlosses; k++) {
            if (done[k] || s->losses[k].reason != s->losses[i].reason ||
                strcmp(s->losses[k].nick, s->losses[i].nick) != 0)
                continue;
            strv_push(&tags, s->losses[k].tag);
            done[k] = true;
        }
        failed(s, s->losses[i].nick, s->losses[i].reason, &tags);
        strv_free(&tags);
    }
    free(done);
    trim_sent(s);
    for (size_t i = 0; i < s->nlosses; i++) {
        free(s->losses[i].nick);
        free(s->losses[i].tag);
    }
    free(s->losses);
    free(s->own_e);
    free(s->own_k);
    s->losses = NULL;
    s->nlosses = 0;
}

/* Frees what step_begin took when a step ends without `end` (cic returns
 * the result unended when the payload did not decode). */
static void step_abandon(step *s) {
    free(s->own_e);
    free(s->own_k);
    for (size_t i = 0; i < s->nlosses; i++) {
        free(s->losses[i].nick);
        free(s->losses[i].tag);
    }
    free(s->losses);
}

/* ── sending ── */

/* The lane an inner message takes. */
static e2e_priority priority_of(const char *t) {
    if (!t) return E2E_PRIO_TEXT;
    if (strcmp(t, "chal") == 0 || strcmp(t, "ack") == 0) return E2E_PRIO_CONTROL;
    if (strcmp(t, "list") == 0 || strcmp(t, "listreq") == 0) return E2E_PRIO_REACTIVE;
    return E2E_PRIO_TEXT;
}

static bool working(step *s, const e2e_device *d) {
    return !strv_has(&s->st->rekeying, d->ed25519) && sessions_count(s->st, d->curve25519) > 0;
}

static bool list_held(step *s, const char *master) {
    e2e_master *m = master_get(s->st, master);
    return m && m->ver > 0;
}

/* engine.ts split: `ready` the trusted devices with a working session
 * (still due), `lacking` the rest of what the master vouches for. */
static void split(step *s, const char *master, const char *only, const e2e_strv *done,
                  devlist *ready, e2e_strv *lacking) {
    *ready = (devlist){0};
    *lacking = (e2e_strv){0};
    devlist trusted = trusted_devices(s, master);
#define DUE(key) ((!only || strcmp((key), only) == 0) && !strv_has(done, (key)))
    for (size_t i = 0; i < trusted.n; i++) {
        if (DUE(trusted.v[i]->ed25519) && working(s, trusted.v[i])) {
            ready->v = xrealloc(ready->v, (ready->n + 1) * sizeof(*ready->v));
            ready->v[ready->n++] = trusted.v[i];
        }
    }
    e2e_strv wanted = {0};
    e2e_master *m = master_get(s->st, master);
    for (size_t i = 0; m && i < m->devices.n; i++)
        if (!strv_has(&wanted, m->devices.v[i])) strv_push(&wanted, m->devices.v[i]);
    for (size_t i = 0; i < trusted.n; i++)
        if (!strv_has(&wanted, trusted.v[i]->ed25519)) strv_push(&wanted, trusted.v[i]->ed25519);
    for (size_t i = 0; i < wanted.n; i++) {
        if (!DUE(wanted.v[i])) continue;
        bool is_ready = false;
        for (size_t k = 0; k < ready->n; k++)
            if (strcmp(ready->v[k]->ed25519, wanted.v[i]) == 0) is_ready = true;
        if (!is_ready) strv_push(lacking, wanted.v[i]);
    }
#undef DUE
    strv_free(&wanted);
    free(trusted.v);
}

/* A body encrypted on a device's newest session, advanced in memory only. */
typedef struct {
    vz_session *session;
    bool pre_key;
    char *body;
} encrypted;

/* engine.ts withBinding: our own compact object, `fb` appended. */
static char *with_binding(const char *plaintext, const char *binding) {
    size_t n = strlen(plaintext);
    if (n < 2 || plaintext[n - 1] != '}') abort(); /* ours: always an object */
    bool empty = n == 2;
    return xprintf("%.*s%s\"fb\":\"%s\"}", (int)(n - 1), plaintext, empty ? "" : ",", binding);
}

/* engine.ts encryptOn; false when vodozemac refuses OUR stored state. */
static bool encrypt_on(step *s, const char *curve, const char *ed25519, const char *plaintext,
                       encrypted *out) {
    memset(out, 0, sizeof(*out));
    e2e_session_set *set = sessions_get(s->st, curve);
    if (!set || set->pickles.n == 0) return false;
    vz_session *ss = vz_session_from_pickle(set->pickles.v[0]);
    if (!ss) return false;
    int received = vz_session_has_received_message(ss);
    if (received < 0) {
        vz_session_free(ss);
        return false;
    }
    bool pre_key = received == 0;
    char *inner;
    if (pre_key) {
        char binding[E2E_FB_LEN + 1];
        e2e_fb(s->own_e, ed25519, binding);
        inner = with_binding(plaintext, binding);
    } else {
        inner = xstrdup(plaintext);
    }
    size_t type = 9;
    vz_buf body;
    int rc = vz_session_encrypt(ss, (const uint8_t *)inner, strlen(inner), &type, &body);
    free(inner);
    if (rc != 0) {
        vz_session_free(ss);
        return false;
    }
    out->body = e2e_base64(body.ptr, body.len);
    vz_buf_free(body);
    if ((type == 0) != pre_key) {
        free(out->body);
        vz_session_free(ss);
        out->body = NULL;
        return false;
    }
    out->session = ss;
    out->pre_key = pre_key;
    return true;
}

/* engine.ts wireOf: a PKMSG presenting our certificate, or a MSG. */
static char *wire_of(step *s, bool pre_key, const e2e_body *bodies, size_t n, e2e_verb *verb) {
    if (!pre_key) {
        *verb = E2E_VERB_MSG;
        return e2e_msg_payload(s->own_k, bodies, n);
    }
    *verb = E2E_VERB_PKMSG;
    char *p = e2e_pkmsg_payload(s->account, s->own->master, s->own->cert, s->own->cert_ver,
                                bodies, n);
    if (!p) abort();
    return p;
}

typedef struct {
    e2e_verb verb;
    char *to;
    char *payload;
    size_t first, count; /* the bodies (indices into the sorted set) it holds */
} grouped;

typedef enum { ENC_OK = -1 } enc_ok;

/* engine.ts encrypt: one body per device, MSG bodies first then PKMSG,
 * never both kinds in one message, <= 4 bodies a message, a group too long
 * for grappa sent one per body. Nothing is stored unless all fit. Answers
 * ENC_OK or the failure. */
static int encrypt_to(step *s, const char *nick, const char *master, const devlist *devices,
                      const e2e_outgoing *msg) {
    long budget = e2e_line_budget(s->c->frame_budget_base, nick);
    if (budget < 0) return E2E_FAIL_NO_BUDGET;
    size_t n = devices->n;
    encrypted *enc = xmalloc(n * sizeof(*enc));
    e2e_device **order = xmalloc(n * sizeof(*order));
    size_t made = 0;
    int verdict = ENC_OK;
    for (size_t i = 0; i < n; i++) {
        if (!encrypt_on(s, devices->v[i]->curve25519, devices->v[i]->ed25519, msg->plaintext,
                        &enc[made])) {
            verdict = E2E_FAIL_INTERNAL;
            break;
        }
        made++;
    }
    /* Sorted: the MSG bodies first, then the pre-key ones, each in order. */
    encrypted *sorted = xmalloc(n * sizeof(*sorted));
    size_t ns = 0;
    for (int kind = 0; kind < 2 && verdict == ENC_OK; kind++)
        for (size_t i = 0; i < n; i++)
            if (enc[i].pre_key == (kind == 1)) {
                sorted[ns] = enc[i];
                order[ns++] = devices->v[i];
            }
    grouped *msgs = NULL;
    size_t nmsgs = 0;
    for (size_t at = 0; at < ns && verdict == ENC_OK;) {
        size_t end = at;
        while (end < ns && sorted[end].pre_key == sorted[at].pre_key && end - at < E2E_MAX_DEVICES)
            end++;
        size_t count = end - at;
        bool together = false;
        if (count > 1) {
            e2e_body bodies[E2E_MAX_DEVICES];
            for (size_t k = 0; k < count; k++) {
                bodies[k].did = order[at + k]->did;
                bodies[k].body = sorted[at + k].body;
            }
            e2e_verb verb;
            char *payload = wire_of(s, sorted[at].pre_key, bodies, count, &verb);
            if (e2e_lines_needed(verb, payload, budget, s->own->did, "*") <= E2E_MAX_FRAGMENTS) {
                grouped *g = grow((void **)&msgs, &nmsgs, sizeof(*g));
                *g = (grouped){verb, xstrdup("*"), payload, at, count};
                together = true;
            } else {
                free(payload);
            }
        }
        for (size_t k = 0; !together && k < count; k++) {
            e2e_body one = {order[at + k]->did, sorted[at + k].body};
            e2e_verb verb;
            char *payload = wire_of(s, sorted[at + k].pre_key, &one, 1, &verb);
            grouped *g = grow((void **)&msgs, &nmsgs, sizeof(*g));
            *g = (grouped){verb, xstrdup(one.did), payload, at + k, 1};
            if (e2e_lines_needed(verb, payload, budget, s->own->did, one.did) > E2E_MAX_FRAGMENTS)
                verdict = E2E_FAIL_TOO_LONG;
        }
        at = end;
    }
    if (verdict == ENC_OK) {
        for (size_t i = 0; i < ns; i++) {
            char *pickle = vzs(vz_session_pickle(sorted[i].session));
            e2e_session_set *set = sessions_get(s->st, order[i]->curve25519);
            if (!pickle || !set) abort();
            free(set->pickles.v[0]);
            set->pickles.v[0] = pickle;
        }
        for (size_t m = 0; m < nmsgs; m++) {
            grouped *g = &msgs[m];
            long ref = s->st->next_ref++;
            e2e_sent *r = grow((void **)&s->st->sent, &s->st->nsent, sizeof(*r));
            r->ref = ref;
            r->nick = xstrdup(nick);
            r->master = xstrdup(master);
            r->msg = outgoing_dup(msg);
            r->at = now_of(s);
            for (size_t k = 0; k < g->count; k++) {
                e2e_sent_device *d = grow((void **)&r->devices, &r->ndevices, sizeof(*d));
                d->did = xstrdup(order[g->first + k]->did);
                d->ed25519 = xstrdup(order[g->first + k]->ed25519);
                d->session_id = vzs(vz_session_id(sorted[g->first + k].session));
                if (!d->session_id) abort();
            }
            outbound(s, nick, g->verb, g->to, g->payload, msg->priority, ref, msg->tag,
                     msg->expires_at);
            g->payload = NULL;
        }
    }
    for (size_t m = 0; m < nmsgs; m++) {
        free(msgs[m].to);
        free(msgs[m].payload);
    }
    free(msgs);
    for (size_t i = 0; i < made; i++) {
        vz_session_free(enc[i].session);
        free(enc[i].body);
    }
    free(enc);
    free(sorted);
    free(order);
    return verdict;
}

static bool dispatch(step *s, const char *nick, const char *inner_json, const char *tag,
                     int64_t expires_at, const char *only, const char *except);

/* engine.ts maybeKeyreq: at most one per nick per KEYREQ_RETRY_MS. */
static void maybe_keyreq(step *s, const char *nick) {
    e2e_peer *p = peer_get(s->st, nick, true);
    if (p->has_keyreq_at && now_of(s) - p->keyreq_sent_at < E2E_KEYREQ_RETRY_MS) return;
    p->has_keyreq_at = true;
    p->keyreq_sent_at = now_of(s);
    p->keys_awaited = true;
    outbound(s, nick, E2E_VERB_KEYREQ, "*", e2e_keyreq_payload(), E2E_PRIO_CONTROL, 0, NULL, 0);
}

/* engine.ts liveQueue: what waited past OUTQ_TTL_MS goes (lost). The peer
 * keeps the live entries. */
static e2e_peer *live_queue(step *s, const char *nick) {
    e2e_peer *p = peer_get(s->st, nick, true);
    size_t w = 0;
    char *first_nick = p->noutq ? xstrdup(p->outq[0].nick) : NULL;
    for (size_t i = 0; i < p->noutq; i++) {
        if (p->outq[i].at > now_of(s) - E2E_OUTQ_TTL_MS) {
            p->outq[w++] = p->outq[i];
        } else {
            lost(s, first_nick, E2E_FAIL_KEYS_TIMEOUT, &p->outq[i].msg);
            queued_free(&p->outq[i]);
        }
    }
    p->noutq = w;
    if (w == 0) {
        free(p->outq);
        p->outq = NULL;
    }
    free(first_nick);
    return p;
}

/* engine.ts enqueue. `done` is taken over. */
static bool enqueue(step *s, const char *nick, const char *master, const char *only,
                    const char *except, e2e_strv *done, const e2e_outgoing *msg) {
    e2e_peer *p = live_queue(s, nick);
    if (p->noutq >= E2E_OUTQ_MAX) {
        lost(s, nick, E2E_FAIL_QUEUE_FULL, msg);
        strv_free(done);
        return false;
    }
    e2e_queued *q = grow((void **)&p->outq, &p->noutq, sizeof(*q));
    q->nick = xstrdup(nick);
    q->master = xstrdup(master);
    q->only = opt_dup(only);
    q->except = opt_dup(except);
    q->done = *done;
    *done = (e2e_strv){0};
    q->msg = outgoing_dup(msg);
    q->at = now_of(s);
    size_t queued = p->noutq;
    if (strcmp(msg->tag, E2E_LIST_TAG) != 0 && !went_out(s, msg->id)) {
        e2e_event *e = ev(s, E2E_EV_SEND_QUEUED, nick);
        e->queued = (long)queued;
        e->tag = xstrdup(msg->tag);
    }
    maybe_keyreq(s, nick);
    return true;
}

/* engine.ts sendTo. */
static bool send_to(step *s, const char *nick, const char *master, const char *only,
                    const char *except, const e2e_outgoing *msg) {
    e2e_strv done = {0};
    if (except) strv_push(&done, except);
    devlist ready;
    e2e_strv lacking;
    split(s, master, only, &done, &ready, &lacking);
    int refused = ready.n > 0 ? encrypt_to(s, nick, master, &ready, msg) : ENC_OK;
    bool ok;
    if (refused != ENC_OK) {
        lost(s, nick, (e2e_send_failure)refused, msg);
        ok = false;
    } else {
        for (size_t i = 0; i < ready.n; i++) strv_push(&done, ready.v[i]->ed25519);
        size_t nready = ready.n;
        if (lacking.n > 0 || (!list_held(s, master) && (!only || nready == 0))) {
            ok = enqueue(s, nick, master, only, except, &done, msg) || nready > 0;
        } else if (nready > 0 || except) {
            ok = true;
        } else {
            lost(s, nick, E2E_FAIL_UNPINNED_KEY, msg);
            ok = false;
        }
    }
    free(ready.v);
    strv_free(&lacking);
    strv_free(&done);
    return ok;
}

/* The inner message as the engine sends it: the caller's members but
 * `lv`/`fb`, then our list's `lv`. NULL when it is no typed object. */
static char *outgoing_plaintext(step *s, const char *inner_json, const char **t_out,
                                json_doc **doc_out) {
    json_doc *d = inner_json ? decode_object(inner_json, strlen(inner_json)) : NULL;
    if (!d) return NULL;
    const json_value *root = json_root(d);
    json_buf b;
    jb_init(&b);
    jb_obj_open(&b);
    for (size_t i = 0; i < json_len(root); i++) {
        const char *k = json_key_at(root, i);
        if (strcmp(k, "lv") == 0 || strcmp(k, "fb") == 0) continue;
        jb_key(&b, k);
        jb_value(&b, json_value_at(root, i));
    }
    jb_key(&b, "lv");
    jb_num(&b, (double)s->own->list_ver);
    jb_obj_close(&b);
    *t_out = str_field(root, "t");
    *doc_out = d;
    return take(&b);
}

/* engine.ts dispatch. */
static bool dispatch(step *s, const char *nick, const char *inner_json, const char *tag,
                     int64_t expires_at, const char *only, const char *except) {
    if (e2e_line_budget(s->c->frame_budget_base, nick) < 0) {
        failed1(s, nick, E2E_FAIL_NO_BUDGET, tag);
        return false;
    }
    if (e2e_nick_eq(nick, s->c->own_nick)) {
        failed1(s, nick, E2E_FAIL_OWN_NICK, tag);
        return false;
    }
    const char *t = NULL;
    json_doc *doc = NULL;
    char *plaintext = outgoing_plaintext(s, inner_json, &t, &doc);
    if (!plaintext) {
        failed1(s, nick, E2E_FAIL_UNENCODABLE, tag);
        return false;
    }
    e2e_outgoing msg = {s->st->next_ref++, plaintext, priority_of(t), 1, xstrdup(tag), expires_at};
    json_free(doc);
    const char *pin = pin_of(s->st, nick);
    bool ok;
    if (!pin) {
        e2e_strv done = {0};
        if (except) strv_push(&done, except);
        ok = enqueue(s, nick, "", only, except, &done, &msg);
    } else {
        char *master = xstrdup(pin);
        ok = send_to(s, nick, master, only, except, &msg);
        free(master);
    }
    outgoing_free(&msg);
    return ok;
}

/* engine.ts requestList. `lv` 0 = asked by a pin or a SAS. */
static bool request_list(step *s, const char *nick, const char *only, long lv) {
    const char *pin = pin_of(s->st, nick);
    e2e_master *m = pin ? master_get(s->st, pin) : NULL;
    long ver = m ? m->ver : 0;
    e2e_peer *p = peer_get(s->st, nick, true);
    size_t w = 0;
    for (size_t i = 0; i < p->nlistreq_lv; i++)
        if (p->listreq_lv[i] > ver) p->listreq_lv[w++] = p->listreq_lv[i];
    p->nlistreq_lv = w;
    if (lv > 0)
        for (size_t i = 0; i < p->nlistreq_lv; i++)
            if (p->listreq_lv[i] == lv) return false;
    if (p->has_listreq && now_of(s) - p->listreq_at < E2E_LISTREQ_INTERVAL_MS) return false;
    char *inner = e2e_inner_listreq();
    bool ok = dispatch(s, nick, inner, E2E_LIST_TAG, 0, only, NULL);
    free(inner);
    if (!ok) return false;
    p = peer_get(s->st, nick, true);
    p->has_listreq = true;
    p->listreq_at = now_of(s);
    if (lv > 0) {
        p->listreq_lv = xrealloc(p->listreq_lv, (p->nlistreq_lv + 1) * sizeof(long));
        p->listreq_lv[p->nlistreq_lv++] = lv;
    }
    return true;
}

/* engine.ts askList. */
static void ask_list(step *s, const char *nick_in) {
    char *nick = xstrdup(nick_in);
    if (e2e_nick_eq(nick, s->c->own_nick)) {
        e2e_peer *p = peer_get(s->st, nick, false);
        if (p) {
            free(p->listreq_held);
            p->listreq_held = NULL;
        }
        free(nick);
        return;
    }
    bool went = request_list(s, nick, NULL, 0);
    e2e_peer *p = peer_get(s->st, nick, true);
    free(p->listreq_held);
    p->listreq_held = went ? NULL : xstrdup(nick);
    free(nick);
}

/* engine.ts sendList: our signed list to one device, once a minute. */
static bool send_list(step *s, const char *nick, const char *ed25519, const char *did) {
    int64_t now = now_of(s);
    size_t w = 0;
    for (size_t i = 0; i < s->st->nanswered; i++) {
        if (now - s->st->answered[i].at >= E2E_LISTREQ_INTERVAL_MS) free(s->st->answered[i].key);
        else s->st->answered[w++] = s->st->answered[i];
    }
    s->st->nanswered = w;
    char *folded = e2e_fold(nick);
    char *key = xprintf("%s %s", folded, did);
    free(folded);
    for (size_t i = 0; i < s->st->nanswered; i++) {
        if (strcmp(s->st->answered[i].key, key) == 0) {
            free(key);
            return false;
        }
    }
    e2e_answered *a = grow((void **)&s->st->answered, &s->st->nanswered, sizeof(*a));
    a->key = key;
    a->at = now;
    json_buf b;
    inner_open(&b, "list");
    jb_key(&b, "master");
    write_master_list(&b, s->own->master, s->own->list_ver,
                      (const char *const *)s->own->list_devices.v, s->own->list_devices.n,
                      s->own->list_sig);
    char *inner = inner_close(&b);
    dispatch(s, nick, inner, E2E_LIST_TAG, 0, ed25519, NULL);
    free(inner);
    return true;
}

/* engine.ts flush: what waits for `nick`'s keys, to every device of
 * `master` now ready for it. */
static void flush(step *s, const char *nick, const char *master) {
    e2e_peer *p = live_queue(s, nick);
    e2e_queued *queue = p->outq;
    size_t n = p->noutq;
    p->outq = NULL;
    p->noutq = 0;
    e2e_queued *waiting = NULL;
    size_t nwaiting = 0;
    for (size_t i = 0; i < n; i++) {
        e2e_queued *q = &queue[i];
        if (strcmp(q->master, master) != 0 && q->master[0] != 0) {
            lost(s, nick, E2E_FAIL_KEY_MISMATCH, &q->msg);
            queued_free(q);
            continue;
        }
        devlist ready;
        e2e_strv lacking;
        split(s, master, q->only, &q->done, &ready, &lacking);
        int refused = ready.n > 0 ? encrypt_to(s, nick, master, &ready, &q->msg) : ENC_OK;
        if (refused != ENC_OK) {
            lost(s, nick, (e2e_send_failure)refused, &q->msg);
            queued_free(q);
        } else {
            for (size_t k = 0; k < ready.n; k++) strv_push(&q->done, ready.v[k]->ed25519);
            if (lacking.n > 0) {
                free(q->master);
                q->master = xstrdup(master);
                e2e_queued *w = grow((void **)&waiting, &nwaiting, sizeof(*w));
                *w = *q;
            } else {
                if (!q->except) lost(s, nick, E2E_FAIL_UNPINNED_KEY, &q->msg);
                queued_free(q);
            }
        }
        free(ready.v);
        strv_free(&lacking);
    }
    free(queue);
    p = peer_get(s->st, nick, true);
    peer_clear_outq(p);
    p->outq = waiting;
    p->noutq = nwaiting;
}

/* ── receiving ── */

/* engine.ts undecryptable: reported, and NACKed to the device it came from. */
static void undecryptable(step *s, const char *nick, const char *msgid, const char *from_did,
                          e2e_undecryptable_reason reason) {
    e2e_event *e = ev(s, E2E_EV_UNDECRYPTABLE, nick);
    e->msgid = xstrdup(msgid);
    e->undecryptable = reason;
    outbound(s, nick, E2E_VERB_NACK, from_did, e2e_nack_payload(msgid), E2E_PRIO_CONTROL, 0, NULL,
             0);
}

/* engine.ts notForUs. */
static void not_for_us(step *s, const char *nick, const char *msgid, const char *from_did,
                       e2e_verb verb, const e2e_payload *p) {
    for (size_t i = 0; i < s->own->list_devices.n; i++) {
        char did[E2E_DID_LEN + 1];
        if (e2e_did(s->own->list_devices.v[i], did) && e2e_payload_body(p, did)) {
            dropped(s, nick, E2E_DROP_NOT_FOR_US, verb, NULL);
            return;
        }
    }
    undecryptable(s, nick, msgid, from_did, E2E_UNDEC_NOT_FOR_OUR_DEVICES);
}

/* The session to `curve` a pre-key message of `session_id` was written on (a copy), or NULL. */
static char *held_session(step *s, const char *curve, const char *session_id) {
    e2e_session_set *set = sessions_get(s->st, curve);
    for (size_t i = 0; set && i < set->pickles.n; i++) {
        char *id = session_id_of(set->pickles.v[i]);
        bool match = id && strcmp(id, session_id) == 0;
        free(id);
        if (match) return xstrdup(set->pickles.v[i]);
    }
    return NULL;
}

/* engine.ts decryptWith: on success the session becomes the newest. */
static bool decrypt_with(step *s, const char *curve, const char *pickle, size_t type,
                         const uint8_t *body, size_t len, vz_buf *plain) {
    vz_session *ss = vz_session_from_pickle(pickle);
    if (!ss) return false;
    if (vz_session_decrypt(ss, type, body, len, plain) != 0) {
        vz_session_free(ss);
        return false;
    }
    char *next = vzs(vz_session_pickle(ss));
    vz_session_free(ss);
    if (!next) abort();
    e2e_session_set *set = sessions_make(s->st, curve);
    strv_remove(&set->pickles, pickle);
    set->pickles.v = xrealloc(set->pickles.v, (set->pickles.n + 1) * sizeof(char *));
    memmove(set->pickles.v + 1, set->pickles.v, set->pickles.n * sizeof(char *));
    set->pickles.v[0] = next;
    set->pickles.n++;
    return true;
}

static bool decrypt_any(step *s, const char *curve, const uint8_t *body, size_t len,
                        vz_buf *plain) {
    e2e_session_set *set = sessions_get(s->st, curve);
    if (!set) return false;
    e2e_strv copy = strv_dup(&set->pickles);
    bool ok = false;
    for (size_t i = 0; i < copy.n && !ok; i++)
        ok = decrypt_with(s, curve, copy.v[i], 1, body, len, plain);
    strv_free(&copy);
    return ok;
}

/* engine.ts openInbound: -1 and a session, or why none. The id is seen
 * from then on, whatever becomes of the session. */
static int open_inbound(step *s, const char *curve, const uint8_t *body, size_t len,
                        const char *session_id, vz_session **session, vz_buf *plain) {
    *session = NULL;
    if (strv_has(&s->st->seen, session_id)) return E2E_UNDEC_REPLAYED_SESSION;
    vz_session *ss = vz_account_create_inbound_session(s->account, curve, body, len, plain);
    if (!ss) return E2E_UNDEC_SESSION_CREATION;
    strv_push(&s->st->seen, session_id);
    while (s->st->seen.n > E2E_SEEN_SESSIONS_MAX) strv_remove_at(&s->st->seen, 0);
    *session = ss;
    return -1;
}

/* engine.ts inner: the decrypted body as a typed object, `fb` checked for
 * a pre-key body (`sender` its device's E, NULL for a MSG). */
static json_doc *inner_of(step *s, const char *nick, const vz_buf *plain, const char *sender) {
    if (!utf8_valid(plain->ptr, plain->len)) {
        dropped(s, nick, E2E_DROP_UNDECODABLE_INNER, E2E_VERB_NONE, NULL);
        return NULL;
    }
    json_doc *d = json_parse((const char *)plain->ptr, plain->len, NULL, 0);
    if (!d || dup_keys(json_root(d))) {
        json_free(d);
        dropped(s, nick, E2E_DROP_UNDECODABLE_INNER, E2E_VERB_NONE, NULL);
        return NULL;
    }
    const json_value *root = json_root(d);
    if (json_type_of(root) != JSON_OBJECT || json_type_of(json_get(root, "t")) != JSON_STRING) {
        json_free(d);
        dropped(s, nick, E2E_DROP_INNER_WITHOUT_TYPE, E2E_VERB_NONE, NULL);
        return NULL;
    }
    if (sender) {
        char expect[E2E_FB_LEN + 1];
        e2e_fb(sender, s->own_e, expect);
        if (!streq(str_field(root, "fb"), expect)) {
            json_free(d);
            dropped(s, nick, E2E_DROP_INNER_KEY_MISMATCH, E2E_VERB_NONE, NULL);
            return NULL;
        }
    }
    return d;
}

/* The inner object without `fb` and `lv`: what the application sees. */
static char *delivered_json(const json_value *root) {
    json_buf b;
    jb_init(&b);
    jb_obj_open(&b);
    for (size_t i = 0; i < json_len(root); i++) {
        const char *k = json_key_at(root, i);
        if (strcmp(k, "fb") == 0 || strcmp(k, "lv") == 0) continue;
        jb_key(&b, k);
        jb_value(&b, json_value_at(root, i));
    }
    jb_obj_close(&b);
    return take(&b);
}

/* engine.ts onList. */
static void on_list(step *s, const char *nick, const json_value *root) {
    const json_value *block = obj_field(root, "master");
    e2e_master_list list;
    if (!block || !e2e_master_list_parse(block, &list) || !e2e_valid_master_list(&list)) {
        dropped(s, nick, E2E_DROP_BAD_LIST, E2E_VERB_NONE, NULL);
        return;
    }
    if (check_master(s, nick, list.ed25519) == MASTER_ALARM) return;
    apply_list(s, list.ed25519, (long)list.ver, list.devices, list.ndevices);
}

/* engine.ts deliver. */
static void deliver(step *s, const char *nick, const char *master_in, const char *ed25519_in,
                    const char *did_in, const json_value *root, const e2e_payload *p) {
    char *master = xstrdup(master_in), *ed25519 = xstrdup(ed25519_in), *did = xstrdup(did_in);
    const char *t = str_field(root, "t");
    if (streq(t, "list")) {
        on_list(s, nick, root);
    } else if (streq(t, "listreq")) {
        if (!send_list(s, nick, ed25519, did))
            dropped(s, nick, E2E_DROP_LISTREQ_RATE_LIMITED, E2E_VERB_NONE, NULL);
    } else {
        e2e_master *m = master_get(s->st, master);
        e2e_event *e = ev(s, E2E_EV_RECEIVED, nick);
        e->master = xstrdup(master);
        e->device = xstrdup(ed25519);
        e->verified = m && m->verified;
        e->inner = delivered_json(root);
    }
    bool stranger = false;
    for (size_t i = 0; i < p->nbodies && !stranger; i++) {
        bool ours = false;
        for (size_t k = 0; k < s->own->list_devices.n && !ours; k++) {
            char d[E2E_DID_LEN + 1];
            ours = e2e_did(s->own->list_devices.v[k], d) && strcmp(d, p->bodies[i].did) == 0;
        }
        stranger = !ours;
    }
    if (stranger) send_list(s, nick, ed25519, did);
    double lv;
    if (number_field(root, "lv", &lv) && e2e_valid_ver(lv)) {
        e2e_master *m = master_get(s->st, master);
        if (lv > (m ? m->ver : 0)) request_list(s, nick, ed25519, (long)lv);
    }
    free(master);
    free(ed25519);
    free(did);
}

/* A step's failure on wire input: cic's PayloadError/Rejected, caught by
 * `guarded` and reported as bad-payload. */
typedef struct {
    bool bad;
    char detail[160];
} wire_fault;

static void fault(wire_fault *f, const char *detail) {
    f->bad = true;
    snprintf(f->detail, sizeof(f->detail), "%s", detail);
}

static void fault_vz(wire_fault *f) { fault(f, vz_last_error()); }

/* engine.ts openSession, for the first KEYS entry of one device. */
static bool open_session(step *s, const char *nick, const char *master, const e2e_keys_entry *e) {
    int reason = refusal(s, master, &e->id);
    if (reason < 0) reason = curve_refusal(s, &e->id, false);
    if (reason < 0 && !otk_signed(e)) reason = E2E_DROP_BAD_OTK_SIGNATURE;
    if (reason >= 0) {
        dropped(s, nick, (e2e_drop_reason)reason, E2E_VERB_KEYS, NULL);
        return false;
    }
    if (!strv_has(&s->st->rekeying, e->id.ed25519) && sessions_count(s->st, e->id.curve25519) > 0)
        return false;
    vz_session *ss = vz_account_create_outbound_session(s->account, e->id.curve25519, e->otk_key);
    if (!ss) {
        dropped(s, nick, E2E_DROP_BAD_PAYLOAD, E2E_VERB_KEYS, vz_last_error());
        return false;
    }
    char *pickle = vzs(vz_session_pickle(ss));
    vz_session_free(ss);
    if (!pickle) abort();
    add_session(s->st, e->id.curve25519, pickle);
    free(pickle);
    strv_remove(&s->st->rekeying, e->id.ed25519);
    e2e_device *known = device_get(s->st, e->id.ed25519);
    bool proven = known && known->proven;
    long cert_ver = known ? known->cert_ver : 0;
    char did[E2E_DID_LEN + 1];
    e2e_did(e->id.ed25519, did);
    device_put(s->st, e->id.ed25519, e->id.curve25519, master, did, proven, cert_ver);
    return true;
}

/* engine.ts onKeys. */
static void on_keys(step *s, const char *nick, const json_value *root, wire_fault *f) {
    e2e_peer *p = peer_get(s->st, nick, false);
    if (!p || !p->keys_awaited) {
        dropped(s, nick, E2E_DROP_UNSOLICITED_KEYS, E2E_VERB_KEYS, NULL);
        return;
    }
    e2e_payload k = {0};
    char err[80];
    if (!parse_on(E2E_VERB_KEYS, root, &k, err, sizeof(err))) {
        fault(f, err);
        return;
    }
    if (!e2e_valid_master_list(&k.master)) {
        dropped(s, nick, E2E_DROP_BAD_LIST, E2E_VERB_KEYS, NULL);
        return;
    }
    const char *master = k.master.ed25519;
    p = peer_get(s->st, nick, true);
    p->keys_awaited = false;
    bool asked = p->keys_asked_nick != NULL;
    free(p->keys_asked_nick);
    p->keys_asked_nick = NULL;
    if (check_master(s, nick, master) == MASTER_ALARM) {
        p = live_queue(s, nick);
        for (size_t i = 0; i < p->noutq; i++) lost(s, nick, E2E_FAIL_KEY_MISMATCH, &p->outq[i].msg);
        peer_clear_outq(p);
        if (asked && strcmp(master, s->own->master) == 0) ev(s, E2E_EV_KEYS_UNANSWERED, nick);
        return;
    }
    apply_list(s, master, (long)k.master.ver, k.master.devices, k.master.ndevices);
    bool opened = false;
    for (size_t i = 0; i < k.nentries; i++) {
        bool judged = false;
        for (size_t j = 0; j < i && !judged; j++)
            judged = strcmp(k.entries[j].id.ed25519, k.entries[i].id.ed25519) == 0;
        if (judged) continue;
        opened = open_session(s, nick, master, &k.entries[i]) || opened;
    }
    flush(s, nick, master);
    if (asked) ev(s, opened ? E2E_EV_KEYS_RENEWED : E2E_EV_KEYS_UNANSWERED, nick);
}

/* engine.ts presented: the checks a PKMSG passes whoever wrote it. -1 and
 * the body for this device (malloc'd), or why not; E2E_DROP_NOT_FOR_US for
 * no body here. A body that is no base64 is a fault (bad-payload). */
static int presented(step *s, const char *from_did, const e2e_payload *p, uint8_t **body,
                     size_t *len, wire_fault *f) {
    *body = NULL;
    if (!canonical_id(&p->id) || !e2e_ed25519_canonical(p->cert_master))
        return E2E_DROP_NON_CANONICAL_KEY;
    char did[E2E_DID_LEN + 1];
    if (!e2e_did(p->id.ed25519, did) || strcmp(did, from_did) != 0) return E2E_DROP_BAD_FROM;
    const char *mine = e2e_payload_body(p, s->own->did);
    if (!mine) return E2E_DROP_NOT_FOR_US;
    if (!e2e_unbase64(mine, body, len)) {
        fault(f, "not base64");
        return E2E_DROP_BAD_PAYLOAD;
    }
    char *cert_text = e2e_cert_sig_text(p->cert_ver, p->id.ed25519);
    bool cert_ok = sig_ok(p->cert_master, cert_text, p->cert);
    free(cert_text);
    int reason = -1;
    if (!cert_ok) reason = E2E_DROP_BAD_CERT;
    else if (!id_signed(&p->id, p->cert_master)) reason = E2E_DROP_BAD_IDENTITY_SIGNATURE;
    if (reason >= 0) {
        free(*body);
        *body = NULL;
    }
    return reason;
}

/* engine.ts onPkmsg, rev 2's order. */
static void on_pkmsg(step *s, const char *nick, const char *msgid, const char *from_did,
                     const json_value *root, wire_fault *f) {
    e2e_payload p = {0};
    char err[80];
    if (!parse_on(E2E_VERB_PKMSG, root, &p, err, sizeof(err))) {
        fault(f, err);
        return;
    }
    const char *master = p.cert_master;
    uint8_t *body;
    size_t len;
    int why = presented(s, from_did, &p, &body, &len, f);
    if (f->bad) return;
    if (why == E2E_DROP_NOT_FOR_US) {
        not_for_us(s, nick, msgid, from_did, E2E_VERB_PKMSG, &p);
        return;
    }
    if (why >= 0) {
        dropped(s, nick, (e2e_drop_reason)why, E2E_VERB_PKMSG, NULL);
        return;
    }
    if (check_master(s, nick, master) == MASTER_ALARM) {
        free(body);
        return;
    }
    int reason = standing(s, master, p.id.ed25519, p.cert_ver);
    if (reason < 0) reason = curve_refusal(s, &p.id, true);
    if (reason >= 0) {
        dropped(s, nick, (e2e_drop_reason)reason, E2E_VERB_PKMSG, NULL);
        free(body);
        return;
    }
    char *session_id = vzs(vz_pre_key_session_id(body, len));
    if (!session_id) {
        fault_vz(f);
        free(body);
        return;
    }
    e2e_device *bound = device_get(s->st, p.id.ed25519);
    char *held = bound ? held_session(s, p.id.curve25519, session_id) : NULL;
    vz_buf plain = {0};
    if (bound && held) {
        bool ok = decrypt_with(s, p.id.curve25519, held, 0, body, len, &plain);
        free(held);
        if (!ok) {
            undecryptable(s, nick, msgid, from_did, E2E_UNDEC_DECRYPTION_FAILED);
        } else {
            json_doc *inner = inner_of(s, nick, &plain, p.id.ed25519);
            vz_buf_free(plain);
            if (inner) {
                bound = device_get(s->st, p.id.ed25519);
                char *did = xstrdup(bound->did);
                deliver(s, nick, master, p.id.ed25519, did, json_root(inner), &p);
                free(did);
                json_free(inner);
            }
        }
        free(session_id);
        free(body);
        return;
    }
    vz_session *ss;
    int opened = open_inbound(s, p.id.curve25519, body, len, session_id, &ss, &plain);
    free(body);
    if (opened >= 0) {
        if (opened == E2E_UNDEC_REPLAYED_SESSION) {
            e2e_event *e = ev(s, E2E_EV_REPLAYED, nick);
            e->session_id = xstrdup(session_id);
        }
        undecryptable(s, nick, msgid, from_did, (e2e_undecryptable_reason)opened);
        free(session_id);
        return;
    }
    free(session_id);
    json_doc *inner = inner_of(s, nick, &plain, p.id.ed25519);
    vz_buf_free(plain);
    if (!inner) {
        vz_session_free(ss);
        return;
    }
    bind_proven(s, master, &p.id, p.cert_ver);
    char *pickle = vzs(vz_session_pickle(ss));
    vz_session_free(ss);
    if (!pickle) abort();
    add_session(s->st, p.id.curve25519, pickle);
    free(pickle);
    char did[E2E_DID_LEN + 1];
    e2e_did(p.id.ed25519, did);
    char *m = xstrdup(master);
    deliver(s, nick, m, p.id.ed25519, did, json_root(inner), &p);
    json_free(inner);
    flush(s, nick, m);
    free(m);
}

/* engine.ts onMsg. */
static void on_msg(step *s, const char *nick, const char *msgid, const char *from_did,
                   const json_value *root, wire_fault *f) {
    e2e_payload p = {0};
    char err[80];
    if (!parse_on(E2E_VERB_MSG, root, &p, err, sizeof(err))) {
        fault(f, err);
        return;
    }
    char *curve = vzs(vz_canonical_curve25519(p.ck));
    if (!curve) {
        fault_vz(f);
        return;
    }
    const char *mine = e2e_payload_body(&p, s->own->did);
    if (!mine) {
        not_for_us(s, nick, msgid, from_did, E2E_VERB_MSG, &p);
        free(curve);
        return;
    }
    uint8_t *body;
    size_t len;
    if (!e2e_unbase64(mine, &body, &len)) {
        fault(f, "not base64");
        free(curve);
        return;
    }
    const char *pin = pin_of(s->st, nick);
    char *master = opt_dup(pin);
    e2e_master *rec = master ? master_get(s->st, master) : NULL;
    if (rec && strv_has(&rec->revoked_curves, curve)) {
        dropped(s, nick, E2E_DROP_REVOKED_DEVICE, E2E_VERB_MSG, NULL);
    } else {
        e2e_device *device = master ? trusted_by_curve(s, master, curve) : NULL;
        if (device) {
            if (strcmp(device->did, from_did) != 0) {
                dropped(s, nick, E2E_DROP_BAD_FROM, E2E_VERB_MSG, NULL);
            } else {
                char *e = xstrdup(device->ed25519), *did = xstrdup(device->did);
                vz_buf plain = {0};
                if (!decrypt_any(s, curve, body, len, &plain)) {
                    undecryptable(s, nick, msgid, from_did,
                                  sessions_count(s->st, curve) == 0 ? E2E_UNDEC_NO_SESSION
                                                                    : E2E_UNDEC_DECRYPTION_FAILED);
                } else {
                    json_doc *inner = inner_of(s, nick, &plain, NULL);
                    vz_buf_free(plain);
                    if (inner) deliver(s, nick, master, e, did, json_root(inner), &p);
                    json_free(inner);
                }
                free(e);
                free(did);
            }
        } else if (device_by_curve(s->st, curve)) {
            dropped(s, nick, E2E_DROP_UNPINNED_KEY, E2E_VERB_MSG, NULL);
        } else {
            undecryptable(s, nick, msgid, from_did, E2E_UNDEC_NO_SESSION);
        }
    }
    free(master);
    free(body);
    free(curve);
}

static bool keys_under_way(step *s, const char *nick);

/* engine.ts unreadableBy. */
static bool unreadable_by(step *s, const char *nick, const char *from_did, const e2e_sent *sent) {
    if (!e2e_nick_eq(sent->nick, nick)) return false;
    if (strcmp(from_did, "*") == 0) return true;
    for (size_t i = 0; i < s->st->ndevices; i++)
        if (strcmp(s->st->devices[i].master, sent->master) == 0 &&
            strcmp(s->st->devices[i].did, from_did) == 0)
            return false;
    e2e_master *m = master_get(s->st, sent->master);
    for (size_t i = 0; m && i < m->devices.n; i++) {
        char did[E2E_DID_LEN + 1];
        if (e2e_did(m->devices.v[i], did) && strcmp(did, from_did) == 0) return false;
    }
    return true;
}

static bool rekey_due(step *s, const char *nick) {
    e2e_peer *p = peer_get(s->st, nick, false);
    return p && p->has_rekey_at && (!p->has_keyreq_at || p->rekey_at > p->keyreq_sent_at);
}

static bool keys_under_way(step *s, const char *nick) {
    e2e_peer *p = peer_get(s->st, nick, false);
    bool awaited = p && p->keys_awaited && p->has_keyreq_at &&
                   now_of(s) - p->keyreq_sent_at < E2E_KEYREQ_RETRY_MS;
    return awaited || rekey_due(s, nick);
}

/* engine.ts onNack. */
static void on_nack(step *s, const char *nick, const char *from_did, const json_value *root,
                    wire_fault *f) {
    e2e_payload p = {0};
    char err[80];
    if (!parse_on(E2E_VERB_NACK, root, &p, err, sizeof(err))) {
        fault(f, err);
        return;
    }
    trim_sent(s);
    size_t idx = s->st->nsent;
    for (size_t i = 0; i < s->st->nsent; i++)
        if (streq(s->st->sent[i].msgid, p.ref)) {
            idx = i;
            break;
        }
    if (idx == s->st->nsent) {
        dropped(s, nick, E2E_DROP_UNKNOWN_NACK_REF, E2E_VERB_NACK, NULL);
        return;
    }
    e2e_sent *sent = &s->st->sent[idx];
    size_t di = sent->ndevices;
    for (size_t i = 0; i < sent->ndevices; i++)
        if (strcmp(sent->devices[i].did, from_did) == 0) di = i;
    if (di == sent->ndevices) {
        if (!unreadable_by(s, nick, from_did, sent)) {
            dropped(s, nick, E2E_DROP_UNKNOWN_NACK_REF, E2E_VERB_NACK, NULL);
            return;
        }
        e2e_outgoing msg = outgoing_dup(&sent->msg);
        sent_remove_at(s->st, idx);
        lost(s, nick, E2E_FAIL_UNREADABLE, &msg);
        outgoing_free(&msg);
        return;
    }
    /* What the record says, before it goes. */
    char *ed25519 = xstrdup(sent->devices[di].ed25519);
    char *session_id = xstrdup(sent->devices[di].session_id);
    char *sent_nick = xstrdup(sent->nick), *sent_master = xstrdup(sent->master);
    e2e_outgoing msg = outgoing_dup(&sent->msg);
    free(sent->devices[di].did);
    free(sent->devices[di].ed25519);
    free(sent->devices[di].session_id);
    memmove(sent->devices + di, sent->devices + di + 1,
            (sent->ndevices - di - 1) * sizeof(*sent->devices));
    sent->ndevices--;
    if (sent->ndevices == 0) sent_remove_at(s->st, idx);

    const char *pin = pin_of(s->st, nick);
    e2e_device *device = device_get(s->st, ed25519);
    int untrusted = -1;
    if (!e2e_nick_eq(sent_nick, nick)) {
        lost(s, sent_nick, E2E_FAIL_NACK_FROM_ANOTHER_NICK, &msg);
    } else if (!streq(pin, sent_master)) {
        lost(s, nick, E2E_FAIL_REPINNED, &msg);
    } else if (!device || strcmp(device->master, sent_master) != 0) {
        dropped(s, nick, E2E_DROP_REVOKED_DEVICE, E2E_VERB_NACK, NULL);
        lost(s, nick, E2E_FAIL_UNPINNED_KEY, &msg);
    } else if ((untrusted = standing(s, sent_master, ed25519, device->cert_ver)) >= 0) {
        dropped(s, nick, (e2e_drop_reason)untrusted, E2E_VERB_NACK, NULL);
        lost(s, nick, E2E_FAIL_UNPINNED_KEY, &msg);
    } else if (msg.sends >= E2E_MAX_SENDS) {
        lost(s, nick, E2E_FAIL_RESEND_FAILED, &msg);
    } else {
        char *curve = xstrdup(device->curve25519);
        e2e_session_set *set = sessions_get(s->st, curve);
        char *newest = set && set->pickles.n ? session_id_of(set->pickles.v[0]) : NULL;
        bool go = true;
        if (!newest || strcmp(newest, session_id) == 0) {
            if (!keys_under_way(s, nick)) {
                e2e_peer *pr = peer_get(s->st, nick, true);
                if (pr->has_rekey_at && now_of(s) - pr->rekey_at < E2E_REKEY_INTERVAL_MS) {
                    lost(s, nick, E2E_FAIL_REKEY_THROTTLED, &msg);
                    go = false;
                } else {
                    pr->has_rekey_at = true;
                    pr->rekey_at = now_of(s);
                    e2e_event *e = ev(s, E2E_EV_REKEYING, nick);
                    e->master = xstrdup(sent_master);
                    e->device = xstrdup(ed25519);
                }
            }
            if (go && !strv_has(&s->st->rekeying, ed25519)) strv_push(&s->st->rekeying, ed25519);
        }
        free(newest);
        if (go) {
            drop_session(s, curve, session_id);
            msg.sends++;
            send_to(s, nick, sent_master, ed25519, NULL, &msg);
        }
        free(curve);
    }
    outgoing_free(&msg);
    free(ed25519);
    free(session_id);
    free(sent_nick);
    free(sent_master);
}

void e2e_receive(const e2e_ctx *c, const char *nick, e2e_verb verb, const char *msgid,
                 const char *from_did, const char *payload, e2e_result *res) {
    step s;
    step_begin(&s, c, res);
    json_doc *d = payload ? decode_object(payload, strlen(payload)) : NULL;
    if (!d) {
        dropped(&s, nick, E2E_DROP_UNDECODABLE_PAYLOAD, verb, NULL);
        step_abandon(&s);
        return;
    }
    wire_fault f = {0};
    const json_value *root = json_root(d);
    switch (verb) {
    case E2E_VERB_KEYS: on_keys(&s, nick, root, &f); break;
    case E2E_VERB_PKMSG: on_pkmsg(&s, nick, msgid, from_did, root, &f); break;
    case E2E_VERB_MSG: on_msg(&s, nick, msgid, from_did, root, &f); break;
    case E2E_VERB_NACK: on_nack(&s, nick, from_did, root, &f); break;
    case E2E_VERB_KEYREQ:
    case E2E_VERB_NONE: fault(&f, "not a verb grappa delivers"); break;
    }
    if (f.bad) dropped(&s, nick, E2E_DROP_BAD_PAYLOAD, verb, f.detail);
    json_free(d);
    step_end(&s);
}

/* engine.ts liveCopies: the copies waiting for sibling `ed25519`'s keys,
 * minus those that waited OUTQ_TTL_MS (sibling-no-keys). */
static void live_copies(step *s, const char *ed25519) {
    e2e_copy_queue *q = copyq_get(s->st, ed25519);
    if (!q) return;
    size_t w = 0;
    for (size_t k = 0; k < q->ncopies; k++) {
        if (q->copies[k].at > now_of(s) - E2E_OUTQ_TTL_MS) {
            q->copies[w++] = q->copies[k];
        } else {
            dropped(s, q->copies[k].peer, E2E_DROP_SIBLING_NO_KEYS, E2E_VERB_NONE, NULL);
            free(q->copies[k].peer);
            free(q->copies[k].body);
        }
    }
    q->ncopies = w;
    if (w == 0) copyq_delete(s->st, ed25519);
}

/* ── the public sending verbs ── */

bool e2e_send(const e2e_ctx *c, const char *nick, const char *inner_json, const char *tag,
              int64_t expires_at, const char *only, e2e_result *res) {
    if (!tag || strcmp(tag, E2E_LIST_TAG) == 0) return false;
    step s;
    step_begin(&s, c, res);
    dispatch(&s, nick, inner_json, tag, expires_at, only, NULL);
    step_end(&s);
    return true;
}

bool e2e_send_except(const e2e_ctx *c, const char *nick, const char *inner_json, const char *tag,
                     const char *except, e2e_result *res) {
    if (!tag || strcmp(tag, E2E_LIST_TAG) == 0 || !except) return false;
    step s;
    step_begin(&s, c, res);
    dispatch(&s, nick, inner_json, tag, 0, NULL, except);
    step_end(&s);
    return true;
}

void e2e_sent_ok(const e2e_ctx *c, long ref, const char *msgid) {
    e2e_state *st = &c->record->state;
    for (size_t i = 0; i < st->nsent; i++) {
        if (st->sent[i].ref == ref && !st->sent[i].msgid) {
            st->sent[i].msgid = xstrdup(msgid);
            return;
        }
    }
}

/* `pending` outside a step: the same question, no step needed. */
static bool pending_in(e2e_state *st, long id) {
    step s = {0};
    s.st = st;
    return pending(&s, id);
}

bool e2e_discard(const e2e_ctx *c, long ref, char **nick, char **tag) {
    *nick = *tag = NULL;
    e2e_state *st = &c->record->state;
    for (size_t i = 0; i < st->nsent; i++) {
        if (st->sent[i].ref != ref) continue;
        long id = st->sent[i].msg.id;
        char *n = xstrdup(st->sent[i].nick), *t = xstrdup(st->sent[i].msg.tag);
        sent_remove_at(st, i);
        if (pending_in(st, id) || strcmp(t, E2E_LIST_TAG) == 0) {
            free(n);
            free(t);
            return false;
        }
        *nick = n;
        *tag = t;
        return true;
    }
    return false;
}

bool e2e_dropped(const e2e_ctx *c, const char *msgid, char **nick, char **tag) {
    *nick = *tag = NULL;
    e2e_state *st = &c->record->state;
    for (size_t i = 0; i < st->nsent; i++)
        if (streq(st->sent[i].msgid, msgid)) return e2e_discard(c, st->sent[i].ref, nick, tag);
    return false;
}

bool e2e_sent_as(const e2e_ctx *c, const char *msgid, char **nick, char **tag) {
    *nick = *tag = NULL;
    e2e_state *st = &c->record->state;
    for (size_t i = 0; i < st->nsent; i++) {
        if (!streq(st->sent[i].msgid, msgid)) continue;
        *nick = xstrdup(st->sent[i].nick);
        *tag = xstrdup(st->sent[i].msg.tag);
        return true;
    }
    return false;
}

void e2e_forget(const e2e_ctx *c, const char *nick) {
    e2e_state *st = &c->record->state;
    e2e_peer *p = peer_get(st, nick, false);
    if (p) {
        peer_clear_outq(p);
        free(p->keys_asked_nick);
        p->keys_asked_nick = NULL;
    }
    for (size_t i = 0; i < st->nsent;) {
        if (e2e_nick_eq(st->sent[i].nick, nick)) sent_remove_at(st, i);
        else i++;
    }
    for (size_t i = 0; i < st->ncopyq;) {
        e2e_copy_queue *q = &st->copyq[i];
        size_t w = 0;
        for (size_t k = 0; k < q->ncopies; k++) {
            if (e2e_nick_eq(q->copies[k].peer, nick)) {
                free(q->copies[k].peer);
                free(q->copies[k].body);
            } else {
                q->copies[w++] = q->copies[k];
            }
        }
        q->ncopies = w;
        if (w == 0) {
            char *e = xstrdup(q->ed25519);
            copyq_delete(st, e);
            free(e);
        } else {
            i++;
        }
    }
}

void e2e_rekey(const e2e_ctx *c, const char *nick, e2e_result *res) {
    step s;
    step_begin(&s, c, res);
    if (!e2e_nick_eq(nick, c->own_nick)) {
        const char *pin = pin_of(s.st, nick);
        if (pin) {
            devlist t = trusted_devices(&s, pin);
            for (size_t i = 0; i < t.n; i++)
                if (!strv_has(&s.st->rekeying, t.v[i]->ed25519))
                    strv_push(&s.st->rekeying, t.v[i]->ed25519);
            free(t.v);
        }
        e2e_peer *p = peer_get(s.st, nick, true);
        free(p->keys_asked_nick);
        p->keys_asked_nick = xstrdup(nick);
        p->keys_asked_at = now_of(&s);
        ev(&s, E2E_EV_KEYS_ASKED, nick);
        maybe_keyreq(&s, nick);
    }
    step_end(&s);
}

void e2e_ask_keys(const e2e_ctx *c, const char *nick, e2e_result *res) {
    step s;
    step_begin(&s, c, res);
    if (!e2e_nick_eq(nick, c->own_nick)) maybe_keyreq(&s, nick);
    step_end(&s);
}

void e2e_absent(const e2e_ctx *c, const char *nick, e2e_result *res) {
    step s;
    step_begin(&s, c, res);
    e2e_peer *p = peer_get(s.st, nick, false);
    if (p) {
        for (size_t i = 0; i < p->noutq; i++)
            lost(&s, p->outq[i].nick, E2E_FAIL_NO_SUCH_NICK, &p->outq[i].msg);
        /* The losses copy what they need; the queue goes now. Judged at
         * the end, nothing of these is pending any more. */
        peer_clear_outq(p);
        p->keys_awaited = false;
        p->has_keyreq_at = false;
        if (p->keys_asked_nick) {
            ev(&s, E2E_EV_KEYS_UNANSWERED, p->keys_asked_nick);
            free(p->keys_asked_nick);
            p->keys_asked_nick = NULL;
        }
    }
    step_end(&s);
}

void e2e_tick(const e2e_ctx *c, e2e_result *res) {
    step s;
    step_begin(&s, c, res);
    for (size_t i = 0; i < s.st->npeers; i++) {
        if (s.st->peers[i].noutq == 0) continue;
        char *key = xstrdup(s.st->peers[i].key);
        e2e_peer *p = live_queue(&s, key);
        char *asking = NULL;
        for (size_t k = 0; k < p->noutq && !asking; k++)
            if (!went_out(&s, p->outq[k].msg.id)) asking = xstrdup(p->outq[k].nick);
        if (!asking && p->noutq > 0 && rekey_due(&s, key)) asking = xstrdup(p->outq[0].nick);
        if (asking) maybe_keyreq(&s, asking);
        free(asking);
        free(key);
    }
    for (size_t i = 0; i < s.st->ncopyq;) {
        size_t before = s.st->ncopyq;
        char *e = xstrdup(s.st->copyq[i].ed25519);
        live_copies(&s, e);
        if (s.st->ncopyq == before) i++;
        free(e);
    }
    for (size_t i = 0; i < s.st->npeers; i++) {
        if (!s.st->peers[i].listreq_held) continue;
        char *held = xstrdup(s.st->peers[i].listreq_held);
        ask_list(&s, held);
        free(held);
    }
    for (size_t i = 0; i < s.st->npeers; i++) {
        e2e_peer *p = &s.st->peers[i];
        if (!p->keys_asked_nick) continue;
        if (now_of(&s) - p->keys_asked_at < E2E_OUTQ_TTL_MS) {
            char *nick = xstrdup(p->keys_asked_nick);
            maybe_keyreq(&s, nick);
            free(nick);
            continue;
        }
        ev(&s, E2E_EV_KEYS_UNANSWERED, p->keys_asked_nick);
        free(p->keys_asked_nick);
        p->keys_asked_nick = NULL;
    }
    step_end(&s);
}

bool e2e_waits_on_the_clock(const e2e_ctx *c) {
    const e2e_state *st = &c->record->state;
    if (st->ncopyq > 0 || st->nsas > 0) return true;
    for (size_t i = 0; i < st->npeers; i++)
        if (st->peers[i].noutq > 0 || st->peers[i].listreq_held || st->peers[i].keys_asked_nick)
            return true;
    return false;
}

/* ── trust verbs ── */

e2e_pin_outcome e2e_pin(const e2e_ctx *c, const char *nick, const char *master, bool verified,
                        e2e_result *res) {
    if (!e2e_ed25519_canonical(master)) return E2E_PIN_BAD_KEY;
    if (strcmp(master, c->record->own->master) == 0) return E2E_PIN_OWN_KEY;
    step s;
    step_begin(&s, c, res);
    char *before = opt_dup(pin_of(s.st, nick));
    e2e_master *known = master_get(s.st, master);
    if (known) known->verified = known->verified || verified;
    else master_add(s.st, master, nick, verified);
    e2e_peer *p = peer_get(s.st, nick, true);
    free(p->pin);
    p->pin = xstrdup(master);
    if (before) {
        bool still = false;
        for (size_t i = 0; i < s.st->npeers && !still; i++)
            still = streq(s.st->peers[i].pin, before);
        for (size_t i = 0; !still && i < s.st->ndevices; i++) {
            if (strcmp(s.st->devices[i].master, before) != 0) continue;
            char *e = xstrdup(s.st->devices[i].ed25519), *k = xstrdup(s.st->devices[i].curve25519);
            drop_sessions(&s, e, k);
            free(e);
            free(k);
        }
    }
    free(before);
    ask_list(&s, nick);
    step_end(&s);
    return E2E_PIN_PINNED;
}

void e2e_verify(const e2e_ctx *c, const char *nick, const char *master, e2e_result *res) {
    step s;
    step_begin(&s, c, res);
    e2e_master *m = master_get(s.st, master);
    if (m) {
        m->verified = true;
        if (streq(pin_of(s.st, nick), master)) ask_list(&s, nick);
    }
    step_end(&s);
}

bool e2e_pinned(const e2e_ctx *c, const char *nick, const char **master, bool *verified,
                size_t *trusted) {
    e2e_state *st = &c->record->state;
    const char *pin = pin_of(st, nick);
    e2e_master *m = pin ? master_get(st, pin) : NULL;
    if (!m) return false;
    step s = {0};
    s.st = st;
    devlist t = trusted_devices(&s, pin);
    *master = pin;
    *verified = m->verified;
    *trusted = t.n;
    free(t.v);
    return true;
}

const e2e_master *e2e_master_of(const e2e_ctx *c, const char *master) {
    return master ? master_get(&c->record->state, master) : NULL;
}

bool e2e_trusted(const e2e_ctx *c, const char *master, const char *ed25519) {
    step s = {0};
    s.st = &c->record->state;
    e2e_device *d = device_get(s.st, ed25519);
    return d && streq(d->master, master) && standing(&s, master, ed25519, d->cert_ver) < 0;
}

/* ── siblings (S1: a copy of each text sent, to our own other devices) ── */

static bool our_list_names(step *s, const char *ed25519) {
    return strv_has(&s->own->list_devices, ed25519);
}

/* engine.ts dropCopies. */
static void drop_copies(step *s, const char *ed25519, e2e_drop_reason reason) {
    e2e_copy_queue *q = copyq_get(s->st, ed25519);
    for (size_t k = 0; q && k < q->ncopies; k++)
        dropped(s, q->copies[k].peer, reason, E2E_VERB_NONE, NULL);
    copyq_delete(s->st, ed25519);
}

/* engine.ts forgetSibling: its sessions go, its waiting copies unsent. */
static void forget_sibling(step *s, const char *ed25519_in) {
    char *ed25519 = xstrdup(ed25519_in);
    for (size_t i = 0; i < s->st->nsiblings; i++) {
        if (strcmp(s->st->siblings[i].ed25519, ed25519) != 0) continue;
        sessions_delete(s->st, s->st->siblings[i].curve25519);
        sibling_free(&s->st->siblings[i]);
        memmove(s->st->siblings + i, s->st->siblings + i + 1,
                (s->st->nsiblings - i - 1) * sizeof(*s->st->siblings));
        s->st->nsiblings--;
        break;
    }
    drop_copies(s, ed25519, E2E_DROP_SIBLING_GONE);
    free(ed25519);
}

/* engine.ts listedSiblings: a sibling our list no longer names is forgotten. */
static void listed_siblings(step *s) {
    for (size_t i = 0; i < s->st->nsiblings;) {
        if (our_list_names(s, s->st->siblings[i].ed25519)) i++;
        else forget_sibling(s, s->st->siblings[i].ed25519);
    }
}

/* engine.ts admit: a peer's claim on the curve goes; the sibling is set. */
static void admit(step *s, const char *ed25519, const char *curve, const char *did) {
    evict_claimant(s, curve, ed25519);
    e2e_sibling *sb = sibling_get(s->st, ed25519);
    if (sb) {
        sibling_free(sb);
    } else {
        sb = grow((void **)&s->st->siblings, &s->st->nsiblings, sizeof(*sb));
    }
    sb->ed25519 = xstrdup(ed25519);
    sb->curve25519 = xstrdup(curve);
    sb->did = xstrdup(did);
}

void e2e_set_siblings(const e2e_ctx *c, const e2e_id_block *blocks, size_t n, e2e_result *res) {
    step s;
    step_begin(&s, c, res);
    e2e_sibling *next = NULL;
    size_t nnext = 0;
    for (size_t i = 0; i < n; i++) {
        const e2e_id_block *b = &blocks[i];
        if (!b->ed25519 || !b->curve25519 || !b->sig || !our_list_names(&s, b->ed25519)) continue;
        char did[E2E_DID_LEN + 1];
        if (e2e_did(b->ed25519, did) && strcmp(did, s.own->did) == 0) continue;
        if (!did[0] || !id_signed(b, s.own->master)) {
            dropped(&s, c->own_nick, E2E_DROP_SIBLING_BAD_SIGNATURE, E2E_VERB_NONE, NULL);
            continue;
        }
        evict_claimant(&s, b->curve25519, b->ed25519);
        e2e_sibling *sb = grow((void **)&next, &nnext, sizeof(*sb));
        sb->ed25519 = xstrdup(b->ed25519);
        sb->did = xstrdup(did);
        sb->curve25519 = xstrdup(b->curve25519);
    }
    for (size_t i = 0; i < s.st->nsiblings;) {
        const e2e_sibling *known = &s.st->siblings[i];
        const e2e_sibling *kept = NULL;
        for (size_t k = 0; k < nnext && !kept; k++)
            if (strcmp(next[k].ed25519, known->ed25519) == 0) kept = &next[k];
        if (kept && strcmp(kept->curve25519, known->curve25519) == 0) i++;
        else forget_sibling(&s, known->ed25519);
    }
    for (size_t i = 0; i < s.st->nsiblings; i++) sibling_free(&s.st->siblings[i]);
    free(s.st->siblings);
    s.st->siblings = next;
    s.st->nsiblings = nnext;
    step_end(&s);
}

/* engine.ts sendCopies: what waits for sibling `ed25519`, in order, on
 * its newest session. */
static void send_copies(step *s, const char *ed25519_in) {
    char *ed25519 = xstrdup(ed25519_in);
    e2e_sibling *sb = sibling_get(s->st, ed25519);
    e2e_copy_queue *q = copyq_get(s->st, ed25519);
    if (!sb || !q) {
        copyq_delete(s->st, ed25519);
        free(ed25519);
        return;
    }
    char *curve = xstrdup(sb->curve25519), *did = xstrdup(sb->did);
    for (size_t k = 0; k < q->ncopies; k++) {
        char *inner = e2e_inner_copy(q->copies[k].peer, q->copies[k].body, q->copies[k].body_len);
        encrypted enc;
        bool ok = encrypt_on(s, curve, ed25519, inner, &enc);
        free(inner);
        if (!ok) {
            dropped(s, q->copies[k].peer, E2E_DROP_SIBLING_NO_KEYS, E2E_VERB_NONE,
                    "the session to the sibling no longer encrypts");
            continue;
        }
        char *pickle = vzs(vz_session_pickle(enc.session));
        vz_session_free(enc.session);
        e2e_session_set *set = sessions_get(s->st, curve);
        if (!pickle || !set) abort();
        free(set->pickles.v[0]);
        set->pickles.v[0] = pickle;
        e2e_body one = {did, enc.body};
        e2e_sibling_copy *cp = grow((void **)&s->res->copies, &s->res->ncopies, sizeof(*cp));
        cp->to = xstrdup(did);
        cp->payload = wire_of(s, enc.pre_key, &one, 1, &cp->verb);
        free(enc.body);
    }
    copyq_delete(s->st, ed25519);
    free(curve);
    free(did);
    free(ed25519);
}

void e2e_copy(const e2e_ctx *c, const char *peer, const char *body, size_t body_len,
              e2e_result *res) {
    step s;
    step_begin(&s, c, res);
    listed_siblings(&s);
    for (size_t i = 0; i < s.st->nsiblings; i++) {
        char *e = xstrdup(s.st->siblings[i].ed25519);
        live_copies(&s, e);
        e2e_copy_queue *q = copyq_get(s.st, e);
        if (!q) {
            q = grow((void **)&s.st->copyq, &s.st->ncopyq, sizeof(*q));
            q->ed25519 = xstrdup(e);
        }
        e2e_waiting_copy *w = grow((void **)&q->copies, &q->ncopies, sizeof(*w));
        w->peer = xstrdup(peer);
        w->body = xstrndup(body, body_len);
        w->body_len = body_len;
        w->at = now_of(&s);
        e2e_sibling *sb = sibling_get(s.st, e);
        if (sessions_count(s.st, sb->curve25519) > 0) {
            send_copies(&s, e);
        } else if (q->ncopies == 1) {
            e2e_event *ev1 = ev(&s, E2E_EV_SIBLING_KEYS_NEEDED, NULL);
            ev1->did = xstrdup(sb->did);
        }
        free(e);
    }
    step_end(&s);
}

/* engine.ts siblingEntry: -1 and the entry index, or why not. */
static int sibling_entry(step *s, const char *ed25519, const e2e_sibling *sb,
                         const e2e_payload *k, size_t *index) {
    if (strcmp(k->master.ed25519, s->own->master) != 0) return E2E_DROP_SIBLING_NOT_OURS;
    if (!e2e_valid_master_list(&k->master)) return E2E_DROP_SIBLING_BAD_SIGNATURE;
    size_t found = k->nentries;
    for (size_t i = 0; i < k->nentries && found == k->nentries; i++)
        if (strcmp(k->entries[i].id.ed25519, ed25519) == 0) found = i;
    bool listed = false;
    for (size_t i = 0; i < k->master.ndevices; i++)
        listed = listed || strcmp(k->master.devices[i], ed25519) == 0;
    if (found == k->nentries || strcmp(k->entries[found].id.curve25519, sb->curve25519) != 0 ||
        !listed)
        return E2E_DROP_SIBLING_UNKNOWN;
    if (!id_signed(&k->entries[found].id, s->own->master) || !otk_signed(&k->entries[found]))
        return E2E_DROP_SIBLING_BAD_SIGNATURE;
    *index = found;
    return -1;
}

void e2e_sibling_keys(const e2e_ctx *c, const char *did, const char *keys, e2e_result *res) {
    step s;
    step_begin(&s, c, res);
    listed_siblings(&s);
    e2e_sibling *sb = NULL;
    for (size_t i = 0; i < s.st->nsiblings && !sb; i++)
        if (strcmp(s.st->siblings[i].did, did) == 0) sb = &s.st->siblings[i];
    if (!sb) {
        if (keys) dropped(&s, c->own_nick, E2E_DROP_SIBLING_UNKNOWN, E2E_VERB_KEYS, NULL);
        step_end(&s);
        return;
    }
    char *e = xstrdup(sb->ed25519), *curve = xstrdup(sb->curve25519);
    live_copies(&s, e);
    if (keys) {
        e2e_payload k;
        bool undecodable;
        char err[80];
        if (!e2e_payload_parse(E2E_VERB_KEYS, keys, &k, &undecodable, err, sizeof(err))) {
            dropped(&s, c->own_nick, E2E_DROP_BAD_PAYLOAD, E2E_VERB_KEYS, err);
        } else {
            size_t index;
            int why = sibling_entry(&s, e, sibling_get(s.st, e), &k, &index);
            if (why >= 0) {
                dropped(&s, c->own_nick, (e2e_drop_reason)why, E2E_VERB_KEYS, NULL);
            } else if (sessions_count(s.st, curve) == 0) {
                vz_session *ss = vz_account_create_outbound_session(s.account, curve,
                                                                    k.entries[index].otk_key);
                if (!ss) {
                    dropped(&s, c->own_nick, E2E_DROP_BAD_PAYLOAD, E2E_VERB_KEYS, vz_last_error());
                } else {
                    char *pickle = vzs(vz_session_pickle(ss));
                    vz_session_free(ss);
                    if (!pickle) abort();
                    add_session(s.st, curve, pickle);
                    free(pickle);
                }
            }
            e2e_payload_free(&k);
        }
    }
    if (sessions_count(s.st, curve) > 0) send_copies(&s, e);
    else drop_copies(&s, e, E2E_DROP_SIBLING_NO_KEYS);
    free(e);
    free(curve);
    step_end(&s);
}

/* engine.ts readCopy: the body must be {t:"copy", peer, body}. */
static bool read_copy(step *s, const char *device, const vz_buf *plain, bool pre_key) {
    json_doc *d = inner_of(s, s->c->own_nick, plain, pre_key ? device : NULL);
    if (!d) return false;
    const json_value *root = json_root(d);
    const char *peer = str_field(root, "peer");
    const json_value *body = json_get(root, "body");
    bool ok = streq(str_field(root, "t"), "copy") && non_empty(peer) &&
              json_type_of(body) == JSON_STRING;
    if (!ok) {
        dropped(s, s->c->own_nick, E2E_DROP_SIBLING_NOT_A_COPY, E2E_VERB_NONE, NULL);
    } else {
        e2e_event *e = ev(s, E2E_EV_COPIED, NULL);
        e->peer = xstrdup(peer);
        e->body = xstrndup(json_string(body), json_string_len(body));
        e->body_len = json_string_len(body);
        e->device = xstrdup(device);
    }
    json_free(d);
    return ok;
}

static void on_copy_pkmsg(step *s, const char *from_did, const json_value *root, wire_fault *f) {
    const char *own_nick = s->c->own_nick;
    e2e_payload p = {0};
    char err[80];
    if (!parse_on(E2E_VERB_PKMSG, root, &p, err, sizeof(err))) {
        fault(f, err);
        return;
    }
    if (strcmp(p.cert_master, s->own->master) != 0) {
        dropped(s, own_nick, E2E_DROP_SIBLING_NOT_OURS, E2E_VERB_PKMSG, NULL);
        return;
    }
    uint8_t *body;
    size_t len;
    int why = presented(s, from_did, &p, &body, &len, f);
    if (f->bad) return;
    if (why >= 0) {
        if (why == E2E_DROP_BAD_CERT || why == E2E_DROP_BAD_IDENTITY_SIGNATURE)
            why = E2E_DROP_SIBLING_BAD_SIGNATURE;
        dropped(s, own_nick, (e2e_drop_reason)why, E2E_VERB_PKMSG, NULL);
        return;
    }
    if (!our_list_names(s, p.id.ed25519)) {
        dropped(s, own_nick,
                p.cert_ver > s->own->list_ver ? E2E_DROP_SIBLING_LIST_BEHIND
                                              : E2E_DROP_SIBLING_UNKNOWN,
                E2E_VERB_PKMSG, NULL);
        free(body);
        return;
    }
    char *session_id = vzs(vz_pre_key_session_id(body, len));
    if (!session_id) {
        fault_vz(f);
        free(body);
        return;
    }
    char *held = held_session(s, p.id.curve25519, session_id);
    vz_buf plain = {0};
    if (held) {
        if (!decrypt_with(s, p.id.curve25519, held, 0, body, len, &plain)) {
            dropped(s, own_nick, E2E_DROP_SIBLING_UNDECRYPTABLE, E2E_VERB_PKMSG, NULL);
        } else {
            read_copy(s, p.id.ed25519, &plain, true);
            vz_buf_free(plain);
        }
        free(held);
        free(session_id);
        free(body);
        return;
    }
    vz_session *ss;
    int opened = open_inbound(s, p.id.curve25519, body, len, session_id, &ss, &plain);
    free(session_id);
    free(body);
    if (opened >= 0) {
        dropped(s, own_nick, E2E_DROP_SIBLING_UNDECRYPTABLE, E2E_VERB_PKMSG, NULL);
        return;
    }
    bool ok = read_copy(s, p.id.ed25519, &plain, true);
    vz_buf_free(plain);
    if (ok) {
        admit(s, p.id.ed25519, p.id.curve25519, from_did);
        char *pickle = vzs(vz_session_pickle(ss));
        if (!pickle) abort();
        add_session(s->st, p.id.curve25519, pickle);
        free(pickle);
    }
    vz_session_free(ss);
}

static void on_copy_msg(step *s, const char *from_did, const json_value *root, wire_fault *f) {
    const char *own_nick = s->c->own_nick;
    e2e_payload p = {0};
    char err[80];
    if (!parse_on(E2E_VERB_MSG, root, &p, err, sizeof(err))) {
        fault(f, err);
        return;
    }
    char *curve = vzs(vz_canonical_curve25519(p.ck));
    if (!curve) {
        fault_vz(f);
        return;
    }
    e2e_sibling *sb = NULL;
    for (size_t i = 0; i < s->st->nsiblings && !sb; i++)
        if (strcmp(s->st->siblings[i].curve25519, curve) == 0) sb = &s->st->siblings[i];
    const char *mine = e2e_payload_body(&p, s->own->did);
    uint8_t *body = NULL;
    size_t len = 0;
    if (!sb) {
        dropped(s, own_nick, E2E_DROP_SIBLING_UNKNOWN, E2E_VERB_MSG, NULL);
    } else if (strcmp(sb->did, from_did) != 0) {
        dropped(s, own_nick, E2E_DROP_BAD_FROM, E2E_VERB_MSG, NULL);
    } else if (!mine) {
        dropped(s, own_nick, E2E_DROP_NOT_FOR_US, E2E_VERB_MSG, NULL);
    } else if (!e2e_unbase64(mine, &body, &len)) {
        fault(f, "not base64");
    } else {
        char *e = xstrdup(sb->ed25519);
        vz_buf plain = {0};
        if (!decrypt_any(s, curve, body, len, &plain)) {
            dropped(s, own_nick, E2E_DROP_SIBLING_UNDECRYPTABLE, E2E_VERB_MSG, NULL);
        } else {
            read_copy(s, e, &plain, false);
            vz_buf_free(plain);
        }
        free(e);
    }
    free(body);
    free(curve);
}

void e2e_receive_copy(const e2e_ctx *c, const char *from_did, e2e_verb verb, const char *payload,
                      e2e_result *res) {
    step s;
    step_begin(&s, c, res);
    listed_siblings(&s);
    json_doc *d = payload ? decode_object(payload, strlen(payload)) : NULL;
    if (!d) {
        dropped(&s, c->own_nick, E2E_DROP_UNDECODABLE_PAYLOAD, verb, NULL);
        step_end(&s);
        return;
    }
    wire_fault f = {0};
    if (verb == E2E_VERB_PKMSG) on_copy_pkmsg(&s, from_did, json_root(d), &f);
    else if (verb == E2E_VERB_MSG) on_copy_msg(&s, from_did, json_root(d), &f);
    else fault(&f, "a copy is a pkmsg or a msg");
    if (f.bad) dropped(&s, c->own_nick, E2E_DROP_BAD_PAYLOAD, verb, f.detail);
    json_free(d);
    step_end(&s);
}

/* ── Pairing (pairingMessages.ts; identity.ts startOver/prepareJoin/completeJoin) ── */

static const char *const PAIR_REFUSALS[] = {
    [E2E_PAIR_FULL] = "full",
    [E2E_PAIR_PAIRED] = "paired",
    [E2E_PAIR_LIST_CHANGED] = "list-changed",
    [E2E_PAIR_FAILED] = "failed",
};

const char *e2e_pair_refusal_name(e2e_pair_refusal r) {
    return (size_t)r < sizeof(PAIR_REFUSALS) / sizeof(PAIR_REFUSALS[0]) ? PAIR_REFUSALS[r] : "failed";
}

static bool pair_refusal_of(const char *s, e2e_pair_refusal *out) {
    for (size_t i = 0; s && i < sizeof(PAIR_REFUSALS) / sizeof(PAIR_REFUSALS[0]); i++) {
        if (strcmp(s, PAIR_REFUSALS[i]) == 0) {
            *out = (e2e_pair_refusal)i;
            return true;
        }
    }
    return false;
}

char *e2e_pair_wrap_initial(const char *message) {
    return e2e_base64url((const uint8_t *)message, strlen(message));
}

char *e2e_pair_unwrap_initial(const char *payload) {
    if (!payload || !payload[0]) return NULL;
    char *std = xstrdup(payload);
    for (char *p = std; *p; p++) {
        if (*p == '-') *p = '+';
        else if (*p == '_') *p = '/';
        else if (!((*p >= 'A' && *p <= 'Z') || (*p >= 'a' && *p <= 'z') || (*p >= '0' && *p <= '9'))) {
            free(std);
            return NULL;
        }
    }
    uint8_t *bytes;
    size_t len;
    bool ok = e2e_unbase64(std, &bytes, &len);
    free(std);
    if (!ok) return NULL;
    /* A fatal TextDecoder's UTF-8; and no NUL, which vodozemac's C side
     * would read as the end of the message. */
    if (!utf8_valid(bytes, len) || memchr(bytes, 0, len)) {
        free(bytes);
        return NULL;
    }
    char *out = xstrndup((const char *)bytes, len);
    free(bytes);
    return out;
}

/* `key` when it is the canonical spelling of an Ed25519 / Curve25519 key. */
static const char *pair_ed(const json_value *v) {
    const char *s = str_of(v);
    return s && e2e_ed25519_canonical(s) ? s : NULL;
}

static const char *pair_curve(const json_value *v) {
    const char *s = str_of(v);
    return s && e2e_curve25519_canonical(s) ? s : NULL;
}

static const char *pair_slug(const json_value *v) {
    const char *s = str_of(v);
    return s && s[0] ? s : NULL;
}

static const json_value *pair_array(const json_value *obj, const char *key) {
    const json_value *v = json_get(obj, key);
    return json_type_of(v) == JSON_ARRAY ? v : NULL;
}

/* Every element of `key` read as a slug; false for anything else. */
static bool pair_slugs(const json_value *obj, const char *key, const char ***out, size_t *n) {
    const json_value *a = pair_array(obj, key);
    if (!a) return false;
    *n = json_len(a);
    *out = xmalloc((*n ? *n : 1) * sizeof(**out));
    for (size_t i = 0; i < *n; i++)
        if (!((*out)[i] = pair_slug(json_at(a, i)))) return false;
    return true;
}

static bool pair_refusals(const json_value *obj, const char *key, e2e_pair_refused **out,
                          size_t *n) {
    const json_value *a = pair_array(obj, key);
    if (!a) return false;
    *n = json_len(a);
    *out = xmalloc((*n ? *n : 1) * sizeof(**out));
    for (size_t i = 0; i < *n; i++) {
        const json_value *r = json_at(a, i);
        if (json_type_of(r) != JSON_OBJECT) return false;
        (*out)[i].network = pair_slug(json_get(r, "network"));
        if (!(*out)[i].network || !pair_refusal_of(str_field(r, "reason"), &(*out)[i].reason))
            return false;
    }
    return true;
}

static bool pair_id_block(const json_value *v, e2e_id_block *out) {
    if (json_type_of(v) != JSON_OBJECT) return false;
    out->curve25519 = pair_curve(json_get(v, "curve25519"));
    out->ed25519 = pair_ed(json_get(v, "ed25519"));
    out->sig = str_field(v, "sig");
    return out->curve25519 && out->ed25519 && out->sig;
}

/* signedList: a number `ver`, every device a canonical key, a string sig.
 * The rules (sorted, 1..4, ver range, the signature) are acceptSigned's. */
static bool pair_signed_list(const json_value *v, e2e_master_list *out) {
    memset(out, 0, sizeof(*out));
    if (json_type_of(v) != JSON_OBJECT || !number_field(v, "ver", &out->ver)) return false;
    const json_value *devs = pair_array(v, "devices");
    out->sig = str_field(v, "sig");
    if (!devs || !out->sig) return false;
    out->ndevices = json_len(devs);
    for (size_t i = 0; i < out->ndevices; i++) {
        const char *k = pair_ed(json_at(devs, i));
        if (!k) return false;
        if (i < E2E_MAX_DEVICES) out->devices[i] = k;
    }
    return true;
}

static bool pair_fields(const json_value *o, e2e_pair_msg *m) {
    const char *t = str_field(o, "t");
    if (!t) return false;
    if (strcmp(t, "hello") == 0) {
        m->kind = E2E_PAIR_HELLO;
        return true;
    }
    if (strcmp(t, "offer") == 0) {
        m->kind = E2E_PAIR_OFFER;
        const json_value *a = pair_array(o, "networks");
        if (!a) return false;
        m->nnetworks = json_len(a);
        m->networks = xmalloc((m->nnetworks ? m->nnetworks : 1) * sizeof(*m->networks));
        for (size_t i = 0; i < m->nnetworks; i++) {
            const json_value *n = json_at(a, i);
            if (json_type_of(n) != JSON_OBJECT) return false;
            m->networks[i].network = pair_slug(json_get(n, "network"));
            m->networks[i].master = pair_ed(json_get(n, "master"));
            if (!m->networks[i].network || !m->networks[i].master) return false;
        }
        return pair_slugs(o, "full", &m->full, &m->nfull);
    }
    if (strcmp(t, "join") == 0) {
        m->kind = E2E_PAIR_JOIN;
        const json_value *a = pair_array(o, "devices");
        if (!a) return false;
        m->ndevices = json_len(a);
        m->devices = xmalloc((m->ndevices ? m->ndevices : 1) * sizeof(*m->devices));
        for (size_t i = 0; i < m->ndevices; i++) {
            const json_value *d = json_at(a, i);
            if (json_type_of(d) != JSON_OBJECT) return false;
            m->devices[i].network = pair_slug(json_get(d, "network"));
            if (!m->devices[i].network || !pair_id_block(json_get(d, "id"), &m->devices[i].id))
                return false;
        }
        return pair_refusals(o, "skipped", &m->refused, &m->nrefused);
    }
    if (strcmp(t, "signed") == 0) {
        m->kind = E2E_PAIR_SIGNED;
        const json_value *a = pair_array(o, "devices");
        if (!a) return false;
        m->nsigned = json_len(a);
        m->signed_ = xmalloc((m->nsigned ? m->nsigned : 1) * sizeof(*m->signed_));
        for (size_t i = 0; i < m->nsigned; i++) {
            const json_value *d = json_at(a, i);
            if (json_type_of(d) != JSON_OBJECT) return false;
            m->signed_[i].network = pair_slug(json_get(d, "network"));
            m->signed_[i].cert = str_field(d, "cert");
            if (!m->signed_[i].network || !m->signed_[i].cert ||
                !pair_signed_list(json_get(d, "list"), &m->signed_[i].list))
                return false;
        }
        return pair_refusals(o, "refused", &m->refused, &m->nrefused);
    }
    if (strcmp(t, "done") == 0) {
        m->kind = E2E_PAIR_DONE;
        return pair_slugs(o, "paired", &m->paired, &m->npaired);
    }
    return false;
}

bool e2e_pair_decode(const uint8_t *bytes, size_t len, e2e_pair_msg *out) {
    memset(out, 0, sizeof(*out));
    if (!bytes || !utf8_valid(bytes, len)) return false;
    json_doc *d = decode_object((const char *)bytes, len);
    if (!d) return false;
    out->doc = d;
    const json_value *o = json_root(d);
    double v;
    if (!number_field(o, "v", &v) || v != 1 || !pair_fields(o, out)) {
        e2e_pair_msg_free(out);
        return false;
    }
    return true;
}

void e2e_pair_msg_free(e2e_pair_msg *m) {
    json_free(m->doc);
    free(m->networks);
    free(m->full);
    free(m->devices);
    free(m->refused);
    free(m->signed_);
    free(m->paired);
    memset(m, 0, sizeof(*m));
}

static void pair_open(json_buf *b, const char *t) {
    jb_init(b);
    jb_obj_open(b);
    jb_key(b, "v");
    jb_num(b, 1);
    jb_key(b, "t");
    jb_str(b, t);
}

static void pair_write_slugs(json_buf *b, const char *key, const char *const *s, size_t n) {
    jb_key(b, key);
    jb_arr_open(b);
    for (size_t i = 0; i < n; i++) jb_str(b, s[i]);
    jb_arr_close(b);
}

static void pair_write_refusals(json_buf *b, const char *key, const e2e_pair_refused *r,
                                size_t n) {
    jb_key(b, key);
    jb_arr_open(b);
    for (size_t i = 0; i < n; i++) {
        jb_obj_open(b);
        jb_key(b, "network");
        jb_str(b, r[i].network);
        jb_key(b, "reason");
        jb_str(b, e2e_pair_refusal_name(r[i].reason));
        jb_obj_close(b);
    }
    jb_arr_close(b);
}

static char *pair_close(json_buf *b) {
    jb_obj_close(b);
    return take(b);
}

char *e2e_pair_hello(void) {
    json_buf b;
    pair_open(&b, "hello");
    return pair_close(&b);
}

char *e2e_pair_offer(const e2e_pair_offered *networks, size_t n, const char *const *full,
                     size_t nfull) {
    json_buf b;
    pair_open(&b, "offer");
    jb_key(&b, "networks");
    jb_arr_open(&b);
    for (size_t i = 0; i < n; i++) {
        jb_obj_open(&b);
        jb_key(&b, "network");
        jb_str(&b, networks[i].network);
        jb_key(&b, "master");
        jb_str(&b, networks[i].master);
        jb_obj_close(&b);
    }
    jb_arr_close(&b);
    pair_write_slugs(&b, "full", full, nfull);
    return pair_close(&b);
}

char *e2e_pair_join(const e2e_pair_device *devices, size_t n, const e2e_pair_refused *skipped,
                    size_t nskipped) {
    json_buf b;
    pair_open(&b, "join");
    jb_key(&b, "devices");
    jb_arr_open(&b);
    for (size_t i = 0; i < n; i++) {
        jb_obj_open(&b);
        jb_key(&b, "network");
        jb_str(&b, devices[i].network);
        write_id_block(&b, devices[i].id.curve25519, devices[i].id.ed25519, devices[i].id.sig);
        jb_obj_close(&b);
    }
    jb_arr_close(&b);
    pair_write_refusals(&b, "skipped", skipped, nskipped);
    return pair_close(&b);
}

char *e2e_pair_signed(const e2e_pair_signed_entry *devices, size_t n,
                      const e2e_pair_refused *refused, size_t nrefused) {
    json_buf b;
    pair_open(&b, "signed");
    jb_key(&b, "devices");
    jb_arr_open(&b);
    for (size_t i = 0; i < n; i++) {
        const e2e_master_list *l = &devices[i].list;
        jb_obj_open(&b);
        jb_key(&b, "network");
        jb_str(&b, devices[i].network);
        jb_key(&b, "cert");
        jb_str(&b, devices[i].cert);
        jb_key(&b, "list");
        jb_obj_open(&b);
        jb_key(&b, "ver");
        jb_num(&b, l->ver);
        pair_write_slugs(&b, "devices", l->devices, l->ndevices < E2E_MAX_DEVICES ? l->ndevices : E2E_MAX_DEVICES);
        jb_key(&b, "sig");
        jb_str(&b, l->sig);
        jb_obj_close(&b);
        jb_obj_close(&b);
    }
    jb_arr_close(&b);
    pair_write_refusals(&b, "refused", refused, nrefused);
    return pair_close(&b);
}

char *e2e_pair_done(const char *const *paired, size_t n) {
    json_buf b;
    pair_open(&b, "done");
    pair_write_slugs(&b, "paired", paired, n);
    return pair_close(&b);
}

bool e2e_pair_id_block(vz_account *device, const char *master, char **curve25519, char **ed25519,
                       char **sig) {
    return id_block_sign(device, master, curve25519, ed25519, sig);
}

static int cmp_str(const void *a, const void *b) {
    return strcmp(*(const char *const *)a, *(const char *const *)b);
}

void e2e_pair_issued_free(e2e_pair_issued *i) {
    strv_free(&i->devices);
    free(i->sig);
    free(i->cert);
    memset(i, 0, sizeof(*i));
}

bool e2e_pair_issue(vz_account *master_acct, const e2e_own *own, const e2e_id_block *joiner,
                    e2e_pair_issued *out, e2e_pair_refusal *why) {
    memset(out, 0, sizeof(*out));
    *why = E2E_PAIR_FAILED;
    if (!joiner->curve25519 || !joiner->ed25519 || !joiner->sig ||
        !e2e_curve25519_canonical(joiner->curve25519) || !e2e_ed25519_canonical(joiner->ed25519))
        return false;
    char *text = e2e_id_sig_text(joiner->curve25519, own->master);
    bool vouches = vz_verify_ed25519(joiner->ed25519, text, joiner->sig) == 1;
    free(text);
    if (!vouches) return false;
    if (strv_has(&own->list_devices, joiner->ed25519)) {
        *why = E2E_PAIR_PAIRED;
        return false;
    }
    if (own->list_devices.n >= E2E_DEVICE_CAP) {
        *why = E2E_PAIR_FULL;
        return false;
    }
    long ver = own->list_ver + 1;
    if (ver > E2E_MAX_VER) return false;
    out->ver = ver;
    out->devices = strv_dup(&own->list_devices);
    strv_push(&out->devices, joiner->ed25519);
    qsort(out->devices.v, out->devices.n, sizeof(*out->devices.v), cmp_str);
    out->sig = e2e_sign_list(master_acct, ver, (const char *const *)out->devices.v, out->devices.n);
    out->cert = e2e_sign_cert(master_acct, ver, joiner->ed25519);
    if (!out->sig || !out->cert) {
        e2e_pair_issued_free(out);
        return false;
    }
    return true;
}

bool e2e_pair_accept_signed(const char *master, vz_account *device,
                            const e2e_pair_signed_entry *entry, e2e_own *out) {
    memset(out, 0, sizeof(*out));
    e2e_master_list l = entry->list;
    l.ed25519 = master;
    if (!e2e_valid_master_list(&l)) return false;
    char *e = vzs(vz_account_ed25519_key(device));
    if (!e) abort();
    char did[E2E_DID_LEN + 1];
    bool ok = list_names(&l, e) && e2e_did(e, did);
    long ver = (long)l.ver;
    char *text = e2e_cert_sig_text(ver, e);
    ok = ok && entry->cert && vz_verify_ed25519(master, text, entry->cert) == 1;
    free(text);
    free(e);
    if (!ok) return false;
    out->master = xstrdup(master);
    out->cert = xstrdup(entry->cert);
    out->cert_ver = ver;
    out->list_ver = ver;
    for (size_t i = 0; i < l.ndevices; i++) strv_push(&out->list_devices, l.devices[i]);
    out->list_sig = xstrdup(l.sig);
    out->did = xstrdup(did);
    return true;
}

void e2e_record_start_over(e2e_record *r) {
    vz_account_free(r->account);
    r->account = vz_account_new();
    if (!r->account) abort();
    vz_account_free(r->master);
    r->master = NULL;
    if (r->own) {
        e2e_own_free(r->own);
        free(r->own);
        r->own = NULL;
    }
    /* The trust placed in others stays: their masters, devices and pins.
     * Everything bound to the old device account goes. */
    e2e_state kept;
    e2e_state_init(&kept);
    kept.masters = r->state.masters;
    kept.nmasters = r->state.nmasters;
    kept.devices = r->state.devices;
    kept.ndevices = r->state.ndevices;
    r->state.masters = NULL;
    r->state.nmasters = 0;
    r->state.devices = NULL;
    r->state.ndevices = 0;
    for (size_t i = 0; i < r->state.npeers; i++) {
        e2e_peer *p = &r->state.peers[i];
        if (!p->pin) continue;
        kept.peers = xrealloc(kept.peers, (kept.npeers + 1) * sizeof(*kept.peers));
        e2e_peer *q = &kept.peers[kept.npeers++];
        memset(q, 0, sizeof(*q));
        q->key = xstrdup(p->key);
        q->pin = xstrdup(p->pin);
    }
    e2e_state_free(&r->state);
    r->state = kept;
}

/* Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's
 * days_from_civil). */
static int64_t days_from_civil(int64_t y, int64_t m, int64_t d) {
    y -= m <= 2;
    int64_t era = (y >= 0 ? y : y - 399) / 400;
    int64_t yoe = y - era * 400;
    int64_t doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
    int64_t doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return era * 146097 + doe - 719468;
}

static bool digits(const char *s, int n, int *out) {
    int v = 0;
    for (int i = 0; i < n; i++) {
        if (s[i] < '0' || s[i] > '9') return false;
        v = v * 10 + (s[i] - '0');
    }
    *out = v;
    return true;
}

bool e2e_iso8601_seconds(const char *s, int64_t *out) {
    int y, mo, d, h, mi, se;
    if (!s || strlen(s) < 20 || !digits(s, 4, &y) || s[4] != '-' || !digits(s + 5, 2, &mo) ||
        s[7] != '-' || !digits(s + 8, 2, &d) || (s[10] != 'T' && s[10] != ' ') ||
        !digits(s + 11, 2, &h) || s[13] != ':' || !digits(s + 14, 2, &mi) || s[16] != ':' ||
        !digits(s + 17, 2, &se))
        return false;
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 60) return false;
    const char *p = s + 19;
    if (*p == '.') {
        p++;
        if (*p < '0' || *p > '9') return false;
        while (*p >= '0' && *p <= '9') p++;
    }
    int64_t offset = 0;
    if (*p == 'Z' && !p[1]) {
        /* UTC */
    } else if ((*p == '+' || *p == '-') && strlen(p) == 6 && p[3] == ':') {
        int oh, om;
        if (!digits(p + 1, 2, &oh) || !digits(p + 4, 2, &om) || oh > 23 || om > 59) return false;
        offset = (oh * 3600 + om * 60) * (*p == '+' ? 1 : -1);
    } else {
        return false;
    }
    *out = days_from_civil(y, mo, d) * 86400 + h * 3600 + mi * 60 + se - offset;
    return true;
}

/* ── Decrypted history ───────────────────────────────────────────────── */

const char *e2e_row_kind_name(e2e_row_kind k) {
    switch (k) {
    case E2E_ROW_IN: return "in";
    case E2E_ROW_OUT: return "out";
    case E2E_ROW_UNDECRYPTABLE: return "undecryptable";
    case E2E_ROW_KEY_ALARM: return "key_alarm";
    case E2E_ROW_PINNED: return "pinned";
    case E2E_ROW_ACCEPTED: return "accepted";
    case E2E_ROW_VERIFIED: return "verified";
    case E2E_ROW_SAS_ASKED: return "sas_asked";
    case E2E_ROW_SAS_CANCELLED: return "sas_cancelled";
    }
    return "unknown";
}

void e2e_row_free(e2e_row *r) {
    if (!r) return;
    free(r->id);
    free(r->nick);
    free(r->body);
    free(r->key);
    memset(r, 0, sizeof(*r));
}

void e2e_rows_free(e2e_rows *r) {
    for (size_t i = 0; i < r->n; i++) e2e_row_free(&r->v[i]);
    free(r->v);
    r->v = NULL;
    r->n = 0;
}

/* Which fields each kind carries: what a row is written with, and what a
 * read refuses to be without. */
static bool row_has_body(e2e_row_kind k) {
    return k == E2E_ROW_IN || k == E2E_ROW_OUT || k == E2E_ROW_UNDECRYPTABLE ||
           k == E2E_ROW_SAS_CANCELLED;
}
static bool row_has_key(e2e_row_kind k) {
    return k == E2E_ROW_IN || k == E2E_ROW_KEY_ALARM || k == E2E_ROW_PINNED ||
           k == E2E_ROW_ACCEPTED || k == E2E_ROW_VERIFIED;
}
static bool row_has_by(e2e_row_kind k) {
    return k == E2E_ROW_SAS_ASKED || k == E2E_ROW_SAS_CANCELLED;
}

char *e2e_row_to_json(const e2e_row *r) {
    json_buf b;
    jb_init(&b);
    jb_obj_open(&b);
    jb_key(&b, "v");
    jb_num(&b, 1);
    jb_key(&b, "id");
    jb_str(&b, r->id);
    jb_key(&b, "kind");
    jb_str(&b, e2e_row_kind_name(r->kind));
    jb_key(&b, "at");
    jb_num(&b, (double)r->at);
    jb_key(&b, "nick");
    jb_str(&b, r->nick);
    if (row_has_body(r->kind)) {
        jb_key(&b, "body");
        jb_strn(&b, r->body ? r->body : "", r->body ? r->body_len : 0);
    }
    if (row_has_key(r->kind)) {
        jb_key(&b, "key");
        jb_str(&b, r->key ? r->key : "");
    }
    if (row_has_by(r->kind)) {
        jb_key(&b, "by");
        jb_str(&b, r->by_peer ? "peer" : "you");
    }
    jb_obj_close(&b);
    char *out = jb_take(&b);
    if (!out) abort();
    return out;
}

bool e2e_row_from_json(const char *text, size_t len, e2e_row *out) {
    memset(out, 0, sizeof(*out));
    json_doc *d = json_parse(text, len, NULL, 0);
    if (!d) return false;
    const json_value *o = json_root(d);
    double v, at;
    const char *kind = json_string(json_get(o, "kind"));
    const char *id = json_string(json_get(o, "id"));
    const char *nick = json_string(json_get(o, "nick"));
    bool ok = json_type_of(o) == JSON_OBJECT && json_number(json_get(o, "v"), &v) && v == 1 &&
              id && id[0] && nick && nick[0] && kind && json_number(json_get(o, "at"), &at) &&
              at >= 0 && at < 9e15 && at == floor(at);
    e2e_row_kind k = E2E_ROW_IN;
    if (ok) {
        bool named = false;
        for (int i = E2E_ROW_IN; !named && i <= E2E_ROW_SAS_CANCELLED; i++)
            if (strcmp(kind, e2e_row_kind_name((e2e_row_kind)i)) == 0) {
                k = (e2e_row_kind)i;
                named = true;
            }
        ok = named;
    }
    const json_value *body = json_get(o, "body");
    const char *key = json_string(json_get(o, "key"));
    const char *by = json_string(json_get(o, "by"));
    if (ok && row_has_body(k) && !json_string(body)) ok = false;
    if (ok && row_has_key(k) && !key) ok = false;
    if (ok && row_has_by(k) && !streq(by, "you") && !streq(by, "peer")) ok = false;
    if (ok) {
        out->id = xstrdup(id);
        out->kind = k;
        out->at = (int64_t)at;
        out->nick = xstrdup(nick);
        if (row_has_body(k)) {
            out->body_len = json_string_len(body);
            out->body = xstrndup(json_string(body), out->body_len);
        }
        if (row_has_key(k)) out->key = xstrdup(key);
        out->by_peer = row_has_by(k) && streq(by, "peer");
    }
    json_free(d);
    return ok;
}

/* ── Trust as the history records it ─────────────────────────────────── */

const char *e2e_open_alarm(const e2e_rows *rows, const char *nick) {
    for (size_t i = rows->n; i > 0; i--) {
        const e2e_row *r = &rows->v[i - 1];
        if (!e2e_nick_eq(r->nick, nick)) continue;
        if (r->kind == E2E_ROW_KEY_ALARM) return r->key;
        if (r->kind == E2E_ROW_PINNED || r->kind == E2E_ROW_ACCEPTED || r->kind == E2E_ROW_VERIFIED)
            return NULL;
    }
    return NULL;
}

const e2e_row *e2e_last_comparison(const e2e_rows *rows, const char *nick) {
    for (size_t i = rows->n; i > 0; i--) {
        const e2e_row *r = &rows->v[i - 1];
        if (!e2e_nick_eq(r->nick, nick)) continue;
        if (r->kind == E2E_ROW_PINNED || r->kind == E2E_ROW_ACCEPTED) return NULL;
        if (r->kind == E2E_ROW_VERIFIED || r->kind == E2E_ROW_SAS_CANCELLED) return r;
    }
    return NULL;
}

char *e2e_chat_file_name(const char *nick) {
    char *folded = e2e_fold(nick);
    char sha[65];
    e2e_line_sha256(folded, strlen(folded), sha);
    free(folded);
    return xprintf("chat-sha256-%s.jsonl", sha);
}


static void fsync_dir(const char *dir) {
    int dfd = open(dir, O_RDONLY | O_CLOEXEC);
    if (dfd >= 0) {
        fsync(dfd);
        close(dfd);
    }
}

/* A torn last line — a crash inside a write — cut off, so the next line
 * does not land glued to its remains. */
static bool cut_torn_tail(int fd) {
    struct stat st;
    if (fstat(fd, &st) != 0) return false;
    off_t size = st.st_size;
    if (size == 0) return true;
    char last;
    if (pread(fd, &last, 1, size - 1) != 1) return false;
    if (last == '\n') return true;
    off_t keep = size - 1;
    char buf[4096];
    while (keep > 0) {
        off_t from = keep > (off_t)sizeof(buf) ? keep - (off_t)sizeof(buf) : 0;
        ssize_t got = pread(fd, buf, (size_t)(keep - from), from);
        if (got != keep - from) return false;
        ssize_t i = got;
        while (i > 0 && buf[i - 1] != '\n') i--;
        if (i > 0) {
            keep = from + i;
            break;
        }
        keep = from;
    }
    return ftruncate(fd, keep) == 0;
}

bool e2e_chat_append(const char *dir, const e2e_row *r, char *err, size_t err_sz) {
    if (!mkdir_p(dir)) {
        SETERR("cannot make %s: %s", dir, strerror(errno));
        return false;
    }
    char *name = e2e_chat_file_name(r->nick);
    char *path = xprintf("%s/%s", dir, name);
    free(name);
    struct stat st;
    bool fresh = stat(path, &st) != 0;
    int fd = open(path, O_RDWR | O_CREAT | O_APPEND | O_CLOEXEC, 0600);
    bool ok = fd >= 0;
    if (ok) {
        char *json = e2e_row_to_json(r);
        size_t n = strlen(json);
        json = xrealloc(json, n + 2);
        json[n] = '\n';
        json[n + 1] = 0;
        ok = fchmod(fd, 0600) == 0 && cut_torn_tail(fd) && write_all(fd, json, n + 1) &&
             fsync(fd) == 0;
        free(json);
        ok = close(fd) == 0 && ok;
    }
    if (!ok) SETERR("cannot write %s: %s", path, strerror(errno));
    else if (fresh) fsync_dir(dir);
    free(path);
    return ok;
}

/* The whole of a file, malloc'd (NUL-terminated); NULL on a read error. */
static char *read_file(const char *path, size_t *len) {
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    if (fd < 0) return NULL;
    size_t n = 0, cap = 4096;
    char *buf = xmalloc(cap);
    for (;;) {
        if (n + 1 >= cap) buf = xrealloc(buf, cap *= 2);
        ssize_t got = read(fd, buf + n, cap - n - 1);
        if (got < 0 && errno == EINTR) continue;
        if (got < 0) {
            close(fd);
            free(buf);
            return NULL;
        }
        if (got == 0) break;
        n += (size_t)got;
    }
    close(fd);
    buf[n] = 0;
    *len = n;
    return buf;
}

static bool rows_have_id(const e2e_rows *rows, size_t from, const char *id) {
    for (size_t i = rows->n; i > from; i--)
        if (strcmp(rows->v[i - 1].id, id) == 0) return true;
    return false;
}

static void rows_push(e2e_rows *rows, size_t *cap, e2e_row *r) {
    if (rows->n == *cap) rows->v = xrealloc(rows->v, (*cap = *cap ? *cap * 2 : 64) * sizeof(*rows->v));
    rows->v[rows->n++] = *r;
}

/* The newest `keep` rows of one chat, from `from` on in `rows`, written
 * over its file atomically. A failure leaves the old file: still readable,
 * only not compact. */
static void chat_compact(const char *dir, const char *path, const e2e_rows *rows, size_t from) {
    size_t n = rows->n - from;
    size_t first = from + (n > E2E_CHAT_ROWS_MAX ? n - E2E_CHAT_ROWS_MAX : 0);
    char *tmp = xprintf("%s.tmp.%ld", path, (long)getpid());
    int fd = open(tmp, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
    bool ok = fd >= 0;
    for (size_t i = first; ok && i < rows->n; i++) {
        char *json = e2e_row_to_json(&rows->v[i]);
        ok = write_all(fd, json, strlen(json)) && write_all(fd, "\n", 1);
        free(json);
    }
    if (fd >= 0) {
        ok = ok && fsync(fd) == 0;
        ok = close(fd) == 0 && ok;
    }
    if (ok && rename(tmp, path) == 0) fsync_dir(dir);
    else unlink(tmp);
    free(tmp);
}

typedef struct {
    int64_t at;
    size_t order;
    e2e_row row;
} ordered_row;

static int ordered_cmp(const void *a, const void *b) {
    const ordered_row *x = a, *y = b;
    if (x->at != y->at) return x->at < y->at ? -1 : 1;
    return x->order < y->order ? -1 : x->order > y->order;
}

/* The shape chat files had before the digest: "chat-" + the
 * lowercase hex of the folded nick + ".jsonl" — two bytes a nick byte, so
 * past ~120 bytes no filesystem takes the name. The folded nick it names
 * into `nick` (malloc'd), or false. "chat-sha256-…" is never one: `s` is
 * not a hex digit. */
static bool chat_legacy_name(const char *name, char **nick) {
    size_t n = strlen(name);
    if (n < 5 + 2 + 6 || strncmp(name, "chat-", 5) != 0 || strcmp(name + n - 6, ".jsonl") != 0)
        return false;
    size_t hexlen = n - 5 - 6;
    if (hexlen % 2) return false;
    char *out = xmalloc(hexlen / 2 + 1);
    for (size_t i = 0; i < hexlen / 2; i++) {
        int v = 0;
        for (int k = 0; k < 2; k++) {
            char c = name[5 + 2 * i + (size_t)k];
            int d = c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : -1;
            if (d < 0) {
                free(out);
                return false;
            }
            v = v * 16 + d;
        }
        if (v == 0) {
            free(out);
            return false;
        }
        out[i] = (char)v;
    }
    out[hexlen / 2] = 0;
    *nick = out;
    return true;
}

/* Old-named chat files under the new names, before a load reads them:
 * renamed, or — when the new file exists too (written since, or a merge a
 * crash interrupted) — appended to it, then removed. A repeated row is the
 * load's business (it keeps the first of an id and compacts). Collected
 * first and moved after the directory is closed: a rename while readdir
 * walks may show the same file twice. A failure leaves the old file, which
 * the load still reads, and is said in `err`. */
static bool chat_migrate(const char *dir, char *err, size_t err_sz) {
    DIR *d = opendir(dir);
    if (!d) return true; /* the load says why */
    char **names = NULL;
    size_t n = 0;
    struct dirent *ent;
    while ((ent = readdir(d)) != NULL) {
        char *nick;
        if (!chat_legacy_name(ent->d_name, &nick)) continue;
        free(nick);
        names = xrealloc(names, (n + 1) * sizeof(*names));
        names[n++] = xstrdup(ent->d_name);
    }
    closedir(d);
    bool ok = true;
    for (size_t i = 0; i < n; i++) {
        char *nick = NULL;
        chat_legacy_name(names[i], &nick);
        char *fresh = e2e_chat_file_name(nick);
        char *from = xprintf("%s/%s", dir, names[i]);
        char *to = xprintf("%s/%s", dir, fresh);
        struct stat st;
        bool moved;
        if (stat(to, &st) != 0) {
            /* 0600 as every chat file is, whatever the old one had. */
            moved = chmod(from, 0600) == 0 && rename(from, to) == 0;
        } else {
            size_t len = 0;
            char *text = read_file(from, &len);
            int fd = text ? open(to, O_RDWR | O_APPEND | O_CLOEXEC) : -1;
            moved = fd >= 0 && cut_torn_tail(fd) && write_all(fd, text, len) &&
                    (len == 0 || text[len - 1] == '\n' || write_all(fd, "\n", 1)) &&
                    fsync(fd) == 0;
            if (fd >= 0) moved = close(fd) == 0 && moved;
            free(text);
            if (moved) moved = unlink(from) == 0;
        }
        if (!moved && ok) {
            SETERR("cannot move %s to %s: %s", from, to, strerror(errno));
            ok = false;
        }
        free(nick);
        free(fresh);
        free(from);
        free(to);
        free(names[i]);
    }
    free(names);
    if (n) fsync_dir(dir);
    return ok;
}

bool e2e_chat_load(const char *dir, e2e_rows *out, char *err, size_t err_sz) {
    out->v = NULL;
    out->n = 0;
    bool migrated = chat_migrate(dir, err, err_sz);
    DIR *d = opendir(dir);
    if (!d) {
        if (errno == ENOENT) return true;
        SETERR("cannot read %s: %s", dir, strerror(errno));
        return false;
    }
    size_t cap = 0;
    bool ok = migrated;
    struct dirent *ent;
    while ((ent = readdir(d)) != NULL) {
        size_t nl = strlen(ent->d_name);
        if (nl < 11 || strncmp(ent->d_name, "chat-", 5) != 0 ||
            strcmp(ent->d_name + nl - 6, ".jsonl") != 0)
            continue;
        char *path = xprintf("%s/%s", dir, ent->d_name);
        size_t len;
        char *text = read_file(path, &len);
        if (!text) {
            SETERR("cannot read %s: %s", path, strerror(errno));
            free(path);
            ok = false;
            continue;
        }
        size_t from = out->n;
        bool untidy = false;
        size_t lines = 0;
        for (char *p = text; p < text + len;) {
            char *nl2 = memchr(p, '\n', (size_t)(text + len - p));
            if (!nl2) {
                untidy = true; /* torn: no newline ends it */
                break;
            }
            lines++;
            e2e_row r;
            if (!e2e_row_from_json(p, (size_t)(nl2 - p), &r)) untidy = true;
            else if (rows_have_id(out, from, r.id)) {
                untidy = true;
                e2e_row_free(&r);
            } else {
                rows_push(out, &cap, &r);
            }
            p = nl2 + 1;
        }
        free(text);
        size_t kept = out->n - from;
        if (untidy || lines > 2 * E2E_CHAT_ROWS_MAX) chat_compact(dir, path, out, from);
        if (kept > E2E_CHAT_ROWS_MAX) {
            /* What a compaction keeps is what the load answers. */
            size_t drop = kept - E2E_CHAT_ROWS_MAX;
            for (size_t i = from; i < from + drop; i++) e2e_row_free(&out->v[i]);
            memmove(out->v + from, out->v + from + drop, (out->n - from - drop) * sizeof(*out->v));
            out->n -= drop;
        }
        free(path);
    }
    closedir(d);
    if (out->n > 1) {
        ordered_row *o = xmalloc(out->n * sizeof(*o));
        for (size_t i = 0; i < out->n; i++) o[i] = (ordered_row){out->v[i].at, i, out->v[i]};
        qsort(o, out->n, sizeof(*o), ordered_cmp);
        for (size_t i = 0; i < out->n; i++) out->v[i] = o[i].row;
        free(o);
    }
    return ok;
}

/* ── Own devices (identity.ts revokeDevice) ──────────────────────────── */

bool e2e_own_revoked(const e2e_record *r, const char *ed25519, e2e_own *out, bool *unlisted) {
    *unlisted = false;
    if (!r->own || !r->master || !ed25519) return false;
    char *e = vzs(vz_account_ed25519_key(r->account));
    if (!e) abort();
    bool self = strcmp(e, ed25519) == 0;
    free(e);
    if (self) return false;
    if (!strv_has(&r->own->list_devices, ed25519)) {
        *unlisted = true;
        return false;
    }
    long ver = r->own->list_ver + 1;
    if (ver > E2E_MAX_VER) return false;
    const char *rest[E2E_MAX_DEVICES];
    size_t n = 0;
    for (size_t i = 0; i < r->own->list_devices.n && n < E2E_MAX_DEVICES; i++)
        if (strcmp(r->own->list_devices.v[i], ed25519) != 0) rest[n++] = r->own->list_devices.v[i];
    char *sig = e2e_sign_list(r->master, ver, rest, n);
    if (!sig) return false;
    own_copy(r->own, out);
    strv_free(&out->list_devices);
    for (size_t i = 0; i < n; i++) strv_push(&out->list_devices, rest[i]);
    free(out->list_sig);
    out->list_sig = sig;
    out->list_ver = ver;
    return true;
}

/* ── SAS (sas.ts) ────────────────────────────────────────────────────── */

/* Matrix's sas-emoji.json @7aaeac07, as sasEmoji.ts holds it: index,
 * glyph (UTF-8 bytes), English name. */
static const struct {
    const char *glyph, *name;
} SAS_EMOJI[64] = {
    {"\xF0\x9F\x90\xB6", "Dog"}, /* 0 🐶 */
    {"\xF0\x9F\x90\xB1", "Cat"}, /* 1 🐱 */
    {"\xF0\x9F\xA6\x81", "Lion"}, /* 2 🦁 */
    {"\xF0\x9F\x90\x8E", "Horse"}, /* 3 🐎 */
    {"\xF0\x9F\xA6\x84", "Unicorn"}, /* 4 🦄 */
    {"\xF0\x9F\x90\xB7", "Pig"}, /* 5 🐷 */
    {"\xF0\x9F\x90\x98", "Elephant"}, /* 6 🐘 */
    {"\xF0\x9F\x90\xB0", "Rabbit"}, /* 7 🐰 */
    {"\xF0\x9F\x90\xBC", "Panda"}, /* 8 🐼 */
    {"\xF0\x9F\x90\x93", "Rooster"}, /* 9 🐓 */
    {"\xF0\x9F\x90\xA7", "Penguin"}, /* 10 🐧 */
    {"\xF0\x9F\x90\xA2", "Turtle"}, /* 11 🐢 */
    {"\xF0\x9F\x90\x9F", "Fish"}, /* 12 🐟 */
    {"\xF0\x9F\x90\x99", "Octopus"}, /* 13 🐙 */
    {"\xF0\x9F\xA6\x8B", "Butterfly"}, /* 14 🦋 */
    {"\xF0\x9F\x8C\xB7", "Flower"}, /* 15 🌷 */
    {"\xF0\x9F\x8C\xB3", "Tree"}, /* 16 🌳 */
    {"\xF0\x9F\x8C\xB5", "Cactus"}, /* 17 🌵 */
    {"\xF0\x9F\x8D\x84", "Mushroom"}, /* 18 🍄 */
    {"\xF0\x9F\x8C\x8F", "Globe"}, /* 19 🌏 */
    {"\xF0\x9F\x8C\x99", "Moon"}, /* 20 🌙 */
    {"\xE2\x98\x81\xEF\xB8\x8F", "Cloud"}, /* 21 ☁️ */
    {"\xF0\x9F\x94\xA5", "Fire"}, /* 22 🔥 */
    {"\xF0\x9F\x8D\x8C", "Banana"}, /* 23 🍌 */
    {"\xF0\x9F\x8D\x8E", "Apple"}, /* 24 🍎 */
    {"\xF0\x9F\x8D\x93", "Strawberry"}, /* 25 🍓 */
    {"\xF0\x9F\x8C\xBD", "Corn"}, /* 26 🌽 */
    {"\xF0\x9F\x8D\x95", "Pizza"}, /* 27 🍕 */
    {"\xF0\x9F\x8E\x82", "Cake"}, /* 28 🎂 */
    {"\xE2\x9D\xA4\xEF\xB8\x8F", "Heart"}, /* 29 ❤️ */
    {"\xF0\x9F\x98\x80", "Smiley"}, /* 30 😀 */
    {"\xF0\x9F\xA4\x96", "Robot"}, /* 31 🤖 */
    {"\xF0\x9F\x8E\xA9", "Hat"}, /* 32 🎩 */
    {"\xF0\x9F\x91\x93", "Glasses"}, /* 33 👓 */
    {"\xF0\x9F\x94\xA7", "Spanner"}, /* 34 🔧 */
    {"\xF0\x9F\x8E\x85", "Santa"}, /* 35 🎅 */
    {"\xF0\x9F\x91\x8D", "Thumbs Up"}, /* 36 👍 */
    {"\xE2\x98\x82\xEF\xB8\x8F", "Umbrella"}, /* 37 ☂️ */
    {"\xE2\x8C\x9B", "Hourglass"}, /* 38 ⌛ */
    {"\xE2\x8F\xB0", "Clock"}, /* 39 ⏰ */
    {"\xF0\x9F\x8E\x81", "Gift"}, /* 40 🎁 */
    {"\xF0\x9F\x92\xA1", "Light Bulb"}, /* 41 💡 */
    {"\xF0\x9F\x93\x95", "Book"}, /* 42 📕 */
    {"\xE2\x9C\x8F\xEF\xB8\x8F", "Pencil"}, /* 43 ✏️ */
    {"\xF0\x9F\x93\x8E", "Paperclip"}, /* 44 📎 */
    {"\xE2\x9C\x82\xEF\xB8\x8F", "Scissors"}, /* 45 ✂️ */
    {"\xF0\x9F\x94\x92", "Lock"}, /* 46 🔒 */
    {"\xF0\x9F\x94\x91", "Key"}, /* 47 🔑 */
    {"\xF0\x9F\x94\xA8", "Hammer"}, /* 48 🔨 */
    {"\xE2\x98\x8E\xEF\xB8\x8F", "Telephone"}, /* 49 ☎️ */
    {"\xF0\x9F\x8F\x81", "Flag"}, /* 50 🏁 */
    {"\xF0\x9F\x9A\x82", "Train"}, /* 51 🚂 */
    {"\xF0\x9F\x9A\xB2", "Bicycle"}, /* 52 🚲 */
    {"\xE2\x9C\x88\xEF\xB8\x8F", "Aeroplane"}, /* 53 ✈️ */
    {"\xF0\x9F\x9A\x80", "Rocket"}, /* 54 🚀 */
    {"\xF0\x9F\x8F\x86", "Trophy"}, /* 55 🏆 */
    {"\xE2\x9A\xBD", "Ball"}, /* 56 ⚽ */
    {"\xF0\x9F\x8E\xB8", "Guitar"}, /* 57 🎸 */
    {"\xF0\x9F\x8E\xBA", "Trumpet"}, /* 58 🎺 */
    {"\xF0\x9F\x94\x94", "Bell"}, /* 59 🔔 */
    {"\xE2\x9A\x93", "Anchor"}, /* 60 ⚓ */
    {"\xF0\x9F\x8E\xA7", "Headphones"}, /* 61 🎧 */
    {"\xF0\x9F\x93\x81", "Folder"}, /* 62 📁 */
    {"\xF0\x9F\x93\x8C", "Pin"}, /* 63 📌 */
};

const char *e2e_sas_emoji_glyph(unsigned index) { return index < 64 ? SAS_EMOJI[index].glyph : NULL; }
const char *e2e_sas_emoji_name(unsigned index) { return index < 64 ? SAS_EMOJI[index].name : NULL; }

void e2e_sas_emoji_line(const uint8_t emoji[7], char *out, size_t out_sz) {
    size_t n = 0;
    if (out_sz) out[0] = 0;
    for (int i = 0; i < 7 && n < out_sz; i++) {
        const char *g = e2e_sas_emoji_glyph(emoji[i]), *name = e2e_sas_emoji_name(emoji[i]);
        int w = snprintf(out + n, out_sz - n, "%s%s %s", i ? "  " : "", g ? g : "?",
                         name ? name : "?");
        if (w < 0 || (size_t)w >= out_sz - n) break;
        n += (size_t)w;
    }
}

char *e2e_sas_commitment(const char *key, const char *tx) {
    char *text = xprintf("%s|%s", key, tx);
    uint8_t digest[32];
    if (vz_sha256((const uint8_t *)text, strlen(text), digest) != 0) abort();
    free(text);
    return e2e_base64(digest, 32);
}

char *e2e_sas_info(const char *a_curve, const char *a_key, const char *b_curve, const char *b_key,
                   const char *tx) {
    return xprintf("%s%s|%s|%s|%s|%s", E2E_SAS_INFO_PREFIX, a_curve, a_key, b_curve, b_key, tx);
}

char *e2e_sas_mac_info(bool master, const char *first_curve, const char *second_curve,
                       const char *tx) {
    return xprintf("%s%s|%s|%s", master ? E2E_SAS_MMAC_PREFIX : E2E_SAS_MAC_PREFIX, first_curve,
                   second_curve, tx);
}

/* EncryptedRail.tsx SAS_REASON. */
const char *e2e_sas_reason_text(const char *reason) {
    static const char *const words[][2] = {
        {"user", "cancelled"},
        {"mismatch", "the emoji did not match"},
        {"timeout", "no answer in 10 minutes"},
        {"unexpected-message", "a step came out of order"},
        {"commitment-mismatch", "a key was not the one promised"},
        {"mac-mismatch", "the confirmation did not match"},
        {"key-changed", "the nick was pinned to another key"},
        {"page-gone", "the page running it was closed or reloaded"},
        {"bad-key", "a key could not be used"},
        {"other-device", "answered on another device"},
    };
    for (size_t i = 0; reason && i < sizeof(words) / sizeof(words[0]); i++)
        if (strcmp(reason, words[i][0]) == 0) return words[i][1];
    return NULL;
}

const char *e2e_sas_phase_name(e2e_sas_phase p) {
    switch (p) {
    case E2E_SAS_STARTED: return "started";
    case E2E_SAS_KEYED: return "keyed";
    case E2E_SAS_ASKED: return "asked";
    case E2E_SAS_ACCEPTED: return "accepted";
    case E2E_SAS_COMPARE: return "compare";
    }
    return "unknown";
}

/* Random bytes from the system, for a tx and a row id. vodozemac draws
 * its own keys; this is only for the two labels sas.ts draws with
 * crypto.getRandomValues / randomUUID. No randomness: no SAS. */
static void random_bytes(uint8_t *out, size_t n) {
    int fd = open("/dev/urandom", O_RDONLY | O_CLOEXEC);
    if (fd < 0) abort();
    size_t got = 0;
    while (got < n) {
        ssize_t r = read(fd, out + got, n - got);
        if (r < 0 && errno == EINTR) continue;
        if (r <= 0) abort();
        got += (size_t)r;
    }
    close(fd);
}

/* The secret halves, by our SAS public key. */
typedef struct {
    char *key;
    vz_sas *sas;              /* before the key exchange */
    vz_established_sas *est;  /* after it */
} sas_secret;

struct e2e_sas_host {
    sas_secret *v;
    size_t n;
};

e2e_sas_host *e2e_sas_host_new(void) { return calloc(1, sizeof(e2e_sas_host)); }

static void secret_free(sas_secret *s) {
    free(s->key);
    vz_sas_free(s->sas);
    vz_established_sas_free(s->est);
}

void e2e_sas_host_free(e2e_sas_host *h) {
    if (!h) return;
    for (size_t i = 0; i < h->n; i++) secret_free(&h->v[i]);
    free(h->v);
    free(h);
}

static sas_secret *secret_get(e2e_sas_host *h, const char *key) {
    for (size_t i = 0; key && i < h->n; i++)
        if (strcmp(h->v[i].key, key) == 0) return &h->v[i];
    return NULL;
}

static void secret_drop(e2e_sas_host *h, const char *key) {
    for (size_t i = 0; key && i < h->n; i++) {
        if (strcmp(h->v[i].key, key) != 0) continue;
        secret_free(&h->v[i]);
        memmove(&h->v[i], &h->v[i + 1], (h->n - i - 1) * sizeof(*h->v));
        h->n--;
        return;
    }
}

/* A new Sas: its public key (malloc'd), the secret kept under it. */
static char *new_secret(e2e_sas_host *h) {
    vz_sas *sas = vz_sas_new();
    char *key = sas ? vzs(vz_sas_public_key(sas)) : NULL;
    if (!key) abort();
    sas_secret *s = grow((void **)&h->v, &h->n, sizeof(*s));
    s->key = xstrdup(key);
    s->sas = sas;
    return key;
}

/* One SAS call: the context, the host, and where its output goes. */
typedef struct {
    const e2e_ctx *c;
    e2e_state *st;
    e2e_sas_host *h;
    e2e_result *res;
    e2e_rows *rows;
} sasop;

static void sas_begin(sasop *op, const e2e_ctx *c, e2e_sas_host *h, e2e_result *res,
                      e2e_rows *rows) {
    op->c = c;
    op->st = &c->record->state;
    op->h = h;
    op->res = res;
    op->rows = rows;
    /* The Verifier's constructor: a secret no held record names any more
     * (its SAS ended, or the record was read back from disk) goes. */
    for (size_t i = 0; i < h->n;) {
        bool named = false;
        for (size_t k = 0; k < op->st->nsas && !named; k++)
            named = op->st->sas[k].held && streq(op->st->sas[k].our_key, h->v[i].key);
        if (named) {
            i++;
            continue;
        }
        char *key = xstrdup(h->v[i].key);
        secret_drop(h, key);
        free(key);
    }
}

static int64_t sas_now(const sasop *op) { return op->c->now_ms; }

static e2e_sas *sas_of(e2e_state *st, const char *master) {
    for (size_t i = 0; master && i < st->nsas; i++)
        if (strcmp(st->sas[i].master, master) == 0) return &st->sas[i];
    return NULL;
}

/* Forgets the secret of `rec` (where it is held), then the record. */
static void sas_remove(sasop *op, e2e_sas *rec) {
    if (rec->held) secret_drop(op->h, rec->our_key);
    size_t i = (size_t)(rec - op->st->sas);
    sas_free(rec);
    memmove(&op->st->sas[i], &op->st->sas[i + 1], (op->st->nsas - i - 1) * sizeof(e2e_sas));
    op->st->nsas--;
}

static void sas_row(sasop *op, const char *nick, e2e_row_kind kind, bool by_peer,
                    const char *text, const char *row_id) {
    op->rows->v = xrealloc(op->rows->v, (op->rows->n + 1) * sizeof(e2e_row));
    e2e_row *r = &op->rows->v[op->rows->n++];
    memset(r, 0, sizeof(*r));
    if (row_id) {
        r->id = xstrdup(row_id);
    } else {
        uint8_t b[8];
        random_bytes(b, sizeof(b));
        r->id = xprintf("sas:%02x%02x%02x%02x%02x%02x%02x%02x", b[0], b[1], b[2], b[3], b[4],
                        b[5], b[6], b[7]);
    }
    r->kind = kind;
    r->at = sas_now(op);
    r->nick = xstrdup(nick);
    r->by_peer = by_peer;
    if (kind == E2E_ROW_SAS_CANCELLED) {
        r->body = xstrdup(text);
        r->body_len = strlen(text);
    } else if (kind == E2E_ROW_VERIFIED) {
        r->key = xstrdup(text);
    }
}

/* A step of `rec`, through the engine: to its peer device, to every
 * device of the master before one is known. A step that cannot go is
 * reported by the engine like any message (tag "sas"); the SAS then times
 * out, as cic's does. */
static void sas_send(sasop *op, const e2e_sas *rec, char *inner) {
    e2e_send(op->c, rec->nick, inner, E2E_SAS_TAG, 0, rec->device, op->res);
    free(inner);
}

/* Issue 2457: our start of `rec` went to every device of the master, and
 * `device` is now the one it runs with, or ended with: the others are told
 * it is not theirs, under the start's tx. */
static void sas_release(sasop *op, const e2e_sas *rec, const char *device) {
    char *inner = e2e_inner_sas_cancel(rec->tx, "other-device");
    e2e_send_except(op->c, rec->nick, inner, E2E_SAS_RELEASE_TAG, device, op->res);
    free(inner);
}

/* Ends it with a cancel on the wire, and says so in the chat. */
static void sas_end(sasop *op, e2e_sas *rec, const char *reason, const char *row_id) {
    char *nick = xstrdup(rec->nick), *device = opt_dup(rec->device);
    char *inner = e2e_inner_sas_cancel(rec->tx, reason);
    sas_remove(op, rec);
    e2e_send(op->c, nick, inner, E2E_SAS_TAG, 0, device, op->res);
    free(inner);
    sas_row(op, nick, E2E_ROW_SAS_CANCELLED, false, reason, row_id);
    free(nick);
    free(device);
}

/* The master pinned to `nick` (copied) and its SAS, if one runs. */
static e2e_sas *sas_record_of(sasop *op, const char *nick, char **master) {
    const char *pin = pin_of(op->st, nick);
    *master = pin && master_get(op->st, pin) ? xstrdup(pin) : NULL;
    return *master ? sas_of(op->st, *master) : NULL;
}

/* The peer device `rec` runs with, while its master vouches for it:
 * copies of its keys. */
static bool sas_peer(sasop *op, const char *master, const e2e_sas *rec, char **ed25519,
                     char **curve) {
    if (!rec->device) return false;
    e2e_device *d = device_get(op->st, rec->device);
    step s = {0};
    s.st = op->st;
    if (!d || !streq(d->master, master) || standing(&s, master, d->ed25519, d->cert_ver) >= 0)
        return false;
    *ed25519 = xstrdup(d->ed25519);
    *curve = xstrdup(d->curve25519);
    return true;
}

typedef enum { SAS_ESTABLISHED, SAS_NOT_YET, SAS_ENDED } sas_establishment;

/* establish: the shared secret, once, with the peer device it binds.
 * vodozemac refusing the key ends the SAS (`bad-key`); so does a peer
 * device its master no longer vouches for. On ENDED `rec` is gone. */
static sas_establishment sas_establish(sasop *op, const char *master, e2e_sas *rec,
                                       vz_established_sas **est, char **peer_e,
                                       char **peer_curve) {
    if (!sas_peer(op, master, rec, peer_e, peer_curve)) {
        sas_end(op, rec, "bad-key", NULL);
        return SAS_ENDED;
    }
    sas_secret *secret = secret_get(op->h, rec->our_key);
    if (secret && secret->est) {
        *est = secret->est;
        return SAS_ESTABLISHED;
    }
    if (!secret || !secret->sas || !rec->their_key) {
        free(*peer_e);
        free(*peer_curve);
        return SAS_NOT_YET;
    }
    /* The exchange uses the secret up, whatever it answers. */
    secret->est = vz_sas_diffie_hellman(secret->sas, rec->their_key);
    secret->sas = NULL;
    if (!secret->est) {
        free(*peer_e);
        free(*peer_curve);
        secret_drop(op->h, rec->our_key);
        sas_end(op, rec, "bad-key", NULL);
        return SAS_ENDED;
    }
    *est = secret->est;
    return SAS_ESTABLISHED;
}

/* Verified, once both halves are in: our human's match, and the peer's
 * MACs, both the ones expected. */
static void sas_settle(sasop *op, const char *master, e2e_sas *rec, const char *row_id) {
    if (!rec->expected || !rec->their_mac) return;
    if (strcmp(rec->their_mac, rec->expected) != 0 ||
        strcmp(rec->their_mmac, rec->expected_mmac) != 0) {
        sas_end(op, rec, "mac-mismatch", row_id);
        return;
    }
    char *nick = xstrdup(rec->nick);
    sas_remove(op, rec);
    e2e_verify(op->c, nick, master, op->res);
    sas_row(op, nick, E2E_ROW_VERIFIED, false, master, row_id);
    free(nick);
}

static char *calc_mac(vz_established_sas *est, const char *input, const char *info) {
    return vzs(vz_established_sas_calculate_mac(est, input, info));
}

static e2e_sas_outcome sas_confirm(sasop *op, const char *master, e2e_sas *rec) {
    if (rec->phase != E2E_SAS_COMPARE || rec->expected || !rec->held) return E2E_SAS_NOT_NOW;
    vz_established_sas *est = NULL;
    char *peer_e = NULL, *peer_curve = NULL;
    sas_establishment got = sas_establish(op, master, rec, &est, &peer_e, &peer_curve);
    if (got == SAS_ENDED) return E2E_SAS_DONE;
    if (got == SAS_NOT_YET) return E2E_SAS_NOT_NOW;
    /* Each side's MACs bind its own curve first: ours, then the ones we expect. */
    char *own_e = vzs(vz_account_ed25519_key(op->c->record->account));
    char *own_k = vzs(vz_account_curve25519_key(op->c->record->account));
    if (!own_e || !own_k) abort();
    char *ours = e2e_sas_mac_info(false, own_k, peer_curve, rec->tx);
    char *ours_m = e2e_sas_mac_info(true, own_k, peer_curve, rec->tx);
    char *theirs = e2e_sas_mac_info(false, peer_curve, own_k, rec->tx);
    char *theirs_m = e2e_sas_mac_info(true, peer_curve, own_k, rec->tx);
    char *mac = calc_mac(est, own_e, ours);
    char *mmac = calc_mac(est, op->c->record->own->master, ours_m);
    char *expected = calc_mac(est, peer_e, theirs);
    char *expected_m = calc_mac(est, master, theirs_m);
    free(ours);
    free(ours_m);
    free(theirs);
    free(theirs_m);
    free(own_e);
    free(own_k);
    free(peer_e);
    free(peer_curve);
    if (!mac || !mmac || !expected || !expected_m) {
        free(mac);
        free(mmac);
        free(expected);
        free(expected_m);
        sas_end(op, rec, "bad-key", NULL);
        return E2E_SAS_DONE;
    }
    rec->expected = expected;
    rec->expected_mmac = expected_m;
    secret_drop(op->h, rec->our_key);
    sas_send(op, rec, e2e_inner_sas_mac(rec->tx, mac, mmac));
    free(mac);
    free(mmac);
    sas_settle(op, master, rec, NULL);
    return E2E_SAS_DONE;
}

/* One SAS per master: a nick with none pinned, or with a SAS under way,
 * starts none. */
static e2e_sas_outcome sas_start(sasop *op, const char *nick) {
    char *master = NULL;
    e2e_sas *running = sas_record_of(op, nick, &master);
    if (!master) return E2E_SAS_NO_PIN;
    if (running) {
        free(master);
        return E2E_SAS_RUNNING;
    }
    uint8_t b[8];
    random_bytes(b, sizeof(b));
    e2e_sas *rec = grow((void **)&op->st->sas, &op->st->nsas, sizeof(*rec));
    rec->master = master;
    rec->tx = e2e_base64(b, sizeof(b));
    rec->nick = xstrdup(nick);
    rec->role_a = true;
    rec->phase = E2E_SAS_STARTED;
    rec->at = sas_now(op);
    rec->held = true;
    rec->our_key = new_secret(op->h);
    sas_send(op, rec, e2e_inner_sas_start(rec->tx));
    sas_row(op, nick, E2E_ROW_SAS_ASKED, false, NULL, NULL);
    return E2E_SAS_DONE;
}

e2e_sas_outcome e2e_sas_user(const e2e_ctx *c, e2e_sas_host *h, const char *nick, e2e_sas_step step,
                             e2e_result *res, e2e_rows *rows) {
    sasop op;
    sas_begin(&op, c, h, res, rows);
    if (step == E2E_SAS_STEP_START) return sas_start(&op, nick);
    char *master = NULL;
    e2e_sas *rec = sas_record_of(&op, nick, &master);
    if (!rec) {
        free(master);
        return E2E_SAS_NONE;
    }
    e2e_sas_outcome out = E2E_SAS_DONE;
    switch (step) {
    case E2E_SAS_STEP_ACCEPT:
        if (rec->phase != E2E_SAS_ASKED) {
            out = E2E_SAS_NOT_NOW;
            break;
        }
        rec->our_key = new_secret(h);
        rec->held = true;
        rec->phase = E2E_SAS_ACCEPTED;
        {
            char *commitment = e2e_sas_commitment(rec->our_key, rec->tx);
            sas_send(&op, rec, e2e_inner_sas_accept(rec->tx, commitment));
            free(commitment);
        }
        break;
    case E2E_SAS_STEP_MATCH:
        out = sas_confirm(&op, master, rec);
        break;
    case E2E_SAS_STEP_MISMATCH:
    case E2E_SAS_STEP_CANCEL:
        sas_end(&op, rec, step == E2E_SAS_STEP_CANCEL ? "user" : "mismatch", NULL);
        break;
    case E2E_SAS_STEP_START:
        break;
    }
    free(master);
    return out;
}

void e2e_sas_repinned(const e2e_ctx *c, e2e_sas_host *h, const char *nick, e2e_rows *rows) {
    e2e_result none;
    e2e_result_init(&none);
    sasop op;
    sas_begin(&op, c, h, &none, rows);
    const char *pinned = pin_of(op.st, nick);
    for (size_t i = 0; i < op.st->nsas;) {
        e2e_sas *rec = &op.st->sas[i];
        if (streq(rec->master, pinned) || !e2e_nick_eq(rec->nick, nick)) {
            i++;
            continue;
        }
        char *at = xstrdup(rec->nick);
        sas_remove(&op, rec);
        sas_row(&op, at, E2E_ROW_SAS_CANCELLED, false, "key-changed", NULL);
        free(at);
    }
    e2e_result_free(&none);
}

static void sas_compare(e2e_sas *rec, const char *their_key) {
    free(rec->their_key);
    rec->their_key = xstrdup(their_key);
    rec->phase = E2E_SAS_COMPARE;
}

static void sas_on_start(sasop *op, const char *nick, const char *master, const char *device,
                         e2e_sas *rec, const char *tx, const char *row_id) {
    if (rec && strcmp(rec->tx, tx) == 0) return;
    if (rec && rec->phase == E2E_SAS_STARTED && rec->our_key) {
        /* Both asked at once. Both sides keep the smaller tx: if it is
         * ours, the peer turns its start into our B; if theirs, ours
         * becomes their B, with the device that sent it, and our key, not
         * sent yet, is the one we commit to; the other devices our start
         * reached are told it ended. */
        if (strcmp(tx, rec->tx) > 0) return;
        sas_release(op, rec, device);
        free(rec->tx);
        rec->tx = xstrdup(tx);
        rec->role_a = false;
        rec->phase = E2E_SAS_ACCEPTED;
        rec->at = sas_now(op);
        free(rec->device);
        rec->device = xstrdup(device);
        char *commitment = e2e_sas_commitment(rec->our_key, tx);
        sas_send(op, rec, e2e_inner_sas_accept(tx, commitment));
        free(commitment);
        return;
    }
    /* A new start replaces whatever ran with this master: the device the
     * old SAS ran with is not told, and its steps, naming the old tx, are
     * ignored. */
    if (rec) sas_remove(op, rec);
    e2e_sas *n = grow((void **)&op->st->sas, &op->st->nsas, sizeof(*n));
    n->master = xstrdup(master);
    n->tx = xstrdup(tx);
    n->nick = xstrdup(nick);
    n->role_a = false;
    n->phase = E2E_SAS_ASKED;
    n->at = sas_now(op);
    n->device = xstrdup(device);
    sas_row(op, nick, E2E_ROW_SAS_ASKED, true, NULL, row_id);
}

void e2e_sas_receive(const e2e_ctx *c, e2e_sas_host *h, const char *nick, const char *master,
                     const char *device, const char *inner_json, const char *row_id,
                     e2e_result *res, e2e_rows *rows) {
    e2e_inner in;
    if (!inner_json || !master || !device || !e2e_inner_parse(inner_json, strlen(inner_json), &in))
        return;
    if (in.type < E2E_INNER_SAS_START || in.type > E2E_INNER_SAS_CANCEL) {
        e2e_inner_free(&in);
        return;
    }
    sasop op;
    sas_begin(&op, c, h, res, rows);
    e2e_sas *rec = sas_of(op.st, master);
    if (in.type == E2E_INNER_SAS_START) {
        sas_on_start(&op, nick, master, device, rec, in.tx, row_id);
        e2e_inner_free(&in);
        return;
    }
    if (!rec || strcmp(rec->tx, in.tx) != 0) {
        e2e_inner_free(&in);
        return;
    }
    if (!rec->device) {
        sas_release(&op, rec, device);
        rec->device = xstrdup(device);
    } else if (strcmp(rec->device, device) != 0) {
        e2e_inner_free(&in);
        return;
    }
    bool handled = false;
    switch (in.type) {
    case E2E_INNER_SAS_ACCEPT:
        if (rec->phase != E2E_SAS_STARTED || !rec->our_key) break;
        free(rec->commitment);
        rec->commitment = xstrdup(in.commitment);
        rec->phase = E2E_SAS_KEYED;
        sas_send(&op, rec, e2e_inner_sas_key(rec->tx, rec->our_key));
        handled = true;
        break;
    case E2E_INNER_SAS_KEY:
        if (rec->phase == E2E_SAS_KEYED) {
            char *want = e2e_sas_commitment(in.key, rec->tx);
            bool kept = streq(want, rec->commitment);
            free(want);
            if (kept) sas_compare(rec, in.key);
            else sas_end(&op, rec, "commitment-mismatch", row_id);
            handled = true;
        } else if (rec->phase == E2E_SAS_ACCEPTED && rec->our_key) {
            sas_send(&op, rec, e2e_inner_sas_key(rec->tx, rec->our_key));
            sas_compare(rec, in.key);
            handled = true;
        }
        break;
    case E2E_INNER_SAS_MAC:
        if (rec->phase != E2E_SAS_COMPARE || rec->their_mac) break;
        rec->their_mac = xstrdup(in.mac);
        rec->their_mmac = xstrdup(in.mmac);
        {
            char *m = xstrdup(master);
            sas_settle(&op, m, rec, row_id);
            free(m);
        }
        handled = true;
        break;
    case E2E_INNER_SAS_CANCEL: {
        char *at = xstrdup(rec->nick);
        sas_remove(&op, rec);
        sas_row(&op, at, E2E_ROW_SAS_CANCELLED, true, in.reason, row_id);
        free(at);
        handled = true;
        break;
    }
    default:
        break;
    }
    if (!handled) sas_end(&op, rec, "unexpected-message", row_id);
    e2e_inner_free(&in);
}

void e2e_sas_tick(const e2e_ctx *c, e2e_sas_host *h, e2e_result *res, e2e_rows *rows) {
    sasop op;
    sas_begin(&op, c, h, res, rows);
    for (size_t i = 0; i < op.st->nsas;) {
        e2e_sas *rec = &op.st->sas[i];
        if (sas_now(&op) >= rec->at + E2E_SAS_TIMEOUT_MS) {
            sas_end(&op, rec, "timeout", NULL);
        } else if (rec->held && !rec->expected && !secret_get(h, rec->our_key)) {
            sas_end(&op, rec, "page-gone", NULL);
        } else {
            i++;
        }
    }
}

bool e2e_sas_view_of(const e2e_ctx *c, e2e_sas_host *h, const char *nick, e2e_sas_view *out,
                     e2e_result *res, e2e_rows *rows) {
    memset(out, 0, sizeof(*out));
    sasop op;
    sas_begin(&op, c, h, res, rows);
    char *master = NULL;
    e2e_sas *rec = sas_record_of(&op, nick, &master);
    if (!rec) {
        free(master);
        return false;
    }
    out->role_a = rec->role_a;
    out->phase = rec->phase;
    out->confirmed = rec->expected != NULL;
    out->here = rec->held;
    snprintf(out->tx, sizeof(out->tx), "%s", rec->tx);
    if (rec->held && rec->phase == E2E_SAS_COMPARE && !rec->expected) {
        vz_established_sas *est = NULL;
        char *peer_e = NULL, *peer_curve = NULL;
        sas_establishment got = sas_establish(&op, master, rec, &est, &peer_e, &peer_curve);
        if (got == SAS_ENDED) {
            free(master);
            return false;
        }
        if (got == SAS_ESTABLISHED) {
            /* A's device curve and SAS key, then B's, then the tx. */
            char *own_k = vzs(vz_account_curve25519_key(c->record->account));
            if (!own_k) abort();
            char *info = rec->role_a
                             ? e2e_sas_info(own_k, rec->our_key, peer_curve, rec->their_key, rec->tx)
                             : e2e_sas_info(peer_curve, rec->their_key, own_k, rec->our_key, rec->tx);
            out->has_emoji = vz_established_sas_emoji_indices(est, info, out->emoji) == 0;
            free(info);
            free(own_k);
            free(peer_e);
            free(peer_curve);
        }
    }
    free(master);
    return true;
}

/* ── Order challenges (orders.ts SendLog, client.ts answer) ──────────── */

void e2e_line_sha256(const char *body, size_t len, char out[65]) {
    uint8_t digest[32];
    if (vz_sha256((const uint8_t *)body, len, digest) != 0) abort();
    static const char hex[] = "0123456789abcdef";
    for (size_t i = 0; i < 32; i++) {
        out[2 * i] = hex[digest[i] >> 4];
        out[2 * i + 1] = hex[digest[i] & 15];
    }
    out[64] = 0;
}

static void sent_line_free(e2e_sent_line *s) {
    free(s->slug);
    free(s->target);
    free(s->nonce);
}

static void send_log_drop(e2e_send_log *l, size_t i) {
    sent_line_free(&l->v[i]);
    memmove(l->v + i, l->v + i + 1, (l->n - i - 1) * sizeof(*l->v));
    l->n--;
}

/* Lines past the window confirm nothing: they go at the next record or
 * check (orders.ts prune). */
static void send_log_prune(e2e_send_log *l, int64_t at) {
    for (size_t i = l->n; i > 0; i--)
        if (at - l->v[i - 1].at > E2E_SENT_WINDOW_MS) send_log_drop(l, i - 1);
}

void e2e_send_log_record(e2e_send_log *l, const char *slug, const char *target, const char *body,
                         size_t len, int64_t at_ms) {
    send_log_prune(l, at_ms);
    if (l->n >= E2E_SENT_LOG_MAX) send_log_drop(l, 0);
    l->v = xrealloc(l->v, (l->n + 1) * sizeof(*l->v));
    e2e_sent_line *s = &l->v[l->n++];
    s->slug = xstrdup(slug);
    s->target = xstrdup(target);
    e2e_line_sha256(body, len, s->sha256);
    s->at = at_ms;
    s->nonce = NULL;
}

void e2e_send_log_forget(e2e_send_log *l, const char *slug, const char *target, const char *body,
                         size_t len, int64_t at_ms) {
    char sha[65];
    e2e_line_sha256(body, len, sha);
    for (size_t i = l->n; i > 0; i--) {
        const e2e_sent_line *s = &l->v[i - 1];
        if (s->at == at_ms && strcmp(s->sha256, sha) == 0 && strcmp(s->slug, slug) == 0 &&
            strcmp(s->target, target) == 0)
            send_log_drop(l, i - 1);
    }
}

void e2e_send_log_free(e2e_send_log *l) {
    for (size_t i = 0; i < l->n; i++) sent_line_free(&l->v[i]);
    free(l->v);
    l->v = NULL;
    l->n = 0;
}

static bool order_channel_name(const char *name, const char *chantypes) {
    return name[0] && chantypes && strchr(chantypes, name[0]) != NULL;
}

e2e_order_verdict e2e_order_check(e2e_send_log *l, const e2e_inner *chal, const char *challenger,
                                  bool verified, const e2e_order_scope *scope, int64_t at_ms) {
    if (!verified) return E2E_ORDER_UNVERIFIED;
    if (!scope->network || !scope->network[0]) return E2E_ORDER_UNNAMED_NETWORK;
    if (strcmp(chal->network, scope->network) != 0) return E2E_ORDER_OTHER_NETWORK;
    /* Safe integers only reach here (e2e_inner_parse), so the product fits. */
    if (at_ms >= chal->expires_at * 1000) return E2E_ORDER_EXPIRED;
    if (!order_channel_name(chal->channel, scope->chantypes) &&
        !e2e_nick_eq(chal->channel, challenger))
        return E2E_ORDER_PM_TO_ANOTHER;
    send_log_prune(l, at_ms);
    e2e_sent_line *fresh = NULL;
    for (size_t i = 0; i < l->n; i++) {
        e2e_sent_line *s = &l->v[i];
        if (s->at > at_ms || strcmp(s->sha256, chal->line_sha256) != 0 ||
            !e2e_nick_eq(s->slug, scope->slug) || !e2e_nick_eq(s->target, chal->channel))
            continue;
        if (s->nonce && strcmp(s->nonce, chal->nonce) == 0) return E2E_ORDER_CONFIRMED;
        if (!s->nonce && !fresh) fresh = s;
    }
    if (!fresh) return E2E_ORDER_NOT_SENT;
    fresh->nonce = xstrdup(chal->nonce);
    return E2E_ORDER_CONFIRMED;
}

const char *e2e_order_verdict_name(e2e_order_verdict v) {
    switch (v) {
    case E2E_ORDER_CONFIRMED: return "confirmed";
    case E2E_ORDER_UNVERIFIED: return "unverified";
    case E2E_ORDER_UNNAMED_NETWORK: return "unnamed-network";
    case E2E_ORDER_OTHER_NETWORK: return "other-network";
    case E2E_ORDER_EXPIRED: return "expired";
    case E2E_ORDER_PM_TO_ANOTHER: return "pm-to-another";
    case E2E_ORDER_NOT_SENT: return "not-sent";
    }
    return "?";
}

const char *e2e_order_verdict_text(e2e_order_verdict v) {
    switch (v) {
    case E2E_ORDER_CONFIRMED: return "confirmed";
    case E2E_ORDER_UNVERIFIED: return "their key is not verified here";
    case E2E_ORDER_UNNAMED_NETWORK:
        return "this network has sent no 005 NETWORK= name to match it against";
    case E2E_ORDER_OTHER_NETWORK: return "it names another network";
    case E2E_ORDER_EXPIRED: return "it has expired by this device's clock";
    case E2E_ORDER_PM_TO_ANOTHER:
        return "it names a private message to someone other than the bot asking";
    case E2E_ORDER_NOT_SENT:
        return "this device sent no such line there in the last 30 s, or it already confirmed it";
    }
    return "?";
}
