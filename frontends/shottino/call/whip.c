/* whip.c — see whip.h for what WHIP is and why it is the cheap option. */
#include "whip.h"
#include "../http.h"

#include <ctype.h>
#include <errno.h>
#include <limits.h>
#include <netdb.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <sys/types.h>
#include <unistd.h>

#include <openssl/err.h>
#include <openssl/ssl.h>

/* ── URL parsing ──────────────────────────────────────────────────────── */

bool whip_url_parse(const char *url, struct whip_url *out) {
    if (!url || !out) return false;
    memset(out, 0, sizeof(*out));

    const char *p;
    if (strncmp(url, "https://", 8) == 0) {
        out->tls = true;
        out->port = 443;
        p = url + 8;
    } else if (strncmp(url, "http://", 7) == 0) {
        out->tls = false;
        out->port = 80;
        p = url + 7;
    } else {
        /* Every other scheme is refused rather than guessed: this URL
         * arrived in an IRC message. */
        return false;
    }

    /* Host, which may be a bracketed IPv6 literal. The brackets are
     * syntax, not part of the name — getaddrinfo wants them gone, and
     * SNI must never see them. */
    size_t n = 0;
    if (*p == '[') {
        p++;
        while (*p && *p != ']') {
            if (n + 1 >= sizeof(out->host)) return false;
            out->host[n++] = *p++;
        }
        if (*p != ']') return false;
        p++;
    } else {
        while (*p && *p != ':' && *p != '/' && *p != '?' && *p != '#') {
            if (n + 1 >= sizeof(out->host)) return false;
            out->host[n++] = *p++;
        }
    }
    out->host[n] = 0;
    if (n == 0) return false;

    if (*p == ':') {
        p++;
        if (!isdigit((unsigned char)*p)) return false;
        long port = 0;
        while (isdigit((unsigned char)*p)) {
            port = port * 10 + (*p++ - '0');
            if (port > 65535) return false;
        }
        if (port < 1) return false;
        out->port = (int)port;
    }

    /* A URL with no path means "/": a request line without one is
     * malformed, so this is normalised here rather than at every use. */
    if (*p != '/') {
        if (*p && *p != '?' && *p != '#') return false;
        /* Refused rather than cut to length, like the branch below: a
         * truncated query is a DIFFERENT request — another session id,
         * a token that is no longer the token — and it would go out
         * looking like the one that was asked for. */
        if (strlen(p) + 2 > sizeof(out->path)) return false;
        snprintf(out->path, sizeof(out->path), "/%s", p);
    } else {
        if (strlen(p) + 1 > sizeof(out->path)) return false;
        snprintf(out->path, sizeof(out->path), "%s", p);
    }
    /* A fragment is a client-side concept and is never sent. */
    char *hash = strchr(out->path, '#');
    if (hash) *hash = 0;
    return true;
}

/* Render a whip_url back to an absolute URL, omitting the default port
 * so the result is the spelling a server would recognise as its own. */
static bool whip_url_format(const struct whip_url *u, char *out, size_t out_sz) {
    bool bracket = strchr(u->host, ':') != NULL; /* IPv6 literal */
    bool default_port = (u->tls && u->port == 443) || (!u->tls && u->port == 80);
    int w;
    if (default_port)
        w = snprintf(out, out_sz, "%s://%s%s%s%s", u->tls ? "https" : "http", bracket ? "[" : "",
                     u->host, bracket ? "]" : "", u->path);
    else
        w = snprintf(out, out_sz, "%s://%s%s%s:%d%s", u->tls ? "https" : "http",
                     bracket ? "[" : "", u->host, bracket ? "]" : "", u->port, u->path);
    return w > 0 && (size_t)w < out_sz;
}

bool whip_resolve(const struct whip_url *base, const char *location, char *out, size_t out_sz) {
    if (!base || !location || !out || out_sz == 0) return false;
    while (*location == ' ' || *location == '\t') location++;
    if (!*location) return false;

    /* Absolute: accepted only if it is still http/https. A 201 that
     * redirects the session resource to another scheme is not something
     * to follow quietly. */
    if (strncmp(location, "https://", 8) == 0 || strncmp(location, "http://", 7) == 0) {
        struct whip_url probe;
        if (!whip_url_parse(location, &probe)) return false;
        if (strlen(location) + 1 > out_sz) return false;
        snprintf(out, out_sz, "%s", location);
        return true;
    }
    /* A scheme-relative Location is refused rather than half-understood:
     * "//evil.example/x" keeps our scheme but changes the HOST. */
    if (strncmp(location, "//", 2) == 0) return false;
    /* Anything else carrying a SCHEME is not a relative reference, and
     * the only two schemes allowed were accepted above — so this is a
     * `file:` or worse. RFC 3986: ALPHA *( ALPHA / DIGIT / "+" / "-" /
     * "." ) ":". Checked properly rather than by looking for a colon,
     * which "file:///etc/passwd" passes on its way to being treated as
     * a relative path. */
    if (isalpha((unsigned char)location[0])) {
        size_t i = 1;
        while (isalnum((unsigned char)location[i]) || location[i] == '+' ||
               location[i] == '-' || location[i] == '.')
            i++;
        if (location[i] == ':') return false;
    }

    struct whip_url resolved = *base;
    if (location[0] == '/') {
        if (strlen(location) + 1 > sizeof(resolved.path)) return false;
        snprintf(resolved.path, sizeof(resolved.path), "%s", location);
    } else {
        /* Relative to the request path's DIRECTORY, which is everything
         * up to and including the last '/'. */
        const char *slash = strrchr(base->path, '/');
        size_t dir = slash ? (size_t)(slash - base->path) + 1 : 1;
        if (dir + strlen(location) + 1 > sizeof(resolved.path)) return false;
        memcpy(resolved.path, base->path, dir);
        resolved.path[dir] = 0;
        snprintf(resolved.path + dir, sizeof(resolved.path) - dir, "%s", location);
    }
    return whip_url_format(&resolved, out, out_sz);
}

/* ── Response parsing ─────────────────────────────────────────────────── */

/* Case-insensitive header lookup over one header block. `block` spans
 * the headers only, without the terminating blank line. */
static bool header_value(const char *block, size_t len, const char *name, char *out,
                         size_t out_sz) {
    size_t name_len = strlen(name);
    size_t pos = 0;
    while (pos < len) {
        size_t eol = pos;
        while (eol < len && block[eol] != '\n') eol++;
        size_t line_end = eol;
        if (line_end > pos && block[line_end - 1] == '\r') line_end--;

        if (line_end - pos > name_len && strncasecmp(block + pos, name, name_len) == 0 &&
            block[pos + name_len] == ':') {
            size_t v = pos + name_len + 1;
            while (v < line_end && (block[v] == ' ' || block[v] == '\t')) v++;
            size_t vlen = line_end - v;
            if (vlen + 1 > out_sz) return false;
            memcpy(out, block + v, vlen);
            out[vlen] = 0;
            return true;
        }
        pos = eol + 1;
    }
    return false;
}

bool whip_response_parse(const char *raw, size_t len, struct whip_response *out) {
    if (!raw || !out) return false;
    memset(out, 0, sizeof(*out));

    /* Status line: "HTTP/1.x NNN ..." */
    if (len < 12 || strncmp(raw, "HTTP/1.", 7) != 0) return false;
    const char *sp = memchr(raw, ' ', len);
    if (!sp) return false;
    size_t at = (size_t)(sp - raw) + 1;
    if (at + 3 > len) return false;
    if (!isdigit((unsigned char)raw[at]) || !isdigit((unsigned char)raw[at + 1]) ||
        !isdigit((unsigned char)raw[at + 2]))
        return false;
    out->status = (raw[at] - '0') * 100 + (raw[at + 1] - '0') * 10 + (raw[at + 2] - '0');

    /* Header/body split. A response whose header block never terminates
     * is TRUNCATED, and a truncated answer that parses is worse than one
     * that does not: the SDP would be silently short. */
    const char *hdr_end = NULL;
    size_t body_at = 0;
    for (size_t i = 0; i + 1 < len; i++) {
        if (raw[i] == '\n' && raw[i + 1] == '\n') {
            hdr_end = raw + i;
            body_at = i + 2;
            break;
        }
        if (i + 3 < len && raw[i] == '\r' && raw[i + 1] == '\n' && raw[i + 2] == '\r' &&
            raw[i + 3] == '\n') {
            hdr_end = raw + i;
            body_at = i + 4;
            break;
        }
    }
    if (!hdr_end) return false;

    /* Past the status line, so a "Location" appearing in the reason
     * phrase cannot be read as a header. */
    const char *first_eol = memchr(raw, '\n', len);
    if (!first_eol) return false;
    const char *hblock = first_eol + 1;
    /* With ZERO header lines the blank-line terminator IS the status
     * line's own newline, so hblock lands PAST hdr_end and the two
     * pointers have crossed: subtracting them into a size_t wraps to
     * about SIZE_MAX and the header scan below walks off the end of the
     * buffer. Such a response has an EMPTY header block, which is what
     * the clamp says. It is not refused: a response nobody can use is
     * still a response, and the caller reports its status — same
     * reasoning as the 404 that parses fine and has no Location. */
    size_t hlen = hblock < hdr_end ? (size_t)(hdr_end - hblock) : 0;

    header_value(hblock, hlen, "Location", out->location, sizeof(out->location));

    size_t body_len = len - body_at;
    char enc[64];
    if (header_value(hblock, hlen, "Transfer-Encoding", enc, sizeof(enc)) &&
        strcasecmp(enc, "chunked") == 0) {
        /* shottino's decoder, not a second one: it is already hardened
         * against a hostile chunk size and already under the sanitizers. */
        size_t decoded = 0;
        out->body = http_decode_chunked(raw + body_at, body_len, &decoded);
        if (!out->body) return false;
        out->body_len = decoded;
        return true;
    }

    char clen[32];
    if (header_value(hblock, hlen, "Content-Length", clen, sizeof(clen))) {
        char *end = NULL;
        errno = 0;
        unsigned long declared = strtoul(clen, &end, 10);
        if (errno || !end || *end) return false;
        /* Trust the smaller of declared and received: a Content-Length
         * longer than the bytes in hand means the read was cut short. */
        if (declared < body_len) body_len = declared;
    }

    out->body = malloc(body_len + 1);
    if (!out->body) return false;
    memcpy(out->body, raw + body_at, body_len);
    out->body[body_len] = 0;
    out->body_len = body_len;
    return true;
}

void whip_response_free(struct whip_response *r) {
    if (!r) return;
    free(r->body);
    r->body = NULL;
    r->body_len = 0;
}

/* ── The one part that touches a socket ───────────────────────────────── */

#define WHIP_MAX_RESPONSE (256u * 1024u)

static void set_err(char *err, size_t err_sz, const char *fmt, ...) {
    if (!err || err_sz == 0) return;
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(err, err_sz, fmt, ap);
    va_end(ap);
}

static int dial(const char *host, int port, int timeout_ms, char *err, size_t err_sz) {
    char service[16];
    snprintf(service, sizeof(service), "%d", port);
    struct addrinfo hints;
    memset(&hints, 0, sizeof(hints));
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    struct addrinfo *res = NULL;
    int rc = getaddrinfo(host, service, &hints, &res);
    if (rc != 0) {
        set_err(err, err_sz, "cannot resolve %s: %s", host, gai_strerror(rc));
        return -1;
    }
    int fd = -1;
    for (struct addrinfo *ai = res; ai; ai = ai->ai_next) {
        fd = socket(ai->ai_family, ai->ai_socktype, ai->ai_protocol);
        if (fd < 0) continue;
        struct timeval tv = { .tv_sec = timeout_ms / 1000,
                              .tv_usec = (timeout_ms % 1000) * 1000 };
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
        if (connect(fd, ai->ai_addr, ai->ai_addrlen) == 0) break;
        close(fd);
        fd = -1;
    }
    freeaddrinfo(res);
    if (fd < 0) set_err(err, err_sz, "cannot connect to %s:%d: %s", host, port, strerror(errno));
    return fd;
}

/* Anything that would end the request line early, i.e. every C0 byte,
 * DEL, and the space that separates target from version. */
static bool has_request_line_break(const char *s) {
    for (const unsigned char *p = (const unsigned char *)s; *p; p++)
        if (*p <= ' ' || *p == 0x7f) return true;
    return false;
}

bool whip_request(const struct whip_url *url, const char *method, const char *content_type,
                  const char *body, int timeout_ms, struct whip_response *out, char *err,
                  size_t err_sz) {
    if (!url || !method || !out) return false;

    /* BELT AND BRACES over the encoding done by whoever built this URL.
     *
     * A request line is ONE line: a CR in the path is not a strange path,
     * it is a second request the server will answer, and a CR in the host
     * is an extra header. Today every caller encodes its path segments
     * and the URL arrived in an IRC message, which cannot carry either
     * byte — this gate is what keeps that true the day the URL comes from
     * a config value, a flag, a redirect Location or a transport that is
     * not IRC. Refused rather than encoded: at this depth we can no
     * longer tell a path apart from its delimiters. */
    if (has_request_line_break(url->path) || has_request_line_break(url->host)) {
        set_err(err, err_sz, "refusing a URL with a control character in it");
        return false;
    }

    int fd = dial(url->host, url->port, timeout_ms, err, err_sz);
    if (fd < 0) return false;

    SSL_CTX *ctx = NULL;
    SSL *ssl = NULL;
    if (url->tls) {
        ctx = SSL_CTX_new(TLS_client_method());
        if (!ctx) {
            set_err(err, err_sz, "cannot create a TLS context");
            close(fd);
            return false;
        }
        SSL_CTX_set_default_verify_paths(ctx);
        SSL_CTX_set_verify(ctx, SSL_VERIFY_PEER, NULL);
        ssl = SSL_new(ctx);
        if (!ssl) {
            set_err(err, err_sz, "cannot create a TLS session");
            SSL_CTX_free(ctx);
            close(fd);
            return false;
        }
        SSL_set_fd(ssl, fd);
        SSL_set_tlsext_host_name(ssl, url->host);
        /* SNI only NAMES the host; SSL_VERIFY_PEER validates the CHAIN
         * but not that the certificate belongs to THIS host. Without
         * binding the expected name, any CA-signed certificate for any
         * domain passes and an active MITM reads the session. Same
         * reasoning, same pair of calls, as shottino's own client. */
        if (SSL_set1_host(ssl, url->host) != 1 || SSL_connect(ssl) != 1) {
            set_err(err, err_sz, "TLS handshake with %s failed (certificate or hostname)",
                    url->host);
            SSL_free(ssl);
            SSL_CTX_free(ctx);
            close(fd);
            return false;
        }
    }

    size_t body_len = body ? strlen(body) : 0;
    /* Host carries the PORT whenever it is not the scheme's default.
     * Omitting it reaches the right socket and then the wrong vhost —
     * and an SFU behind a reverse proxy routes on this header. */
    char hostport[WHIP_MAX_HOST + 8];
    bool bracket = strchr(url->host, ':') != NULL; /* IPv6 literal */
    bool default_port = (url->tls && url->port == 443) || (!url->tls && url->port == 80);
    if (default_port)
        snprintf(hostport, sizeof(hostport), "%s%s%s", bracket ? "[" : "", url->host,
                 bracket ? "]" : "");
    else
        snprintf(hostport, sizeof(hostport), "%s%s%s:%d", bracket ? "[" : "", url->host,
                 bracket ? "]" : "", url->port);

    char head[WHIP_MAX_URL + 512];
    int hn = snprintf(head, sizeof(head),
                      "%s %s HTTP/1.1\r\n"
                      "Host: %s\r\n"
                      "User-Agent: shottino-call\r\n"
                      "Accept: application/sdp\r\n"
                      "Connection: close\r\n"
                      "%s%s%s"
                      "Content-Length: %zu\r\n"
                      "\r\n",
                      method, url->path, hostport, content_type ? "Content-Type: " : "",
                      content_type ? content_type : "", content_type ? "\r\n" : "", body_len);
    bool ok = hn > 0 && (size_t)hn < sizeof(head);
    if (!ok) set_err(err, err_sz, "request line too long");

    /* Header then body, both to completion: a short write on a socket is
     * normal, not an error. */
    for (int part = 0; ok && part < 2; part++) {
        const char *buf = part == 0 ? head : body;
        size_t remain = part == 0 ? (size_t)hn : body_len;
        while (ok && remain > 0) {
            int w = ssl ? SSL_write(ssl, buf, (int)(remain > INT_MAX ? INT_MAX : remain))
                        : (int)send(fd, buf, remain, 0);
            if (w <= 0) {
                set_err(err, err_sz, "connection dropped while sending");
                ok = false;
                break;
            }
            buf += w;
            remain -= (size_t)w;
        }
    }

    char *raw = ok ? malloc(WHIP_MAX_RESPONSE) : NULL;
    size_t len = 0;
    if (ok && !raw) {
        set_err(err, err_sz, "out of memory");
        ok = false;
    }
    while (ok) {
        size_t room = WHIP_MAX_RESPONSE - 1 - len;
        if (room == 0) break; /* a body this large is not an SDP answer */
        int r = ssl ? SSL_read(ssl, raw + len, (int)(room > INT_MAX ? INT_MAX : room))
                    : (int)recv(fd, raw + len, room, 0);
        if (r <= 0) break; /* Connection: close — EOF ends the body */
        len += (size_t)r;
    }

    if (ssl) {
        SSL_shutdown(ssl);
        SSL_free(ssl);
    }
    if (ctx) SSL_CTX_free(ctx);
    close(fd);

    if (ok && len == 0) {
        set_err(err, err_sz, "no answer from %s", url->host);
        ok = false;
    }
    if (ok) {
        ok = whip_response_parse(raw, len, out);
        if (!ok) set_err(err, err_sz, "malformed HTTP response from %s", url->host);
    }
    free(raw);
    return ok;
}
