/* http.h — pure HTTP/1.1 response-body decoding for shottino.
 *
 * Shottino's HTTP client (`http_request_raw` in shottino.c) talks to grappa
 * over a socket it does not control, so the response body is attacker-shaped
 * exactly like the websocket frames. The transfer-decoding is the one piece
 * of that path that is PURE — bytes in, bytes out, no socket / OpenSSL / app
 * state — so it lives here where it can be exercised under ASan/UBSan and
 * fuzzed for the overflow class. The rest of the HTTP path stays in
 * shottino.c because it is bound to the live TLS connection.
 */
#ifndef SHOTTINO_HTTP_H
#define SHOTTINO_HTTP_H

#include <stdbool.h>
#include <stddef.h>

/* Decode an HTTP/1.1 `Transfer-Encoding: chunked` body.
 *
 * `body`/`len` is the raw body span; the decoder scans it and does not
 * require NUL-termination. Returns a freshly malloc'd, NUL-terminated buffer
 * whose decoded length is written to `*out_len` (the caller owns and frees
 * it), or NULL on allocation failure.
 *
 * Hardened against a hostile chunk size: the size is parsed with a size_t
 * overflow guard, and each chunk is bounds-checked with NON-wrapping
 * arithmetic (`n > len - pos`, never `pos + n > len` which wraps). A garbage
 * length — e.g. 16+ hex digits — is refused rather than driving an
 * out-of-bounds copy. Malformed framing stops decoding at the last good
 * chunk rather than aborting, matching lenient real-world HTTP clients. */
char *http_decode_chunked(const char *body, size_t len, size_t *out_len);

/* Where one HTTP/1.1 response ends, for a connection that is kept open.
 *
 * `buf`/`len` is what has been read so far (headers and whatever body
 * followed). Answers:
 *   HTTP_FRAME_COMPLETE    — `*total` is the length of the WHOLE response
 *                            (headers + body); bytes past it are not ours.
 *   HTTP_FRAME_PARTIAL     — read more.
 *   HTTP_FRAME_UNTIL_CLOSE — the server named no length: the body runs to
 *                            the close, and the connection is spent.
 *   HTTP_FRAME_BAD         — not a response, or a length that cannot be
 *                            one (negative, overflowing, two that disagree).
 * `*keep_alive` says whether the connection may carry the next request:
 * false on `Connection: close`, on HTTP/1.0 without keep-alive, and on a
 * body that runs to the close. Pure: no socket, no allocation. */
typedef enum {
    HTTP_FRAME_PARTIAL,
    HTTP_FRAME_COMPLETE,
    HTTP_FRAME_UNTIL_CLOSE,
    HTTP_FRAME_BAD
} http_frame;

http_frame http_frame_response(const char *buf, size_t len, size_t *total, bool *keep_alive);

#endif /* SHOTTINO_HTTP_H */
