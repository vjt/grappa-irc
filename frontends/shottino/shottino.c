// Shottino, a standalone terminal client for grappa.
//
// Contract: authenticate against grappa's REST API, read scrollback via REST,
// send PRIVMSG/JOIN/PART via REST, and subscribe to Phoenix Channels for live
// typed JSON events. The client never parses IRC framing.

#include <arpa/inet.h>
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <locale.h>
#include <netdb.h>
#include <ncurses.h>
#include <openssl/bio.h>
#include <openssl/buffer.h>
#include <openssl/evp.h>
#include <openssl/rand.h>
#include <openssl/ssl.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/socket.h>
#include <sys/ioctl.h>
#include <sys/types.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>
#include <sys/wait.h>
#include <sys/stat.h>
#include <limits.h>

#define MAX_TOKEN 4096
#define MAX_SUBJECT 512
#define MAX_NETWORKS 32
#define MAX_WINDOWS 128
#define MAX_CHANNEL 256
#define MAX_SLUG 128
#define MAX_LINE 1024
#define MAX_TOPIC 4096
#define LOG_LINES 2000
#define HTTP_MAX (4 * 1024 * 1024)
#define WS_MAX_PAYLOAD (1024 * 1024)
#define JOB_QUEUE 256
#define SEEN_MESSAGES 12000
#define INPUT_HISTORY 200
#define PANEL_LINES 256
#define MAX_LINK_REGIONS 256

enum color_pair {
    CP_MAIN = 1,
    CP_ALT,
    CP_BORDER,
    CP_ACCENT,
    CP_MUTED,
    CP_MENTION,
    CP_ERROR,
    CP_INPUT,
    CP_SELECTED,
    CP_NICK0,
    CP_NICK1,
    CP_NICK2,
    CP_NICK3,
    CP_NICK4,
    CP_NICK5,
    CP_NICK6,
    CP_NICK7,
    CP_NICK8,
    CP_NICK9,
    CP_NICK10,
    CP_NICK11,
    CP_NICK12,
    CP_NICK13,
    CP_NICK14,
    CP_NICK15
};

enum theme_color {
    TC_BG = 16,
    TC_BG_ALT,
    TC_FG,
    TC_ACCENT,
    TC_MUTED,
    TC_BORDER,
    TC_MENTION,
    TC_ERROR,
    TC_NICK0,
    TC_NICK1,
    TC_NICK2,
    TC_NICK3,
    TC_NICK4,
    TC_NICK5,
    TC_NICK6,
    TC_NICK7,
    TC_NICK8,
    TC_NICK9,
    TC_NICK10,
    TC_NICK11,
    TC_NICK12,
    TC_NICK13,
    TC_NICK14,
    TC_NICK15
};

struct url {
    bool tls;
    char host[256];
    char port[16];
    char base[512];
};

struct http_response {
    int status;
    char *body;
    size_t body_len;
};

struct tls_conn {
    int fd;
    bool tls;
    SSL *ssl;
};

struct network {
    int id;
    char slug[MAX_SLUG];
    char nick[MAX_CHANNEL];
};

struct window {
    char network[MAX_SLUG];
    char channel[MAX_CHANNEL];
    char topic[MAX_TOPIC];
    char members[512][MAX_CHANNEL];
    size_t member_count;
    long last_id;
    unsigned unread;
    bool joined_ws;
};

enum job_kind {
    JOB_FETCH,
    JOB_SEND,
    JOB_JOIN,
    JOB_PART,
    JOB_NICK,
    JOB_NETWORK_STATE,
    JOB_TOPIC,
    JOB_MEMBERS,
    JOB_CLOSE_QUERY
};

struct job {
    enum job_kind kind;
    char network[MAX_SLUG];
    char channel[MAX_CHANNEL];
    char arg1[MAX_LINE];
    char arg2[MAX_LINE];
};

struct seen_message {
    long id;
    char network[MAX_SLUG];
    char channel[MAX_CHANNEL];
};

struct pending_echo {
    unsigned long id;
    char network[MAX_SLUG];
    char channel[MAX_CHANNEL];
    char body[MAX_LINE];
};

enum panel_kind {
    PANEL_CHAT,
    PANEL_ARCHIVE,
    PANEL_SETTINGS,
    PANEL_ADMIN
};

/* A clickable media link rendered in the chat area. Recorded each draw()
 * frame (cleared at frame start) so mouse coordinates can be mapped back to
 * the URL under the cursor without re-deriving the wrapped layout. */
struct link_region {
    int y0;
    int y1;
    int x0;
    int x1;
    bool is_video;
    char url[MAX_LINE];
};

struct app {
    struct url url;
    char token[MAX_TOKEN];
    char token_path[PATH_MAX];
    char subject[MAX_SUBJECT];
    char login_nick[MAX_CHANNEL];
    struct network networks[MAX_NETWORKS];
    size_t network_count;
    struct window windows[MAX_WINDOWS];
    size_t window_count;
    size_t current;
    char *log[LOG_LINES];
    bool log_mentions[LOG_LINES];
    bool log_pending[LOG_LINES];
    size_t log_count;
    struct pending_echo pending[256];
    size_t pending_count;
    unsigned long next_pending_id;
    enum panel_kind panel;
    char *panel_lines[PANEL_LINES];
    size_t panel_line_count;
    struct seen_message seen[SEEN_MESSAGES];
    size_t seen_count;
    size_t seen_next;
    size_t scrollback_offset;
    bool scrollback_pinned;
    char input[MAX_LINE];
    size_t input_len;
    char last_url[MAX_LINE];
    char hover_url[MAX_LINE];
    struct link_region link_regions[MAX_LINK_REGIONS];
    size_t link_region_count;
    char history[INPUT_HISTORY][MAX_LINE];
    size_t history_count;
    size_t history_pos;
    bool running;
    pthread_mutex_t lock;
    pthread_mutex_t jobs_lock;
    pthread_cond_t jobs_cond;
    pthread_t worker;
    struct job jobs[JOB_QUEUE];
    size_t jobs_head;
    size_t jobs_tail;
    bool worker_stop;
    struct tls_conn ws;
    bool ws_connected;
    unsigned long ws_ref;
    time_t next_heartbeat;
    SSL_CTX *ssl_ctx;
};

static void die(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
static void startup(const char *fmt, ...) __attribute__((format(printf, 1, 2)));

static void die(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    vfprintf(stderr, fmt, ap);
    va_end(ap);
    fputc('\n', stderr);
    exit(1);
}

static void startup(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    fputs("shottino: ", stderr);
    vfprintf(stderr, fmt, ap);
    fputc('\n', stderr);
    fflush(stderr);
    va_end(ap);
}

static char *xasprintf(const char *fmt, ...) __attribute__((format(printf, 1, 2)));

static char *xasprintf(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    va_list ap2;
    va_copy(ap2, ap);
    int n = vsnprintf(NULL, 0, fmt, ap);
    va_end(ap);
    if (n < 0) die("format failed");
    char *s = malloc((size_t)n + 1);
    if (!s) die("out of memory");
    vsnprintf(s, (size_t)n + 1, fmt, ap2);
    va_end(ap2);
    return s;
}

static void log_line(struct app *app, const char *fmt, ...) __attribute__((format(printf, 2, 3)));
static void log_line_mention(struct app *app, bool mention, const char *fmt, ...) __attribute__((format(printf, 3, 4)));

static void log_line(struct app *app, const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    va_list ap2;
    va_copy(ap2, ap);
    int n = vsnprintf(NULL, 0, fmt, ap);
    va_end(ap);
    if (n < 0) return;
    char *s = malloc((size_t)n + 1);
    if (!s) return;
    vsnprintf(s, (size_t)n + 1, fmt, ap2);
    va_end(ap2);

    pthread_mutex_lock(&app->lock);
    if (app->log_count == LOG_LINES) {
        free(app->log[0]);
        memmove(app->log, app->log + 1, sizeof(app->log[0]) * (LOG_LINES - 1));
        memmove(app->log_mentions, app->log_mentions + 1, sizeof(app->log_mentions[0]) * (LOG_LINES - 1));
        memmove(app->log_pending, app->log_pending + 1, sizeof(app->log_pending[0]) * (LOG_LINES - 1));
        app->log_count--;
    }
    app->log[app->log_count] = s;
    app->log_mentions[app->log_count] = false;
    app->log_pending[app->log_count] = false;
    app->log_count++;
    pthread_mutex_unlock(&app->lock);
}

static void log_line_mention(struct app *app, bool mention, const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    va_list ap2;
    va_copy(ap2, ap);
    int n = vsnprintf(NULL, 0, fmt, ap);
    va_end(ap);
    if (n < 0) return;
    char *s = malloc((size_t)n + 1);
    if (!s) return;
    vsnprintf(s, (size_t)n + 1, fmt, ap2);
    va_end(ap2);

    pthread_mutex_lock(&app->lock);
    if (app->log_count == LOG_LINES) {
        free(app->log[0]);
        memmove(app->log, app->log + 1, sizeof(app->log[0]) * (LOG_LINES - 1));
        memmove(app->log_mentions, app->log_mentions + 1, sizeof(app->log_mentions[0]) * (LOG_LINES - 1));
        memmove(app->log_pending, app->log_pending + 1, sizeof(app->log_pending[0]) * (LOG_LINES - 1));
        app->log_count--;
    }
    app->log[app->log_count] = s;
    app->log_mentions[app->log_count] = mention;
    app->log_pending[app->log_count] = false;
    app->log_count++;
    pthread_mutex_unlock(&app->lock);
}

static void add_pending_echo(struct app *app, const char *network, const char *channel, const char *sender, const char *body) {
    char clock[16];
    time_t now = time(NULL);
    struct tm tm;
    localtime_r(&now, &tm);
    strftime(clock, sizeof(clock), "%H:%M", &tm);
    char *line = xasprintf("[%s/%s] %s <%s> %s", network, channel, clock, sender && sender[0] ? sender : "me", body);
    pthread_mutex_lock(&app->lock);
    if (app->log_count == LOG_LINES) {
        free(app->log[0]);
        memmove(app->log, app->log + 1, sizeof(app->log[0]) * (LOG_LINES - 1));
        memmove(app->log_mentions, app->log_mentions + 1, sizeof(app->log_mentions[0]) * (LOG_LINES - 1));
        memmove(app->log_pending, app->log_pending + 1, sizeof(app->log_pending[0]) * (LOG_LINES - 1));
        app->log_count--;
    }
    app->log[app->log_count] = line;
    app->log_mentions[app->log_count] = false;
    app->log_pending[app->log_count] = true;
    app->log_count++;
    if (app->pending_count < sizeof(app->pending) / sizeof(app->pending[0])) {
        struct pending_echo *p = &app->pending[app->pending_count++];
        p->id = ++app->next_pending_id;
        snprintf(p->network, sizeof(p->network), "%s", network);
        snprintf(p->channel, sizeof(p->channel), "%s", channel);
        snprintf(p->body, sizeof(p->body), "%s", body);
    }
    app->scrollback_offset = 0;
    app->scrollback_pinned = false;
    pthread_mutex_unlock(&app->lock);
}

static void clear_matching_pending_echo(struct app *app, const char *network, const char *channel, const char *body) {
    pthread_mutex_lock(&app->lock);
    for (size_t i = 0; i < app->log_count; i++) {
        if (!app->log_pending[i]) continue;
        if (strstr(app->log[i], body) && strstr(app->log[i], network) && strstr(app->log[i], channel)) {
            free(app->log[i]);
            memmove(app->log + i, app->log + i + 1, sizeof(app->log[0]) * (app->log_count - i - 1));
            memmove(app->log_mentions + i, app->log_mentions + i + 1, sizeof(app->log_mentions[0]) * (app->log_count - i - 1));
            memmove(app->log_pending + i, app->log_pending + i + 1, sizeof(app->log_pending[0]) * (app->log_count - i - 1));
            app->log_count--;
            break;
        }
    }
    for (size_t i = 0; i < app->pending_count; i++) {
        if (strcmp(app->pending[i].network, network) == 0 && strcmp(app->pending[i].channel, channel) == 0 && strcmp(app->pending[i].body, body) == 0) {
            memmove(app->pending + i, app->pending + i + 1, sizeof(app->pending[0]) * (app->pending_count - i - 1));
            app->pending_count--;
            break;
        }
    }
    pthread_mutex_unlock(&app->lock);
}

static bool has_matching_pending_echo(struct app *app, const char *network, const char *channel, const char *body) {
    bool found = false;
    pthread_mutex_lock(&app->lock);
    for (size_t i = 0; i < app->pending_count; i++) {
        if (strcmp(app->pending[i].network, network) == 0 && strcmp(app->pending[i].channel, channel) == 0 && strcmp(app->pending[i].body, body) == 0) {
            found = true;
            break;
        }
    }
    pthread_mutex_unlock(&app->lock);
    return found;
}

static bool has_matching_confirmed_line(struct app *app, const char *network, const char *channel, const char *sender, const char *body) {
    char key[MAX_SLUG + MAX_CHANNEL + 8];
    snprintf(key, sizeof(key), "[%s/%s]", network, channel);
    bool found = false;
    pthread_mutex_lock(&app->lock);
    for (size_t i = 0; i < app->log_count; i++) {
        if (app->log_pending[i]) continue;
        if (strncmp(app->log[i], key, strlen(key)) == 0 && strstr(app->log[i], sender) && strstr(app->log[i], body)) {
            found = true;
            break;
        }
    }
    pthread_mutex_unlock(&app->lock);
    return found;
}

static void clear_panel_lines(struct app *app) {
    for (size_t i = 0; i < app->panel_line_count; i++) free(app->panel_lines[i]);
    app->panel_line_count = 0;
}

static void panel_line(struct app *app, const char *fmt, ...) __attribute__((format(printf, 2, 3)));

static void panel_line(struct app *app, const char *fmt, ...) {
    if (app->panel_line_count == PANEL_LINES) return;
    va_list ap;
    va_start(ap, fmt);
    va_list ap2;
    va_copy(ap2, ap);
    int n = vsnprintf(NULL, 0, fmt, ap);
    va_end(ap);
    if (n < 0) return;
    char *s = malloc((size_t)n + 1);
    if (!s) return;
    vsnprintf(s, (size_t)n + 1, fmt, ap2);
    va_end(ap2);
    app->panel_lines[app->panel_line_count++] = s;
}

static int hexval(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static short rgb_component(int hex, int shift) {
    return (short)((((hex >> shift) & 0xff) * 1000) / 255);
}

static void define_color(short id, int hex) {
    if (can_change_color()) init_color(id, rgb_component(hex, 16), rgb_component(hex, 8), rgb_component(hex, 0));
}

static void init_theme(void) {
    if (!has_colors()) return;
    start_color();
    use_default_colors();

    define_color(TC_BG, 0x0a0a0a);
    define_color(TC_BG_ALT, 0x111111);
    define_color(TC_FG, 0xe0e0e0);
    define_color(TC_ACCENT, 0x5fafd7);
    define_color(TC_MUTED, 0x707070);
    define_color(TC_BORDER, 0x1f1f1f);
    define_color(TC_MENTION, 0x2a1f00);
    define_color(TC_ERROR, 0xd77070);
    define_color(TC_NICK0, 0xff8c8c);
    define_color(TC_NICK1, 0xffb060);
    define_color(TC_NICK2, 0xffd060);
    define_color(TC_NICK3, 0xd8e060);
    define_color(TC_NICK4, 0x90d870);
    define_color(TC_NICK5, 0x60d8a8);
    define_color(TC_NICK6, 0x60d8d8);
    define_color(TC_NICK7, 0x60b8e8);
    define_color(TC_NICK8, 0x88a8ff);
    define_color(TC_NICK9, 0xb890ff);
    define_color(TC_NICK10, 0xe088e0);
    define_color(TC_NICK11, 0xff90c0);
    define_color(TC_NICK12, 0xe0a888);
    define_color(TC_NICK13, 0xc0c0c0);
    define_color(TC_NICK14, 0xa0e8b8);
    define_color(TC_NICK15, 0xf0d090);

    init_pair(CP_MAIN, TC_FG, TC_BG);
    init_pair(CP_ALT, TC_FG, TC_BG_ALT);
    init_pair(CP_BORDER, TC_BORDER, TC_BG);
    init_pair(CP_ACCENT, TC_ACCENT, TC_BG);
    init_pair(CP_MUTED, TC_MUTED, TC_BG);
    init_pair(CP_MENTION, TC_FG, TC_MENTION);
    init_pair(CP_ERROR, TC_ERROR, TC_BG);
    init_pair(CP_INPUT, TC_FG, TC_BG);
    init_pair(CP_SELECTED, TC_ACCENT, TC_BORDER);
    for (short i = 0; i < 16; i++) init_pair((short)(CP_NICK0 + i), (short)(TC_NICK0 + i), TC_BG);
    bkgd(COLOR_PAIR(CP_MAIN));
}

static unsigned long djb2(const char *s) {
    unsigned long hash = 5381;
    for (const unsigned char *p = (const unsigned char *)s; *p; p++) hash = ((hash << 5) + hash) + *p;
    return hash;
}

static int nick_pair(const char *nick) {
    return CP_NICK0 + (int)(djb2(nick) % 16);
}

static char *url_encode(const char *s) {
    static const char *hex = "0123456789ABCDEF";
    size_t len = 0;
    for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
        if (isalnum(*p) || *p == '-' || *p == '_' || *p == '.' || *p == '~') len++;
        else len += 3;
    }
    char *out = malloc(len + 1);
    if (!out) die("out of memory");
    char *w = out;
    for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
        if (isalnum(*p) || *p == '-' || *p == '_' || *p == '.' || *p == '~') {
            *w++ = (char)*p;
        } else {
            *w++ = '%';
            *w++ = hex[*p >> 4];
            *w++ = hex[*p & 15];
        }
    }
    *w = 0;
    return out;
}

static char *json_escape(const char *s) {
    size_t len = 0;
    for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
        switch (*p) {
        case '"': case '\\': case '\b': case '\f': case '\n': case '\r': case '\t': len += 2; break;
        default: len += (*p < 0x20) ? 6 : 1; break;
        }
    }
    char *out = malloc(len + 1);
    if (!out) die("out of memory");
    char *w = out;
    for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
        switch (*p) {
        case '"': *w++ = '\\'; *w++ = '"'; break;
        case '\\': *w++ = '\\'; *w++ = '\\'; break;
        case '\b': *w++ = '\\'; *w++ = 'b'; break;
        case '\f': *w++ = '\\'; *w++ = 'f'; break;
        case '\n': *w++ = '\\'; *w++ = 'n'; break;
        case '\r': *w++ = '\\'; *w++ = 'r'; break;
        case '\t': *w++ = '\\'; *w++ = 't'; break;
        default:
            if (*p < 0x20) {
                sprintf(w, "\\u%04x", *p);
                w += 6;
            } else {
                *w++ = (char)*p;
            }
        }
    }
    *w = 0;
    return out;
}

static bool parse_url(const char *raw, struct url *out) {
    memset(out, 0, sizeof(*out));
    const char *p = raw;
    if (strncmp(p, "https://", 8) == 0) {
        out->tls = true;
        p += 8;
        strcpy(out->port, "443");
    } else if (strncmp(p, "http://", 7) == 0) {
        out->tls = false;
        p += 7;
        strcpy(out->port, "80");
    } else {
        return false;
    }

    const char *slash = strchr(p, '/');
    const char *end = slash ? slash : p + strlen(p);
    const char *colon = memchr(p, ':', (size_t)(end - p));
    size_t host_len = colon ? (size_t)(colon - p) : (size_t)(end - p);
    if (host_len == 0 || host_len >= sizeof(out->host)) return false;
    memcpy(out->host, p, host_len);
    out->host[host_len] = 0;
    if (colon) {
        size_t port_len = (size_t)(end - colon - 1);
        if (port_len == 0 || port_len >= sizeof(out->port)) return false;
        memcpy(out->port, colon + 1, port_len);
        out->port[port_len] = 0;
    }
    snprintf(out->base, sizeof(out->base), "%s://%s%s%s",
             out->tls ? "https" : "http", out->host,
             (strcmp(out->port, out->tls ? "443" : "80") == 0) ? "" : ":",
             (strcmp(out->port, out->tls ? "443" : "80") == 0) ? "" : out->port);
    return true;
}

static int connect_tcp(const char *host, const char *port) {
    struct addrinfo hints;
    memset(&hints, 0, sizeof(hints));
    hints.ai_socktype = SOCK_STREAM;
    hints.ai_family = AF_UNSPEC;
    struct addrinfo *res = NULL;
    int err = getaddrinfo(host, port, &hints, &res);
    if (err != 0) return -1;
    int fd = -1;
    for (struct addrinfo *ai = res; ai; ai = ai->ai_next) {
        fd = socket(ai->ai_family, ai->ai_socktype, ai->ai_protocol);
        if (fd < 0) continue;
        if (connect(fd, ai->ai_addr, ai->ai_addrlen) == 0) break;
        close(fd);
        fd = -1;
    }
    freeaddrinfo(res);
    return fd;
}

static bool conn_open(struct app *app, struct tls_conn *conn) {
    memset(conn, 0, sizeof(*conn));
    conn->fd = connect_tcp(app->url.host, app->url.port);
    if (conn->fd < 0) return false;
    conn->tls = app->url.tls;
    if (conn->tls) {
        conn->ssl = SSL_new(app->ssl_ctx);
        if (!conn->ssl) return false;
        SSL_set_fd(conn->ssl, conn->fd);
        SSL_set_tlsext_host_name(conn->ssl, app->url.host);
        if (SSL_connect(conn->ssl) != 1) return false;
    }
    return true;
}

static void conn_close(struct tls_conn *conn) {
    if (conn->ssl) {
        SSL_shutdown(conn->ssl);
        SSL_free(conn->ssl);
    }
    if (conn->fd >= 0) close(conn->fd);
    memset(conn, 0, sizeof(*conn));
    conn->fd = -1;
}

static ssize_t conn_write(struct tls_conn *conn, const void *buf, size_t len) {
    if (conn->tls) return SSL_write(conn->ssl, buf, (int)len);
    return write(conn->fd, buf, len);
}

static ssize_t conn_read(struct tls_conn *conn, void *buf, size_t len) {
    if (conn->tls) return SSL_read(conn->ssl, buf, (int)len);
    return read(conn->fd, buf, len);
}

static bool conn_write_all(struct tls_conn *conn, const char *buf, size_t len) {
    size_t off = 0;
    while (off < len) {
        ssize_t n = conn_write(conn, buf + off, len - off);
        if (n <= 0) return false;
        off += (size_t)n;
    }
    return true;
}

static char *read_all(struct tls_conn *conn, size_t *out_len) {
    size_t cap = 8192;
    size_t len = 0;
    char *buf = malloc(cap + 1);
    if (!buf) die("out of memory");
    for (;;) {
        if (len == cap) {
            cap *= 2;
            if (cap > HTTP_MAX) die("HTTP response too large");
            buf = realloc(buf, cap + 1);
            if (!buf) die("out of memory");
        }
        ssize_t n = conn_read(conn, buf + len, cap - len);
        if (n <= 0) break;
        len += (size_t)n;
    }
    buf[len] = 0;
    *out_len = len;
    return buf;
}

static char *decode_chunked(const char *body, size_t len, size_t *out_len) {
    char *out = malloc(len + 1);
    if (!out) die("out of memory");
    size_t pos = 0, w = 0;
    while (pos < len) {
        size_t line = pos;
        while (line + 1 < len && !(body[line] == '\r' && body[line + 1] == '\n')) line++;
        if (line + 1 >= len) break;
        size_t n = 0;
        for (size_t i = pos; i < line; i++) {
            int v = hexval(body[i]);
            if (v < 0) break;
            n = n * 16 + (size_t)v;
        }
        pos = line + 2;
        if (n == 0 || pos + n > len) break;
        memcpy(out + w, body + pos, n);
        w += n;
        pos += n + 2;
    }
    out[w] = 0;
    *out_len = w;
    return out;
}

static struct http_response http_request(struct app *app, const char *method, const char *path, const char *body) {
    struct tls_conn conn;
    if (!conn_open(app, &conn)) die("failed to connect to %s:%s", app->url.host, app->url.port);
    size_t body_len = body ? strlen(body) : 0;
    char auth[MAX_TOKEN + 64] = "";
    if (app->token[0]) snprintf(auth, sizeof(auth), "Authorization: Bearer %s\r\n", app->token);
    char *req = xasprintf(
        "%s %s HTTP/1.1\r\n"
        "Host: %s\r\n"
        "User-Agent: shottino/0.1\r\n"
        "Accept: application/json\r\n"
        "Content-Type: application/json\r\n"
        "%s"
        "Connection: close\r\n"
        "Content-Length: %zu\r\n\r\n"
        "%s",
        method, path, app->url.host, auth, body_len, body ? body : "");
    if (!conn_write_all(&conn, req, strlen(req))) die("HTTP write failed");
    free(req);
    size_t raw_len = 0;
    char *raw = read_all(&conn, &raw_len);
    conn_close(&conn);

    char *sep = strstr(raw, "\r\n\r\n");
    if (!sep) die("bad HTTP response");
    *sep = 0;
    char *statusp = strchr(raw, ' ');
    int status = statusp ? atoi(statusp + 1) : 0;
    char *body_start = sep + 4;
    size_t hdr_len = (size_t)(body_start - raw);
    size_t blen = raw_len >= hdr_len ? raw_len - hdr_len : 0;
    char *payload = NULL;
    size_t payload_len = 0;
    if (strcasestr(raw, "Transfer-Encoding: chunked")) {
        payload = decode_chunked(body_start, blen, &payload_len);
    } else {
        payload = malloc(blen + 1);
        if (!payload) die("out of memory");
        memcpy(payload, body_start, blen);
        payload[blen] = 0;
        payload_len = blen;
    }
    free(raw);
    return (struct http_response){ .status = status, .body = payload, .body_len = payload_len };
}

static bool json_find_string(const char *json, const char *key, char *out, size_t out_sz) {
    char needle[128];
    snprintf(needle, sizeof(needle), "\"%s\"", key);
    const char *p = strstr(json, needle);
    if (!p) return false;
    p = strchr(p + strlen(needle), ':');
    if (!p) return false;
    p++;
    while (isspace((unsigned char)*p)) p++;
    if (*p != '"') return false;
    p++;
    size_t w = 0;
    while (*p && *p != '"') {
        char c = *p++;
        if (c == '\\') {
            c = *p++;
            switch (c) {
            case 'n': c = '\n'; break;
            case 'r': c = '\r'; break;
            case 't': c = '\t'; break;
            case 'b': c = '\b'; break;
            case 'f': c = '\f'; break;
            case 'u':
                if (strlen(p) >= 4) p += 4;
                c = '?';
                break;
            default: break;
            }
        }
        if (w + 1 < out_sz) out[w++] = c;
    }
    if (out_sz) out[w] = 0;
    return true;
}

static bool json_find_int(const char *json, const char *key, int *out) {
    char needle[128];
    snprintf(needle, sizeof(needle), "\"%s\"", key);
    const char *p = strstr(json, needle);
    if (!p) return false;
    p = strchr(p + strlen(needle), ':');
    if (!p) return false;
    p++;
    while (isspace((unsigned char)*p)) p++;
    if (!isdigit((unsigned char)*p) && *p != '-') return false;
    *out = atoi(p);
    return true;
}

static bool json_find_long(const char *json, const char *key, long *out) {
    char needle[128];
    snprintf(needle, sizeof(needle), "\"%s\"", key);
    const char *p = strstr(json, needle);
    if (!p) return false;
    p = strchr(p + strlen(needle), ':');
    if (!p) return false;
    p++;
    while (isspace((unsigned char)*p)) p++;
    if (!isdigit((unsigned char)*p) && *p != '-') return false;
    *out = strtol(p, NULL, 10);
    return true;
}

static void parse_subject(const char *json, char *out, size_t out_sz) {
    char kind[64] = "";
    char name[256] = "";
    char id[256] = "";
    json_find_string(json, "kind", kind, sizeof(kind));
    if (strcmp(kind, "visitor") == 0) {
        json_find_string(json, "id", id, sizeof(id));
        snprintf(out, out_sz, "visitor:%s", id);
    } else {
        if (!json_find_string(json, "name", name, sizeof(name))) json_find_string(json, "identifier", name, sizeof(name));
        snprintf(out, out_sz, "%s", name);
    }
}

static void parse_networks(struct app *app, const char *json) {
    app->network_count = 0;
    const char *p = json;
    while ((p = strstr(p, "\"slug\"")) && app->network_count < MAX_NETWORKS) {
        struct network *n = &app->networks[app->network_count];
        memset(n, 0, sizeof(*n));
        const char *obj = p;
        while (obj > json && *obj != '{') obj--;
        json_find_int(obj, "id", &n->id);
        json_find_string(obj, "slug", n->slug, sizeof(n->slug));
        json_find_string(obj, "nick", n->nick, sizeof(n->nick));
        if (n->slug[0]) app->network_count++;
        p += 6;
    }
}

static void add_window_ex(struct app *app, const char *network, const char *channel, bool focus) {
    pthread_mutex_lock(&app->lock);
    for (size_t i = 0; i < app->window_count; i++) {
        if (strcmp(app->windows[i].network, network) == 0 && strcmp(app->windows[i].channel, channel) == 0) {
            if (focus) app->current = i;
            pthread_mutex_unlock(&app->lock);
            return;
        }
    }
    if (app->window_count == MAX_WINDOWS) {
        pthread_mutex_unlock(&app->lock);
        return;
    }
    struct window *w = &app->windows[app->window_count++];
    memset(w, 0, sizeof(*w));
    snprintf(w->network, sizeof(w->network), "%s", network);
    snprintf(w->channel, sizeof(w->channel), "%s", channel);
    w->last_id = 0;
    if (focus) app->current = app->window_count - 1;
    pthread_mutex_unlock(&app->lock);
}

static void add_window(struct app *app, const char *network, const char *channel) {
    add_window_ex(app, network, channel, true);
}

static void remove_window(struct app *app, const char *network, const char *channel) {
    pthread_mutex_lock(&app->lock);
    for (size_t i = 0; i < app->window_count; i++) {
        if (strcmp(app->windows[i].network, network) == 0 && strcmp(app->windows[i].channel, channel) == 0) {
            memmove(app->windows + i, app->windows + i + 1, sizeof(app->windows[0]) * (app->window_count - i - 1));
            app->window_count--;
            if (app->window_count == 0) {
                app->current = 0;
            } else if (app->current >= app->window_count) {
                app->current = app->window_count - 1;
            } else if (app->current > i) {
                app->current--;
            }
            if (app->current < app->window_count) app->windows[app->current].unread = 0;
            break;
        }
    }
    pthread_mutex_unlock(&app->lock);
}

static void parse_channels(struct app *app, const char *network, const char *json) {
    const char *p = json;
    while ((p = strstr(p, "\"name\""))) {
        char name[MAX_CHANNEL] = "";
        if (json_find_string(p, "name", name, sizeof(name)) && name[0]) add_window(app, network, name);
        p += 6;
    }
}

static void enqueue_fetch(struct app *app, const char *network, const char *channel);
static void ws_join(struct app *app, const char *topic);

static const char *network_slug_by_id(struct app *app, int id) {
    for (size_t i = 0; i < app->network_count; i++) {
        if (app->networks[i].id == id) return app->networks[i].slug;
    }
    return NULL;
}

static void apply_query_windows_list(struct app *app, const char *json) {
    const char *p = strstr(json, "\"windows\"");
    if (!p) return;
    while ((p = strchr(p, '"'))) {
        p++;
        if (!isdigit((unsigned char)*p)) continue;
        int network_id = atoi(p);
        const char *slug = network_slug_by_id(app, network_id);
        const char *next_key = strchr(p, ']');
        if (!slug || !next_key) continue;
        const char *q = p;
        while ((q = strstr(q, "\"target_nick\"")) && q < next_key) {
            char nick[MAX_CHANNEL] = "";
            if (json_find_string(q, "target_nick", nick, sizeof(nick)) && nick[0]) {
                add_window_ex(app, slug, nick, false);
                enqueue_fetch(app, slug, nick);
                if (app->ws_connected) {
                    char *topic = xasprintf("grappa:user:%s/network:%s/channel:%s", app->subject, slug, nick);
                    ws_join(app, topic);
                    free(topic);
                }
            }
            q += 13;
        }
        p = next_key + 1;
    }
}

static void clear_current_unread_locked(struct app *app) {
    if (app->current < app->window_count) app->windows[app->current].unread = 0;
}

static void clear_active_window_log(struct app *app) {
    pthread_mutex_lock(&app->lock);
    if (app->current >= app->window_count) {
        pthread_mutex_unlock(&app->lock);
        return;
    }
    char key[MAX_SLUG + MAX_CHANNEL + 8];
    snprintf(key, sizeof(key), "[%s/%s]", app->windows[app->current].network, app->windows[app->current].channel);
    size_t write_i = 0;
    for (size_t read_i = 0; read_i < app->log_count; read_i++) {
        if (strncmp(app->log[read_i], key, strlen(key)) == 0) {
            free(app->log[read_i]);
            continue;
        }
        if (write_i != read_i) {
            app->log[write_i] = app->log[read_i];
            app->log_mentions[write_i] = app->log_mentions[read_i];
            app->log_pending[write_i] = app->log_pending[read_i];
        }
        write_i++;
    }
    app->log_count = write_i;
    app->scrollback_offset = 0;
    app->scrollback_pinned = false;
    clear_current_unread_locked(app);
    pthread_mutex_unlock(&app->lock);
}

static void set_window_members(struct app *app, const char *network, const char *channel, char members[][MAX_CHANNEL], size_t count) {
    pthread_mutex_lock(&app->lock);
    for (size_t i = 0; i < app->window_count; i++) {
        if (strcmp(app->windows[i].network, network) == 0 && strcmp(app->windows[i].channel, channel) == 0) {
            app->windows[i].member_count = count > 512 ? 512 : count;
            for (size_t j = 0; j < app->windows[i].member_count; j++) {
                memcpy(app->windows[i].members[j], members[j], MAX_CHANNEL);
                app->windows[i].members[j][MAX_CHANNEL - 1] = 0;
            }
            break;
        }
    }
    pthread_mutex_unlock(&app->lock);
}

static void maybe_mark_unread(struct app *app, const char *network, const char *channel, bool live) {
    if (!live || !network[0] || !channel[0]) return;
    pthread_mutex_lock(&app->lock);
    for (size_t i = 0; i < app->window_count; i++) {
        if (strcmp(app->windows[i].network, network) == 0 && strcmp(app->windows[i].channel, channel) == 0) {
            if (i != app->current || app->panel != PANEL_CHAT) app->windows[i].unread++;
            break;
        }
    }
    pthread_mutex_unlock(&app->lock);
}

static void apply_topic_event(struct app *app, const char *json) {
    char network[MAX_SLUG] = "";
    char channel[MAX_CHANNEL] = "";
    char text[MAX_TOPIC] = "";
    json_find_string(json, "network", network, sizeof(network));
    json_find_string(json, "channel", channel, sizeof(channel));
    const char *topic = strstr(json, "\"topic\"");
    if (topic) json_find_string(topic, "text", text, sizeof(text));
    if (!network[0] || !channel[0]) return;
    pthread_mutex_lock(&app->lock);
    for (size_t i = 0; i < app->window_count; i++) {
        if (strcmp(app->windows[i].network, network) == 0 && strcmp(app->windows[i].channel, channel) == 0) {
            snprintf(app->windows[i].topic, sizeof(app->windows[i].topic), "%s", text[0] ? text : "no topic set");
            break;
        }
    }
    pthread_mutex_unlock(&app->lock);
}

static void apply_members_seeded_event(struct app *app, const char *json) {
    char network[MAX_SLUG] = "";
    char channel[MAX_CHANNEL] = "";
    char members[512][MAX_CHANNEL];
    size_t count = 0;
    json_find_string(json, "network", network, sizeof(network));
    json_find_string(json, "channel", channel, sizeof(channel));
    const char *p = json;
    while ((p = strstr(p, "\"nick\"")) && count < 512) {
        char nick[MAX_CHANNEL] = "";
        if (json_find_string(p, "nick", nick, sizeof(nick)) && nick[0]) snprintf(members[count++], MAX_CHANNEL, "%s", nick);
        p += 6;
    }
    if (network[0] && channel[0]) set_window_members(app, network, channel, members, count);
}

static void remember_url(struct app *app, const char *body);
static bool message_mentions_me(struct app *app, const char *network, const char *sender, const char *body);
static bool nick_case_equal(const char *a, const char *b);
static const char *own_nick_for_network(struct app *app, const char *network);

static void log_message_json(struct app *app, const char *json, bool live) {
    long id = 0;
    long server_time = 0;
    char network[MAX_SLUG] = "";
    char channel[MAX_CHANNEL] = "";
    char sender[MAX_CHANNEL] = "";
    char body[MAX_LINE] = "";
    char kind[64] = "";
    const char *msg = strstr(json, "\"message\"");
    if (msg) json = msg;
    json_find_long(json, "id", &id);
    json_find_long(json, "server_time", &server_time);
    json_find_string(json, "network", network, sizeof(network));
    json_find_string(json, "channel", channel, sizeof(channel));
    json_find_string(json, "sender", sender, sizeof(sender));
    json_find_string(json, "body", body, sizeof(body));
    json_find_string(json, "kind", kind, sizeof(kind));
    if (!body[0]) return;

    char display_channel[MAX_CHANNEL];
    snprintf(display_channel, sizeof(display_channel), "%s", channel);
    const char *own_nick = own_nick_for_network(app, network);
    if (live && own_nick && nick_case_equal(channel, own_nick) && sender[0] && !nick_case_equal(sender, own_nick)) {
        snprintf(display_channel, sizeof(display_channel), "%s", sender);
        add_window_ex(app, network, display_channel, false);
    }

    bool had_pending = has_matching_pending_echo(app, network, channel, body);
    if (!had_pending && !live && has_matching_confirmed_line(app, network, display_channel, sender, body)) return;
    clear_matching_pending_echo(app, network, display_channel, body);

    if (id > 0 && network[0] && channel[0]) {
        pthread_mutex_lock(&app->lock);
        for (size_t i = 0; i < app->seen_count; i++) {
            if (app->seen[i].id == id && strcmp(app->seen[i].network, network) == 0 && strcmp(app->seen[i].channel, channel) == 0) {
                pthread_mutex_unlock(&app->lock);
                return;
            }
        }
        struct seen_message *seen = &app->seen[app->seen_next];
        seen->id = id;
        snprintf(seen->network, sizeof(seen->network), "%s", network);
        snprintf(seen->channel, sizeof(seen->channel), "%s", channel);
        app->seen_next = (app->seen_next + 1) % SEEN_MESSAGES;
        if (app->seen_count < SEEN_MESSAGES) app->seen_count++;
        pthread_mutex_unlock(&app->lock);
    }

    pthread_mutex_lock(&app->lock);
    for (size_t i = 0; i < app->window_count; i++) {
        if (network[0] && display_channel[0] && strcmp(app->windows[i].network, network) == 0 && strcmp(app->windows[i].channel, display_channel) == 0 && id > app->windows[i].last_id) app->windows[i].last_id = id;
    }
    pthread_mutex_unlock(&app->lock);
    remember_url(app, body);
    maybe_mark_unread(app, network, display_channel, live);
    bool mention = message_mentions_me(app, network, sender, body);
    char clock[16];
    time_t ts = server_time > 100000000000L ? (time_t)(server_time / 1000) : time(NULL);
    struct tm tm;
    localtime_r(&ts, &tm);
    strftime(clock, sizeof(clock), "%H:%M", &tm);
    if (strcmp(kind, "action") == 0) log_line_mention(app, mention, "[%s/%s] %s * %s %s", network, display_channel, clock, sender, body);
    else log_line_mention(app, mention, "[%s/%s] %s <%s> %s", network, display_channel, clock, sender, body);

    pthread_mutex_lock(&app->lock);
    if (!app->scrollback_pinned) app->scrollback_offset = 0;
    pthread_mutex_unlock(&app->lock);
}

static const char *find_url(const char *s) {
    const char *http = strstr(s, "http://");
    const char *https = strstr(s, "https://");
    if (!http) return https;
    if (!https) return http;
    return http < https ? http : https;
}

/* Copy the leading non-whitespace token of `url` into `out` (case preserved).
 * Returns the token length. Shared by URL remembering, link-region recording,
 * and the lowercasing classifier so the token-boundary rule stays in one place. */
static size_t copy_url_token(const char *url, char *out, size_t out_size) {
    size_t n = 0;
    while (url[n] && !isspace((unsigned char)url[n]) && n + 1 < out_size) {
        out[n] = url[n];
        n++;
    }
    out[n] = 0;
    return n;
}

/* Lowercased copy of the leading URL token with any `?query` stripped, so
 * extension matching ignores case and `?sig=...` suffixes. */
static void url_token_lower(const char *url, char *out, size_t out_size) {
    copy_url_token(url, out, out_size);
    for (char *p = out; *p; p++) *p = (char)tolower((unsigned char)*p);
    char *q = strchr(out, '?');
    if (q) *q = 0;
}

static bool token_has_suffix(const char *token, const char *const *exts) {
    for (size_t i = 0; exts[i]; i++) {
        if (strstr(token, exts[i])) return true;
    }
    return false;
}

enum media_kind { MEDIA_NONE = 0, MEDIA_IMAGE, MEDIA_VIDEO };

/* Classify a URL by extension (and grappa's /uploads/ image convention) in a
 * single lowercasing pass. Video is checked first so an extension wins over the
 * /uploads/ heuristic. */
static enum media_kind media_kind_of(const char *url) {
    static const char *const img[] = {".jpg", ".jpeg", ".png", ".gif",
                                      ".webp", ".bmp", NULL};
    static const char *const vid[] = {".mp4", ".m4v", ".webm", ".mkv", ".mov",
                                      ".avi", ".ogv", ".flv", ".wmv", ".mpg",
                                      ".mpeg", NULL};
    char lower[MAX_LINE];
    url_token_lower(url, lower, sizeof(lower));
    if (token_has_suffix(lower, vid)) return MEDIA_VIDEO;
    if (token_has_suffix(lower, img) || strstr(lower, "/uploads/")) return MEDIA_IMAGE;
    return MEDIA_NONE;
}

static bool contains_ci(const char *haystack, const char *needle) {
    if (!needle || !needle[0]) return false;
    size_t nlen = strlen(needle);
    for (const char *p = haystack; *p; p++) {
        size_t i = 0;
        while (i < nlen && p[i] && tolower((unsigned char)p[i]) == tolower((unsigned char)needle[i])) i++;
        if (i == nlen) return true;
    }
    return false;
}

static bool nick_case_equal(const char *a, const char *b) {
    return a && b && strcasecmp(a, b) == 0;
}

static bool message_mentions_me(struct app *app, const char *network, const char *sender, const char *body) {
    for (size_t i = 0; i < app->network_count; i++) {
        if (strcmp(app->networks[i].slug, network) == 0 && app->networks[i].nick[0]) {
            if (contains_ci(sender, app->networks[i].nick)) return false;
            return contains_ci(body, app->networks[i].nick);
        }
    }
    const char *colon = strchr(app->subject, ':');
    const char *subject_name = colon ? colon + 1 : app->subject;
    if (contains_ci(sender, subject_name)) return false;
    return contains_ci(body, subject_name);
}

static void remember_url(struct app *app, const char *body) {
    const char *url = find_url(body);
    if (!url) return;
    pthread_mutex_lock(&app->lock);
    copy_url_token(url, app->last_url, sizeof(app->last_url));
    pthread_mutex_unlock(&app->lock);
}

static void parse_messages(struct app *app, const char *json) {
    const char *p = json;
    while ((p = strstr(p, "\"body\""))) {
        const char *obj = p;
        while (obj > json && *obj != '{') obj--;
        log_message_json(app, obj, false);
        p += 6;
    }
}

static void draw_fill(int y, int x, int n, int pair) {
    attron(COLOR_PAIR(pair));
    for (int i = 0; i < n; i++) mvaddch(y, x + i, ' ');
    attroff(COLOR_PAIR(pair));
}

static void draw_text(int y, int x, int max, int pair, attr_t attrs, const char *fmt, ...) __attribute__((format(printf, 6, 7)));
static int split_message_line(const char *line, char *prefix, size_t prefix_sz, char *nick, size_t nick_sz, const char **body);

static void draw_text(int y, int x, int max, int pair, attr_t attrs, const char *fmt, ...) {
    if (max <= 0) return;
    char buf[2048];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    attron(COLOR_PAIR(pair) | attrs);
    mvprintw(y, x, "%.*s", max, buf);
    attroff(COLOR_PAIR(pair) | attrs);
}

static int wrapped_text_lines(const char *s, int width) {
    if (width <= 0) return 0;
    int lines = 1;
    int col = 0;
    for (const char *p = s; *p; p++) {
        if (*p == '\n' || *p == '\r') {
            lines++;
            col = 0;
            if (*p == '\r' && p[1] == '\n') p++;
            continue;
        }
        if (col >= width) {
            lines++;
            col = 0;
        }
        col++;
    }
    return lines;
}

static void draw_wrapped_text(int y, int x, int width, int max_lines, int pair, attr_t attrs, const char *s) {
    if (width <= 0 || max_lines <= 0) return;
    int line = 0;
    int col = 0;
    attron(COLOR_PAIR(pair) | attrs);
    move(y, x);
    for (const char *p = s; *p && line < max_lines; p++) {
        if (*p == '\r') {
            if (p[1] == '\n') p++;
            line++;
            col = 0;
            if (line < max_lines) move(y + line, x);
            continue;
        }
        if (*p == '\n') {
            line++;
            col = 0;
            if (line < max_lines) move(y + line, x);
            continue;
        }
        if (col >= width) {
            line++;
            col = 0;
            if (line >= max_lines) break;
            move(y + line, x);
        }
        addch((unsigned char)*p);
        col++;
    }
    attroff(COLOR_PAIR(pair) | attrs);
}

static int message_display_lines(const char *line, int width) {
    if (width <= 0) return 1;
    char prefix[256], nick[256];
    const char *body;
    if (split_message_line(line, prefix, sizeof(prefix), nick, sizeof(nick), &body)) {
        int body_x = (int)strlen(prefix) + (int)strlen(nick) + 3;
        int body_w = width - body_x;
        if (body_w < 12) body_w = width > 12 ? width - 2 : width;
        return wrapped_text_lines(body, body_w);
    }
    return wrapped_text_lines(line, width);
}

static void draw_message_line(int y, int x, int width, int max_lines, const char *line, bool mention_row, bool pending_row) {
    if (width <= 0 || max_lines <= 0) return;
    for (int row = 0; row < max_lines; row++) {
        if (mention_row) draw_fill(y + row, x, width, CP_MENTION);
    }

    char prefix[256], nick[256];
    const char *body;
    if (split_message_line(line, prefix, sizeof(prefix), nick, sizeof(nick), &body)) {
        int base_pair = mention_row ? CP_MENTION : (pending_row ? CP_MUTED : CP_MUTED);
        int body_pair = mention_row ? CP_MENTION : (pending_row ? CP_MUTED : CP_MAIN);
        attr_t body_attr = mention_row ? A_BOLD : (pending_row ? A_DIM : 0);
        attr_t base_attr = pending_row ? A_DIM : 0;
        draw_text(y, x, width, base_pair, base_attr, "%s", prefix);
        int px = x + (int)strlen(prefix);
        draw_text(y, px, 1, base_pair, base_attr, "<");
        draw_text(y, px + 1, (int)strlen(nick), mention_row ? CP_MENTION : nick_pair(nick), A_BOLD | base_attr, "%s", nick);
        draw_text(y, px + 1 + (int)strlen(nick), 1, base_pair, base_attr, ">");
        int body_x = px + 3 + (int)strlen(nick);
        int body_w = width - (body_x - x);
        if (body_w < 12) {
            body_x = x + 2;
            body_w = width - 2;
        }
        draw_wrapped_text(y, body_x, body_w, max_lines, body_pair, body_attr, body);
        if (pending_row && width > 11) draw_text(y + max_lines - 1, x + width - 11, 11, CP_MUTED, A_DIM, "[sending]");
    } else if (find_url(line)) {
        draw_wrapped_text(y, x, width, max_lines, media_kind_of(find_url(line)) != MEDIA_NONE ? CP_ACCENT : CP_MUTED, A_UNDERLINE, line);
    } else if (strstr(line, "failed") || strstr(line, "error")) {
        draw_wrapped_text(y, x, width, max_lines, CP_ERROR, 0, line);
    } else {
        draw_wrapped_text(y, x, width, max_lines, CP_MUTED, 0, line);
    }
}

static int input_display_lines(const char *prompt, const char *input, int width) {
    if (width <= 0) return 1;
    size_t total = strlen(prompt) + strlen(input);
    int lines = (int)(total / (size_t)width) + 1;
    return lines < 1 ? 1 : lines;
}

static void draw_input_box(int y, int x, int width, int height, const char *prompt, const char *input, int *cursor_y, int *cursor_x) {
    if (width <= 0 || height <= 0) return;
    for (int row = 0; row < height; row++) draw_fill(y + row, x, width, CP_INPUT);
    int inner_x = x + 1;
    int inner_w = width - 2;
    if (inner_w <= 0) inner_w = width;

    char *joined = xasprintf("%s%s", prompt, input);
    int total_lines = input_display_lines(prompt, input, inner_w);
    int first_line = total_lines > height ? total_lines - height : 0;
    int pos = 0;
    int row = 0;
    const int prompt_len = (int)strlen(prompt);
    const int joined_len = (int)strlen(joined);
    while (row < height && pos < joined_len) {
        int line_no = pos / inner_w;
        int take = inner_w - (pos % inner_w);
        if (take > joined_len - pos) take = joined_len - pos;
        if (line_no >= first_line) {
            attron(COLOR_PAIR(CP_INPUT) | A_BOLD);
            for (int i = 0; i < take; i++) {
                if (pos + i == prompt_len) attroff(COLOR_PAIR(CP_INPUT) | A_BOLD), attron(COLOR_PAIR(CP_INPUT));
                mvaddch(y + row, inner_x + (pos % inner_w) + i, (unsigned char)joined[pos + i]);
            }
            attroff(COLOR_PAIR(CP_INPUT) | A_BOLD);
            attroff(COLOR_PAIR(CP_INPUT));
            row++;
        }
        pos += take;
    }
    if (joined_len == 0) draw_text(y, inner_x, inner_w, CP_INPUT, 0, "%s", "");

    int cursor_pos = joined_len;
    int cursor_line = cursor_pos / inner_w;
    int cursor_col = cursor_pos % inner_w;
    if (cursor_line < first_line) {
        cursor_line = first_line;
        cursor_col = 0;
    }
    if (cursor_line - first_line >= height) {
        cursor_line = first_line + height - 1;
        cursor_col = inner_w - 1;
    }
    *cursor_y = y + cursor_line - first_line;
    *cursor_x = inner_x + cursor_col;
    free(joined);
}

static const char *panel_name(enum panel_kind panel) {
    switch (panel) {
    case PANEL_CHAT: return "chat";
    case PANEL_ARCHIVE: return "archive";
    case PANEL_SETTINGS: return "settings";
    case PANEL_ADMIN: return "admin";
    }
    return "chat";
}

static void open_panel(struct app *app, enum panel_kind panel) {
    pthread_mutex_lock(&app->lock);
    clear_panel_lines(app);
    app->panel = panel;
    struct window current = app->windows[app->current];
    panel_line(app, "%s", panel_name(panel));
    panel_line(app, "%s", "");
    switch (panel) {
    case PANEL_ARCHIVE:
        panel_line(app, "Archive panel for network: %s", current.network);
        panel_line(app, "%s", "");
        panel_line(app, "Planned parity commands:");
        panel_line(app, "  /archive                 open this panel");
        panel_line(app, "  /archive open <target>   open archived scrollback target");
        panel_line(app, "  /archive purge <target>  delete archived scrollback target");
        panel_line(app, "%s", "");
        panel_line(app, "Server endpoint: GET /networks/%s/archive", current.network);
        panel_line(app, "This panel shell is wired; archive row fetching is the next REST pass.");
        break;
    case PANEL_SETTINGS:
        panel_line(app, "Settings panel");
        panel_line(app, "%s", "");
        panel_line(app, "Server: %s", app->url.base);
        panel_line(app, "Subject: %s", app->subject);
        panel_line(app, "WebSocket: %s", app->ws_connected ? "connected" : "offline");
        panel_line(app, "Windows: %zu", app->window_count);
        panel_line(app, "%s", "");
        panel_line(app, "Local keys:");
        panel_line(app, "  PgUp/PgDn scroll chat buffer");
        panel_line(app, "  Ctrl-N/Ctrl-P cycle windows");
        panel_line(app, "  Tab complete, Up/Down input history");
        panel_line(app, "  Click image/video links to preview (needs chafa+ffmpeg)");
        panel_line(app, "  Esc or /chat returns to chat");
        break;
    case PANEL_ADMIN:
        panel_line(app, "Admin panel");
        panel_line(app, "%s", "");
        panel_line(app, "Admin REST surfaces available in grappa:");
        panel_line(app, "  /admin/me /admin/visitors /admin/sessions /admin/networks");
        panel_line(app, "  /admin/users /admin/credentials /admin/settings /admin/uploads");
        panel_line(app, "%s", "");
        panel_line(app, "This terminal panel shell is wired; admin tables/actions are the next REST pass.");
        break;
    case PANEL_CHAT:
        break;
    }
    pthread_mutex_unlock(&app->lock);
}

static int split_message_line(const char *line, char *prefix, size_t prefix_sz, char *nick, size_t nick_sz, const char **body) {
    const char *visible = line;
    if (*visible == '[') {
        const char *end = strchr(visible, ']');
        if (end && end[1] == ' ') visible = end + 2;
    }
    const char *lt = strchr(visible, '<');
    const char *gt = lt ? strchr(lt, '>') : NULL;
    if (!lt || !gt || gt <= lt + 1) {
        prefix[0] = 0;
        nick[0] = 0;
        *body = visible;
        return 0;
    }
    size_t plen = (size_t)(lt - visible);
    if (plen >= prefix_sz) plen = prefix_sz - 1;
    memcpy(prefix, visible, plen);
    prefix[plen] = 0;
    size_t nlen = (size_t)(gt - lt - 1);
    if (nlen >= nick_sz) nlen = nick_sz - 1;
    memcpy(nick, lt + 1, nlen);
    nick[nlen] = 0;
    *body = gt + 1;
    while (**body == ' ') (*body)++;
    return 1;
}

static bool login(struct app *app, const char *identifier, const char *password) {
    char *id = json_escape(identifier);
    char *pw = json_escape(password);
    char *body = xasprintf("{\"identifier\":\"%s\",\"password\":\"%s\"}", id, pw);
    free(id);
    free(pw);
    struct http_response r = http_request(app, "POST", "/auth/login", body);
    free(body);
    if (r.status < 200 || r.status >= 300) {
        fprintf(stderr, "login failed HTTP %d: %s\n", r.status, r.body);
        free(r.body);
        return false;
    }
    if (!json_find_string(r.body, "token", app->token, sizeof(app->token))) die("login response missing token");
    parse_subject(r.body, app->subject, sizeof(app->subject));
    if (!app->subject[0]) die("login response missing subject");
    free(r.body);
    return true;
}

static unsigned long token_key_hash(const char *server, const char *identifier) {
    char *key = xasprintf("%s|%s", server, identifier);
    unsigned long h = djb2(key);
    free(key);
    return h;
}

static char *token_path_for(const char *server, const char *identifier) {
    const char *home = getenv("HOME");
    if (!home || !home[0]) home = ".";
    char *dir = xasprintf("%s/.local", home);
    mkdir(dir, 0700);
    free(dir);
    dir = xasprintf("%s/.local/share", home);
    mkdir(dir, 0700);
    free(dir);
    dir = xasprintf("%s/.local/share/shottino", home);
    mkdir(dir, 0700);
    char *path = xasprintf("%s/%lx.token", dir, token_key_hash(server, identifier));
    free(dir);
    return path;
}

static bool load_saved_token(struct app *app, const char *path) {
    FILE *f = fopen(path, "r");
    if (!f) return false;
    if (!fgets(app->token, sizeof(app->token), f)) {
        fclose(f);
        return false;
    }
    fclose(f);
    app->token[strcspn(app->token, "\r\n")] = 0;
    return app->token[0] != 0;
}

static void save_token(struct app *app, const char *path) {
    FILE *f = fopen(path, "w");
    if (!f) return;
    chmod(path, 0600);
    fprintf(f, "%s\n", app->token);
    fclose(f);
    chmod(path, 0600);
}

static bool validate_saved_token(struct app *app) {
    struct http_response me = http_request(app, "GET", "/me", NULL);
    bool ok = me.status >= 200 && me.status < 300;
    if (ok) parse_subject(me.body, app->subject, sizeof(app->subject));
    free(me.body);
    return ok && app->subject[0];
}

static bool attach_or_login(struct app *app, const char *identifier, const char *password) {
    char *path = token_path_for(app->url.base, identifier);
    snprintf(app->token_path, sizeof(app->token_path), "%s", path);
    if (load_saved_token(app, path) && validate_saved_token(app)) {
        log_line(app, "reattached saved grappa session as %s", app->subject);
        free(path);
        return true;
    }
    app->token[0] = 0;
    app->subject[0] = 0;
    bool ok = login(app, identifier, password);
    if (ok) save_token(app, path);
    free(path);
    return ok;
}

static char *login_identifier_for_mode(const char *mode, const char *identifier) {
    if (strcmp(mode, "user") == 0 && strchr(identifier, '@') == NULL) {
        return xasprintf("%s@shottino.local", identifier);
    }
    return xasprintf("%s", identifier);
}

static void logout_grappa(struct app *app) {
    struct http_response r = http_request(app, "DELETE", "/auth/logout", NULL);
    if (r.status == 204 || (r.status >= 200 && r.status < 300)) {
        log_line(app, "grappa session terminated");
        if (app->token_path[0]) unlink(app->token_path);
    } else {
        log_line(app, "logout failed HTTP %d: %.200s", r.status, r.body);
    }
    free(r.body);
}

static void seed_state(struct app *app) {
    struct http_response me = http_request(app, "GET", "/me", NULL);
    if (me.status >= 200 && me.status < 300) log_line(app, "authenticated as %s", app->subject);
    free(me.body);

    struct http_response nets = http_request(app, "GET", "/networks", NULL);
    if (nets.status < 200 || nets.status >= 300) die("GET /networks failed HTTP %d: %s", nets.status, nets.body);
    parse_networks(app, nets.body);
    free(nets.body);
    if (app->network_count == 0) die("no networks available");

    for (size_t i = 0; i < app->network_count; i++) {
        char *slug = url_encode(app->networks[i].slug);
        char *path = xasprintf("/networks/%s/channels", slug);
        free(slug);
        struct http_response ch = http_request(app, "GET", path, NULL);
        free(path);
        if (ch.status >= 200 && ch.status < 300) parse_channels(app, app->networks[i].slug, ch.body);
        free(ch.body);
    }
    if (app->window_count == 0) add_window(app, app->networks[0].slug, "$server");
}

static void fetch_scrollback(struct app *app, struct window *w) {
    char *net = url_encode(w->network);
    char *chan = url_encode(w->channel);
    char *path = xasprintf("/networks/%s/channels/%s/messages?limit=80", net, chan);
    free(net);
    free(chan);
    struct http_response r = http_request(app, "GET", path, NULL);
    free(path);
    if (r.status >= 200 && r.status < 300) parse_messages(app, r.body);
    else log_line(app, "GET messages failed HTTP %d", r.status);
    free(r.body);
}

static void fetch_scrollback_target(struct app *app, const char *network, const char *channel) {
    char *net = url_encode(network);
    char *chan = url_encode(channel);
    char *path = xasprintf("/networks/%s/channels/%s/messages?limit=80", net, chan);
    free(net);
    free(chan);
    struct http_response r = http_request(app, "GET", path, NULL);
    free(path);
    if (r.status >= 200 && r.status < 300) parse_messages(app, r.body);
    else log_line(app, "GET messages failed HTTP %d", r.status);
    free(r.body);
}

static char *base64_encode(const unsigned char *buf, size_t len) {
    BIO *b64 = BIO_new(BIO_f_base64());
    BIO *mem = BIO_new(BIO_s_mem());
    BIO_set_flags(b64, BIO_FLAGS_BASE64_NO_NL);
    BIO_push(b64, mem);
    BIO_write(b64, buf, (int)len);
    BIO_flush(b64);
    BUF_MEM *bptr = NULL;
    BIO_get_mem_ptr(mem, &bptr);
    char *out = malloc(bptr->length + 1);
    if (!out) die("out of memory");
    memcpy(out, bptr->data, bptr->length);
    out[bptr->length] = 0;
    BIO_free_all(b64);
    return out;
}

static bool ws_connect(struct app *app) {
    if (!conn_open(app, &app->ws)) return false;
    unsigned char nonce[16];
    RAND_bytes(nonce, sizeof(nonce));
    char *key = base64_encode(nonce, sizeof(nonce));
    char *tok = url_encode(app->token);
    char *req = xasprintf(
        "GET /socket/websocket?token=%s&vsn=2.0.0 HTTP/1.1\r\n"
        "Host: %s\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        "Sec-WebSocket-Key: %s\r\n"
        "Sec-WebSocket-Version: 13\r\n"
        "User-Agent: shottino/0.1\r\n\r\n",
        tok, app->url.host, key);
    free(tok);
    free(key);
    if (!conn_write_all(&app->ws, req, strlen(req))) {
        free(req);
        return false;
    }
    free(req);
    char hdr[4096];
    size_t len = 0;
    while (len + 1 < sizeof(hdr)) {
        char c;
        ssize_t n = conn_read(&app->ws, &c, 1);
        if (n <= 0) return false;
        hdr[len++] = c;
        hdr[len] = 0;
        if (strstr(hdr, "\r\n\r\n")) break;
    }
    if (!strstr(hdr, " 101 ")) return false;
    int flags = fcntl(app->ws.fd, F_GETFL, 0);
    fcntl(app->ws.fd, F_SETFL, flags | O_NONBLOCK);
    app->ws_connected = true;
    app->next_heartbeat = time(NULL) + 25;
    return true;
}

static bool ws_send_text(struct app *app, const char *text) {
    if (!app->ws_connected) return false;
    size_t len = strlen(text);
    unsigned char hdr[14];
    size_t hlen = 0;
    hdr[hlen++] = 0x81;
    if (len < 126) {
        hdr[hlen++] = 0x80 | (unsigned char)len;
    } else if (len <= 65535) {
        hdr[hlen++] = 0x80 | 126;
        hdr[hlen++] = (unsigned char)(len >> 8);
        hdr[hlen++] = (unsigned char)len;
    } else {
        hdr[hlen++] = 0x80 | 127;
        for (int i = 7; i >= 0; i--) hdr[hlen++] = (unsigned char)(len >> (i * 8));
    }
    unsigned char mask[4];
    RAND_bytes(mask, sizeof(mask));
    memcpy(hdr + hlen, mask, 4);
    hlen += 4;
    unsigned char *frame = malloc(hlen + len);
    if (!frame) die("out of memory");
    memcpy(frame, hdr, hlen);
    for (size_t i = 0; i < len; i++) frame[hlen + i] = ((const unsigned char *)text)[i] ^ mask[i % 4];
    bool ok = conn_write_all(&app->ws, (const char *)frame, hlen + len);
    free(frame);
    return ok;
}

static void ws_join(struct app *app, const char *topic) {
    char ref[32];
    snprintf(ref, sizeof(ref), "%lu", ++app->ws_ref);
    char *topic_json = json_escape(topic);
    char *frame = xasprintf("[\"%s\",\"%s\",\"%s\",\"phx_join\",{}]", ref, ref, topic_json);
    free(topic_json);
    ws_send_text(app, frame);
    free(frame);
}

static void ws_push_user(struct app *app, const char *event, const char *payload) {
    if (!app->ws_connected) {
        log_line(app, "websocket is not connected; /%s not sent", event);
        return;
    }
    char ref[32];
    snprintf(ref, sizeof(ref), "%lu", ++app->ws_ref);
    char *topic = xasprintf("grappa:user:%s", app->subject);
    char *topic_json = json_escape(topic);
    char *event_json = json_escape(event);
    char *frame = xasprintf("[\"%s\",\"%s\",\"%s\",\"%s\",%s]", ref, ref, topic_json, event_json, payload);
    free(topic);
    free(topic_json);
    free(event_json);
    ws_send_text(app, frame);
    free(frame);
}

static int current_network_id(struct app *app) {
    const char *slug = app->windows[app->current].network;
    for (size_t i = 0; i < app->network_count; i++) {
        if (strcmp(app->networks[i].slug, slug) == 0) return app->networks[i].id;
    }
    return app->network_count > 0 ? app->networks[0].id : 0;
}

static const char *current_channel(struct app *app) {
    return app->windows[app->current].channel;
}

static void ws_join_topics(struct app *app) {
    char *subject = json_escape(app->subject);
    char *topic = xasprintf("grappa:user:%s", subject);
    free(subject);
    ws_join(app, topic);
    free(topic);
    for (size_t i = 0; i < app->window_count; i++) {
        char *chan = json_escape(app->windows[i].channel);
        char *net = json_escape(app->windows[i].network);
        char *t = xasprintf("grappa:user:%s/network:%s/channel:%s", app->subject, net, chan);
        free(chan);
        free(net);
        ws_join(app, t);
        app->windows[i].joined_ws = true;
        free(t);
    }
}

static int ws_read_frame(struct app *app, char **out) {
    unsigned char h[2];
    ssize_t n = conn_read(&app->ws, h, 2);
    if (n < 0) {
        int e = app->ws.tls ? SSL_get_error(app->ws.ssl, (int)n) : 0;
        if ((!app->ws.tls && (errno == EAGAIN || errno == EWOULDBLOCK)) || e == SSL_ERROR_WANT_READ) return 0;
        return -1;
    }
    if (n == 0) return -1;
    if (n != 2) return 0;
    int opcode = h[0] & 0x0f;
    bool masked = (h[1] & 0x80) != 0;
    uint64_t len = h[1] & 0x7f;
    if (len == 126) {
        unsigned char x[2];
        if (conn_read(&app->ws, x, 2) != 2) return 0;
        len = ((uint64_t)x[0] << 8) | x[1];
    } else if (len == 127) {
        unsigned char x[8];
        if (conn_read(&app->ws, x, 8) != 8) return 0;
        len = 0;
        for (int i = 0; i < 8; i++) len = (len << 8) | x[i];
    }
    if (len > WS_MAX_PAYLOAD) return -1;
    unsigned char mask[4] = {0};
    if (masked && conn_read(&app->ws, mask, 4) != 4) return 0;
    char *payload = malloc((size_t)len + 1);
    if (!payload) die("out of memory");
    size_t off = 0;
    while (off < len) {
        ssize_t r = conn_read(&app->ws, payload + off, (size_t)len - off);
        if (r <= 0) {
            free(payload);
            return 0;
        }
        off += (size_t)r;
    }
    for (size_t i = 0; masked && i < len; i++) payload[i] ^= mask[i % 4];
    payload[len] = 0;
    if (opcode == 0x8) {
        free(payload);
        return -1;
    }
    if (opcode == 0x9) {
        free(payload);
        return 0;
    }
    if (opcode != 0x1) {
        free(payload);
        return 0;
    }
    *out = payload;
    return 1;
}

static void ws_pump(struct app *app) {
    if (!app->ws_connected) return;
    time_t now = time(NULL);
    if (now >= app->next_heartbeat) {
        char ref[32];
        snprintf(ref, sizeof(ref), "%lu", ++app->ws_ref);
        char *hb = xasprintf("[null,\"%s\",\"phoenix\",\"heartbeat\",{}]", ref);
        ws_send_text(app, hb);
        free(hb);
        app->next_heartbeat = now + 25;
    }
    for (;;) {
        char *frame = NULL;
        int r = ws_read_frame(app, &frame);
        if (r == 0) break;
        if (r < 0) {
            log_line(app, "websocket disconnected");
            conn_close(&app->ws);
            app->ws_connected = false;
            break;
        }
        if (strstr(frame, "\"event\"") && strstr(frame, "\"kind\":\"message\"")) log_message_json(app, frame, true);
        else if (strstr(frame, "\"event\"") && strstr(frame, "\"kind\":\"topic_changed\"")) apply_topic_event(app, frame);
        else if (strstr(frame, "\"event\"") && strstr(frame, "\"kind\":\"members_seeded\"")) apply_members_seeded_event(app, frame);
        else if (strstr(frame, "\"event\"") && strstr(frame, "\"kind\":\"query_windows_list\"")) apply_query_windows_list(app, frame);
        else if (strstr(frame, "\"phx_reply\"") && strstr(frame, "\"status\":\"error\"")) log_line(app, "channel join error: %.200s", frame);
        free(frame);
    }
}

/* Record the screen rectangle of a media link so a later mouse event can map
 * back to its URL. Caller holds app->lock (draw path). */
static void add_link_region(struct app *app, int y0, int y1, int x0, int x1,
                            const char *url, bool is_video) {
    if (app->link_region_count >= MAX_LINK_REGIONS) return;
    struct link_region *r = &app->link_regions[app->link_region_count++];
    r->y0 = y0;
    r->y1 = y1;
    r->x0 = x0;
    r->x1 = x1;
    r->is_video = is_video;
    snprintf(r->url, sizeof(r->url), "%s", url);
}

static void draw(struct app *app) {
    pthread_mutex_lock(&app->lock);
    erase();
    app->link_region_count = 0;
    int rows, cols;
    getmaxyx(stdscr, rows, cols);
    int side = cols > 118 ? 22 : (cols > 90 ? 18 : 14);
    int members = cols > 118 ? 24 : 0;
    int main_x = side + 1;
    int main_w = cols - side - members - 2;
    int members_x = cols - members;
    int chrome_y = 0;
    int topic_y = 1;
    struct window *w = &app->windows[app->current];
    char prompt[MAX_CHANNEL + 4];
    if (app->panel == PANEL_CHAT) snprintf(prompt, sizeof(prompt), "%s> ", w->channel);
    else snprintf(prompt, sizeof(prompt), "%s> ", panel_name(app->panel));
    int input_h = input_display_lines(prompt, app->input, main_w - 4);
    int max_input_h = rows / 3;
    if (max_input_h < 1) max_input_h = 1;
    if (input_h > max_input_h) input_h = max_input_h;
    int input_y = rows - input_h - 1;
    int compose_y = input_y - 1;
    const char *topic_text = w->topic[0] ? w->topic : "(not loaded yet)";
    int topic_label_w = main_w / 3;
    if (topic_label_w < 12) topic_label_w = 12;
    if (topic_label_w > main_w - 12) topic_label_w = main_w / 2;
    int topic_text_x = main_x + topic_label_w + 2;
    int topic_text_w = main_w - topic_label_w - 3;
    int topic_prefix_w = 7;
    if (topic_text_w < topic_prefix_w + 8) topic_prefix_w = 0;
    int topic_wrap_w = topic_text_w - topic_prefix_w;
    if (topic_wrap_w < 1) topic_wrap_w = 1;
    int topic_h = wrapped_text_lines(topic_text, topic_wrap_w);
    int max_topic_h = compose_y - topic_y - 1;
    if (max_topic_h < 1) max_topic_h = 1;
    if (topic_h > max_topic_h) topic_h = max_topic_h;
    int scroll_y = topic_y + topic_h;
    int scroll_h = compose_y - 1 - scroll_y;
    if (scroll_h < 0) scroll_h = 0;

    for (int y = 0; y < rows; y++) {
        draw_fill(y, 0, side, CP_ALT);
        if (members) draw_fill(y, members_x, members, CP_ALT);
    }
    attron(COLOR_PAIR(CP_BORDER));
    mvvline(0, side, ACS_VLINE, rows);
    if (members) mvvline(0, members_x - 1, ACS_VLINE, rows);
    mvhline(scroll_y, main_x, ACS_HLINE, main_w);
    mvhline(compose_y - 1, main_x, ACS_HLINE, main_w);
    attroff(COLOR_PAIR(CP_BORDER));

    draw_text(0, 1, side - 2, CP_ACCENT, A_BOLD, "shottino");
    draw_text(1, 1, side - 2, app->ws_connected ? CP_MUTED : CP_ERROR, 0,
              "%s", app->ws_connected ? "ws" : "offline");

    char last_net[MAX_SLUG] = "";
    int y = 3;
    for (size_t i = 0; i < app->window_count && y < rows - 1; i++) {
        struct window *win = &app->windows[i];
        if (strcmp(last_net, win->network) != 0) {
            snprintf(last_net, sizeof(last_net), "%s", win->network);
            draw_text(y++, 1, side - 2, CP_ACCENT, A_BOLD, "%s", win->network);
            if (y >= rows - 1) break;
        }
        bool selected = i == app->current;
        bool unread = app->windows[i].unread > 0;
        int pair = selected ? CP_SELECTED : (unread ? CP_ACCENT : CP_ALT);
        draw_fill(y, 0, side, pair);
        draw_text(y, 1, 2, pair, (selected || unread) ? A_BOLD : 0, "%2zu", i + 1);
        if (unread) draw_text(y, 4, side - 5, pair, A_BOLD, "%s [%u]", win->channel, app->windows[i].unread);
        else draw_text(y, 4, side - 5, pair, selected ? A_BOLD : 0, "%s", win->channel);
        y++;
    }

    if (app->hover_url[0])
        draw_text(chrome_y, main_x + 1, main_w - 2, CP_ACCENT, A_BOLD,
                  "click to preview: %s", app->hover_url);
    else
        draw_text(chrome_y, main_x + 1, main_w - 2, CP_MUTED, 0,
                  "/archive  /settings  /admin  /chat  ws:%s", app->ws_connected ? "connected" : "offline");
    for (int ty = 0; ty < topic_h; ty++) draw_fill(topic_y + ty, main_x, main_w, CP_ALT);
    draw_text(topic_y, main_x + 1, topic_label_w, CP_ACCENT, A_BOLD, "%s/%s", w->network, w->channel);
    if (topic_prefix_w) draw_text(topic_y, topic_text_x, topic_text_w, CP_ALT, A_BOLD, "topic: ");
    draw_wrapped_text(topic_y, topic_text_x + topic_prefix_w, topic_wrap_w, topic_h, CP_ALT, 0, topic_text);

    if (app->panel != PANEL_CHAT) {
        draw_text(scroll_y, main_x + 1, main_w - 2, CP_ACCENT, A_BOLD, "%s", panel_name(app->panel));
        for (size_t i = 0; i < app->panel_line_count && (int)i + scroll_y + 2 < compose_y - 1; i++) {
            int pair = i == 0 ? CP_ACCENT : CP_MAIN;
            attr_t attr = i == 0 ? A_BOLD : 0;
            draw_text(scroll_y + 2 + (int)i, main_x + 1, main_w - 2, pair, attr, "%s", app->panel_lines[i]);
        }
        draw_text(compose_y, main_x + 1, main_w - 2, CP_MUTED, 0, "panel: %s | Esc or /chat returns to chat", panel_name(app->panel));
        int cursor_y = input_y;
        int cursor_x = main_x + 2;
        draw_input_box(input_y, main_x + 1, main_w - 2, input_h, prompt, app->input, &cursor_y, &cursor_x);
        move(cursor_y, cursor_x);
        pthread_mutex_unlock(&app->lock);
        refresh();
        return;
    }

    char wanted_prefix[MAX_SLUG + MAX_CHANNEL + 8];
    snprintf(wanted_prefix, sizeof(wanted_prefix), "[%s/%s]", w->network, w->channel);
    size_t visible[LOG_LINES];
    int heights[LOG_LINES];
    size_t visible_count = 0;
    int total_visible_lines = 0;
    for (size_t i = 0; i < app->log_count; i++) {
        if (strncmp(app->log[i], "[", 1) != 0 || strncmp(app->log[i], wanted_prefix, strlen(wanted_prefix)) == 0) {
            visible[visible_count] = i;
            heights[visible_count] = message_display_lines(app->log[i], main_w - 2);
            if (heights[visible_count] < 1) heights[visible_count] = 1;
            total_visible_lines += heights[visible_count];
            visible_count++;
        }
    }
    int max_offset = total_visible_lines > scroll_h ? total_visible_lines - scroll_h : 0;
    if ((int)app->scrollback_offset > max_offset) app->scrollback_offset = (size_t)max_offset;
    int skip_lines = max_offset - (int)app->scrollback_offset;
    int used_lines = 0;
    for (size_t vi = 0; vi < visible_count; vi++) {
        if (skip_lines >= heights[vi]) {
            skip_lines -= heights[vi];
            continue;
        }
        size_t i = visible[vi];
        if (skip_lines > 0) {
            skip_lines = 0;
            continue;
        }
        int available = scroll_h - used_lines;
        int draw_lines = heights[vi];
        if (draw_lines > available) draw_lines = available;
        if (draw_lines <= 0) break;
        int msg_y = scroll_y + used_lines;
        draw_message_line(msg_y, main_x + 1, main_w - 2, draw_lines, app->log[i], app->log_mentions[i], app->log_pending[i]);
        const char *msg_url = find_url(app->log[i]);
        enum media_kind mk = msg_url ? media_kind_of(msg_url) : MEDIA_NONE;
        if (mk != MEDIA_NONE) {
            char url_tok[MAX_LINE];
            copy_url_token(msg_url, url_tok, sizeof(url_tok));
            add_link_region(app, msg_y, msg_y + draw_lines - 1, main_x + 1,
                            main_x + main_w - 2, url_tok, mk == MEDIA_VIDEO);
        }
        used_lines += draw_lines;
        skip_lines = 0;
    }

    draw_text(compose_y, main_x + 1, main_w - 2, CP_MUTED, 0,
              "[%s] PgUp/PgDn scroll | End bottom | Tab complete | Up/Down history | /open | /exit%s",
              w->channel, app->scrollback_pinned ? " | scrolled" : "");
    int cursor_y = input_y;
    int cursor_x = main_x + 2;
    draw_input_box(input_y, main_x + 1, main_w - 2, input_h, prompt, app->input, &cursor_y, &cursor_x);

    if (members) {
        draw_text(0, members_x + 1, members - 2, CP_ACCENT, A_BOLD, "members");
        draw_text(2, members_x + 1, members - 2, CP_MUTED, 0, "topic/modes/member");
        draw_text(3, members_x + 1, members - 2, CP_MUTED, 0, "snapshots mirror");
        draw_text(4, members_x + 1, members - 2, CP_MUTED, 0, "member side pane");
    }

    move(cursor_y, cursor_x);
    pthread_mutex_unlock(&app->lock);
    refresh();
}

static void send_message(struct app *app, const char *body) {
    struct window *w = &app->windows[app->current];
    char *net = url_encode(w->network);
    char *chan = url_encode(w->channel);
    char *escaped = json_escape(body);
    char *path = xasprintf("/networks/%s/channels/%s/messages", net, chan);
    char *json = xasprintf("{\"body\":\"%s\"}", escaped);
    free(net);
    free(chan);
    free(escaped);
    struct http_response r = http_request(app, "POST", path, json);
    if (r.status < 200 || r.status >= 300) log_line(app, "send failed HTTP %d: %.200s", r.status, r.body);
    else if (r.status == 201) log_message_json(app, r.body, false);
    free(path);
    free(json);
    free(r.body);
}

static void send_message_target(struct app *app, const char *network, const char *channel, const char *body) {
    char *net = url_encode(network);
    char *chan = url_encode(channel);
    char *escaped = json_escape(body);
    char *path = xasprintf("/networks/%s/channels/%s/messages", net, chan);
    char *json = xasprintf("{\"body\":\"%s\"}", escaped);
    free(net);
    free(chan);
    free(escaped);
    struct http_response r = http_request(app, "POST", path, json);
    if (r.status < 200 || r.status >= 300) log_line(app, "send failed HTTP %d: %.200s", r.status, r.body);
    else if (r.status == 201) log_message_json(app, r.body, false);
    free(path);
    free(json);
    free(r.body);
}

static void set_network_state(struct app *app, const char *network, const char *state, const char *reason) {
    char *net = url_encode(network);
    char *path = xasprintf("/networks/%s/", net);
    char *why = json_escape(reason ? reason : "");
    char *body = reason && reason[0]
        ? xasprintf("{\"connection_state\":\"%s\",\"reason\":\"%s\"}", state, why)
        : xasprintf("{\"connection_state\":\"%s\"}", state);
    free(net);
    free(why);
    struct http_response r = http_request(app, "PATCH", path, body);
    if (r.status >= 200 && r.status < 300) log_line(app, "%s is %s", network, state);
    else log_line(app, "network state failed HTTP %d: %.200s", r.status, r.body);
    free(path);
    free(body);
    free(r.body);
}

static void set_nick(struct app *app, const char *nick) {
    char *net = url_encode(app->windows[app->current].network);
    char *path = xasprintf("/networks/%s/nick", net);
    char *escaped = json_escape(nick);
    char *body = xasprintf("{\"nick\":\"%s\"}", escaped);
    free(net);
    free(escaped);
    struct http_response r = http_request(app, "POST", path, body);
    if (r.status >= 200 && r.status < 300) log_line(app, "nick change requested: %s", nick);
    else log_line(app, "nick failed HTTP %d: %.200s", r.status, r.body);
    free(path);
    free(body);
    free(r.body);
}

static void set_topic_target(struct app *app, const char *network, const char *channel, const char *topic) {
    char *net = url_encode(network);
    char *chan = url_encode(channel);
    char *escaped = json_escape(topic);
    char *path = xasprintf("/networks/%s/channels/%s/topic", net, chan);
    char *body = xasprintf("{\"body\":\"%s\"}", escaped);
    free(net);
    free(chan);
    free(escaped);
    struct http_response r = http_request(app, "POST", path, body);
    if (r.status >= 200 && r.status < 300) log_line(app, "topic change requested for %s", channel);
    else log_line(app, "topic failed HTTP %d: %.200s", r.status, r.body);
    free(path);
    free(body);
    free(r.body);
}

static void list_members_target(struct app *app, const char *network, const char *channel) {
    char *net = url_encode(network);
    char *chan = url_encode(channel);
    char *path = xasprintf("/networks/%s/channels/%s/members", net, chan);
    free(net);
    free(chan);
    struct http_response r = http_request(app, "GET", path, NULL);
    if (r.status == 204) {
        log_line(app, "members for %s are not seeded yet", channel);
    } else if (r.status >= 200 && r.status < 300) {
        struct member_row { char nick[MAX_CHANNEL]; char modes[32]; int rank; } rows[512];
        size_t count = 0;
        const char *p = r.body;
        while ((p = strstr(p, "\"nick\"")) && count < 512) {
            char nick[MAX_CHANNEL] = "";
            char modes[32] = "";
            if (json_find_string(p, "nick", nick, sizeof(nick)) && nick[0]) {
                const char *m = strstr(p, "\"modes\"");
                if (m) {
                    char *w = modes;
                    const char *end = strchr(m, ']');
                    while ((m = strchr(m, '"')) && (!end || m < end) && (size_t)(w - modes) + 2 < sizeof(modes)) {
                        m++;
                        if (*m && *m != 'm') *w++ = *m;
                        m++;
                    }
                    *w = 0;
                }
                snprintf(rows[count].nick, sizeof(rows[count].nick), "%s", nick);
                snprintf(rows[count].modes, sizeof(rows[count].modes), "%s", modes);
                rows[count].rank = strchr(modes, '@') ? 0 : (strchr(modes, '%') ? 1 : (strchr(modes, '+') ? 2 : 3));
                count++;
            }
            p += 6;
        }
        for (size_t i = 0; i < count; i++) {
            for (size_t j = i + 1; j < count; j++) {
                if (rows[j].rank < rows[i].rank || (rows[j].rank == rows[i].rank && strcasecmp(rows[j].nick, rows[i].nick) < 0)) {
                    struct member_row tmp = rows[i]; rows[i] = rows[j]; rows[j] = tmp;
                }
            }
        }
        pthread_mutex_lock(&app->lock);
        for (size_t wi = 0; wi < app->window_count; wi++) {
            if (strcmp(app->windows[wi].network, network) == 0 && strcmp(app->windows[wi].channel, channel) == 0) {
                app->windows[wi].member_count = count > 512 ? 512 : count;
                for (size_t mi = 0; mi < app->windows[wi].member_count; mi++) {
                    memcpy(app->windows[wi].members[mi], rows[mi].nick, MAX_CHANNEL);
                    app->windows[wi].members[mi][MAX_CHANNEL - 1] = 0;
                }
                break;
            }
        }
        pthread_mutex_unlock(&app->lock);
        log_line(app, "members %s (%zu):", channel, count);
        for (size_t i = 0; i < count; i++) {
            const char *label = rows[i].rank == 0 ? "op" : (rows[i].rank == 1 ? "halfop" : (rows[i].rank == 2 ? "voice" : "user"));
            log_line(app, "  %-6s %-3s %s", label, rows[i].modes[0] ? rows[i].modes : "-", rows[i].nick);
        }
        if (count == 0) log_line(app, "members %s: (none)", channel);
    } else {
        log_line(app, "members failed HTTP %d: %.200s", r.status, r.body);
    }
    free(path);
    free(r.body);
}

static void push_simple_channel_action(struct app *app, const char *event, const char *extra_json) {
    int id = current_network_id(app);
    char *channel = json_escape(current_channel(app));
    char *payload = extra_json
        ? xasprintf("{\"network_id\":%d,\"channel\":\"%s\",%s}", id, channel, extra_json)
        : xasprintf("{\"network_id\":%d,\"channel\":\"%s\"}", id, channel);
    free(channel);
    ws_push_user(app, event, payload);
    free(payload);
}

static char *json_array_words(const char *words) {
    char *copy = xasprintf("%s", words);
    char *out = xasprintf("[");
    bool first = true;
    for (char *tok = strtok(copy, " \t"); tok; tok = strtok(NULL, " \t")) {
        char *e = json_escape(tok);
        char *next = xasprintf("%s%s\"%s\"", out, first ? "" : ",", e);
        free(out);
        free(e);
        out = next;
        first = false;
    }
    char *next = xasprintf("%s]", out);
    free(out);
    free(copy);
    return next;
}

static void query_window(struct app *app, const char *target) {
    int id = current_network_id(app);
    char *t = json_escape(target);
    char *payload = xasprintf("{\"network_id\":%d,\"target_nick\":\"%s\"}", id, t);
    ws_push_user(app, "open_query_window", payload);
    add_window(app, app->windows[app->current].network, target);
    free(t);
    free(payload);
}

static void join_channel(struct app *app, const char *name) {
    const char *net_slug = app->networks[0].slug;
    if (app->window_count > 0) net_slug = app->windows[app->current].network;
    char *net = url_encode(net_slug);
    char *path = xasprintf("/networks/%s/channels", net);
    char *escaped = json_escape(name);
    char *body = xasprintf("{\"name\":\"%s\"}", escaped);
    free(net);
    free(escaped);
    struct http_response r = http_request(app, "POST", path, body);
    if (r.status >= 200 && r.status < 300) {
        add_window(app, net_slug, name);
        fetch_scrollback(app, &app->windows[app->current]);
        if (app->ws_connected) {
            char *t = xasprintf("grappa:user:%s/network:%s/channel:%s", app->subject, net_slug, name);
            ws_join(app, t);
            free(t);
        }
    } else {
        log_line(app, "join failed HTTP %d: %.200s", r.status, r.body);
    }
    free(path);
    free(body);
    free(r.body);
}

static void part_current(struct app *app) {
    char network[MAX_SLUG];
    char channel[MAX_CHANNEL];
    pthread_mutex_lock(&app->lock);
    snprintf(network, sizeof(network), "%s", app->windows[app->current].network);
    snprintf(channel, sizeof(channel), "%s", app->windows[app->current].channel);
    pthread_mutex_unlock(&app->lock);
    char *net = url_encode(network);
    char *chan = url_encode(channel);
    char *path = xasprintf("/networks/%s/channels/%s", net, chan);
    free(net);
    free(chan);
    struct http_response r = http_request(app, "DELETE", path, NULL);
    if (r.status >= 200 && r.status < 300) {
        log_line(app, "parted %s", channel);
        remove_window(app, network, channel);
    }
    else log_line(app, "part failed HTTP %d: %.200s", r.status, r.body);
    free(path);
    free(r.body);
}

static void close_query_target(struct app *app, const char *network, const char *target) {
    int id = 0;
    for (size_t i = 0; i < app->network_count; i++) {
        if (strcmp(app->networks[i].slug, network) == 0) {
            id = app->networks[i].id;
            break;
        }
    }
    if (id == 0) {
        log_line(app, "close query failed: unknown network %s", network);
        return;
    }
    char *nick = json_escape(target);
    char *payload = xasprintf("{\"network_id\":%d,\"target_nick\":\"%s\"}", id, nick);
    free(nick);
    ws_push_user(app, "close_query_window", payload);
    free(payload);
    remove_window(app, network, target);
    log_line(app, "closed query %s", target);
}

static bool enqueue_job(struct app *app, struct job job) {
    pthread_mutex_lock(&app->jobs_lock);
    size_t next = (app->jobs_tail + 1) % JOB_QUEUE;
    if (next == app->jobs_head) {
        pthread_mutex_unlock(&app->jobs_lock);
        log_line(app, "background queue full; command not sent");
        return false;
    }
    app->jobs[app->jobs_tail] = job;
    app->jobs_tail = next;
    pthread_cond_signal(&app->jobs_cond);
    pthread_mutex_unlock(&app->jobs_lock);
    return true;
}

static bool dequeue_job(struct app *app, struct job *job) {
    pthread_mutex_lock(&app->jobs_lock);
    while (!app->worker_stop && app->jobs_head == app->jobs_tail) pthread_cond_wait(&app->jobs_cond, &app->jobs_lock);
    if (app->worker_stop && app->jobs_head == app->jobs_tail) {
        pthread_mutex_unlock(&app->jobs_lock);
        return false;
    }
    *job = app->jobs[app->jobs_head];
    app->jobs_head = (app->jobs_head + 1) % JOB_QUEUE;
    pthread_mutex_unlock(&app->jobs_lock);
    return true;
}

static void *worker_main(void *arg) {
    struct app *app = arg;
    struct job job;
    while (dequeue_job(app, &job)) {
        switch (job.kind) {
        case JOB_FETCH:
            fetch_scrollback_target(app, job.network, job.channel);
            break;
        case JOB_SEND: {
            send_message_target(app, job.network, job.channel, job.arg1);
            break;
        }
        case JOB_JOIN:
            join_channel(app, job.channel);
            break;
        case JOB_PART: {
            add_window(app, job.network, job.channel);
            part_current(app);
            break;
        }
        case JOB_NICK:
            add_window(app, job.network, job.channel);
            set_nick(app, job.arg1);
            break;
        case JOB_NETWORK_STATE:
            set_network_state(app, job.network, job.arg1, job.arg2[0] ? job.arg2 : NULL);
            break;
        case JOB_TOPIC:
            set_topic_target(app, job.network, job.channel, job.arg1);
            break;
        case JOB_MEMBERS:
            list_members_target(app, job.network, job.channel);
            break;
        case JOB_CLOSE_QUERY:
            close_query_target(app, job.network, job.channel);
            break;
        }
    }
    return NULL;
}

static void enqueue_fetch(struct app *app, const char *network, const char *channel) {
    struct job job = { .kind = JOB_FETCH };
    snprintf(job.network, sizeof(job.network), "%s", network);
    snprintf(job.channel, sizeof(job.channel), "%s", channel);
    enqueue_job(app, job);
}

static void enqueue_send(struct app *app, const char *network, const char *channel, const char *body) {
    struct job job = { .kind = JOB_SEND };
    snprintf(job.network, sizeof(job.network), "%s", network);
    snprintf(job.channel, sizeof(job.channel), "%s", channel);
    snprintf(job.arg1, sizeof(job.arg1), "%s", body);
    enqueue_job(app, job);
}

static const char *own_nick_for_network(struct app *app, const char *network) {
    for (size_t i = 0; i < app->network_count; i++) {
        if (strcmp(app->networks[i].slug, network) == 0 && app->networks[i].nick[0]) return app->networks[i].nick;
    }
    if (app->login_nick[0]) return app->login_nick;
    const char *colon = strchr(app->subject, ':');
    return colon ? colon + 1 : app->subject;
}

static void add_history(struct app *app, const char *line) {
    if (!line[0]) return;
    if (app->history_count > 0 && strcmp(app->history[app->history_count - 1], line) == 0) {
        app->history_pos = app->history_count;
        return;
    }
    if (app->history_count == INPUT_HISTORY) {
        memmove(app->history, app->history + 1, sizeof(app->history[0]) * (INPUT_HISTORY - 1));
        app->history_count--;
    }
    snprintf(app->history[app->history_count++], MAX_LINE, "%s", line);
    app->history_pos = app->history_count;
}

static void history_prev(struct app *app) {
    if (app->history_count == 0 || app->history_pos == 0) return;
    app->history_pos--;
    snprintf(app->input, sizeof(app->input), "%s", app->history[app->history_pos]);
    app->input_len = strlen(app->input);
}

static void history_next(struct app *app) {
    if (app->history_pos >= app->history_count) return;
    app->history_pos++;
    if (app->history_pos == app->history_count) app->input[0] = 0;
    else snprintf(app->input, sizeof(app->input), "%s", app->history[app->history_pos]);
    app->input_len = strlen(app->input);
}

static void scroll_chat(struct app *app, int delta) {
    pthread_mutex_lock(&app->lock);
    if (delta > 0) app->scrollback_offset += (size_t)delta;
    else {
        size_t n = (size_t)(-delta);
        app->scrollback_offset = n > app->scrollback_offset ? 0 : app->scrollback_offset - n;
    }
    app->scrollback_pinned = app->scrollback_offset > 0;
    pthread_mutex_unlock(&app->lock);
}

static void scroll_bottom(struct app *app) {
    pthread_mutex_lock(&app->lock);
    app->scrollback_offset = 0;
    app->scrollback_pinned = false;
    pthread_mutex_unlock(&app->lock);
}

static void cycle_window(struct app *app, int delta) {
    pthread_mutex_lock(&app->lock);
    if (app->window_count == 0) {
        pthread_mutex_unlock(&app->lock);
        return;
    }
    if (delta > 0) app->current = (app->current + 1) % app->window_count;
    else app->current = app->current == 0 ? app->window_count - 1 : app->current - 1;
    clear_current_unread_locked(app);
    app->scrollback_offset = 0;
    app->scrollback_pinned = false;
    char network[MAX_SLUG];
    char channel[MAX_CHANNEL];
    snprintf(network, sizeof(network), "%s", app->windows[app->current].network);
    snprintf(channel, sizeof(channel), "%s", app->windows[app->current].channel);
    pthread_mutex_unlock(&app->lock);
    enqueue_fetch(app, network, channel);
}

static const char *commands[] = {
    "/admin", "/archive", "/away", "/ban", "/banlist", "/chat", "/clear", "/close", "/connect", "/deop", "/devoice", "/disconnect",
    "/invite", "/join", "/kick", "/lusers", "/me", "/members", "/mode", "/msg", "/names",
    "/nick", "/op", "/oper", "/part", "/q", "/query", "/quit", "/quote", "/settings", "/topic", "/umode",
    "/unban", "/users", "/voice", "/w", "/watch", "/whowas", "/who", "/whois", "/win", "/window"
};

static bool prefix_ci(const char *s, const char *prefix) {
    while (*prefix) {
        if (!*s) return false;
        if (tolower((unsigned char)*s) != tolower((unsigned char)*prefix)) return false;
        s++;
        prefix++;
    }
    return true;
}

static bool candidate_seen(char candidates[][MAX_CHANNEL], size_t count, const char *candidate) {
    for (size_t i = 0; i < count; i++) {
        if (strcasecmp(candidates[i], candidate) == 0) return true;
    }
    return false;
}

static void add_completion_candidate(char candidates[][MAX_CHANNEL], size_t *count, const char *candidate, const char *stem) {
    if (!candidate || !candidate[0]) return;
    if (!prefix_ci(candidate, stem)) return;
    if (candidate_seen(candidates, *count, candidate)) return;
    if (*count >= 64) return;
    snprintf(candidates[*count], MAX_CHANNEL, "%s", candidate);
    (*count)++;
}

static void collect_log_nick_candidate(struct app *app, char candidates[][MAX_CHANNEL], size_t *count, const char *line, const char *stem) {
    char prefix[256];
    char nick[MAX_CHANNEL];
    const char *body;
    (void)app;
    if (split_message_line(line, prefix, sizeof(prefix), nick, sizeof(nick), &body)) {
        add_completion_candidate(candidates, count, nick, stem);
    }
}

static void complete_input(struct app *app) {
    char prefix[MAX_LINE];
    snprintf(prefix, sizeof(prefix), "%s", app->input);
    char *last_space = strrchr(prefix, ' ');
    const char *stem = last_space ? last_space + 1 : prefix;
    size_t stem_len = strlen(stem);

    if (app->input_len == 0 || stem_len == 0) return;

    char candidates[64][MAX_CHANNEL];
    size_t matches = 0;

    if (prefix[0] == '/' && !last_space) {
        for (size_t i = 0; i < sizeof(commands) / sizeof(commands[0]); i++) {
            add_completion_candidate(candidates, &matches, commands[i], stem);
        }
    } else {
        const char *current_network = app->window_count > 0 ? app->windows[app->current].network : "";
        if (app->window_count > 0) {
            struct window *w = &app->windows[app->current];
            for (size_t i = 0; i < w->member_count; i++) add_completion_candidate(candidates, &matches, w->members[i], stem);
        }
        for (size_t i = 0; i < app->window_count; i++) {
            const char *name = app->windows[i].channel;
            add_completion_candidate(candidates, &matches, name, stem);
        }
        for (size_t i = 0; i < app->network_count; i++) {
            const char *name = app->networks[i].slug;
            add_completion_candidate(candidates, &matches, name, stem);
            if (strcmp(app->networks[i].slug, current_network) == 0) add_completion_candidate(candidates, &matches, app->networks[i].nick, stem);
        }
        for (size_t i = 0; i < app->log_count; i++) {
            collect_log_nick_candidate(app, candidates, &matches, app->log[i], stem);
        }
    }

    if (matches == 1) {
        size_t head = last_space ? (size_t)(last_space + 1 - prefix) : 0;
        snprintf(app->input + head, sizeof(app->input) - head, "%s", candidates[0]);
        app->input_len = strlen(app->input);
        if (app->input_len + 1 < sizeof(app->input)) {
            app->input[app->input_len++] = ' ';
            app->input[app->input_len] = 0;
        }
    } else if (matches > 1) {
        char list[1024] = "";
        size_t used = 0;
        for (size_t i = 0; i < matches; i++) {
            int n = snprintf(list + used, sizeof(list) - used, "%s%s", i == 0 ? "" : " ", candidates[i]);
            if (n < 0 || (size_t)n >= sizeof(list) - used) break;
            used += (size_t)n;
        }
        log_line(app, "completions for '%s': %s", stem, list);
    }
}

static void open_external_url(struct app *app, const char *url) {
    if (!url || !url[0]) {
        log_line(app, "no URL captured yet");
        return;
    }
    /* Double-fork: the grandchild runs xdg-open and is reparented to init,
     * so it is auto-reaped — we must not block the UI thread waiting on a
     * browser launcher, and a single fork would leak a zombie per call.
     * xdg-open's own diagnostics are sent to /dev/null so they can't scribble
     * over the ncurses screen. */
    pid_t pid = fork();
    if (pid == 0) {
        if (fork() == 0) {
            int devnull = open("/dev/null", O_WRONLY);
            if (devnull >= 0) {
                dup2(devnull, STDOUT_FILENO);
                dup2(devnull, STDERR_FILENO);
                if (devnull > STDERR_FILENO) close(devnull);
            }
            execlp("xdg-open", "xdg-open", url, (char *)NULL);
            _exit(127);
        }
        _exit(0);
    }
    if (pid < 0) {
        log_line(app, "failed to launch xdg-open");
        return;
    }
    while (waitpid(pid, NULL, 0) < 0 && errno == EINTR) {}
    log_line(app, "opened %s", url);
}

/* Search PATH for an executable named `name` (no shell, no PATH injection). */
static bool tool_on_path(const char *name) {
    const char *path = getenv("PATH");
    if (!path || !path[0]) path = "/usr/bin:/bin";
    char buf[PATH_MAX];
    const char *p = path;
    while (*p) {
        const char *colon = strchr(p, ':');
        size_t dir_len = colon ? (size_t)(colon - p) : strlen(p);
        if (dir_len > 0 && dir_len + 1 + strlen(name) + 1 < sizeof(buf)) {
            memcpy(buf, p, dir_len);
            buf[dir_len] = '/';
            snprintf(buf + dir_len + 1, sizeof(buf) - dir_len - 1, "%s", name);
            if (access(buf, X_OK) == 0) return true;
        }
        if (!colon) break;
        p = colon + 1;
    }
    return false;
}

/* Run argv[0] with execvp (no shell). stderr always discarded; stdout goes to
 * the controlling terminal when `inherit_stdout` (so chafa can paint), else to
 * /dev/null (ffmpeg writes its frame to a file, not stdout). Returns the
 * process exit code, or -1 on spawn/abnormal exit. */
static int run_cmd(char *const argv[], bool inherit_stdout) {
    pid_t pid = fork();
    if (pid < 0) return -1;
    if (pid == 0) {
        int devnull = open("/dev/null", O_WRONLY);
        if (devnull >= 0) {
            if (!inherit_stdout) dup2(devnull, STDOUT_FILENO);
            dup2(devnull, STDERR_FILENO);
            if (devnull > STDERR_FILENO) close(devnull);
        }
        execvp(argv[0], argv);
        _exit(127);
    }
    int status = 0;
    while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {}
    if (WIFEXITED(status)) return WEXITSTATUS(status);
    return -1;
}

/* Block for a single raw keypress on stdin, used to dismiss the preview while
 * ncurses is suspended. Restores the prior terminal mode before returning. */
static void wait_for_dismiss_key(void) {
    struct termios old_tio, raw;
    if (tcgetattr(STDIN_FILENO, &old_tio) != 0) {
        getchar();
        return;
    }
    raw = old_tio;
    cfmakeraw(&raw);
    unsigned char c;
    /* First drain whatever the terminal sent in reply to chafa's graphics
     * capability probes (DA / cursor-position / Kitty responses). If left in
     * the buffer, the blocking read below would consume one of those bytes as
     * the dismiss key and flash the preview shut. VMIN=0/VTIME=1 polls with a
     * 100ms idle window: read until a quiet gap, then there is nothing stray
     * left. */
    raw.c_cc[VMIN] = 0;
    raw.c_cc[VTIME] = 1;
    tcsetattr(STDIN_FILENO, TCSANOW, &raw);
    while (read(STDIN_FILENO, &c, 1) > 0) {}
    /* Then block for a genuine keypress. */
    raw.c_cc[VMIN] = 1;
    raw.c_cc[VTIME] = 0;
    tcsetattr(STDIN_FILENO, TCSANOW, &raw);
    while (read(STDIN_FILENO, &c, 1) < 0 && errno == EINTR) {}
    tcsetattr(STDIN_FILENO, TCSANOW, &old_tio);
}

/* Mouse motion/button reporting escapes. Enabled while shottino owns the
 * screen; disabled around the preview (so frame bytes aren't read as a
 * dismiss key) and at shutdown. */
static void mouse_reporting(bool on) {
    fputs(on ? "\033[?1000h\033[?1003h\033[?1006h"
             : "\033[?1006l\033[?1003l\033[?1000l",
          stdout);
    fflush(stdout);
}

/* Full-screen modal media preview. Both images and videos are normalized to a
 * single PNG frame by ffmpeg (which also does the network fetch + decode),
 * then rendered by chafa, which auto-detects the terminal graphics protocol
 * (Kitty > iTerm2 > Sixel > symbols). Falls back to xdg-open when either tool
 * is absent or the frame extraction fails. Blocks until a key is pressed; the
 * caller's next draw() repaints the chat, clearing the preview. */
static void preview_media(struct app *app, const char *url, bool is_video) {
    if (!url || !url[0]) return;
    if (!tool_on_path("chafa") || !tool_on_path("ffmpeg")) {
        log_line(app, "preview needs 'chafa' + 'ffmpeg' on PATH — opening externally");
        open_external_url(app, url);
        return;
    }

    char dir[] = "/tmp/shottino-preview-XXXXXX";
    if (!mkdtemp(dir)) {
        log_line(app, "preview: failed to create temp dir — opening externally");
        open_external_url(app, url);
        return;
    }
    char png[PATH_MAX];
    snprintf(png, sizeof(png), "%s/frame.png", dir);

    /* ffmpeg fetches + decodes the URL and writes one representative frame.
     * The thumbnail filter picks a non-leader frame for video and is a no-op
     * pass-through for a still image, so one pipeline covers both (and avoids a
     * black first frame for an extensionless video URL). rw_timeout bounds a
     * stalled network fetch (microseconds). */
    char *ff_argv[] = {"ffmpeg", "-y", "-loglevel", "error",
                       "-rw_timeout", "15000000", "-i", (char *)url,
                       "-vf", "thumbnail", "-frames:v", "1", png, NULL};
    int rc = run_cmd(ff_argv, false);
    if (rc != 0 || access(png, R_OK) != 0) {
        log_line(app, "preview: could not fetch/decode media (ffmpeg rc=%d) — opening externally", rc);
        open_external_url(app, url);
        unlink(png);
        rmdir(dir);
        return;
    }

    struct winsize ws = {0};
    int term_rows = 24, term_cols = 80;
    if (ioctl(STDOUT_FILENO, TIOCGWINSZ, &ws) == 0 && ws.ws_row > 2 && ws.ws_col > 0) {
        term_rows = ws.ws_row;
        term_cols = ws.ws_col;
    }
    char size_arg[32];
    snprintf(size_arg, sizeof(size_arg), "%dx%d", term_cols, term_rows - 2);

    /* Leave ncurses entirely so chafa's protocol detection sees a real tty and
     * its escapes don't fight the ncurses screen buffer. */
    def_prog_mode();
    endwin();
    mouse_reporting(false);
    fputs("\033[2J\033[H", stdout);
    int url_w = term_cols - 10;
    if (url_w < 0) url_w = 0;
    printf("preview: %.*s\r\n", url_w, url);
    fflush(stdout);

    char *chafa_argv[] = {"chafa", "--clear", "--size", size_arg, png, NULL};
    run_cmd(chafa_argv, true);

    printf("\033[%d;1H[ %s — press any key to return ]", term_rows,
           is_video ? "video frame" : "image");
    fflush(stdout);
    wait_for_dismiss_key();

    /* Kitty placements persist above the cell grid; ask the terminal to drop
     * all images so the chat repaint underneath is clean (no-op elsewhere). */
    fputs("\033_Ga=d\033\\", stdout);
    fflush(stdout);

    unlink(png);
    rmdir(dir);

    /* Restore ncurses first, then re-assert mouse reporting so our escapes
     * aren't clobbered by terminfo strings reset_prog_mode may re-emit. */
    reset_prog_mode();
    clearok(stdscr, TRUE);
    refresh();
    mouse_reporting(true);
}

static void show_help(struct app *app) {
    log_line(app, "commands: /help /archive /settings /admin /chat /exit /quit /window N [/w N, /win N] /join #chan [/j] /part /close /clear /msg nick text /query nick [/q nick] /me text");
    log_line(app, "network: /connect slug /disconnect [slug] [reason] /nick nick /away [reason]");
    log_line(app, "info: /topic [text|-delete] /members [/users] /whois nick /whowas nick /who [#chan] /names [#chan] /lusers /watch add|del|list pattern");
    log_line(app, "ops: /op nicks /deop nicks /voice nicks /devoice nicks /kick nick [reason] /ban mask /unban mask /banlist /invite nick");
    log_line(app, "raw/media: /quote line /oper name password /open last-url; keys: PgUp/PgDn scroll, End bottom, Tab complete, Up/Down history, Ctrl-N/Ctrl-P window cycle");
}

static void show_command_help(struct app *app, const char *raw) {
    while (*raw == ' ') raw++;
    const char *cmd = raw[0] == '/' ? raw + 1 : raw;
    if (!*cmd) {
        show_help(app);
        return;
    }
    if (strcmp(cmd, "quit") == 0) log_line(app, "/quit — terminate the grappa session, delete saved token, and exit Shottino");
    else if (strcmp(cmd, "exit") == 0) log_line(app, "/exit — close Shottino only; grappa stays connected and token remains for reattach");
    else if (strcmp(cmd, "window") == 0 || strcmp(cmd, "win") == 0 || strcmp(cmd, "w") == 0) log_line(app, "/window N, /win N, /w N — switch to window number N and clear its unread count");
    else if (strcmp(cmd, "join") == 0 || strcmp(cmd, "j") == 0) log_line(app, "/join #chan [key], /j #chan [key] — join a channel");
    else if (strcmp(cmd, "part") == 0) log_line(app, "/part — part the current channel");
    else if (strcmp(cmd, "close") == 0) log_line(app, "/close — close current channel/query; channels PART, queries close the query window");
    else if (strcmp(cmd, "clear") == 0) log_line(app, "/clear — clear the local visible buffer for the active window; does not delete server scrollback");
    else if (strcmp(cmd, "msg") == 0) log_line(app, "/msg nick text — send a private message and open/reuse the query window");
    else if (strcmp(cmd, "query") == 0 || strcmp(cmd, "q") == 0) log_line(app, "/query nick, /q nick — open a query window without sending a message");
    else if (strcmp(cmd, "me") == 0) log_line(app, "/me text — send an ACTION (/me) message to the current window");
    else if (strcmp(cmd, "topic") == 0) log_line(app, "/topic [text|-delete] — set or clear the current channel topic; bare /topic requests a snapshot");
    else if (strcmp(cmd, "members") == 0 || strcmp(cmd, "users") == 0) log_line(app, "/members, /users — list known members for the current channel");
    else if (strcmp(cmd, "nick") == 0) log_line(app, "/nick nick — request an IRC nick change on the current network");
    else if (strcmp(cmd, "away") == 0) log_line(app, "/away [reason] — set away with reason; bare /away returns present");
    else if (strcmp(cmd, "connect") == 0) log_line(app, "/connect network — mark a parked network connected so grappa can spawn it");
    else if (strcmp(cmd, "disconnect") == 0) log_line(app, "/disconnect [network] [reason] — park a network while keeping Shottino running");
    else if (strcmp(cmd, "whois") == 0) log_line(app, "/whois nick — request WHOIS for nick");
    else if (strcmp(cmd, "whowas") == 0) log_line(app, "/whowas nick — request WHOWAS for nick");
    else if (strcmp(cmd, "who") == 0) log_line(app, "/who [#chan] — request WHO for target/current channel");
    else if (strcmp(cmd, "names") == 0) log_line(app, "/names [#chan] — request NAMES for target/current channel");
    else if (strcmp(cmd, "lusers") == 0) log_line(app, "/lusers — request IRC network user/server counts");
    else if (strcmp(cmd, "watch") == 0 || strcmp(cmd, "highlight") == 0) log_line(app, "/watch add|del|list pattern — manage highlight watchlist");
    else if (strcmp(cmd, "op") == 0 || strcmp(cmd, "deop") == 0 || strcmp(cmd, "voice") == 0 || strcmp(cmd, "devoice") == 0) log_line(app, "/%s nick [nick...] — change channel privileges", cmd);
    else if (strcmp(cmd, "kick") == 0) log_line(app, "/kick nick [reason] — kick nick from the current channel");
    else if (strcmp(cmd, "ban") == 0 || strcmp(cmd, "unban") == 0) log_line(app, "/%s mask — set or remove a channel ban mask", cmd);
    else if (strcmp(cmd, "banlist") == 0) log_line(app, "/banlist — request current channel ban list");
    else if (strcmp(cmd, "invite") == 0) log_line(app, "/invite nick — invite nick to the current channel");
    else if (strcmp(cmd, "quote") == 0) log_line(app, "/quote raw-line — send a raw IRC line through grappa");
    else if (strcmp(cmd, "oper") == 0) log_line(app, "/oper name password — send IRC OPER credentials; password is not logged");
    else if (strcmp(cmd, "open") == 0) log_line(app, "/open — open the most recent URL using xdg-open");
    else if (strcmp(cmd, "archive") == 0 || strcmp(cmd, "settings") == 0 || strcmp(cmd, "admin") == 0 || strcmp(cmd, "chat") == 0) log_line(app, "/%s — switch to the %s panel", cmd, cmd);
    else log_line(app, "no help for /%s; use /help for the command list", cmd);
}

static void handle_command(struct app *app, char *line) {
    if (strcmp(line, "/quit") == 0) {
        logout_grappa(app);
        app->running = false;
    } else if (strcmp(line, "/exit") == 0) {
        app->running = false;
    } else if (strcmp(line, "/help") == 0) {
        show_help(app);
    } else if (strncmp(line, "/help ", 6) == 0) {
        show_command_help(app, line + 6);
    } else if (strcmp(line, "/chat") == 0) {
        pthread_mutex_lock(&app->lock);
        app->panel = PANEL_CHAT;
        pthread_mutex_unlock(&app->lock);
    } else if (strcmp(line, "/archive") == 0) {
        open_panel(app, PANEL_ARCHIVE);
    } else if (strcmp(line, "/settings") == 0) {
        open_panel(app, PANEL_SETTINGS);
    } else if (strcmp(line, "/admin") == 0) {
        open_panel(app, PANEL_ADMIN);
    } else if (strcmp(line, "/open") == 0) {
        open_external_url(app, app->last_url);
    } else if (strcmp(line, "/clear") == 0) {
        clear_active_window_log(app);
    } else if (strcmp(line, "/close") == 0) {
        struct window w;
        pthread_mutex_lock(&app->lock);
        w = app->windows[app->current];
        pthread_mutex_unlock(&app->lock);
        if (w.channel[0] == '#' || w.channel[0] == '&' || w.channel[0] == '+' || w.channel[0] == '!') {
            struct job job = { .kind = JOB_PART };
            snprintf(job.network, sizeof(job.network), "%s", w.network);
            snprintf(job.channel, sizeof(job.channel), "%s", w.channel);
            enqueue_job(app, job);
        } else if (strcmp(w.channel, "$server") == 0) {
            log_line(app, "cannot close server window");
        } else {
            struct job job = { .kind = JOB_CLOSE_QUERY };
            snprintf(job.network, sizeof(job.network), "%s", w.network);
            snprintf(job.channel, sizeof(job.channel), "%s", w.channel);
            enqueue_job(app, job);
        }
    } else if (strncmp(line, "/join ", 6) == 0 && line[6]) {
        struct job job = { .kind = JOB_JOIN };
        snprintf(job.network, sizeof(job.network), "%s", app->windows[app->current].network);
        snprintf(job.channel, sizeof(job.channel), "%s", line + 6);
        enqueue_job(app, job);
    } else if (strncmp(line, "/j ", 3) == 0 && line[3]) {
        struct job job = { .kind = JOB_JOIN };
        snprintf(job.network, sizeof(job.network), "%s", app->windows[app->current].network);
        snprintf(job.channel, sizeof(job.channel), "%s", line + 3);
        enqueue_job(app, job);
    } else if (strcmp(line, "/part") == 0) {
        handle_command(app, "/close");
    } else if (strncmp(line, "/nick ", 6) == 0 && line[6]) {
        struct job job = { .kind = JOB_NICK };
        snprintf(job.network, sizeof(job.network), "%s", app->windows[app->current].network);
        snprintf(job.channel, sizeof(job.channel), "%s", app->windows[app->current].channel);
        snprintf(job.arg1, sizeof(job.arg1), "%s", line + 6);
        enqueue_job(app, job);
    } else if (strncmp(line, "/msg ", 5) == 0) {
        char *sp = strchr(line + 5, ' ');
        if (!sp) log_line(app, "/msg requires <target> <body>");
        else {
            *sp = 0;
            const char *target = line + 5;
            const char *body = sp + 1;
            const char *network = app->windows[app->current].network;
            query_window(app, target);
            add_pending_echo(app, network, target, own_nick_for_network(app, network), body);
            enqueue_send(app, app->windows[app->current].network, target, body);
        }
    } else if (strcmp(line, "/query") == 0 || strcmp(line, "/q") == 0) {
        log_line(app, "/query requires a nick; use /query nick or /q nick");
    } else if (strncmp(line, "/query ", 7) == 0 && line[7]) {
        query_window(app, line + 7);
    } else if (strncmp(line, "/q ", 3) == 0 && line[3]) {
        query_window(app, line + 3);
    } else if (strncmp(line, "/me ", 4) == 0 && line[4]) {
        char *body = xasprintf("\001ACTION %s\001", line + 4);
        send_message(app, body);
        free(body);
    } else if (strncmp(line, "/disconnect", 11) == 0) {
        char *rest = line + 11;
        while (*rest == ' ') rest++;
        struct job job = { .kind = JOB_NETWORK_STATE };
        snprintf(job.arg1, sizeof(job.arg1), "parked");
        if (!*rest) {
            snprintf(job.network, sizeof(job.network), "%s", app->windows[app->current].network);
            enqueue_job(app, job);
        }
        else {
            char *sp = strchr(rest, ' ');
            if (sp) { *sp = 0; snprintf(job.arg2, sizeof(job.arg2), "%s", sp + 1); }
            snprintf(job.network, sizeof(job.network), "%s", rest);
            enqueue_job(app, job);
        }
    } else if (strncmp(line, "/connect ", 9) == 0 && line[9]) {
        struct job job = { .kind = JOB_NETWORK_STATE };
        snprintf(job.network, sizeof(job.network), "%s", line + 9);
        snprintf(job.arg1, sizeof(job.arg1), "connected");
        enqueue_job(app, job);
    } else if (strncmp(line, "/away", 5) == 0) {
        char *rest = line + 5;
        while (*rest == ' ') rest++;
        char *net = json_escape(app->windows[app->current].network);
        char *payload;
        if (*rest) {
            if (*rest == ':') rest++;
            char *reason = json_escape(rest);
            payload = xasprintf("{\"action\":\"set\",\"network\":\"%s\",\"reason\":\"%s\"}", net, reason);
            free(reason);
        } else {
            payload = xasprintf("{\"action\":\"unset\",\"network\":\"%s\"}", net);
        }
        ws_push_user(app, "away", payload);
        free(net);
        free(payload);
    } else if (strncmp(line, "/whois ", 7) == 0 && line[7]) {
        char *nick = json_escape(line + 7);
        char *payload = xasprintf("{\"network_id\":%d,\"nick\":\"%s\"}", current_network_id(app), nick);
        ws_push_user(app, "whois", payload);
        free(nick); free(payload);
    } else if (strncmp(line, "/whowas ", 8) == 0 && line[8]) {
        char *nick = json_escape(line + 8);
        char *payload = xasprintf("{\"network_id\":%d,\"nick\":\"%s\"}", current_network_id(app), nick);
        ws_push_user(app, "whowas", payload);
        free(nick); free(payload);
    } else if (strcmp(line, "/lusers") == 0) {
        char *payload = xasprintf("{\"network_id\":%d}", current_network_id(app));
        ws_push_user(app, "lusers", payload);
        free(payload);
    } else if (strncmp(line, "/who", 4) == 0) {
        const char *target = line[4] ? line + 5 : current_channel(app);
        char *chan = json_escape(target && *target ? target : current_channel(app));
        char *payload = xasprintf("{\"network_id\":%d,\"channel\":\"%s\"}", current_network_id(app), chan);
        ws_push_user(app, "who", payload);
        free(chan); free(payload);
    } else if (strncmp(line, "/names", 6) == 0) {
        const char *target = line[6] ? line + 7 : current_channel(app);
        char *chan = json_escape(target && *target ? target : current_channel(app));
        char *origin = json_escape(current_channel(app));
        char *payload = xasprintf("{\"network_id\":%d,\"channel\":\"%s\",\"origin_window\":\"%s\"}", current_network_id(app), chan, origin);
        ws_push_user(app, "names", payload);
        free(chan); free(origin); free(payload);
    } else if (strcmp(line, "/members") == 0 || strcmp(line, "/users") == 0) {
        struct job job = { .kind = JOB_MEMBERS };
        snprintf(job.network, sizeof(job.network), "%s", app->windows[app->current].network);
        snprintf(job.channel, sizeof(job.channel), "%s", app->windows[app->current].channel);
        enqueue_job(app, job);
    } else if (strncmp(line, "/topic", 6) == 0) {
        const char *rest = line + 6;
        while (*rest == ' ') rest++;
        if (!*rest) {
            char *chan = json_escape(current_channel(app));
            char *payload = xasprintf("{\"network_id\":%d,\"channel\":\"%s\",\"origin_window\":\"%s\"}", current_network_id(app), chan, chan);
            ws_push_user(app, "names", payload);
            free(chan); free(payload);
            log_line(app, "requested topic snapshot for %s", current_channel(app));
        } else {
            struct job job = { .kind = JOB_TOPIC };
            snprintf(job.network, sizeof(job.network), "%s", app->windows[app->current].network);
            snprintf(job.channel, sizeof(job.channel), "%s", app->windows[app->current].channel);
            snprintf(job.arg1, sizeof(job.arg1), "%s", strcmp(rest, "-delete") == 0 ? " " : rest);
            enqueue_job(app, job);
        }
    } else if (strncmp(line, "/quote ", 7) == 0 && line[7]) {
        char *raw = json_escape(line + 7);
        char *payload = xasprintf("{\"network_id\":%d,\"line\":\"%s\"}", current_network_id(app), raw);
        ws_push_user(app, "raw", payload);
        free(raw); free(payload);
    } else if (strncmp(line, "/oper ", 6) == 0) {
        char *rest = line + 6;
        char *sp = strchr(rest, ' ');
        if (!sp) log_line(app, "/oper requires <name> <password>");
        else {
            *sp = 0;
            char *name = json_escape(rest);
            char *pw = json_escape(sp + 1);
            char *payload = xasprintf("{\"network_id\":%d,\"name\":\"%s\",\"password\":\"%s\"}", current_network_id(app), name, pw);
            ws_push_user(app, "oper", payload);
            free(name); free(pw); free(payload);
        }
    } else if (strncmp(line, "/op ", 4) == 0 || strncmp(line, "/deop ", 6) == 0 || strncmp(line, "/voice ", 7) == 0 || strncmp(line, "/devoice ", 9) == 0) {
        const char *event = line[1] == 'o' ? "op" : (line[1] == 'v' ? "voice" : (line[3] == 'p' ? "deop" : "devoice"));
        char *rest = strchr(line + 1, ' ');
        char *nicks = json_array_words(rest ? rest + 1 : "");
        char *extra = xasprintf("\"nicks\":%s", nicks);
        push_simple_channel_action(app, event, extra);
        free(nicks); free(extra);
    } else if (strncmp(line, "/kick ", 6) == 0) {
        char *rest = line + 6;
        char *sp = strchr(rest, ' ');
        if (sp) *sp = 0;
        char *nick = json_escape(rest);
        char *reason = json_escape(sp ? sp + 1 : "");
        char *extra = xasprintf("\"nick\":\"%s\",\"reason\":\"%s\"", nick, reason);
        push_simple_channel_action(app, "kick", extra);
        free(nick); free(reason); free(extra);
    } else if (strncmp(line, "/ban ", 5) == 0 || strncmp(line, "/unban ", 7) == 0) {
        bool unban = strncmp(line, "/unban ", 7) == 0;
        char *mask = json_escape(line + (unban ? 7 : 5));
        char *extra = xasprintf("\"mask\":\"%s\"", mask);
        push_simple_channel_action(app, unban ? "unban" : "ban", extra);
        free(mask); free(extra);
    } else if (strcmp(line, "/banlist") == 0) {
        push_simple_channel_action(app, "banlist", NULL);
    } else if (strncmp(line, "/invite ", 8) == 0) {
        char *nick = json_escape(line + 8);
        char *extra = xasprintf("\"nick\":\"%s\"", nick);
        push_simple_channel_action(app, "invite", extra);
        free(nick); free(extra);
    } else if (strncmp(line, "/umode ", 7) == 0) {
        char *modes = json_escape(line + 7);
        char *payload = xasprintf("{\"network_id\":%d,\"modes\":\"%s\"}", current_network_id(app), modes);
        ws_push_user(app, "umode", payload);
        free(modes); free(payload);
    } else if (strncmp(line, "/mode ", 6) == 0) {
        log_line(app, "/mode is available through /quote MODE ... in this build");
    } else if (strncmp(line, "/watch ", 7) == 0 || strncmp(line, "/highlight ", 11) == 0) {
        char *rest = strchr(line + 1, ' ');
        char action[16] = "list";
        char pattern[MAX_LINE] = "";
        if (rest) sscanf(rest + 1, "%15s %1023[^\n]", action, pattern);
        char *pat = json_escape(pattern);
        char *payload = xasprintf("{\"action\":\"%s\",\"pattern\":\"%s\"}", action, pat);
        ws_push_user(app, "watchlist", payload);
        free(pat); free(payload);
    } else if (strncmp(line, "/window ", 8) == 0 || strncmp(line, "/win ", 5) == 0 || strncmp(line, "/w ", 3) == 0) {
        const char *arg = line[2] == 'w' && line[3] == ' ' ? line + 3 : (line[4] == ' ' ? line + 5 : line + 8);
        int n = atoi(arg);
        if (n > 0 && (size_t)n <= app->window_count) {
            app->current = (size_t)n - 1;
            clear_current_unread_locked(app);
            app->scrollback_offset = 0;
            app->scrollback_pinned = false;
            enqueue_fetch(app, app->windows[app->current].network, app->windows[app->current].channel);
        }
    } else {
        log_line(app, "unknown command; supported verbs include /join /part /msg /query /me /nick /away /whois /whowas /who /names /lusers /op /deop /voice /devoice /kick /ban /unban /banlist /invite /quote /oper /watch /disconnect /connect /window /quit");
    }
}

static void handle_enter(struct app *app) {
    app->input[app->input_len] = 0;
    if (app->input_len == 0) return;
    char line[MAX_LINE];
    snprintf(line, sizeof(line), "%s", app->input);
    add_history(app, line);
    app->input_len = 0;
    app->input[0] = 0;
    if (line[0] == '/') handle_command(app, line);
    else {
        const char *network = app->windows[app->current].network;
        const char *channel = app->windows[app->current].channel;
        add_pending_echo(app, network, channel, own_nick_for_network(app, network), line);
        enqueue_send(app, network, channel, line);
    }
}

/* Topmost recorded media region containing screen cell (x, y), or NULL.
 * Caller holds app->lock. */
static const struct link_region *region_at(struct app *app, int x, int y) {
    for (size_t i = 0; i < app->link_region_count; i++) {
        const struct link_region *r = &app->link_regions[i];
        if (y >= r->y0 && y <= r->y1 && x >= r->x0 && x <= r->x1) return r;
    }
    return NULL;
}

/* Map a mouse event to a media region: motion updates the hover hint, a left
 * button press over a region opens its preview. */
static void handle_mouse(struct app *app) {
    MEVENT ev;
    if (getmouse(&ev) != OK) return;
    bool click = ev.bstate & (BUTTON1_PRESSED | BUTTON1_CLICKED);

    pthread_mutex_lock(&app->lock);
    const struct link_region *r = region_at(app, ev.x, ev.y);
    char url[MAX_LINE];
    bool is_video = false;
    bool hit = r != NULL;
    if (r) {
        snprintf(url, sizeof(url), "%s", r->url);
        is_video = r->is_video;
        snprintf(app->hover_url, sizeof(app->hover_url), "%s", r->url);
    } else {
        app->hover_url[0] = 0;
    }
    pthread_mutex_unlock(&app->lock);

    if (click && hit) {
        preview_media(app, url, is_video);
        pthread_mutex_lock(&app->lock);
        app->hover_url[0] = 0;
        pthread_mutex_unlock(&app->lock);
    }
}

static void event_loop(struct app *app) {
    setlocale(LC_ALL, "");
    initscr();
    init_theme();
    cbreak();
    noecho();
    keypad(stdscr, TRUE);
    timeout(50);
    mousemask(ALL_MOUSE_EVENTS | REPORT_MOUSE_POSITION, NULL);
    mouseinterval(0);
    mouse_reporting(true);
    app->running = true;
    while (app->running) {
        ws_pump(app);
        draw(app);
        int ch = getch();
        if (ch == ERR) continue;
        if (ch == '\n' || ch == '\r') {
            handle_enter(app);
        } else if (ch == 27) {
            pthread_mutex_lock(&app->lock);
            app->panel = PANEL_CHAT;
            pthread_mutex_unlock(&app->lock);
        } else if (ch == KEY_MOUSE) {
            handle_mouse(app);
        } else if (ch == 14) {
            cycle_window(app, 1);
        } else if (ch == 16) {
            cycle_window(app, -1);
#ifdef KEY_CTAB
        } else if (ch == KEY_CTAB) {
            cycle_window(app, 1);
#endif
        } else if (ch == KEY_PPAGE) {
            scroll_chat(app, 10);
        } else if (ch == KEY_NPAGE) {
            scroll_chat(app, -10);
        } else if (ch == KEY_HOME) {
            scroll_chat(app, 1000000);
        } else if (ch == KEY_END) {
            scroll_bottom(app);
        } else if (ch == '\t' || ch == KEY_BTAB) {
            complete_input(app);
        } else if (ch == KEY_UP) {
            history_prev(app);
        } else if (ch == KEY_DOWN) {
            history_next(app);
        } else if (ch == KEY_BACKSPACE || ch == 127 || ch == 8) {
            if (app->input_len > 0) app->input[--app->input_len] = 0;
        } else if (isprint(ch) && app->input_len + 1 < sizeof(app->input)) {
            app->input[app->input_len++] = (char)ch;
            app->input[app->input_len] = 0;
        }
    }
    mouse_reporting(false);
    endwin();
}

int main(int argc, char **argv) {
    const char *mode = "auto";
    const char *login_override = NULL;
    int argi = 1;
    while (argi < argc && strncmp(argv[argi], "--", 2) == 0) {
        if (strcmp(argv[argi], "--user") == 0) mode = "user";
        else if (strcmp(argv[argi], "--visitor") == 0) mode = "visitor";
        else if (strcmp(argv[argi], "--auto") == 0) mode = "auto";
        else if (strcmp(argv[argi], "--login-email") == 0) {
            if (argi + 1 >= argc) {
                fprintf(stderr, "--login-email requires an email-like identifier\n");
                return 2;
            }
            mode = "user";
            login_override = argv[++argi];
        } else if (strncmp(argv[argi], "--login-email=", 14) == 0) {
            mode = "user";
            login_override = argv[argi] + 14;
        }
        else {
            fprintf(stderr, "unknown option: %s\n", argv[argi]);
            return 2;
        }
        argi++;
    }
    int expected = login_override ? 2 : 3;
    if (argc - argi != expected) {
        fprintf(stderr, "usage: %s [--auto|--user|--visitor] https://grappa.example.net IDENTIFIER PASSWORD\n", argv[0]);
        fprintf(stderr, "       %s --user --login-email user@example.net https://grappa.example.net PASSWORD\n", argv[0]);
        fprintf(stderr, "       --user turns plain account names into name@shottino.local for grappa registered-user login\n");
        fprintf(stderr, "       --login-email uses EMAIL as the grappa login identifier; IRC nick comes from grappa credentials\n");
        return 2;
    }

    startup("starting (%s mode)", mode);
    SSL_library_init();
    SSL_load_error_strings();
    struct app *app = calloc(1, sizeof(*app));
    if (!app) die("out of memory");
    pthread_mutex_init(&app->lock, NULL);
    pthread_mutex_init(&app->jobs_lock, NULL);
    pthread_cond_init(&app->jobs_cond, NULL);
    app->ws.fd = -1;
    startup("parsing server URL %s", argv[argi]);
    if (!parse_url(argv[argi], &app->url)) die("invalid base URL: %s", argv[argi]);
    startup("initializing TLS context");
    app->ssl_ctx = SSL_CTX_new(TLS_client_method());
    if (!app->ssl_ctx) die("failed to create TLS context");
    SSL_CTX_set_default_verify_paths(app->ssl_ctx);
    SSL_CTX_set_verify(app->ssl_ctx, SSL_VERIFY_PEER, NULL);

    const char *identifier = login_override ? login_override : argv[argi + 1];
    const char *password = login_override ? argv[argi + 1] : argv[argi + 2];
    if (!login_override && strchr(identifier, '@') == NULL) snprintf(app->login_nick, sizeof(app->login_nick), "%s", identifier);
    char *login_id = login_identifier_for_mode(mode, identifier);
    startup("authenticating as %s", login_id);
    if (!attach_or_login(app, login_id, password)) {
        free(login_id);
        pthread_cond_destroy(&app->jobs_cond);
        pthread_mutex_destroy(&app->jobs_lock);
        pthread_mutex_destroy(&app->lock);
        SSL_CTX_free(app->ssl_ctx);
        free(app);
        return 1;
    }
    startup("authenticated as %s", app->subject);
    free(login_id);
    startup("loading networks and channels");
    seed_state(app);
    startup("loading initial scrollback for %zu windows", app->window_count);
    for (size_t i = 0; i < app->window_count; i++) fetch_scrollback(app, &app->windows[i]);
    startup("connecting websocket");
    if (ws_connect(app)) {
        startup("joining websocket topics");
        ws_join_topics(app);
        log_line(app, "websocket connected");
    } else {
        startup("websocket unavailable; continuing with REST");
        log_line(app, "websocket unavailable; REST send/fetch still works");
    }
    startup("starting background worker");
    pthread_create(&app->worker, NULL, worker_main, app);
    startup("entering terminal UI");
    event_loop(app);
    pthread_mutex_lock(&app->jobs_lock);
    app->worker_stop = true;
    pthread_cond_signal(&app->jobs_cond);
    pthread_mutex_unlock(&app->jobs_lock);
    pthread_join(app->worker, NULL);
    if (app->ws_connected) conn_close(&app->ws);
    for (size_t i = 0; i < app->log_count; i++) free(app->log[i]);
    pthread_cond_destroy(&app->jobs_cond);
    pthread_mutex_destroy(&app->jobs_lock);
    pthread_mutex_destroy(&app->lock);
    SSL_CTX_free(app->ssl_ctx);
    free(app);
    return 0;
}
