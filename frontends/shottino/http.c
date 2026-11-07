/* http.c — see http.h. */
#include "http.h"

#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

/* Local hex-digit decoder, like mirc.c's hex_val — each pure module keeps
 * its own tiny primitive rather than reaching across a module boundary. */
static int hexval(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

char *http_decode_chunked(const char *body, size_t len, size_t *out_len) {
    /* The decoded body is never larger than the source span (chunk data is a
     * subset of the input), so one allocation is enough. */
    char *out = malloc(len + 1);
    if (!out) return NULL;
    size_t pos = 0, w = 0;
    while (pos < len) {
        size_t line = pos;
        while (line + 1 < len && !(body[line] == '\r' && body[line + 1] == '\n')) line++;
        if (line + 1 >= len) break;
        size_t n = 0;
        bool overflow = false;
        for (size_t i = pos; i < line; i++) {
            int v = hexval(body[i]);
            if (v < 0) break;
            /* A hostile server can send a 16+ hex-digit chunk size that
             * overflows size_t; then a `pos + n` bounds guard would wrap and
             * pass, turning the memcpy into an unbounded heap overwrite.
             * Detect the overflow before the multiply that would cause it. */
            if (n > (SIZE_MAX - (size_t)v) / 16) { overflow = true; break; }
            n = n * 16 + (size_t)v;
        }
        pos = line + 2; /* pos <= len: the \r\n was found within len above */
        /* Bounds-check WITHOUT wrapping: pos <= len is guaranteed, so
         * `len - pos` cannot underflow and `n > len - pos` is exact even for
         * n == SIZE_MAX (the exactly-16-hex-digit case the overflow guard
         * above does not trip). */
        if (overflow || n == 0 || n > len - pos) break;
        memcpy(out + w, body + pos, n);
        w += n;
        pos += n + 2;
    }
    out[w] = 0;
    *out_len = w;
    return out;
}

/* ── Framing ──────────────────────────────────────────────────────────── */

static bool ci_eq(const char *a, size_t alen, const char *b) {
    size_t blen = strlen(b);
    if (alen != blen) return false;
    for (size_t i = 0; i < alen; i++) {
        char x = a[i], y = b[i];
        if (x >= 'A' && x <= 'Z') x = (char)(x - 'A' + 'a');
        if (y >= 'A' && y <= 'Z') y = (char)(y - 'A' + 'a');
        if (x != y) return false;
    }
    return true;
}

/* Does the comma-separated header value contain `token`? */
static bool value_has_token(const char *v, size_t vlen, const char *token) {
    size_t i = 0;
    while (i < vlen) {
        while (i < vlen && (v[i] == ' ' || v[i] == '\t' || v[i] == ',')) i++;
        size_t start = i;
        while (i < vlen && v[i] != ',') i++;
        size_t end = i;
        while (end > start && (v[end - 1] == ' ' || v[end - 1] == '\t')) end--;
        if (end > start && ci_eq(v + start, end - start, token)) return true;
    }
    return false;
}

/* The end of the chunked body starting at `pos`, or PARTIAL / BAD. */
static http_frame chunked_end(const char *buf, size_t len, size_t pos, size_t *end) {
    for (;;) {
        size_t line = pos;
        while (line + 1 < len && !(buf[line] == '\r' && buf[line + 1] == '\n')) line++;
        if (line + 1 >= len) return HTTP_FRAME_PARTIAL;
        size_t n = 0, digits = 0;
        for (size_t i = pos; i < line; i++) {
            int v = hexval(buf[i]);
            if (v < 0) {
                /* A chunk extension (`;name=value`) may follow the size. */
                if (buf[i] == ';' && digits) break;
                return HTTP_FRAME_BAD;
            }
            if (n > (SIZE_MAX - (size_t)v) / 16) return HTTP_FRAME_BAD;
            n = n * 16 + (size_t)v;
            digits++;
        }
        if (!digits) return HTTP_FRAME_BAD;
        pos = line + 2;
        if (n == 0) {
            /* Trailers, each ending in CRLF, then an empty line. */
            for (;;) {
                size_t t = pos;
                while (t + 1 < len && !(buf[t] == '\r' && buf[t + 1] == '\n')) t++;
                if (t + 1 >= len) return HTTP_FRAME_PARTIAL;
                if (t == pos) {
                    *end = t + 2;
                    return HTTP_FRAME_COMPLETE;
                }
                pos = t + 2;
            }
        }
        if (n > len - pos || len - pos - n < 2) return HTTP_FRAME_PARTIAL;
        if (buf[pos + n] != '\r' || buf[pos + n + 1] != '\n') return HTTP_FRAME_BAD;
        pos += n + 2;
    }
}

http_frame http_frame_response(const char *buf, size_t len, size_t *total, bool *keep_alive) {
    *total = 0;
    *keep_alive = false;
    /* The headers end at the first empty line. */
    size_t hdr_end = 0;
    for (size_t i = 0; i + 3 < len; i++)
        if (buf[i] == '\r' && buf[i + 1] == '\n' && buf[i + 2] == '\r' && buf[i + 3] == '\n') {
            hdr_end = i + 4;
            break;
        }
    if (len >= 5 && memcmp(buf, "HTTP/", 5) != 0) return HTTP_FRAME_BAD;
    if (!hdr_end) return HTTP_FRAME_PARTIAL;
    if (len < 12 || memcmp(buf, "HTTP/1.", 7) != 0) return HTTP_FRAME_BAD;
    bool http10 = buf[7] == '0';
    int status = 0;
    for (size_t i = 9; i < 12; i++) {
        if (buf[i] < '0' || buf[i] > '9') return HTTP_FRAME_BAD;
        status = status * 10 + (buf[i] - '0');
    }

    bool chunked = false, have_len = false, close = false, keep = false;
    size_t clen = 0;
    size_t pos = 0;
    while (pos < hdr_end && !(buf[pos] == '\r' && buf[pos + 1] == '\n')) pos++;
    pos += 2; /* past the status line */
    while (pos + 2 <= hdr_end - 2) {
        size_t eol = pos;
        while (eol + 1 < hdr_end && !(buf[eol] == '\r' && buf[eol + 1] == '\n')) eol++;
        const char *colon = memchr(buf + pos, ':', eol - pos);
        if (colon) {
            size_t nlen = (size_t)(colon - (buf + pos));
            const char *v = colon + 1;
            size_t vlen = (size_t)(buf + eol - v);
            while (vlen && (*v == ' ' || *v == '\t')) v++, vlen--;
            while (vlen && (v[vlen - 1] == ' ' || v[vlen - 1] == '\t')) vlen--;
            if (ci_eq(buf + pos, nlen, "content-length")) {
                if (!vlen) return HTTP_FRAME_BAD;
                size_t n = 0;
                for (size_t i = 0; i < vlen; i++) {
                    if (v[i] < '0' || v[i] > '9') return HTTP_FRAME_BAD;
                    if (n > (SIZE_MAX - (size_t)(v[i] - '0')) / 10) return HTTP_FRAME_BAD;
                    n = n * 10 + (size_t)(v[i] - '0');
                }
                if (have_len && n != clen) return HTTP_FRAME_BAD;
                have_len = true;
                clen = n;
            } else if (ci_eq(buf + pos, nlen, "transfer-encoding")) {
                chunked = value_has_token(v, vlen, "chunked");
            } else if (ci_eq(buf + pos, nlen, "connection")) {
                if (value_has_token(v, vlen, "close")) close = true;
                if (value_has_token(v, vlen, "keep-alive")) keep = true;
            }
        }
        pos = eol + 2;
    }
    bool reusable = !close && (!http10 || keep);

    /* 1xx, 204 and 304 carry no body whatever the headers say. */
    if ((status >= 100 && status < 200) || status == 204 || status == 304) {
        *total = hdr_end;
        *keep_alive = reusable;
        return HTTP_FRAME_COMPLETE;
    }
    if (chunked) {
        size_t end = 0;
        http_frame f = chunked_end(buf, len, hdr_end, &end);
        if (f == HTTP_FRAME_COMPLETE) {
            *total = end;
            *keep_alive = reusable;
        }
        return f;
    }
    if (have_len) {
        if (clen > len - hdr_end) return HTTP_FRAME_PARTIAL;
        *total = hdr_end + clen;
        *keep_alive = reusable;
        return HTTP_FRAME_COMPLETE;
    }
    *total = hdr_end;
    return HTTP_FRAME_UNTIL_CLOSE;
}
