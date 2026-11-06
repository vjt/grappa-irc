/* json.c — see json.h for the why. */
#include "json.h"

#include <errno.h>
#include <limits.h>
#include <math.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ── Arena ─────────────────────────────────────────────────────────────
 * Every node and decoded string lives in bump-allocated blocks chained off
 * the document. Parsing a 100 KB frame does a handful of mallocs instead of
 * thousands, and teardown is a block walk — no recursive free, so a deeply
 * nested document cannot blow the stack on the way out either. */
#define ARENA_BLOCK 8192

struct arena_block {
    struct arena_block *next;
    size_t used;
    size_t cap;
    char data[];
};

struct json_value {
    json_type type;
    union {
        bool boolean;
        double number;
        struct {
            char *ptr;
            size_t len;
        } string;
        struct {
            json_value **items;
            size_t count;
        } array;
        struct {
            char **keys;
            json_value **values;
            size_t count;
        } object;
    } u;
};

struct json_doc {
    struct arena_block *blocks;
    json_value *root;
};

static void *arena_alloc(json_doc *doc, size_t size) {
    /* Keep every allocation pointer-aligned; nodes and arrays of pointers
     * share the arena. */
    size = (size + sizeof(void *) - 1) & ~(sizeof(void *) - 1);
    struct arena_block *b = doc->blocks;
    if (!b || b->cap - b->used < size) {
        size_t cap = size > ARENA_BLOCK ? size : ARENA_BLOCK;
        b = malloc(sizeof(*b) + cap);
        if (!b) return NULL;
        b->next = doc->blocks;
        b->used = 0;
        b->cap = cap;
        doc->blocks = b;
    }
    void *p = b->data + b->used;
    b->used += size;
    return p;
}

void json_free(json_doc *doc) {
    if (!doc) return;
    struct arena_block *b = doc->blocks;
    while (b) {
        struct arena_block *next = b->next;
        free(b);
        b = next;
    }
    free(doc);
}

/* ── Parser ───────────────────────────────────────────────────────── */

struct parser {
    const char *p;
    const char *end;
    json_doc *doc;
    int depth;
    char err[160];
};

static bool fail(struct parser *ps, const char *msg) {
    if (!ps->err[0]) snprintf(ps->err, sizeof(ps->err), "%s", msg);
    return false;
}

static void skip_ws(struct parser *ps) {
    while (ps->p < ps->end &&
           (*ps->p == ' ' || *ps->p == '\t' || *ps->p == '\n' || *ps->p == '\r'))
        ps->p++;
}

static bool parse_value(struct parser *ps, json_value **out);

static json_value *new_value(struct parser *ps, json_type type) {
    json_value *v = arena_alloc(ps->doc, sizeof(*v));
    if (!v) {
        fail(ps, "out of memory");
        return NULL;
    }
    memset(v, 0, sizeof(*v));
    v->type = type;
    return v;
}

/* Encode one code point as UTF-8. Returns bytes written (1..4). */
static size_t utf8_encode(unsigned long cp, char *out) {
    if (cp < 0x80) {
        out[0] = (char)cp;
        return 1;
    }
    if (cp < 0x800) {
        out[0] = (char)(0xC0 | (cp >> 6));
        out[1] = (char)(0x80 | (cp & 0x3F));
        return 2;
    }
    if (cp < 0x10000) {
        out[0] = (char)(0xE0 | (cp >> 12));
        out[1] = (char)(0x80 | ((cp >> 6) & 0x3F));
        out[2] = (char)(0x80 | (cp & 0x3F));
        return 3;
    }
    out[0] = (char)(0xF0 | (cp >> 18));
    out[1] = (char)(0x80 | ((cp >> 12) & 0x3F));
    out[2] = (char)(0x80 | ((cp >> 6) & 0x3F));
    out[3] = (char)(0x80 | (cp & 0x3F));
    return 4;
}

static bool parse_hex4(struct parser *ps, unsigned long *out) {
    if (ps->end - ps->p < 4) return fail(ps, "truncated \\u escape");
    unsigned long v = 0;
    for (int i = 0; i < 4; i++) {
        char c = ps->p[i];
        v <<= 4;
        if (c >= '0' && c <= '9') v |= (unsigned long)(c - '0');
        else if (c >= 'a' && c <= 'f') v |= (unsigned long)(c - 'a' + 10);
        else if (c >= 'A' && c <= 'F') v |= (unsigned long)(c - 'A' + 10);
        else return fail(ps, "bad hex in \\u escape");
    }
    ps->p += 4;
    *out = v;
    return true;
}

/* Parse a string literal, decoding escapes into the arena. The opening
 * quote must already be consumed by the caller. */
static bool parse_string_raw(struct parser *ps, char **out, size_t *out_len) {
    /* The decoded form is never longer than the source span, so one
     * upper-bound reservation avoids a two-pass scan. */
    const char *scan = ps->p;
    size_t bound = 0;
    bool closed = false;
    while (scan < ps->end) {
        if (*scan == '"') {
            closed = true;
            break;
        }
        if (*scan == '\\') {
            if (scan + 1 >= ps->end) return fail(ps, "truncated escape");
            scan += 2;
            bound += 4; /* worst case: \uXXXX -> up to 4 UTF-8 bytes */
            continue;
        }
        scan++;
        bound++;
    }
    if (!closed) return fail(ps, "unterminated string");

    char *buf = arena_alloc(ps->doc, bound + 1);
    if (!buf) return fail(ps, "out of memory");
    size_t n = 0;

    while (ps->p < ps->end && *ps->p != '"') {
        char c = *ps->p;
        if (c != '\\') {
            buf[n++] = c;
            ps->p++;
            continue;
        }
        ps->p++;
        if (ps->p >= ps->end) return fail(ps, "truncated escape");
        char e = *ps->p++;
        switch (e) {
        case '"': buf[n++] = '"'; break;
        case '\\': buf[n++] = '\\'; break;
        case '/': buf[n++] = '/'; break;
        case 'b': buf[n++] = '\b'; break;
        case 'f': buf[n++] = '\f'; break;
        case 'n': buf[n++] = '\n'; break;
        case 'r': buf[n++] = '\r'; break;
        case 't': buf[n++] = '\t'; break;
        case 'u': {
            unsigned long cp;
            if (!parse_hex4(ps, &cp)) return false;
            /* Surrogate pair: Phoenix's JSON encoder emits astral code
             * points (emoji in a PRIVMSG body, say) as a \uD8xx\uDCxx
             * pair. Joining them here means the rest of shottino only ever
             * sees well-formed UTF-8. */
            if (cp >= 0xD800 && cp <= 0xDBFF && ps->end - ps->p >= 6 && ps->p[0] == '\\' &&
                ps->p[1] == 'u') {
                const char *save = ps->p;
                ps->p += 2;
                unsigned long lo;
                if (!parse_hex4(ps, &lo)) return false;
                if (lo >= 0xDC00 && lo <= 0xDFFF) {
                    cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                } else {
                    ps->p = save; /* lone high surrogate — emit replacement */
                    cp = 0xFFFD;
                }
            } else if (cp >= 0xD800 && cp <= 0xDFFF) {
                cp = 0xFFFD; /* unpaired surrogate is not encodable */
            }
            n += utf8_encode(cp, buf + n);
            break;
        }
        default:
            return fail(ps, "unknown escape");
        }
    }
    if (ps->p >= ps->end) return fail(ps, "unterminated string");
    ps->p++; /* closing quote */
    buf[n] = '\0';
    *out = buf;
    *out_len = n;
    return true;
}

/* Growable pointer vector used while collecting array/object children.
 * Lives in malloc space (it is resized), then the final run is copied into
 * the arena so the document owns a compact, stable array. */
struct ptrvec {
    void **items;
    size_t count;
    size_t cap;
};

static bool ptrvec_push(struct ptrvec *v, void *item) {
    if (v->count == v->cap) {
        size_t cap = v->cap ? v->cap * 2 : 8;
        void **grown = realloc(v->items, cap * sizeof(void *));
        if (!grown) return false;
        v->items = grown;
        v->cap = cap;
    }
    v->items[v->count++] = item;
    return true;
}

static void **ptrvec_freeze(struct parser *ps, struct ptrvec *v) {
    if (v->count == 0) return NULL;
    void **out = arena_alloc(ps->doc, v->count * sizeof(void *));
    if (out) memcpy(out, v->items, v->count * sizeof(void *));
    return out;
}

static bool parse_array(struct parser *ps, json_value **out) {
    json_value *v = new_value(ps, JSON_ARRAY);
    if (!v) return false;
    struct ptrvec items = {0};
    bool ok = true;

    skip_ws(ps);
    if (ps->p < ps->end && *ps->p == ']') {
        ps->p++;
        *out = v;
        return true;
    }
    for (;;) {
        json_value *item = NULL;
        if (!parse_value(ps, &item)) {
            ok = false;
            break;
        }
        if (!ptrvec_push(&items, item)) {
            ok = fail(ps, "out of memory");
            break;
        }
        skip_ws(ps);
        if (ps->p >= ps->end) {
            ok = fail(ps, "unterminated array");
            break;
        }
        if (*ps->p == ',') {
            ps->p++;
            skip_ws(ps);
            continue;
        }
        if (*ps->p == ']') {
            ps->p++;
            break;
        }
        ok = fail(ps, "expected ',' or ']' in array");
        break;
    }
    if (ok) {
        v->u.array.items = (json_value **)ptrvec_freeze(ps, &items);
        if (items.count && !v->u.array.items) ok = fail(ps, "out of memory");
        v->u.array.count = ok ? items.count : 0;
    }
    free(items.items);
    if (ok) *out = v;
    return ok;
}

static bool parse_object(struct parser *ps, json_value **out) {
    json_value *v = new_value(ps, JSON_OBJECT);
    if (!v) return false;
    struct ptrvec keys = {0};
    struct ptrvec vals = {0};
    bool ok = true;

    skip_ws(ps);
    if (ps->p < ps->end && *ps->p == '}') {
        ps->p++;
        *out = v;
        return true;
    }
    for (;;) {
        skip_ws(ps);
        if (ps->p >= ps->end || *ps->p != '"') {
            ok = fail(ps, "expected object key");
            break;
        }
        ps->p++;
        char *key = NULL;
        size_t key_len = 0;
        if (!parse_string_raw(ps, &key, &key_len)) {
            ok = false;
            break;
        }
        skip_ws(ps);
        if (ps->p >= ps->end || *ps->p != ':') {
            ok = fail(ps, "expected ':' after object key");
            break;
        }
        ps->p++;
        json_value *val = NULL;
        if (!parse_value(ps, &val)) {
            ok = false;
            break;
        }
        if (!ptrvec_push(&keys, key) || !ptrvec_push(&vals, val)) {
            ok = fail(ps, "out of memory");
            break;
        }
        skip_ws(ps);
        if (ps->p >= ps->end) {
            ok = fail(ps, "unterminated object");
            break;
        }
        if (*ps->p == ',') {
            ps->p++;
            continue;
        }
        if (*ps->p == '}') {
            ps->p++;
            break;
        }
        ok = fail(ps, "expected ',' or '}' in object");
        break;
    }
    if (ok) {
        v->u.object.keys = (char **)ptrvec_freeze(ps, &keys);
        v->u.object.values = (json_value **)ptrvec_freeze(ps, &vals);
        if (keys.count && (!v->u.object.keys || !v->u.object.values))
            ok = fail(ps, "out of memory");
        v->u.object.count = ok ? keys.count : 0;
    }
    free(keys.items);
    free(vals.items);
    if (ok) *out = v;
    return ok;
}

static bool parse_number(struct parser *ps, json_value **out) {
    const char *start = ps->p;
    if (ps->p < ps->end && (*ps->p == '-' || *ps->p == '+')) ps->p++;
    while (ps->p < ps->end && ((*ps->p >= '0' && *ps->p <= '9') || *ps->p == '.' ||
                               *ps->p == 'e' || *ps->p == 'E' || *ps->p == '-' || *ps->p == '+'))
        ps->p++;
    if (ps->p == start) return fail(ps, "expected number");

    /* strtod needs a NUL-terminated span; the frame buffer is not ours to
     * poke, so copy the (always short) numeric token out. */
    char tmp[64];
    size_t n = (size_t)(ps->p - start);
    if (n >= sizeof(tmp)) return fail(ps, "number too long");
    memcpy(tmp, start, n);
    tmp[n] = '\0';

    char *endp = NULL;
    errno = 0;
    double d = strtod(tmp, &endp);
    if (endp != tmp + n) return fail(ps, "malformed number");
    /* `1e999` parses "successfully" as infinity, and an infinity has no
     * JSON spelling — round-tripping one through the writer produced
     * `inf`, which is not JSON and which the next parser rejects. A
     * number nobody can represent is a malformed number. */
    if (errno == ERANGE && (d > 1.0e308 || d < -1.0e308)) return fail(ps, "number out of range");
    if (!isfinite(d)) return fail(ps, "number out of range");

    json_value *v = new_value(ps, JSON_NUMBER);
    if (!v) return false;
    v->u.number = d;
    *out = v;
    return true;
}

static bool parse_literal(struct parser *ps, const char *word, json_type type, bool boolean,
                          json_value **out) {
    size_t n = strlen(word);
    if ((size_t)(ps->end - ps->p) < n || memcmp(ps->p, word, n) != 0)
        return fail(ps, "malformed literal");
    ps->p += n;
    json_value *v = new_value(ps, type);
    if (!v) return false;
    if (type == JSON_BOOL) v->u.boolean = boolean;
    *out = v;
    return true;
}

static bool parse_value(struct parser *ps, json_value **out) {
    if (++ps->depth > JSON_MAX_DEPTH) {
        ps->depth--;
        return fail(ps, "maximum nesting depth exceeded");
    }
    skip_ws(ps);
    bool ok;
    if (ps->p >= ps->end) {
        ok = fail(ps, "unexpected end of input");
    } else {
        switch (*ps->p) {
        case '{':
            ps->p++;
            ok = parse_object(ps, out);
            break;
        case '[':
            ps->p++;
            ok = parse_array(ps, out);
            break;
        case '"': {
            ps->p++;
            char *s = NULL;
            size_t len = 0;
            ok = parse_string_raw(ps, &s, &len);
            if (ok) {
                json_value *v = new_value(ps, JSON_STRING);
                if (!v) ok = false;
                else {
                    v->u.string.ptr = s;
                    v->u.string.len = len;
                    *out = v;
                }
            }
            break;
        }
        case 't': ok = parse_literal(ps, "true", JSON_BOOL, true, out); break;
        case 'f': ok = parse_literal(ps, "false", JSON_BOOL, false, out); break;
        case 'n': ok = parse_literal(ps, "null", JSON_NULL, false, out); break;
        default: ok = parse_number(ps, out); break;
        }
    }
    ps->depth--;
    return ok;
}

json_doc *json_parse(const char *text, size_t len, char *err, size_t err_sz) {
    if (err && err_sz) err[0] = '\0';
    if (!text) {
        if (err && err_sz) snprintf(err, err_sz, "null input");
        return NULL;
    }
    json_doc *doc = calloc(1, sizeof(*doc));
    if (!doc) {
        if (err && err_sz) snprintf(err, err_sz, "out of memory");
        return NULL;
    }
    struct parser ps = {.p = text, .end = text + len, .doc = doc, .depth = 0};
    json_value *root = NULL;
    if (!parse_value(&ps, &root)) {
        if (err && err_sz) snprintf(err, err_sz, "%s", ps.err[0] ? ps.err : "parse error");
        json_free(doc);
        return NULL;
    }
    skip_ws(&ps);
    if (ps.p != ps.end) {
        if (err && err_sz) snprintf(err, err_sz, "trailing bytes after JSON value");
        json_free(doc);
        return NULL;
    }
    doc->root = root;
    return doc;
}

const json_value *json_root(const json_doc *doc) { return doc ? doc->root : NULL; }

json_type json_type_of(const json_value *v) { return v ? v->type : JSON_NULL; }

bool json_is_null(const json_value *v) { return !v || v->type == JSON_NULL; }

const char *json_string(const json_value *v) {
    return (v && v->type == JSON_STRING) ? v->u.string.ptr : NULL;
}

size_t json_string_len(const json_value *v) {
    return (v && v->type == JSON_STRING) ? v->u.string.len : 0;
}

bool json_bool(const json_value *v, bool dflt) {
    return (v && v->type == JSON_BOOL) ? v->u.boolean : dflt;
}

bool json_number(const json_value *v, double *out) {
    if (!v || v->type != JSON_NUMBER) return false;
    *out = v->u.number;
    return true;
}

/* A number that fits in a `long`, or a refusal.
 *
 * The cast used to be unconditional, and converting an out-of-range
 * double to an integer type is undefined behaviour. A hostile or merely
 * broken frame — `{"id":1e300}` — reached this through the wire
 * narrowers, which believed they were rejecting bad shapes. Rejecting it
 * here is what makes that belief true: the caller already handles false
 * as "this field is not what it should be". */
bool json_long(const json_value *v, long *out) {
    if (!v || v->type != JSON_NUMBER) return false;
    double d = v->u.number;
    if (!isfinite(d)) return false;
    if (d < (double)LONG_MIN || d > (double)LONG_MAX) return false;
    *out = (long)d;
    return true;
}

const json_value *json_get(const json_value *obj, const char *key) {
    if (!obj || obj->type != JSON_OBJECT || !key) return NULL;
    for (size_t i = 0; i < obj->u.object.count; i++) {
        if (strcmp(obj->u.object.keys[i], key) == 0) return obj->u.object.values[i];
    }
    return NULL;
}

size_t json_len(const json_value *v) {
    if (!v) return 0;
    if (v->type == JSON_ARRAY) return v->u.array.count;
    if (v->type == JSON_OBJECT) return v->u.object.count;
    return 0;
}

const json_value *json_at(const json_value *arr, size_t index) {
    if (!arr || arr->type != JSON_ARRAY || index >= arr->u.array.count) return NULL;
    return arr->u.array.items[index];
}

const char *json_key_at(const json_value *obj, size_t index) {
    if (!obj || obj->type != JSON_OBJECT || index >= obj->u.object.count) return NULL;
    return obj->u.object.keys[index];
}

const json_value *json_value_at(const json_value *obj, size_t index) {
    if (!obj || obj->type != JSON_OBJECT || index >= obj->u.object.count) return NULL;
    return obj->u.object.values[index];
}

bool json_str_req(const json_value *obj, const char *key, const char **out) {
    const char *s = json_string(json_get(obj, key));
    if (!s) return false;
    *out = s;
    return true;
}

bool json_str_opt(const json_value *obj, const char *key, const char **out) {
    const json_value *v = json_get(obj, key);
    if (!v || v->type == JSON_NULL) {
        *out = NULL;
        return true;
    }
    if (v->type != JSON_STRING) return false;
    *out = v->u.string.ptr;
    return true;
}

bool json_long_req(const json_value *obj, const char *key, long *out) {
    return json_long(json_get(obj, key), out);
}

bool json_long_opt(const json_value *obj, const char *key, long *out, bool *present) {
    const json_value *v = json_get(obj, key);
    if (!v || v->type == JSON_NULL) {
        if (present) *present = false;
        return true;
    }
    if (v->type != JSON_NUMBER) return false;
    *out = (long)v->u.number;
    if (present) *present = true;
    return true;
}

bool json_bool_req(const json_value *obj, const char *key, bool *out) {
    const json_value *v = json_get(obj, key);
    if (!v || v->type != JSON_BOOL) return false;
    *out = v->u.boolean;
    return true;
}

bool json_bool_dflt(const json_value *obj, const char *key, bool dflt, bool *out) {
    const json_value *v = json_get(obj, key);
    if (!v || v->type == JSON_NULL) {
        *out = dflt;
        return true;
    }
    if (v->type != JSON_BOOL) return false;
    *out = v->u.boolean;
    return true;
}

bool json_str_is(const json_value *v, const char *expect) {
    const char *s = json_string(v);
    return s && expect && strcmp(s, expect) == 0;
}

/* ── Writing ─────────────────────────────────────────────────────────── */

/* Append `src` to out, returning false if it would not fit. */
static bool put(char *out, size_t out_sz, size_t *n, const char *src, size_t len) {
    if (*n + len + 1 > out_sz) return false;
    memcpy(out + *n, src, len);
    *n += len;
    out[*n] = 0;
    return true;
}

/* The escaped spelling of one byte of a string, into `esc`; its length.
 * Shared by both writers so a quoting rule is written once. */
static size_t escape_byte(unsigned char c, char esc[8]) {
    switch (c) {
    case '"':  memcpy(esc, "\\\"", 2); return 2;
    case '\\': memcpy(esc, "\\\\", 2); return 2;
    case '\n': memcpy(esc, "\\n", 2); return 2;
    case '\r': memcpy(esc, "\\r", 2); return 2;
    case '\t': memcpy(esc, "\\t", 2); return 2;
    default:
        if (c < 0x20) return (size_t)snprintf(esc, 8, "\\u%04x", c);
        esc[0] = (char)c;
        return 1;
    }
}

/* A number's JSON spelling into `buf` (40 bytes); its length, 0 on failure.
 *
 * RANGE FIRST, then the cast.
 *
 * `d == (double)(long long)d` performs the conversion before the
 * comparison, and converting a double outside long long's range — or an
 * infinity, or a NaN — is undefined behaviour, not a defined wrong
 * answer. It is reachable: a tool-call argument of 1e300 comes back
 * through here on its way to the handler.
 *
 * A non-finite value has no JSON spelling at all (the grammar has no
 * `inf`), so it is written as 0 rather than as something no parser on the
 * other end would accept. */
static size_t format_number(double d, char buf[40]) {
    int w;
    if (!isfinite(d))
        w = snprintf(buf, 40, "0");
    else if (d >= -9.0e18 && d <= 9.0e18 && d == (double)(long long)d)
        w = snprintf(buf, 40, "%lld", (long long)d);
    else
        w = snprintf(buf, 40, "%.17g", d);
    return w > 0 ? (size_t)w : 0;
}

static bool put_string(char *out, size_t out_sz, size_t *n, const char *s, size_t len) {
    if (!put(out, out_sz, n, "\"", 1)) return false;
    for (size_t i = 0; i < len; i++) {
        char esc[8];
        size_t elen = escape_byte((unsigned char)s[i], esc);
        if (!put(out, out_sz, n, esc, elen)) return false;
    }
    return put(out, out_sz, n, "\"", 1);
}

static bool write_value(const json_value *v, char *out, size_t out_sz, size_t *n) {
    if (!v) return put(out, out_sz, n, "null", 4);
    switch (v->type) {
    case JSON_NULL:
        return put(out, out_sz, n, "null", 4);
    case JSON_BOOL:
        return v->u.boolean ? put(out, out_sz, n, "true", 4) : put(out, out_sz, n, "false", 5);
    case JSON_NUMBER: {
        char buf[40];
        size_t w = format_number(v->u.number, buf);
        return w > 0 && put(out, out_sz, n, buf, w);
    }
    case JSON_STRING:
        return put_string(out, out_sz, n, v->u.string.ptr, v->u.string.len);
    case JSON_ARRAY:
        if (!put(out, out_sz, n, "[", 1)) return false;
        for (size_t i = 0; i < v->u.array.count; i++) {
            if (i && !put(out, out_sz, n, ",", 1)) return false;
            if (!write_value(v->u.array.items[i], out, out_sz, n)) return false;
        }
        return put(out, out_sz, n, "]", 1);
    case JSON_OBJECT:
        if (!put(out, out_sz, n, "{", 1)) return false;
        for (size_t i = 0; i < v->u.object.count; i++) {
            if (i && !put(out, out_sz, n, ",", 1)) return false;
            const char *k = v->u.object.keys[i];
            if (!put_string(out, out_sz, n, k, strlen(k))) return false;
            if (!put(out, out_sz, n, ":", 1)) return false;
            if (!write_value(v->u.object.values[i], out, out_sz, n)) return false;
        }
        return put(out, out_sz, n, "}", 1);
    }
    return false;
}

bool json_write(const json_value *v, char *out, size_t out_sz) {
    if (!out || !out_sz) return false;
    size_t n = 0;
    out[0] = 0;
    if (write_value(v, out, out_sz, &n)) return true;
    out[0] = 0; /* a truncated document is not a document */
    return false;
}

/* ── Building ──────────────────────────────────────────────────────────
 * The growable twin of json_write: see json.h. */

static void jb_put(json_buf *b, const char *src, size_t len) {
    if (b->failed) return;
    if (b->len + len + 1 > b->cap) {
        size_t cap = b->cap ? b->cap : 256;
        while (cap < b->len + len + 1) cap *= 2;
        char *p = realloc(b->ptr, cap);
        if (!p) {
            b->failed = true;
            return;
        }
        b->ptr = p;
        b->cap = cap;
    }
    memcpy(b->ptr + b->len, src, len);
    b->len += len;
    b->ptr[b->len] = 0;
}

/* The comma between two members or elements: needed unless what came
 * last opened a container or was a key. */
static void jb_sep(json_buf *b) {
    if (b->failed || b->len == 0) return;
    char last = b->ptr[b->len - 1];
    if (last != '{' && last != '[' && last != ':') jb_put(b, ",", 1);
}

void jb_init(json_buf *b) {
    b->ptr = NULL;
    b->len = 0;
    b->cap = 0;
    b->failed = false;
}

void jb_free(json_buf *b) {
    free(b->ptr);
    jb_init(b);
}

char *jb_take(json_buf *b) {
    char *out = b->failed ? NULL : b->ptr;
    if (b->failed) free(b->ptr);
    else if (!out) out = calloc(1, 1);
    jb_init(b);
    return out;
}

void jb_obj_open(json_buf *b) {
    jb_sep(b);
    jb_put(b, "{", 1);
}

void jb_obj_close(json_buf *b) { jb_put(b, "}", 1); }

void jb_arr_open(json_buf *b) {
    jb_sep(b);
    jb_put(b, "[", 1);
}

void jb_arr_close(json_buf *b) { jb_put(b, "]", 1); }

static void jb_string(json_buf *b, const char *s, size_t len) {
    jb_put(b, "\"", 1);
    for (size_t i = 0; i < len; i++) {
        char esc[8];
        size_t elen = escape_byte((unsigned char)s[i], esc);
        jb_put(b, esc, elen);
    }
    jb_put(b, "\"", 1);
}

void jb_key(json_buf *b, const char *key) {
    jb_sep(b);
    jb_string(b, key, strlen(key));
    jb_put(b, ":", 1);
}

void jb_strn(json_buf *b, const char *s, size_t len) {
    jb_sep(b);
    jb_string(b, s, len);
}

void jb_str(json_buf *b, const char *s) { jb_strn(b, s, strlen(s)); }

void jb_num(json_buf *b, double d) {
    char buf[40];
    size_t w = format_number(d, buf);
    jb_sep(b);
    if (w == 0) b->failed = true;
    else jb_put(b, buf, w);
}

void jb_bool(json_buf *b, bool v) {
    jb_sep(b);
    jb_put(b, v ? "true" : "false", v ? 4 : 5);
}

void jb_null(json_buf *b) {
    jb_sep(b);
    jb_put(b, "null", 4);
}

void jb_value(json_buf *b, const json_value *v) {
    if (!v) {
        jb_null(b);
        return;
    }
    switch (v->type) {
    case JSON_NULL: jb_null(b); break;
    case JSON_BOOL: jb_bool(b, v->u.boolean); break;
    case JSON_NUMBER: jb_num(b, v->u.number); break;
    case JSON_STRING: jb_strn(b, v->u.string.ptr, v->u.string.len); break;
    case JSON_ARRAY:
        jb_arr_open(b);
        for (size_t i = 0; i < v->u.array.count; i++) jb_value(b, v->u.array.items[i]);
        jb_arr_close(b);
        break;
    case JSON_OBJECT:
        jb_obj_open(b);
        for (size_t i = 0; i < v->u.object.count; i++) {
            jb_key(b, v->u.object.keys[i]);
            jb_value(b, v->u.object.values[i]);
        }
        jb_obj_close(b);
        break;
    }
}
