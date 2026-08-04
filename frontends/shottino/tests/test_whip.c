/* test_whip — the WHIP signalling parsers.
 *
 * These bytes arrive from a URL that came out of an IRC message, i.e.
 * from a stranger, so they get the same treatment as the websocket and
 * HTTP paths: parsed under ASan/UBSan, and asserted to REFUSE malformed
 * input rather than to half-understand it.
 *
 * Deliberately links only whip.c + http.c — no libdatachannel. The
 * vendored submodule is opt-in and the gate must not depend on it having
 * been built, so everything testable here is kept free of it.
 */
#include "../call/whip.h"

#include <stdlib.h>
#include <string.h>

#include "test.h"

TEST(a_url_is_split_or_refused) {
    struct whip_url u;

    CHECK(whip_url_parse("https://sfu.example/room/whip", &u));
    CHECK(u.tls);
    CHECK_STR(u.host, "sfu.example");
    CHECK_LONG(u.port, 443);
    CHECK_STR(u.path, "/room/whip");

    CHECK(whip_url_parse("http://sfu.example/x", &u));
    CHECK(!u.tls);
    CHECK_LONG(u.port, 80);

    CHECK(whip_url_parse("https://sfu.example:8889/room/whip", &u));
    CHECK_LONG(u.port, 8889);
    CHECK_STR(u.host, "sfu.example");

    /* No path means "/": a request line without one is malformed, so it
     * is normalised once here instead of at every use. */
    CHECK(whip_url_parse("https://sfu.example", &u));
    CHECK_STR(u.path, "/");

    /* Brackets are syntax, not part of the name — getaddrinfo wants them
     * gone and SNI must never see them. */
    CHECK(whip_url_parse("https://[2001:db8::1]:9000/whip", &u));
    CHECK_STR(u.host, "2001:db8::1");
    CHECK_LONG(u.port, 9000);

    /* A fragment is a client-side concept and is never sent. */
    CHECK(whip_url_parse("https://sfu.example/whip#frag", &u));
    CHECK_STR(u.path, "/whip");

    /* Every other scheme is refused rather than guessed: this URL
     * arrived in a message somebody else wrote. */
    CHECK(!whip_url_parse("file:///etc/passwd", &u));
    CHECK(!whip_url_parse("ws://sfu.example/whip", &u));
    CHECK(!whip_url_parse("javascript:alert(1)", &u));
    CHECK(!whip_url_parse("sfu.example/whip", &u));
    CHECK(!whip_url_parse("", &u));
    CHECK(!whip_url_parse("https://", &u));
    CHECK(!whip_url_parse("https://sfu.example:0/x", &u));
    CHECK(!whip_url_parse("https://sfu.example:99999/x", &u));
    CHECK(!whip_url_parse("https://sfu.example:notaport/x", &u));
}

/* WHIP servers are explicitly allowed to answer 201 with a RELATIVE
 * Location, and several do. Getting this wrong means the DELETE that
 * hangs up goes to the wrong place — or nowhere. */
TEST(a_location_resolves_against_the_request) {
    struct whip_url base;
    CHECK(whip_url_parse("https://sfu.example/room/whip", &base));
    char out[WHIP_MAX_URL];

    CHECK(whip_resolve(&base, "https://other.example/session/1", out, sizeof(out)));
    CHECK_STR(out, "https://other.example/session/1");

    CHECK(whip_resolve(&base, "/session/42", out, sizeof(out)));
    CHECK_STR(out, "https://sfu.example/session/42");

    /* Relative resolves against the request path's DIRECTORY. */
    CHECK(whip_resolve(&base, "42", out, sizeof(out)));
    CHECK_STR(out, "https://sfu.example/room/42");

    /* A non-default port survives resolution, or the DELETE misses. */
    struct whip_url ported;
    CHECK(whip_url_parse("https://sfu.example:8889/room/whip", &ported));
    CHECK(whip_resolve(&ported, "/session/7", out, sizeof(out)));
    CHECK_STR(out, "https://sfu.example:8889/session/7");

    /* Leading whitespace is header formatting, not part of the value. */
    CHECK(whip_resolve(&base, "  /session/9", out, sizeof(out)));
    CHECK_STR(out, "https://sfu.example/session/9");

    /* Refused rather than half-understood. */
    CHECK(!whip_resolve(&base, "//evil.example/x", out, sizeof(out)));
    CHECK(!whip_resolve(&base, "file:///etc/passwd", out, sizeof(out)));
    CHECK(!whip_resolve(&base, "", out, sizeof(out)));
}

TEST(a_response_is_parsed_or_refused) {
    struct whip_response r;

    static const char created[] = "HTTP/1.1 201 Created\r\n"
                                  "Content-Type: application/sdp\r\n"
                                  "Location: /session/42\r\n"
                                  "Content-Length: 7\r\n"
                                  "\r\n"
                                  "v=0\r\na=";
    CHECK(whip_response_parse(created, sizeof(created) - 1, &r));
    CHECK_LONG(r.status, 201);
    CHECK_STR(r.location, "/session/42");
    CHECK_LONG((long)r.body_len, 7);
    CHECK_STR(r.body, "v=0\r\na=");
    whip_response_free(&r);

    /* Bare-LF headers: lenient about line endings, like every real
     * client, because a server that sends them is not a server we get
     * to fix. */
    static const char lf[] = "HTTP/1.1 200 OK\nContent-Length: 3\n\nabc";
    CHECK(whip_response_parse(lf, sizeof(lf) - 1, &r));
    CHECK_LONG(r.status, 200);
    CHECK_STR(r.body, "abc");
    whip_response_free(&r);

    /* Chunked goes through shottino's already hardened decoder rather
     * than a second one that would have to be hardened separately. */
    static const char chunked[] = "HTTP/1.1 201 Created\r\n"
                                  "Transfer-Encoding: chunked\r\n"
                                  "Location: https://sfu.example/s/1\r\n"
                                  "\r\n"
                                  "4\r\nv=0\n\r\n0\r\n\r\n";
    CHECK(whip_response_parse(chunked, sizeof(chunked) - 1, &r));
    CHECK_LONG(r.status, 201);
    CHECK_STR(r.location, "https://sfu.example/s/1");
    CHECK_STR(r.body, "v=0\n");
    whip_response_free(&r);

    /* Header names are case-insensitive on the wire. */
    static const char lower[] = "HTTP/1.1 201 Created\r\nlocation: /s/2\r\ncontent-length: 1\r\n\r\nx";
    CHECK(whip_response_parse(lower, sizeof(lower) - 1, &r));
    CHECK_STR(r.location, "/s/2");
    whip_response_free(&r);

    /* An error status is a SUCCESSFUL parse that reports the status —
     * the caller decides what 4xx means, not the parser. */
    static const char gone[] = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n";
    CHECK(whip_response_parse(gone, sizeof(gone) - 1, &r));
    CHECK_LONG(r.status, 404);
    CHECK_LONG((long)r.body_len, 0);
    whip_response_free(&r);

    /* A Content-Length longer than the bytes in hand means the read was
     * cut short: trust the smaller of the two rather than reading past
     * the buffer. */
    static const char lying[] = "HTTP/1.1 200 OK\r\nContent-Length: 9999\r\n\r\nshort";
    CHECK(whip_response_parse(lying, sizeof(lying) - 1, &r));
    CHECK_LONG((long)r.body_len, 5);
    CHECK_STR(r.body, "short");
    whip_response_free(&r);

    /* A header block that never terminates is TRUNCATED, and a truncated
     * answer that parses is worse than one that does not — the SDP would
     * be silently short. */
    static const char cut[] = "HTTP/1.1 201 Created\r\nLocation: /s/3\r\n";
    CHECK(!whip_response_parse(cut, sizeof(cut) - 1, &r));

    /* Not a response at all. */
    CHECK(!whip_response_parse("garbage\r\n\r\n", 11, &r));
    CHECK(!whip_response_parse("HTTP/1.1 abc OK\r\n\r\n", 19, &r));
    CHECK(!whip_response_parse("", 0, &r));

    /* A "Location:" inside the REASON PHRASE is not a header. */
    static const char sneaky[] = "HTTP/1.1 201 Location: /evil\r\nContent-Length: 0\r\n\r\n";
    CHECK(whip_response_parse(sneaky, sizeof(sneaky) - 1, &r));
    CHECK_STR(r.location, "");
    whip_response_free(&r);
}

/* Both spellings of a response carrying ZERO header lines. The blank-line
 * terminator IS the status line's own newline, so the two pointers that
 * bound the header block have CROSSED: subtracting them into a size_t
 * wraps to about SIZE_MAX and the header scan then walks off the end of
 * the response buffer, reading — and, on a "Location:" hit, COPYING into
 * the session resource — whatever heap follows it.
 *
 * The bytes are handed over in a TIGHT heap allocation, so the over-read
 * is a sanitizer abort here rather than the quiet stroll through the rest
 * of a 256 KB buffer that it is in production. */
static void a_response_with_no_headers(const char *bytes) {
    size_t len = strlen(bytes);
    char *tight = malloc(len);
    CHECK(tight != NULL);
    if (!tight) return;
    memcpy(tight, bytes, len);

    /* Well-formed, just useless: the status is reported and the caller
     * decides what to do about the missing Location, exactly as it does
     * for a 404. */
    struct whip_response r;
    CHECK(whip_response_parse(tight, len, &r));
    CHECK_LONG(r.status, 200);
    CHECK_STR(r.location, "");
    CHECK_LONG((long)r.body_len, 0);
    whip_response_free(&r);
    free(tight);
}

TEST(a_header_block_can_be_empty_but_never_endless) {
    a_response_with_no_headers("HTTP/1.1 200 OK\r\n\r\n");
    a_response_with_no_headers("HTTP/1.1 200 OK\n\n");
}

int main(void) {
    RUN(a_url_is_split_or_refused);
    RUN(a_location_resolves_against_the_request);
    RUN(a_response_is_parsed_or_refused);
    RUN(a_header_block_can_be_empty_but_never_endless);
    return test_report();
}
