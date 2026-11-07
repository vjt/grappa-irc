/* test_http.c — regression tests for the chunked-transfer decoder.
 *
 * The headline case is #446-R1: a hostile HTTP server sends a chunk size
 * that overflows size_t, and the old `pos + n > len` guard wrapped and let
 * an unbounded memcpy through. These run under ASan+UBSan (see the Makefile),
 * so an out-of-bounds copy fails the suite loudly instead of silently
 * corrupting the heap. */
#include "test.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../http.h"

/* Helper: decode a NUL-terminated literal (len = strlen), returning the
 * malloc'd result and its decoded length. */
static char *decode(const char *body, size_t *out_len) {
    return http_decode_chunked(body, strlen(body), out_len);
}

TEST(single_chunk) {
    size_t n = 0;
    char *out = decode("5\r\nHELLO\r\n0\r\n\r\n", &n);
    CHECK(out != NULL);
    CHECK_LONG(n, 5);
    CHECK_STR(out, "HELLO");
    free(out);
}

TEST(multiple_chunks) {
    size_t n = 0;
    char *out = decode("3\r\nabc\r\n2\r\nde\r\n0\r\n\r\n", &n);
    CHECK(out != NULL);
    CHECK_LONG(n, 5);
    CHECK_STR(out, "abcde");
    free(out);
}

TEST(hex_size_uppercase_and_lower) {
    size_t n = 0;
    /* 0x0b = 11 bytes: "hello world" */
    char *out = decode("b\r\nhello world\r\n0\r\n\r\n", &n);
    CHECK(out != NULL);
    CHECK_LONG(n, 11);
    CHECK_STR(out, "hello world");
    free(out);
}

TEST(empty_body) {
    size_t n = 123;
    char *out = decode("", &n);
    CHECK(out != NULL);
    CHECK_LONG(n, 0);
    free(out);
}

/* #446-R1 regression: a 16-hex-digit chunk size is SIZE_MAX. The overflow
 * guard does not trip (it fits exactly), so the non-wrapping bounds check is
 * what must refuse it — the old `pos + n > len` wrapped below `len` and let
 * the memcpy run. Expect: no bytes decoded, no overflow (ASan is the judge). */
TEST(chunk_size_size_max_rejected) {
    size_t n = 123;
    char *out = decode("FFFFFFFFFFFFFFFF\r\noverflow me\r\n0\r\n\r\n", &n);
    CHECK(out != NULL);
    CHECK_LONG(n, 0);
    free(out);
}

/* A 17+ hex-digit size overflows during accumulation — the overflow guard is
 * what refuses this one. Same observable outcome: rejected, no overflow. */
TEST(chunk_size_overflow_rejected) {
    size_t n = 123;
    char *out = decode("1FFFFFFFFFFFFFFFF\r\noverflow me\r\n0\r\n\r\n", &n);
    CHECK(out != NULL);
    CHECK_LONG(n, 0);
    free(out);
}

/* A valid prefix chunk is preserved; the decoder stops AT the absurd chunk
 * rather than dropping everything — and, critically, does not overflow. */
TEST(good_prefix_then_absurd_chunk) {
    size_t n = 0;
    char *out = decode("3\r\nabc\r\nFFFFFFFFFFFFFFFF\r\nx\r\n0\r\n\r\n", &n);
    CHECK(out != NULL);
    CHECK_LONG(n, 3);
    CHECK_STR(out, "abc");
    free(out);
}

/* A chunk size larger than the remaining body (but not overflowing) is also
 * refused — the honest large-value path of the same bounds check. */
TEST(chunk_size_exceeds_body_rejected) {
    size_t n = 0;
    char *out = decode("ff\r\nonly-a-few\r\n", &n);
    CHECK(out != NULL);
    CHECK_LONG(n, 0);
    free(out);
}

/* ── Framing: where one response ends on a kept-alive connection ──────
 *
 * The client used to read every reply until the server hung up, which is
 * why every request paid a fresh TCP + TLS handshake (~0.6 s each to the
 * real bouncer; ~40 of them at startup). Reusing the connection means the
 * reader must stop at exactly the end of THIS response: by Content-Length,
 * by the terminating chunk, or — when the server gave neither — by the
 * close, in which case the connection cannot be reused. */
static http_frame frame(const char *raw, size_t *total, bool *keep) {
    return http_frame_response(raw, strlen(raw), total, keep);
}

TEST(framing_by_content_length) {
    size_t total = 0;
    bool keep = false;
    const char *r = "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello";
    CHECK(frame(r, &total, &keep) == HTTP_FRAME_COMPLETE);
    CHECK_LONG(total, strlen(r));
    CHECK(keep);
    /* A response is complete at its length even when the next one's bytes
     * already follow it. */
    char two[256];
    snprintf(two, sizeof(two), "%sHTTP/1.1 204 No Content\r\n\r\n", r);
    CHECK(frame(two, &total, &keep) == HTTP_FRAME_COMPLETE);
    CHECK_LONG(total, strlen(r));
    /* Short of the length, or short of the headers: read more. */
    CHECK(frame("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhel", &total, &keep) ==
          HTTP_FRAME_PARTIAL);
    CHECK(frame("HTTP/1.1 200 OK\r\nContent-Len", &total, &keep) == HTTP_FRAME_PARTIAL);
    /* Header names are case-insensitive and values may carry spaces. */
    CHECK(frame("HTTP/1.1 200 OK\r\ncontent-length:   2  \r\n\r\nok", &total, &keep) ==
          HTTP_FRAME_COMPLETE);
}

TEST(framing_by_chunks) {
    size_t total = 0;
    bool keep = false;
    const char *r = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n"
                    "5\r\nhello\r\n0\r\n\r\n";
    CHECK(frame(r, &total, &keep) == HTTP_FRAME_COMPLETE);
    CHECK_LONG(total, strlen(r));
    CHECK(keep);
    /* The last chunk is there but not its closing blank line yet. */
    CHECK(frame("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n",
                &total, &keep) == HTTP_FRAME_PARTIAL);
    /* Mid-chunk. */
    CHECK(frame("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\na\r\nhel", &total,
                &keep) == HTTP_FRAME_PARTIAL);
    /* Trailers after the last chunk end at their own blank line. */
    const char *t = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n"
                    "1\r\nx\r\n0\r\nX-T: 1\r\n\r\n";
    CHECK(frame(t, &total, &keep) == HTTP_FRAME_COMPLETE);
    CHECK_LONG(total, strlen(t));
    /* A chunk size that cannot be a size is not a frame. */
    CHECK(frame("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n", &total,
                &keep) == HTTP_FRAME_BAD);
    CHECK(frame("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n"
                "FFFFFFFFFFFFFFFFFF\r\n",
                &total, &keep) == HTTP_FRAME_BAD);
}

TEST(framing_without_a_length_runs_to_the_close) {
    size_t total = 0;
    bool keep = true;
    CHECK(frame("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nabc", &total, &keep) ==
          HTTP_FRAME_UNTIL_CLOSE);
    CHECK(!keep);
    /* No body by definition: complete at the headers, and reusable. */
    const char *nc = "HTTP/1.1 204 No Content\r\n\r\n";
    CHECK(frame(nc, &total, &keep) == HTTP_FRAME_COMPLETE);
    CHECK_LONG(total, strlen(nc));
    CHECK(keep);
    CHECK(frame("HTTP/1.1 304 Not Modified\r\n\r\n", &total, &keep) == HTTP_FRAME_COMPLETE);
}

TEST(framing_reads_the_servers_wish_to_close) {
    size_t total = 0;
    bool keep = true;
    CHECK(frame("HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 0\r\n\r\n", &total,
                &keep) == HTTP_FRAME_COMPLETE);
    CHECK(!keep);
    CHECK(frame("HTTP/1.1 200 OK\r\nconnection: Close\r\nContent-Length: 0\r\n\r\n", &total,
                &keep) == HTTP_FRAME_COMPLETE);
    CHECK(!keep);
    /* HTTP/1.0 closes unless it says otherwise. */
    CHECK(frame("HTTP/1.0 200 OK\r\nContent-Length: 0\r\n\r\n", &total, &keep) ==
          HTTP_FRAME_COMPLETE);
    CHECK(!keep);
    CHECK(frame("HTTP/1.0 200 OK\r\nConnection: keep-alive\r\nContent-Length: 0\r\n\r\n",
                &total, &keep) == HTTP_FRAME_COMPLETE);
    CHECK(keep);
}

TEST(framing_refuses_what_is_not_a_response) {
    size_t total = 0;
    bool keep = false;
    CHECK(frame("SSH-2.0-OpenSSH\r\n\r\n", &total, &keep) == HTTP_FRAME_BAD);
    CHECK(frame("HTTP/1.1 200 OK\r\nContent-Length: -1\r\n\r\n", &total, &keep) ==
          HTTP_FRAME_BAD);
    CHECK(frame("HTTP/1.1 200 OK\r\nContent-Length: 99999999999999999999999\r\n\r\n", &total,
                &keep) == HTTP_FRAME_BAD);
    /* Two lengths that disagree is the request-smuggling shape. */
    CHECK(frame("HTTP/1.1 200 OK\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\nab", &total,
                &keep) == HTTP_FRAME_BAD);
}

int main(void) {
    RUN(single_chunk);
    RUN(multiple_chunks);
    RUN(hex_size_uppercase_and_lower);
    RUN(empty_body);
    RUN(chunk_size_size_max_rejected);
    RUN(chunk_size_overflow_rejected);
    RUN(good_prefix_then_absurd_chunk);
    RUN(chunk_size_exceeds_body_rejected);
    RUN(framing_by_content_length);
    RUN(framing_by_chunks);
    RUN(framing_without_a_length_runs_to_the_close);
    RUN(framing_reads_the_servers_wish_to_close);
    RUN(framing_refuses_what_is_not_a_response);
    return test_report();
}
