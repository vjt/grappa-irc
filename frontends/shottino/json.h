/* json.h — minimal recursive-descent JSON reader for shottino.
 *
 * Why this exists
 * ---------------
 * Shottino used to sniff Phoenix frames with `strstr(frame, "\"kind\":
 * \"message\"")` and pull scalars out with a hand-rolled `json_find_string`
 * that scanned for a key anywhere in the buffer. That works for a flat
 * payload with unique key names and nothing else. Grappa's wire surface is
 * neither: `message` nests a whole object, `query_windows_list` carries a
 * map keyed by nick, `whois_bundle` has an array of channel strings, and
 * several sibling payloads reuse key names (`network`, `channel`, `nick`)
 * at different depths. A key-anywhere scan silently reads the WRONG nesting
 * level; there is no error, just a wrong value.
 *
 * So: a real parser. Values are arena-allocated inside the `json_doc`, so
 * the whole tree is freed with one `json_free`. No value is individually
 * owned and nothing is refcounted — a `const json_value *` borrowed from a
 * document is valid exactly as long as that document.
 *
 * Contract notes
 * --------------
 * - Strings are decoded (escapes resolved, `\uXXXX` transcoded to UTF-8,
 *   surrogate pairs joined) at parse time and stored NUL-terminated. IRC
 *   bodies legitimately contain `\x01` CTCP markers and other control
 *   bytes, so the decoded string may embed NULs only if the server sent a
 *   literal `\u0000`; `json_string_len` gives the true length for callers
 *   that care. Everything in grappa's wire surface is text, so the
 *   NUL-terminated view is what the accessors expose. That holds for
 *   VALUES only: an object KEY that decodes to a NUL makes the document
 *   unparseable, because keys are matched as C strings and would answer
 *   to their prefix — a reading JSON.parse (cicchetto) does not share.
 * - Numbers are parsed as `double` and exposed as both double and long.
 *   Every integer grappa puts on the wire (ids, counts, unix seconds) is
 *   well inside double's exact-integer range.
 * - Depth is bounded (`JSON_MAX_DEPTH`) so a hostile/garbled frame cannot
 *   blow the C stack. Exceeding it is a parse error, not a crash.
 */
#ifndef SHOTTINO_JSON_H
#define SHOTTINO_JSON_H

#include <stdbool.h>
#include <stddef.h>

#define JSON_MAX_DEPTH 64

typedef enum {
    JSON_NULL,
    JSON_BOOL,
    JSON_NUMBER,
    JSON_STRING,
    JSON_ARRAY,
    JSON_OBJECT
} json_type;

typedef struct json_value json_value;
typedef struct json_doc json_doc;

/* Parse `len` bytes of JSON. Returns NULL on malformed input, writing a
 * one-line reason into `err` when `err_sz > 0`. The returned document owns
 * every value reachable from `json_root`. */
json_doc *json_parse(const char *text, size_t len, char *err, size_t err_sz);
void json_free(json_doc *doc);
const json_value *json_root(const json_doc *doc);

json_type json_type_of(const json_value *v);

/* ── Scalar readers ────────────────────────────────────────────────────
 * Each returns false / the default when `v` is NULL or of the wrong type,
 * so callers can chain lookups without a NULL check at every hop. */
bool json_is_null(const json_value *v);
const char *json_string(const json_value *v);   /* NULL unless JSON_STRING */
size_t json_string_len(const json_value *v);
bool json_bool(const json_value *v, bool dflt);
bool json_number(const json_value *v, double *out);
bool json_long(const json_value *v, long *out);

/* ── Container readers ─────────────────────────────────────────────── */
const json_value *json_get(const json_value *obj, const char *key);
size_t json_len(const json_value *v);           /* array or object size */
const json_value *json_at(const json_value *arr, size_t index);
/* Object entry by position — the iteration door for map-shaped payloads
 * like `query_windows_list.windows` (keyed by nick) and `isupport.prefix`
 * (keyed by mode letter), where the keys are data rather than schema. */
const char *json_key_at(const json_value *obj, size_t index);
const json_value *json_value_at(const json_value *obj, size_t index);

/* ── Field helpers ─────────────────────────────────────────────────────
 * These encode the narrowing vocabulary the cicchetto wire narrowers use,
 * so a C narrower reads like its TypeScript twin.
 *
 *   _req  — field must be present AND of the right type (else false)
 *   _opt  — field may be absent or JSON null; both yield the null/default
 *           form and still return true. A present-but-wrong-TYPE field is
 *           still a failure, matching e.g. `(r.reason !== null &&
 *           typeof r.reason !== "string")` in wireNarrow.ts.
 */
bool json_str_req(const json_value *obj, const char *key, const char **out);
bool json_str_opt(const json_value *obj, const char *key, const char **out);
bool json_long_req(const json_value *obj, const char *key, long *out);
bool json_long_opt(const json_value *obj, const char *key, long *out, bool *present);
bool json_bool_req(const json_value *obj, const char *key, bool *out);
/* Present-or-default boolean: absent/null → `dflt`, wrong type → false.
 * Mirrors the defensive reads (e.g. `badge_count`) where a stale server
 * omitting a field must not drop the load-bearing part of the payload. */
bool json_bool_dflt(const json_value *obj, const char *key, bool dflt, bool *out);

/* Equality against a string literal — the `r.state !== "joined"` guard. */
bool json_str_is(const json_value *v, const char *expect);

/* ── Writing ───────────────────────────────────────────────────────────
 * Compact serialisation of a parsed value back to JSON text. This reader
 * grew a writer for one reason: a tool call's `input` arrives as an
 * OBJECT, and a tool handler wants the arguments as TEXT. Re-serialising
 * is the only way across, and doing it by hand at the call site is how a
 * quoting bug gets written twice.
 *
 * Returns false (leaving `out` unusable) when the value does not fit —
 * truncated JSON is not JSON, so a partial write is never reported as
 * success. Numbers round-trip through %.17g and integers print without a
 * decimal point. */
bool json_write(const json_value *v, char *out, size_t out_sz);

/* ── Building ──────────────────────────────────────────────────────────
 * A growable compact writer, for documents whose size is the caller's
 * data rather than a known bound: the E2E payloads (e2e.c) carry Olm
 * bodies and pickles of any length. Commas are placed by the builder —
 * a member or element after another gets one — so a caller writes only
 * the structure. Allocation failure is sticky: every later call is a
 * no-op and jb_take answers NULL, so a half-written document is never
 * mistaken for a whole one. Strings are escaped as json_write escapes
 * them and numbers spelled as it spells them. */
typedef struct {
    char *ptr;
    size_t len;
    size_t cap;
    bool failed;
} json_buf;

void jb_init(json_buf *b);
void jb_free(json_buf *b);
/* The text written so far, malloc'd and NUL-terminated ("" when nothing
 * was), or NULL after an allocation failure; the builder is reset. */
char *jb_take(json_buf *b);
void jb_obj_open(json_buf *b);
void jb_obj_close(json_buf *b);
void jb_arr_open(json_buf *b);
void jb_arr_close(json_buf *b);
void jb_key(json_buf *b, const char *key);
void jb_str(json_buf *b, const char *s);
void jb_strn(json_buf *b, const char *s, size_t len);
void jb_num(json_buf *b, double v);
void jb_bool(json_buf *b, bool v);
void jb_null(json_buf *b);
/* A parsed value, written compact. */
void jb_value(json_buf *b, const json_value *v);

#endif /* SHOTTINO_JSON_H */
