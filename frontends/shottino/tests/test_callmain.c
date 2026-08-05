/* test_callmain — the helper's main loop, under the sanitizers at last.
 *
 * COMPILING IS NOT LINKING. `make call-compile` (#754) proves call/main.c
 * parses under -Werror; it says nothing about a use-after-free in
 * session_release or a bounds mistake in video_retile, and #759 was
 * exactly that class — fds closed with callback threads still live, plus
 * an out-of-bounds `shown[at]` — found by reading, because no sanitizer
 * could reach the file. Seven functions sat outside ASan/UBSan entirely:
 * session_negotiate, session_release, on_state, video_retile,
 * audio_retile, liveness_step and pump_main. This suite links them.
 *
 * HOW IT REACHES THEM. They are all `static`, so the file is compiled INTO
 * this one with `main` renamed away — the same device tests/test_layout.c
 * uses for shottino.c, and the only one that reaches a static function
 * without changing the shape of the code under test. libdatachannel is
 * replaced by tests/stub/rtc/rtc.h + tests/rtc_stub.c, so the gate stays
 * free of the opt-in vendored submodule exactly as test_whip,
 * test_callmedia and test_callnote do; the stub's declarations are checked
 * against the real header by `make call-compile`.
 *
 * WHAT MAKES THIS ABLE TO FAIL, which is the point of linking at all — a
 * test that calls a function and asserts nothing gives ASan a look inside,
 * but it is not evidence, and a sanitizer job nobody has ever seen go red
 * is a line of YAML. Six defects were introduced one at a time to find
 * out, and the mechanism that caught each one is not the one that would be
 * guessed:
 *
 *   - the four arrays liveness_step is handed are SEPARATE allocations
 *     here, exactly CALL_MAX_PEERS long. One index too far is an ASan
 *     heap-buffer-overflow. The per-peer arrays INSIDE `struct call` are
 *     not: an off-by-one there lands on the next member of the same
 *     allocation, so no redzone is touched — what catches those is UBSan's
 *     array-bounds on the declared type (`index 8 out of bounds for type
 *     'bool[8]'`), which is a different check with a different reach;
 *   - the rtc stub COPIES the bytes handed to rtcSendMessage for the
 *     length it is TOLD, so a pump that reports more than it read is an
 *     ASan global-buffer-overflow — but only if a packet gets near the
 *     buffer's edge, which is why one 2048-byte datagram is sent;
 *   - the rest is ordinary assertions, and deliberately so. The stub
 *     refuses to follow a peer-connection id it has already freed and
 *     COUNTS the attempt instead: it has to report the helper's mistake,
 *     not crash on it, so a release that forgets `s->pc = -1` fails a
 *     check rather than raising a use-after-free. Likewise freeing the
 *     WHIP answer before parsing it: whip_response_free NULLs the body, so
 *     that reordering loses the negotiated codec and fails a check with no
 *     sanitizer involved at all.
 */
#define main call_main_unused
#include "../call/main.c"
#undef main

#include "rtc_stub.h"
#include "test.h"

#include <ctype.h>
#include <fcntl.h>
#include <limits.h>
#include <netinet/in.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <time.h>

/* ── A call, on the heap ───────────────────────────────────────────────── */

/* The state each function under test is contracted to read, in the shape
 * main() gives it. On the heap deliberately: see the header comment. */
struct fixture {
    struct call *c;
    struct media_config cfg;
    int devnull;
};

static void fixture_start(struct fixture *f, bool video) {
    /* wait_until() and pump_main() both bail on it, and it is a file-scope
     * static: one test that ends a call would end every later one. */
    stop_requested = 0;
    rtc_stub_reset();

    memset(f, 0, sizeof(*f));
    f->cfg = (struct media_config){ .audio_source = "lavfi:anullsrc",
                                    .video_source = "lavfi:testsrc",
                                    .audio_sink = "null:-",
                                    .audio_payload_type = 111,
                                    .video_payload_type = 96,
                                    .audio_ssrc = 1,
                                    .video_ssrc = 2,
                                    .frame_w = 320,
                                    .frame_h = 240,
                                    .fps = 10,
                                    .capture_w = 640,
                                    .capture_h = 480,
                                    .capture_fps = 20,
                                    .video_kbps = 800,
                                    .video_codec = MEDIA_VIDEO_VP8,
                                    .want_video = video };

    struct call *c = calloc(1, sizeof(*c));
    if (!c) abort();
    pthread_mutex_init(&c->lock, NULL);
    pthread_cond_init(&c->cv, NULL);
    pthread_mutex_init(&c->vlock, NULL);
    c->pub.owner = c;
    c->pub.label = "publish";
    c->pub.pc = -1;
    c->pub.audio_track = c->pub.video_track = -1;
    c->pub.slot = -1;
    for (int i = 0; i < CALL_MAX_PEERS; i++) {
        c->sub[i].owner = c;
        c->sub[i].label = "subscribe";
        c->sub[i].pc = -1;
        c->sub[i].audio_track = c->sub[i].video_track = -1;
        c->sub[i].slot = i;
    }
    c->send_audio.fd = c->send_video.fd = -1;
    c->send_audio.pid = c->send_video.pid = -1;
    c->vmix.pid = c->amix.pid = -1;
    for (int i = 0; i < MEDIA_MAX_PEERS; i++) {
        c->amix.legs[i].fd = c->amix.legs[i].pid = -1;
        c->vmix.legs[i].fd = c->vmix.legs[i].pid = -1;
        c->vmix.legs[i].codec = f->cfg.video_codec;
        c->vmix.legs[i].payload_type = f->cfg.video_payload_type;
    }
    c->want_video = video;
    c->speaker = -1;
    /* main() hands the decoder its own stdout. Here that is the test
     * runner's, and a decoder writing rgb24 into it would be noise. */
    f->devnull = open("/dev/null", O_WRONLY);
    c->frame_fd = f->devnull;
    c->cfg = &f->cfg;
    f->c = c;
}

static void fixture_stop(struct fixture *f) {
    stop_requested = 1;
    media_mix_free(&f->c->amix);
    media_mix_free(&f->c->vmix);
    media_stop(&f->c->send_audio);
    media_stop(&f->c->send_video);
    for (int i = 0; i < CALL_MAX_PEERS; i++)
        if (f->c->sub[i].pc >= 0) rtcDeletePeerConnection(f->c->sub[i].pc);
    if (f->c->pub.pc >= 0) rtcDeletePeerConnection(f->c->pub.pc);
    pthread_mutex_destroy(&f->c->lock);
    pthread_mutex_destroy(&f->c->vlock);
    pthread_cond_destroy(&f->c->cv);
    if (f->devnull >= 0) close(f->devnull);
    free(f->c);
    f->c = NULL;
    rtc_stub_reset();
    stop_requested = 0;
}

/* ── A PATH holding exactly one ffmpeg, or none ────────────────────────── */

/* The same device tests/test_callmedia.c uses, for the same reason: the
 * suite decides the outcome, never the machine it happens to run on. Local
 * to this file rather than shared with that one because the lifetime
 * differs — every start here spawns a child, so the two directories are
 * made once and reused instead of one mkdtemp per call. */
static char path_with[64], path_without[64], path_saved[4096];

static bool fake_ffmpeg_setup(void) {
    snprintf(path_with, sizeof(path_with), "/tmp/shottino-callmain-yes-XXXXXX");
    snprintf(path_without, sizeof(path_without), "/tmp/shottino-callmain-no-XXXXXX");
    if (!mkdtemp(path_with) || !mkdtemp(path_without)) return false;
    char script[128];
    snprintf(script, sizeof(script), "%s/ffmpeg", path_with);
    FILE *fh = fopen(script, "w");
    if (!fh) return false;
    /* Anything that execs and STAYS UP: the spawn contract is what is
     * under test, not ffmpeg's behaviour. The inner PATH is not decoration
     * — this runs with PATH pointing at this directory alone. */
    fputs("#!/bin/sh\nPATH=/usr/bin:/bin\nexec sleep 30\n", fh);
    fclose(fh);
    if (chmod(script, 0755) != 0) return false;
    snprintf(path_saved, sizeof(path_saved), "%s", getenv("PATH") ? getenv("PATH") : "");
    return true;
}

static void fake_ffmpeg_teardown(void) {
    char cmd[256];
    setenv("PATH", path_saved, 1);
    snprintf(cmd, sizeof(cmd), "rm -rf '%s' '%s'", path_with, path_without);
    if (system(cmd) != 0) fprintf(stderr, "warning: fake ffmpeg dirs not removed\n");
}

static void ffmpeg_available(bool yes) { setenv("PATH", yes ? path_with : path_without, 1); }

/* ── A WHIP endpoint on loopback ───────────────────────────────────────── */

#define SFU_MAX_EXCHANGES 6

struct sfu {
    int listen_fd;
    int port;
    pthread_t thread;
    bool started;
    pthread_mutex_t lock;
    bool stop;
    char reply[SFU_MAX_EXCHANGES][2048];
    int replies;
    char request[SFU_MAX_EXCHANGES][8192];
    int requests;
};

/* strcasestr is a GNU extension and this file compiles without the feature
 * macros that would bring it in. The needle is one we own. */
static const char *header_find(const char *hay, const char *needle) {
    size_t n = strlen(needle);
    for (const char *p = hay; *p; p++) {
        size_t i = 0;
        while (i < n && p[i] && tolower((unsigned char)p[i]) == tolower((unsigned char)needle[i]))
            i++;
        if (i == n) return p;
    }
    return NULL;
}

/* Read one whole HTTP request: headers, then Content-Length bytes of body.
 * Bounded on every axis — this runs inside `make check`, and a server that
 * can block forever is a suite that hangs instead of failing. */
static void sfu_read_request(int fd, char *out, size_t out_sz) {
    size_t at = 0, want = 0;
    bool have_head = false;
    for (int spin = 0; spin < 256 && at + 1 < out_sz; spin++) {
        struct pollfd p = { .fd = fd, .events = POLLIN, .revents = 0 };
        if (poll(&p, 1, 500) <= 0) break;
        ssize_t got = recv(fd, out + at, out_sz - at - 1, 0);
        if (got <= 0) break;
        at += (size_t)got;
        out[at] = 0;
        if (!have_head) {
            const char *end = strstr(out, "\r\n\r\n");
            if (!end) continue;
            have_head = true;
            const char *cl = header_find(out, "content-length:");
            want = (size_t)(end + 4 - out) + (cl ? (size_t)atol(cl + 15) : 0);
        }
        if (have_head && at >= want) break;
    }
}

static void *sfu_main(void *arg) {
    struct sfu *s = arg;
    for (;;) {
        pthread_mutex_lock(&s->lock);
        bool stop = s->stop;
        pthread_mutex_unlock(&s->lock);
        if (stop) return NULL;

        struct pollfd p = { .fd = s->listen_fd, .events = POLLIN, .revents = 0 };
        if (poll(&p, 1, 50) <= 0) continue;
        int fd = accept(s->listen_fd, NULL, NULL);
        if (fd < 0) continue;

        char req[8192];
        req[0] = 0;
        sfu_read_request(fd, req, sizeof(req));

        pthread_mutex_lock(&s->lock);
        int n = s->requests;
        if (n < SFU_MAX_EXCHANGES) {
            snprintf(s->request[n], sizeof(s->request[n]), "%s", req);
            s->requests = n + 1;
        }
        /* The last scripted reply REPEATS: a test that scripts one answer
         * should not have to know how many requests the client makes. */
        int which = n < s->replies ? n : (s->replies > 0 ? s->replies - 1 : -1);
        char reply[2048];
        snprintf(reply, sizeof(reply), "%s", which >= 0 ? s->reply[which] : "");
        pthread_mutex_unlock(&s->lock);

        size_t len = strlen(reply), sent = 0;
        while (sent < len) {
            ssize_t w = send(fd, reply + sent, len - sent, 0);
            if (w <= 0) break;
            sent += (size_t)w;
        }
        shutdown(fd, SHUT_RDWR);
        close(fd);
    }
}

static bool sfu_start(struct sfu *s) {
    memset(s, 0, sizeof(*s));
    pthread_mutex_init(&s->lock, NULL);
    s->listen_fd = socket(AF_INET, SOCK_STREAM, 0);
    if (s->listen_fd < 0) return false;
    int one = 1;
    setsockopt(s->listen_fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (bind(s->listen_fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) return false;
    socklen_t len = sizeof(addr);
    if (getsockname(s->listen_fd, (struct sockaddr *)&addr, &len) != 0) return false;
    s->port = ntohs(addr.sin_port);
    if (listen(s->listen_fd, 4) != 0) return false;
    s->started = pthread_create(&s->thread, NULL, sfu_main, s) == 0;
    return s->started;
}

static void sfu_script(struct sfu *s, const char *reply) {
    pthread_mutex_lock(&s->lock);
    if (s->replies < SFU_MAX_EXCHANGES)
        snprintf(s->reply[s->replies], sizeof(s->reply[s->replies]), "%s", reply);
    s->replies++;
    pthread_mutex_unlock(&s->lock);
}

static int sfu_requests(struct sfu *s) {
    pthread_mutex_lock(&s->lock);
    int n = s->requests;
    pthread_mutex_unlock(&s->lock);
    return n;
}

static void sfu_request(struct sfu *s, int i, char *out, size_t out_sz) {
    pthread_mutex_lock(&s->lock);
    snprintf(out, out_sz, "%s", i >= 0 && i < s->requests ? s->request[i] : "");
    pthread_mutex_unlock(&s->lock);
}

static void sfu_stop(struct sfu *s) {
    pthread_mutex_lock(&s->lock);
    s->stop = true;
    pthread_mutex_unlock(&s->lock);
    if (s->started) pthread_join(s->thread, NULL);
    close(s->listen_fd);
    pthread_mutex_destroy(&s->lock);
}

/* An SDP answer naming one video codec, so the negotiated payload type has
 * something real to be read out of. */
#define SFU_ANSWER_VP8                                                                             \
    "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n"                                          \
    "m=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\n"                             \
    "m=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 VP8/90000\r\n"

static void sfu_script_created(struct sfu *s, const char *location, const char *answer) {
    char reply[2048];
    snprintf(reply, sizeof(reply),
             "HTTP/1.1 201 Created\r\nLocation: %s\r\nContent-Type: application/sdp\r\n"
             "Content-Length: %zu\r\nConnection: close\r\n\r\n%s",
             location, strlen(answer), answer);
    sfu_script(s, reply);
}

static void sfu_script_status(struct sfu *s, int status, const char *text) {
    char reply[2048];
    snprintf(reply, sizeof(reply),
             "HTTP/1.1 %d %s\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", status, text);
    sfu_script(s, reply);
}

static void sfu_url(const struct sfu *s, const char *path, char *out, size_t out_sz) {
    snprintf(out, out_sz, "http://127.0.0.1:%d%s", s->port, path);
}

/* ── Bounded waiting ───────────────────────────────────────────────────── */

/* Poll a condition rather than sleep a guess: a fixed sleep is either a
 * slow suite or a flaky one, and usually both. */
static bool wait_for(bool (*done)(void *), void *ctx, int ms) {
    for (int waited = 0; waited < ms; waited += 5) {
        if (done(ctx)) return true;
        struct timespec tick = { .tv_sec = 0, .tv_nsec = 5 * 1000 * 1000 };
        nanosleep(&tick, NULL);
    }
    return done(ctx);
}

/* ── liveness_step ─────────────────────────────────────────────────────── */

/* Membership is measured from arriving packets, and the asymmetry is the
 * design: a peer is live on the FIRST packet and dead only after several
 * quiet ticks, because a re-tile every jittery second is worse than a
 * stale tile.
 *
 * The four arrays are exactly CALL_MAX_PEERS long and on the heap, so a
 * loop that runs one index too far is a heap-buffer-overflow here rather
 * than a silent write into whatever follows. */
TEST(liveness_is_immediate_on_the_way_in_and_patient_on_the_way_out) {
    _Atomic unsigned long *pkts = calloc(CALL_MAX_PEERS, sizeof(*pkts));
    unsigned long *seen = calloc(CALL_MAX_PEERS, sizeof(*seen));
    int *misses = calloc(CALL_MAX_PEERS, sizeof(*misses));
    bool *live = calloc(CALL_MAX_PEERS, sizeof(*live));
    if (!pkts || !seen || !misses || !live) abort();

    /* Nothing has ever arrived: no change, and nobody is live. */
    CHECK(!liveness_step(pkts, seen, misses, live));
    for (int i = 0; i < CALL_MAX_PEERS; i++) CHECK(!live[i]);

    /* One packet from one peer promotes THAT peer, on the first tick. */
    pkts[2] = 1;
    CHECK(liveness_step(pkts, seen, misses, live));
    CHECK(live[2]);
    CHECK(!live[1]);
    CHECK(!live[3]);

    /* Quiet ticks below the threshold do not demote and report nothing:
     * an event per tick is the noise this counter exists to avoid. */
    for (int t = 1; t < CALL_TILE_MISSES; t++) {
        CHECK(!liveness_step(pkts, seen, misses, live));
        CHECK(live[2]);
    }
    /* The threshold tick demotes, once. */
    CHECK(liveness_step(pkts, seen, misses, live));
    CHECK(!live[2]);
    CHECK(!liveness_step(pkts, seen, misses, live));

    /* Movement is a CHANGED counter, not a bigger one — the packet count
     * is unsigned and wraps, and a peer whose counter wrapped is sending. */
    pkts[2] = ULONG_MAX;
    CHECK(liveness_step(pkts, seen, misses, live));
    CHECK(live[2]);
    pkts[2] = 0;                                        /* wrapped */
    CHECK(!liveness_step(pkts, seen, misses, live));    /* still live, no event */
    CHECK(live[2]);

    /* The last peer counts, which is the index a loop bound gets wrong. */
    pkts[CALL_MAX_PEERS - 1] = 7;
    CHECK(liveness_step(pkts, seen, misses, live));
    CHECK(live[CALL_MAX_PEERS - 1]);

    free(pkts);
    free(seen);
    free(misses);
    free(live);
}

/* ── on_state ──────────────────────────────────────────────────────────── */

TEST(a_state_change_is_recorded_and_named_once_per_peer) {
    struct fixture f;
    fixture_start(&f, false);
    char got[4096];

    test_capture_stderr_start();
    on_state(0, RTC_CONNECTED, &f.c->pub);
    test_capture_stderr_end(got, sizeof(got));
    CHECK_LONG(f.c->pub.state, RTC_CONNECTED);
    CHECK_STR(got, "{\"event\":\"state\",\"value\":\"publish connected\"}\n");

    test_capture_stderr_start();
    on_state(0, RTC_FAILED, &f.c->sub[3]);
    test_capture_stderr_end(got, sizeof(got));
    CHECK_LONG(f.c->sub[3].state, RTC_FAILED);
    CHECK_STR(got, "{\"event\":\"state\",\"value\":\"subscribe failed\"}\n");

    /* A peer we already know is absent walks connecting -> closed on every
     * retry. Saying so each time is how a working call looks like a
     * failing one — so the state is still RECORDED and nothing is said. */
    f.c->sub[3].absent = true;
    test_capture_stderr_start();
    on_state(0, RTC_CONNECTING, &f.c->sub[3]);
    on_state(0, RTC_CLOSED, &f.c->sub[3]);
    test_capture_stderr_end(got, sizeof(got));
    CHECK_LONG(f.c->sub[3].state, RTC_CLOSED);
    CHECK_STR(got, "");

    /* A state outside the table names nothing. The name array is indexed
     * by the value the library hands over, so that bound is the difference
     * between an unknown state and a read off the end of the table. */
    f.c->sub[3].absent = false;
    test_capture_stderr_start();
    on_state(0, (rtcState)99, &f.c->sub[3]);
    test_capture_stderr_end(got, sizeof(got));
    CHECK_LONG(f.c->sub[3].state, 99);
    CHECK_STR(got, "");

    fixture_stop(&f);
}

/* The library's own diagnostics belong on stderr as comments: given no
 * callback libdatachannel logs to STDOUT, which here is the rgb24 frame
 * stream, so one warning writes text into the middle of a picture. */
TEST(the_library_log_is_routed_into_the_comment_stream) {
    struct fixture f;
    fixture_start(&f, false);
    char got[4096];
    note_set_verbose(true);
    rtcInitLogger(RTC_LOG_WARNING, on_rtc_log);

    test_capture_stderr_start();
    bool routed = rtc_stub_log(RTC_LOG_WARNING, "Track is not open");
    test_capture_stderr_end(got, sizeof(got));
    CHECK(routed);
    CHECK_STR(got, "# libdatachannel: Track is not open\n");

    /* A NULL message is what the C API allows: printed as an empty note,
     * never dereferenced. */
    test_capture_stderr_start();
    routed = rtc_stub_log(RTC_LOG_ERROR, NULL);
    test_capture_stderr_end(got, sizeof(got));
    CHECK(routed);
    CHECK_STR(got, "# libdatachannel: \n");

    note_set_verbose(false);
    fixture_stop(&f);
}

/* ── video_retile / audio_retile ───────────────────────────────────────── */

/* The composited picture is rebuilt from who is SENDING, and the grid it
 * built is PUBLISHED — the other end samples cells out of one byte pipe,
 * so without the rectangles it cannot tell whose face is where. */
TEST(video_retile_publishes_the_grid_it_actually_composited) {
    struct fixture f;
    fixture_start(&f, true);
    ffmpeg_available(true);
    char got[8192];

    f.c->vlive[1] = true;
    f.c->vlive[4] = true;
    test_capture_stderr_start();
    video_retile(f.c);
    test_capture_stderr_end(got, sizeof(got));

    CHECK_LONG(f.c->vmix.tile_count, 2);
    CHECK(f.c->vmix.pid > 0);
    /* The legs of the peers being drawn were given ports, and the RTP
     * callback writes to those — a tile with no leg is a black cell. */
    CHECK(f.c->vmix.legs[1].peer_port > 0);
    CHECK(f.c->vmix.legs[4].peer_port > 0);
    CHECK_LONG(f.c->vmix.legs[7].peer_port, 0);

    /* The published value IS the grid that was composited, taken from the
     * helper's own formatter. The buffer is the size the helper uses, so a
     * grid this test accepts is one the helper could have published. */
    char expect[64 + CALL_MAX_PEERS * 32];
    bool described = media_tiles_describe(f.c->vmix.tiles, f.c->vmix.tile_count, f.cfg.frame_w,
                                          f.cfg.frame_h, expect, sizeof(expect));
    CHECK(described);
    char line[1024];
    snprintf(line, sizeof(line), "{\"event\":\"tiles\",\"value\":\"%s\"}\n", expect);
    CHECK_STR(got, line);
    /* Both peers are named in it, so "the grid" is not an empty string
     * that happens to round-trip. */
    CHECK(strstr(expect, ";1,") != NULL);
    CHECK(strstr(expect, ";4,") != NULL);

    /* Nobody sending stops the decoder rather than leaving it running on
     * inputs that produce nothing — that is what makes an audio-only
     * participant cost nothing — and publishes an EMPTY grid. */
    f.c->vlive[1] = f.c->vlive[4] = false;
    test_capture_stderr_start();
    video_retile(f.c);
    test_capture_stderr_end(got, sizeof(got));
    CHECK_LONG(f.c->vmix.tile_count, 0);
    CHECK_LONG(f.c->vmix.pid, -1);
    CHECK_STR(got, "{\"event\":\"tiles\",\"value\":\"\"}\n");

    fixture_stop(&f);
}

/* The cap is REPORTED, not silently applied: a peer in the call and not on
 * screen gets the same honest degradation as one with the camera off,
 * rather than a grid that reads as "everyone is here". */
TEST(video_retile_reports_the_pictures_it_had_no_room_for) {
    struct fixture f;
    fixture_start(&f, true);
    ffmpeg_available(true);
    note_set_verbose(true);
    char got[8192];

    for (int i = 0; i < CALL_TILE_MAX + 2; i++) f.c->vlive[i] = true;
    test_capture_stderr_start();
    video_retile(f.c);
    test_capture_stderr_end(got, sizeof(got));

    CHECK_LONG(f.c->vmix.tile_count, CALL_TILE_MAX);
    char expect[128];
    snprintf(expect, sizeof(expect), "# video: %d of %d pictures shown", CALL_TILE_MAX,
             CALL_TILE_MAX + 2);
    CHECK(strstr(got, expect) != NULL);

    note_set_verbose(false);
    fixture_stop(&f);
}

/* A decoder that will not start is an error the user can act on. It used
 * to be unreachable code — a fork that succeeds says nothing about the
 * exec that follows it. */
TEST(video_retile_says_so_when_the_decoder_cannot_start) {
    struct fixture f;
    fixture_start(&f, true);
    ffmpeg_available(false);
    char got[8192];

    f.c->vlive[0] = true;
    test_capture_stderr_start();
    video_retile(f.c);
    test_capture_stderr_end(got, sizeof(got));
    CHECK_LONG(f.c->vmix.pid, -1);
    CHECK_STR(got, "{\"event\":\"error\",\"message\":\"cannot start video decoding\"}\n");
    fixture_stop(&f);

    /* An audio-only call composites nothing, whatever is live. */
    fixture_start(&f, false);
    ffmpeg_available(true);
    f.c->vlive[0] = true;
    test_capture_stderr_start();
    video_retile(f.c);
    test_capture_stderr_end(got, sizeof(got));
    CHECK_LONG(f.c->vmix.pid, -1);
    CHECK_STR(got, "");
    fixture_stop(&f);
}

/* One decoder for every voice, rebuilt over whoever is actually there: an
 * amix fixed at connect time leaves a late joiner audible to nobody. */
TEST(audio_retile_mixes_whoever_is_there_and_stops_when_nobody_is) {
    struct fixture f;
    fixture_start(&f, false);
    ffmpeg_available(true);
    note_set_verbose(true);
    char got[8192];

    f.c->alive[0] = true;
    f.c->alive[5] = true;
    test_capture_stderr_start();
    audio_retile(f.c);
    test_capture_stderr_end(got, sizeof(got));
    CHECK(f.c->amix.pid > 0);
    CHECK(f.c->amix.legs[0].peer_port > 0);
    CHECK(f.c->amix.legs[5].peer_port > 0);
    CHECK(strstr(got, "# audio: mixing 2 voices\n") != NULL);

    /* One voice is not "1 voices". */
    f.c->alive[5] = false;
    test_capture_stderr_start();
    audio_retile(f.c);
    test_capture_stderr_end(got, sizeof(got));
    CHECK(strstr(got, "# audio: mixing 1 voice\n") != NULL);

    /* Nobody left: the decoder stops and says nothing. */
    f.c->alive[0] = false;
    test_capture_stderr_start();
    audio_retile(f.c);
    test_capture_stderr_end(got, sizeof(got));
    CHECK_LONG(f.c->amix.pid, -1);
    CHECK_STR(got, "");

    note_set_verbose(false);
    fixture_stop(&f);
}

TEST(audio_retile_says_so_when_playback_cannot_start) {
    struct fixture f;
    fixture_start(&f, false);
    ffmpeg_available(false);
    char got[8192];

    f.c->alive[2] = true;
    test_capture_stderr_start();
    audio_retile(f.c);
    test_capture_stderr_end(got, sizeof(got));
    CHECK_LONG(f.c->amix.pid, -1);
    CHECK(strstr(got, "cannot start audio playback") != NULL);

    fixture_stop(&f);
}

/* ── the RTP callbacks ─────────────────────────────────────────────────── */

/* Driven through the callback the helper REGISTERED, not called directly:
 * a callback wired to the wrong track is the bug a direct call cannot see.
 * Every subscriber has its own legs — N people are N streams, and one
 * decoder fed from several would be a blender. */
TEST(an_arriving_packet_is_counted_against_the_peer_that_sent_it) {
    struct fixture f;
    fixture_start(&f, true);

    int pc = rtcCreatePeerConnection(NULL);
    CHECK(pc > 0);
    f.c->sub[2].pc = pc;
    rtcSetUserPointer(pc, &f.c->sub[2]);

    rtcTrackInit init;
    memset(&init, 0, sizeof(init));
    init.direction = RTC_DIRECTION_RECVONLY;
    int audio = rtcAddTrackEx(pc, &init);
    int video = rtcAddTrackEx(pc, &init);
    CHECK(audio > 0 && video > 0);
    rtcSetUserPointer(audio, &f.c->sub[2]);
    rtcSetUserPointer(video, &f.c->sub[2]);
    CHECK_LONG(rtcSetMessageCallback(audio, on_audio_rtp), RTC_ERR_SUCCESS);
    CHECK_LONG(rtcSetMessageCallback(video, on_video_rtp), RTC_ERR_SUCCESS);

    char rtp[200];
    memset(rtp, 0x5a, sizeof(rtp));
    CHECK(rtc_stub_deliver(audio, rtp, (int)sizeof(rtp)));
    CHECK(rtc_stub_deliver(video, rtp, (int)sizeof(rtp)));
    CHECK(rtc_stub_deliver(video, rtp, 40));

    CHECK_LONG(f.c->apkts[2], 1);
    CHECK_LONG(f.c->abytes[2], sizeof(rtp));
    CHECK_LONG(f.c->vpkts[2], 2);
    /* Nobody else moved: the slot is what routes a packet. */
    for (int i = 0; i < CALL_MAX_PEERS; i++) {
        if (i == 2) continue;
        CHECK_LONG(f.c->apkts[i], 0);
        CHECK_LONG(f.c->vpkts[i], 0);
    }

    /* An empty or negative length counts for nothing — a size taken from
     * a negative int is how a length check becomes a huge read. */
    CHECK(rtc_stub_deliver(audio, rtp, 0));
    CHECK(rtc_stub_deliver(audio, rtp, -1));
    CHECK(rtc_stub_deliver(video, rtp, -1));
    CHECK_LONG(f.c->apkts[2], 1);
    CHECK_LONG(f.c->vpkts[2], 2);

    fixture_stop(&f);
}

/* ── pump_main ─────────────────────────────────────────────────────────── */

struct pump_ctx {
    int track;
    int want;
};

static bool pump_saw(void *ctx) {
    struct pump_ctx *p = ctx;
    return rtc_stub_sent_count(p->track) >= p->want;
}

/* Has the pump taken everything off both capture sockets? The kernel's own
 * answer, which is the only one that does not involve guessing a duration. */
static bool sockets_drained(void *ctx) {
    const int *fds = ctx;
    for (int i = 0; i < 2; i++) {
        int pending = 0;
        if (ioctl(fds[i], FIONREAD, &pending) != 0 || pending != 0) return false;
    }
    return true;
}

/* Whatever the capture ffmpeg packetised goes onto the publishing track,
 * and the socket is DRAINED per wakeup rather than read once: ffmpeg emits
 * a video frame as a burst, and one-per-poll delivers a fraction of each
 * frame with no keyframe ever completing. */
TEST(the_pump_forwards_the_capture_and_drops_what_is_muted) {
    struct fixture f;
    fixture_start(&f, true);

    int pc = rtcCreatePeerConnection(NULL);
    f.c->pub.pc = pc;
    rtcSetUserPointer(pc, &f.c->pub);
    rtcTrackInit init;
    memset(&init, 0, sizeof(init));
    init.direction = RTC_DIRECTION_SENDONLY;
    f.c->pub.audio_track = rtcAddTrackEx(pc, &init);
    f.c->pub.video_track = rtcAddTrackEx(pc, &init);
    CHECK(f.c->pub.audio_track > 0 && f.c->pub.video_track > 0);

    /* The loopback sockets the capture legs own, and a sender playing the
     * part of ffmpeg. */
    int aport = 0, vport = 0;
    f.c->send_audio.fd = media_bind_loopback(&aport);
    f.c->send_video.fd = media_bind_loopback(&vport);
    CHECK(f.c->send_audio.fd >= 0 && f.c->send_video.fd >= 0);
    int tx = socket(AF_INET, SOCK_DGRAM, 0);
    CHECK(tx >= 0);
    struct sockaddr_in to;
    memset(&to, 0, sizeof(to));
    to.sin_family = AF_INET;
    to.sin_addr.s_addr = htonl(INADDR_LOOPBACK);

    /* A self-view leg: the same encoded frame on its way out, handed to a
     * decoder on loopback — one capture, one encode, two destinations. */
    int self_port = 0;
    int self_sink = media_bind_loopback(&self_port);
    CHECK(self_sink >= 0);
    f.c->vmix.legs[CALL_SELF_SLOT].fd = socket(AF_INET, SOCK_DGRAM, 0);
    f.c->vmix.legs[CALL_SELF_SLOT].peer_port = self_port;

    pthread_t pump;
    CHECK_LONG(pthread_create(&pump, NULL, pump_main, f.c), 0);

    char packet[1400];
    memset(packet, 0x2b, sizeof(packet));
    packet[0] = (char)0x80;
    to.sin_port = htons((uint16_t)aport);
    for (int i = 0; i < 3; i++)
        CHECK(sendto(tx, packet, sizeof(packet), 0, (struct sockaddr *)&to, sizeof(to)) ==
              (ssize_t)sizeof(packet));

    struct pump_ctx ctx = { .track = f.c->pub.audio_track, .want = 3 };
    CHECK(wait_for(pump_saw, &ctx, 5000));
    int size = 0;
    const char *sent = rtc_stub_last_sent(f.c->pub.audio_track, &size);
    CHECK_LONG(size, sizeof(packet));
    CHECK(sent && memcmp(sent, packet, sizeof(packet)) == 0);

    /* A packet that fills the pump's buffer to the edge arrives WHOLE. The
     * buffer is MTU-bounded on purpose and the length travels separately
     * from it, so this is where a length that outruns the bytes shows. */
    char big[2048];
    memset(big, 0x11, sizeof(big));
    CHECK(sendto(tx, big, sizeof(big), 0, (struct sockaddr *)&to, sizeof(to)) ==
          (ssize_t)sizeof(big));
    ctx.want = 4;
    CHECK(wait_for(pump_saw, &ctx, 5000));
    sent = rtc_stub_last_sent(f.c->pub.audio_track, &size);
    CHECK_LONG(size, sizeof(big));
    CHECK(sent && memcmp(sent, big, sizeof(big)) == 0);

    /* Video goes to the video track AND to the self tile, which joins the
     * grid through the same liveness path as everybody else. */
    to.sin_port = htons((uint16_t)vport);
    CHECK(sendto(tx, packet, 120, 0, (struct sockaddr *)&to, sizeof(to)) == 120);
    ctx.track = f.c->pub.video_track;
    ctx.want = 1;
    CHECK(wait_for(pump_saw, &ctx, 5000));
    rtc_stub_last_sent(f.c->pub.video_track, &size);
    CHECK_LONG(size, 120);
    CHECK_LONG(f.c->vpkts[CALL_SELF_SLOT], 1);
    char echo[2048];
    CHECK(recv(self_sink, echo, sizeof(echo), MSG_DONTWAIT) == 120);

    /* Mute is LOCAL and instant: the socket is still DRAINED — a muted
     * minute would otherwise burst on unmute — and nothing is sent.
     *
     * Both halves are observed rather than waited out. The drain is read
     * off the socket itself (FIONREAD reaching zero means the pump has
     * taken every muted datagram), which makes "nothing was forwarded" an
     * assertion about a KNOWN state instead of about a sleep that was
     * hopefully long enough. Unmuting only afterwards is what keeps the
     * marker below from racing the batch. */
    f.c->muted = true;
    f.c->camera_off = true;
    to.sin_port = htons((uint16_t)aport);
    for (int i = 0; i < 4; i++)
        CHECK(sendto(tx, packet, 64, 0, (struct sockaddr *)&to, sizeof(to)) == 64);
    to.sin_port = htons((uint16_t)vport);
    for (int i = 0; i < 4; i++)
        CHECK(sendto(tx, packet, 64, 0, (struct sockaddr *)&to, sizeof(to)) == 64);

    int capture_fds[2] = { f.c->send_audio.fd, f.c->send_video.fd };
    CHECK(wait_for(sockets_drained, capture_fds, 5000));
    CHECK_LONG(rtc_stub_sent_count(f.c->pub.audio_track), 4);
    /* The camera is off too, so the far end and the self tile went dark
     * together — which is the point of dropping at the track rather than
     * at the capture. */
    CHECK_LONG(rtc_stub_sent_count(f.c->pub.video_track), 1);
    CHECK_LONG(f.c->vpkts[CALL_SELF_SLOT], 1);
    CHECK(recv(self_sink, echo, sizeof(echo), MSG_DONTWAIT) < 0);

    /* Unmuting is instant and does NOT replay the minute that was muted. */
    f.c->muted = false;
    to.sin_port = htons((uint16_t)aport);
    CHECK(sendto(tx, packet, 32, 0, (struct sockaddr *)&to, sizeof(to)) == 32);
    ctx.track = f.c->pub.audio_track;
    ctx.want = 5;
    CHECK(wait_for(pump_saw, &ctx, 5000));
    CHECK_LONG(rtc_stub_sent_count(f.c->pub.audio_track), 5);
    rtc_stub_last_sent(f.c->pub.audio_track, &size);
    CHECK_LONG(size, 32);

    stop_requested = 1;
    pthread_join(pump, NULL);
    close(tx);
    close(self_sink);
    fixture_stop(&f);
}

/* With no capture leg there is nothing to poll, and the thread must END
 * rather than spin: it is joined on every teardown. */
TEST(the_pump_returns_when_there_is_nothing_to_pump) {
    struct fixture f;
    fixture_start(&f, false);
    pthread_t pump;
    CHECK_LONG(pthread_create(&pump, NULL, pump_main, f.c), 0);
    CHECK_LONG(pthread_join(pump, NULL), 0);
    fixture_stop(&f);
}

/* ── session_negotiate ─────────────────────────────────────────────────── */

TEST(a_publish_posts_its_offer_and_encodes_what_the_answer_chose) {
    struct fixture f;
    fixture_start(&f, true);
    struct sfu s;
    CHECK(sfu_start(&s));
    sfu_script_created(&s, "/session/7", SFU_ANSWER_VP8);
    rtc_stub_set_offer(
        "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\na=candidate:1 1 udp 1 127.0.0.1 1 typ host\r\n");

    char url[256];
    sfu_url(&s, "/room/whip", url, sizeof(url));
    CHECK(session_negotiate(&f.c->pub, url, RTC_DIRECTION_SENDONLY, true, &f.cfg, NULL, 2000));

    /* The session is up and knows how to hang itself up. */
    CHECK(f.c->pub.active);
    CHECK(f.c->pub.pc > 0);
    CHECK(f.c->pub.have_resource);
    char expect_resource[256];
    snprintf(expect_resource, sizeof(expect_resource), "http://127.0.0.1:%d/session/7", s.port);
    CHECK_STR(f.c->pub.resource, expect_resource);

    /* The request that actually went out, and the gathered offer in it:
     * WHIP is one POST with one body, so a candidate that arrived late
     * would have nowhere to go. */
    CHECK_LONG(sfu_requests(&s), 1);
    char req[8192];
    sfu_request(&s, 0, req, sizeof(req));
    CHECK(strncmp(req, "POST /room/whip HTTP/1.1\r\n", 26) == 0);
    CHECK(strstr(req, "Content-Type: application/sdp\r\n") != NULL);
    CHECK(strstr(req, "a=candidate:1 1 udp 1 127.0.0.1 1 typ host") != NULL);

    /* The answer reached the peer connection whole. */
    CHECK_STR(rtc_stub_remote_description(f.c->pub.pc), SFU_ANSWER_VP8);

    /* A PUBLISHER must ENCODE what the far end chose. Offering both and
     * then encoding the configured preference is a call that arrives
     * one-way, with every subscriber seeing a tile that never paints and
     * no error anywhere. */
    CHECK(f.c->pub.negotiated);
    CHECK_LONG(f.c->pub.neg_codec, MEDIA_VIDEO_VP8);
    CHECK_LONG(f.c->pub.neg_pt, 96);

    /* The tracks it offered, carrying the values declared once in the
     * config — a second copy of "Opus is 111" is a second place for it to
     * stop being true. */
    struct rtc_stub_track t;
    CHECK(rtc_stub_track(f.c->pub.audio_track, &t));
    CHECK_LONG(t.direction, RTC_DIRECTION_SENDONLY);
    CHECK_LONG(t.codec, RTC_CODEC_OPUS);
    CHECK_LONG(t.payload_type, f.cfg.audio_payload_type);
    CHECK_STR(t.mid, "audio");
    /* SENDING is a choice, so the publisher offers ONE video codec. */
    CHECK(rtc_stub_track(f.c->pub.video_track, &t));
    CHECK(!t.from_sdp);
    CHECK_LONG(t.direction, RTC_DIRECTION_SENDONLY);
    CHECK_LONG(t.codec, RTC_CODEC_VP8);
    CHECK_LONG(t.payload_type, f.cfg.video_payload_type);
    CHECK_STR(t.mid, "video");

    session_release(&f.c->pub);
    sfu_stop(&s);
    fixture_stop(&f);
}

/* H.264 is spelled out rather than left NULL: the C API turns a NULL
 * profile into no fmtp line at all, and an H.264 m-line without
 * packetization-mode is one a browser may decline or read as single-NAL. */
TEST(an_h264_publish_names_its_profile) {
    struct fixture f;
    fixture_start(&f, true);
    f.cfg.video_codec = MEDIA_VIDEO_H264;
    struct sfu s;
    CHECK(sfu_start(&s));
    sfu_script_created(&s, "/session/8", SFU_ANSWER_VP8);

    char url[256];
    sfu_url(&s, "/room/whip", url, sizeof(url));
    CHECK(session_negotiate(&f.c->pub, url, RTC_DIRECTION_SENDONLY, true, &f.cfg, NULL, 2000));

    struct rtc_stub_track t;
    CHECK(rtc_stub_track(f.c->pub.video_track, &t));
    CHECK_LONG(t.codec, RTC_CODEC_H264);
    CHECK(strstr(t.profile, "packetization-mode=1") != NULL);
    CHECK(strstr(t.profile, "profile-level-id=42e01f") != NULL);

    /* The answer named VP8, and a publisher encodes what was CHOSEN. */
    CHECK(f.c->pub.negotiated);
    CHECK_LONG(f.c->pub.neg_codec, MEDIA_VIDEO_VP8);

    session_release(&f.c->pub);
    sfu_stop(&s);
    fixture_stop(&f);
}

/* RECEIVING offers every codec we can decode and lets the answer choose:
 * an SFU does not transcode, so the codec is a property of the PUBLISHER,
 * and a subscriber that offered only its own preference sees a black tile
 * for half the room with no error anywhere. */
TEST(a_subscribe_offers_every_codec_and_decodes_the_one_that_answered) {
    struct fixture f;
    fixture_start(&f, true);
    f.c->sub_count = 4;
    struct sfu s;
    CHECK(sfu_start(&s));
    sfu_script_created(&s, "/session/9", SFU_ANSWER_VP8);

    /* The leg starts on something else, so the answer has to move it. */
    f.c->vmix.legs[3].codec = MEDIA_VIDEO_H264;
    f.c->vmix.legs[3].payload_type = 97;
    f.c->sub[3].receives = true;

    char url[256];
    sfu_url(&s, "/room/whep/bob", url, sizeof(url));
    CHECK(session_negotiate(&f.c->sub[3], url, RTC_DIRECTION_RECVONLY, true, &f.cfg, NULL, 2000));

    struct rtc_stub_track t;
    CHECK(rtc_stub_track(f.c->sub[3].video_track, &t));
    CHECK(t.from_sdp); /* the hand-built multi-codec m-line, not rtcAddTrackEx */
    CHECK(strstr(t.sdp, "VP8") != NULL);
    CHECK(strstr(t.sdp, "H264") != NULL);

    /* Per-peer, onto that peer's own leg: a global setting would decode
     * one participant as another. */
    CHECK_LONG(f.c->vmix.legs[3].codec, MEDIA_VIDEO_VP8);
    CHECK_LONG(f.c->vmix.legs[3].payload_type, 96);
    CHECK_LONG(f.c->vmix.legs[2].codec, MEDIA_VIDEO_VP8); /* untouched default */
    CHECK_LONG(f.c->vmix.legs[2].payload_type, f.cfg.video_payload_type);

    session_release(&f.c->sub[3]);
    sfu_stop(&s);
    fixture_stop(&f);
}

/* A refused multi-codec offer falls back to the single-codec track rather
 * than losing video entirely — reported, never silent, because it means
 * this peer is only watchable if they publish what we guessed. */
TEST(a_refused_multi_codec_offer_falls_back_and_says_so) {
    struct fixture f;
    fixture_start(&f, true);
    f.c->sub_count = 1;
    struct sfu s;
    CHECK(sfu_start(&s));
    sfu_script_created(&s, "/session/2", SFU_ANSWER_VP8);
    f.c->sub[0].receives = true;

    char url[256], got[4096];
    sfu_url(&s, "/room/whep/ann", url, sizeof(url));
    rtc_stub_fail_track_at(2); /* audio is 1, the m-line offer is 2 */
    note_set_verbose(true);
    test_capture_stderr_start();
    bool ok = session_negotiate(&f.c->sub[0], url, RTC_DIRECTION_RECVONLY, true, &f.cfg, NULL,
                                2000);
    test_capture_stderr_end(got, sizeof(got));
    note_set_verbose(false);
    CHECK(ok);
    CHECK(strstr(got, "# subscribe: the multi-codec offer was refused") != NULL);

    struct rtc_stub_track t;
    CHECK(rtc_stub_track(f.c->sub[0].video_track, &t));
    CHECK(!t.from_sdp); /* fell back to the single-codec track */
    CHECK_LONG(t.direction, RTC_DIRECTION_RECVONLY);

    /* An audio track that cannot be added is fatal to the session — there
     * is no fallback for the medium a call is made of. */
    session_release(&f.c->sub[0]);
    session_reset(&f.c->sub[0]);
    rtc_stub_fail_track_at(1);
    test_capture_stderr_start();
    ok = session_negotiate(&f.c->sub[0], url, RTC_DIRECTION_RECVONLY, true, &f.cfg, NULL, 2000);
    test_capture_stderr_end(got, sizeof(got));
    CHECK(!ok);
    CHECK(strstr(got, "cannot add the audio track") != NULL);

    session_release(&f.c->sub[0]);
    sfu_stop(&s);
    fixture_stop(&f);
}

/* A 404 on a SUBSCRIBE is "that person is not in the call", which for a
 * channel is true of most members most of the time. Said ONCE, then the
 * retries go quiet — three lines per peer per tick buries the events that
 * matter. */
TEST(a_peer_who_is_not_in_the_call_is_reported_once_and_then_quietly) {
    struct fixture f;
    fixture_start(&f, false);
    f.c->sub_count = 2;
    struct sfu s;
    CHECK(sfu_start(&s));
    sfu_script_status(&s, 404, "Not Found");
    char url[256], got[4096];
    sfu_url(&s, "/room/whep/nobody", url, sizeof(url));

    test_capture_stderr_start();
    bool ok = session_negotiate(&f.c->sub[1], url, RTC_DIRECTION_RECVONLY, false, &f.cfg, NULL,
                                2000);
    test_capture_stderr_end(got, sizeof(got));
    CHECK(!ok);
    CHECK(f.c->sub[1].absent);
    CHECK_STR(got, "{\"event\":\"state\",\"value\":\"subscribe: not in the call — retrying "
                   "quietly\"}\n");

    /* The retry says nothing at all. */
    session_release(&f.c->sub[1]);
    session_reset(&f.c->sub[1]);
    CHECK(f.c->sub[1].absent); /* survives the reset, which runs on every retry */
    test_capture_stderr_start();
    ok = session_negotiate(&f.c->sub[1], url, RTC_DIRECTION_RECVONLY, false, &f.cfg, NULL, 2000);
    test_capture_stderr_end(got, sizeof(got));
    CHECK(!ok);
    CHECK_STR(got, "");

    /* Arriving is loud again: routine chatter is informative once more. */
    session_release(&f.c->sub[1]);
    session_reset(&f.c->sub[1]);
    sfu_script_created(&s, "/session/1", SFU_ANSWER_VP8);
    CHECK(session_negotiate(&f.c->sub[1], url, RTC_DIRECTION_RECVONLY, false, &f.cfg, NULL, 2000));
    CHECK(!f.c->sub[1].absent);

    session_release(&f.c->sub[1]);
    sfu_stop(&s);
    fixture_stop(&f);
}

/* Every other status is a real error and carries its NUMBER: "it did not
 * work" without the number is the message that wastes an afternoon. And a
 * 404 on a PUBLISH is not "not in the call". */
TEST(any_other_status_is_an_error_with_its_number_on_it) {
    struct fixture f;
    fixture_start(&f, false);
    struct sfu s;
    CHECK(sfu_start(&s));
    sfu_script_status(&s, 503, "Service Unavailable");
    char url[256], got[4096];
    sfu_url(&s, "/room/whip", url, sizeof(url));

    test_capture_stderr_start();
    bool ok = session_negotiate(&f.c->pub, url, RTC_DIRECTION_SENDRECV, false, &f.cfg, NULL, 2000);
    test_capture_stderr_end(got, sizeof(got));
    CHECK(!ok);
    CHECK_STR(got, "{\"event\":\"error\",\"message\":\"publish: the endpoint answered 503\"}\n");
    CHECK(!f.c->pub.absent);

    session_release(&f.c->pub);
    session_reset(&f.c->pub);
    sfu_script_status(&s, 404, "Not Found");
    test_capture_stderr_start();
    ok = session_negotiate(&f.c->pub, url, RTC_DIRECTION_SENDRECV, false, &f.cfg, NULL, 2000);
    test_capture_stderr_end(got, sizeof(got));
    CHECK(!ok);
    CHECK_STR(got, "{\"event\":\"error\",\"message\":\"publish: the endpoint answered 404\"}\n");
    CHECK(!f.c->pub.absent);

    session_release(&f.c->pub);
    sfu_stop(&s);
    fixture_stop(&f);
}

/* Vanilla ICE: gather everything, THEN offer — WHIP is one POST with one
 * body and there is nowhere to trickle a late candidate to. A peer that
 * never finishes gathering must time out and say why. */
TEST(a_gathering_that_never_finishes_times_out_and_says_so) {
    struct fixture f;
    fixture_start(&f, false);
    struct sfu s;
    CHECK(sfu_start(&s));
    sfu_script_created(&s, "/session/1", SFU_ANSWER_VP8);
    rtc_stub_set_gathering_completes(false);

    char url[256], got[4096];
    sfu_url(&s, "/room/whip", url, sizeof(url));
    test_capture_stderr_start();
    bool ok = session_negotiate(&f.c->pub, url, RTC_DIRECTION_SENDRECV, false, &f.cfg, NULL, 100);
    test_capture_stderr_end(got, sizeof(got));
    CHECK(!ok);
    CHECK_STR(got, "{\"event\":\"error\",\"message\":\"ICE gathering did not finish in time\"}\n");
    /* Nothing was posted: the offer never became complete. */
    CHECK_LONG(sfu_requests(&s), 0);
    /* The peer connection exists all the same, and is owed a release. */
    CHECK(f.c->pub.active);
    CHECK(f.c->pub.pc > 0);

    session_release(&f.c->pub);
    sfu_stop(&s);
    fixture_stop(&f);
}

/* A refused answer is not a session that quietly half-exists. */
TEST(a_rejected_answer_fails_the_session_and_still_owes_a_hangup) {
    struct fixture f;
    fixture_start(&f, false);
    struct sfu s;
    CHECK(sfu_start(&s));
    sfu_script_created(&s, "/session/4", SFU_ANSWER_VP8);
    rtc_stub_set_remote_description_ok(false);

    char url[256], got[4096];
    sfu_url(&s, "/room/whip", url, sizeof(url));
    test_capture_stderr_start();
    bool ok = session_negotiate(&f.c->pub, url, RTC_DIRECTION_SENDRECV, false, &f.cfg, NULL, 2000);
    test_capture_stderr_end(got, sizeof(got));
    CHECK(!ok);
    CHECK(strstr(got, "the SDP answer was rejected") != NULL);
    /* The resource was resolved BEFORE the answer was tried, so the hangup
     * is still owed — an SFU that never hears it holds the slot. */
    CHECK(f.c->pub.have_resource);

    session_release(&f.c->pub);
    CHECK_LONG(sfu_requests(&s), 2); /* the POST, then the DELETE */
    sfu_stop(&s);
    fixture_stop(&f);
}

/* ── session_release ───────────────────────────────────────────────────── */

/* Hanging up is a DELETE, owed on EVERY path that got a resource. An SFU
 * that never hears it holds the slot until its own timeout, which for a
 * room somebody is trying to re-enter is the difference between "call
 * again" and "wait five minutes". */
TEST(a_release_hangs_up_deletes_the_connection_and_is_safe_twice) {
    struct fixture f;
    fixture_start(&f, false);
    struct sfu s;
    CHECK(sfu_start(&s));
    sfu_script_created(&s, "/session/12", SFU_ANSWER_VP8);
    sfu_script_status(&s, 200, "OK");

    char url[256];
    sfu_url(&s, "/room/whip", url, sizeof(url));
    CHECK(session_negotiate(&f.c->pub, url, RTC_DIRECTION_SENDRECV, false, &f.cfg, NULL, 2000));
    int audio_track = f.c->pub.audio_track;

    session_release(&f.c->pub);
    CHECK_LONG(sfu_requests(&s), 2);
    char req[8192];
    sfu_request(&s, 1, req, sizeof(req));
    CHECK(strncmp(req, "DELETE /session/12 HTTP/1.1\r\n", 29) == 0);

    CHECK(!f.c->pub.have_resource);
    CHECK(!f.c->pub.active);
    CHECK_LONG(f.c->pub.pc, -1);
    CHECK_LONG(rtc_stub_pcs_deleted(), 1);
    /* The tracks went with the connection, as the real library does it. */
    struct rtc_stub_track t;
    CHECK(!rtc_stub_track(audio_track, &t));

    /* Twice is not two hangups and not two deletes: teardown calls this
     * over every subscriber slot, most of which were never used. */
    session_release(&f.c->pub);
    CHECK_LONG(sfu_requests(&s), 2);
    CHECK_LONG(rtc_stub_pcs_deleted(), 1);
    CHECK_LONG(rtc_stub_bad_calls(), 0);

    for (int i = 0; i < CALL_MAX_PEERS; i++) session_release(&f.c->sub[i]);
    CHECK_LONG(rtc_stub_pcs_deleted(), 1);
    CHECK_LONG(rtc_stub_bad_calls(), 0);

    sfu_stop(&s);
    fixture_stop(&f);
}

/* session_negotiate marks a session ACTIVE the moment it creates the peer
 * connection, which is before the POST that can refuse it. Left active, a
 * peer who is simply not in the call is a session that never settles, so
 * the whole call is declared dead — with a message blaming the SFU. */
TEST(a_session_that_never_got_a_resource_still_releases_its_connection) {
    struct fixture f;
    fixture_start(&f, false);
    f.c->sub_count = 1;
    struct sfu s;
    CHECK(sfu_start(&s));
    sfu_script_status(&s, 404, "Not Found");

    char url[256], got[4096];
    sfu_url(&s, "/room/whep/ghost", url, sizeof(url));
    test_capture_stderr_start();
    bool ok = session_negotiate(&f.c->sub[0], url, RTC_DIRECTION_RECVONLY, false, &f.cfg, NULL,
                                2000);
    test_capture_stderr_end(got, sizeof(got));
    CHECK(!ok);
    CHECK_STR(got, "{\"event\":\"state\",\"value\":\"subscribe: not in the call — retrying "
                   "quietly\"}\n");
    CHECK(f.c->sub[0].active);
    CHECK(f.c->sub[0].pc > 0);
    CHECK(!f.c->sub[0].have_resource);

    session_release(&f.c->sub[0]);
    CHECK(!f.c->sub[0].active);
    CHECK_LONG(f.c->sub[0].pc, -1);
    CHECK_LONG(rtc_stub_pcs_deleted(), 1);
    CHECK_LONG(sfu_requests(&s), 1); /* the POST only: no resource, no DELETE */
    CHECK_LONG(rtc_stub_bad_calls(), 0);

    sfu_stop(&s);
    fixture_stop(&f);
}

/* A hangup the endpoint refuses must not stop the teardown: this runs on
 * the way out of main, with the rest of the release still to do. */
TEST(a_hangup_the_endpoint_refuses_is_reported_and_not_fatal) {
    struct fixture f;
    fixture_start(&f, false);
    struct sfu s;
    CHECK(sfu_start(&s));
    sfu_script_created(&s, "/session/5", SFU_ANSWER_VP8);

    char url[256], got[4096];
    sfu_url(&s, "/room/whip", url, sizeof(url));
    CHECK(session_negotiate(&f.c->pub, url, RTC_DIRECTION_SENDRECV, false, &f.cfg, NULL, 2000));

    /* The endpoint is gone by the time we hang up. */
    sfu_stop(&s);
    note_set_verbose(true);
    test_capture_stderr_start();
    session_release(&f.c->pub);
    test_capture_stderr_end(got, sizeof(got));
    note_set_verbose(false);

    CHECK(strstr(got, "# publish: hangup failed:") != NULL);
    CHECK(!f.c->pub.have_resource);
    CHECK_LONG(f.c->pub.pc, -1);
    CHECK_LONG(rtc_stub_pcs_deleted(), 1);

    fixture_stop(&f);
}

int main(void) {
    /* main() ignores SIGPIPE because shottino can close the frame pipe at
     * any moment; here it is the fake endpoint closing a socket, and the
     * default disposition would kill the suite rather than fail it. */
    signal(SIGPIPE, SIG_IGN);
    if (!fake_ffmpeg_setup()) {
        fprintf(stderr, "FATAL %s: cannot make a fake ffmpeg\n", __FILE__);
        return 1;
    }

    RUN(liveness_is_immediate_on_the_way_in_and_patient_on_the_way_out);
    RUN(a_state_change_is_recorded_and_named_once_per_peer);
    RUN(the_library_log_is_routed_into_the_comment_stream);
    RUN(video_retile_publishes_the_grid_it_actually_composited);
    RUN(video_retile_reports_the_pictures_it_had_no_room_for);
    RUN(video_retile_says_so_when_the_decoder_cannot_start);
    RUN(audio_retile_mixes_whoever_is_there_and_stops_when_nobody_is);
    RUN(audio_retile_says_so_when_playback_cannot_start);
    RUN(an_arriving_packet_is_counted_against_the_peer_that_sent_it);
    RUN(the_pump_forwards_the_capture_and_drops_what_is_muted);
    RUN(the_pump_returns_when_there_is_nothing_to_pump);
    RUN(a_publish_posts_its_offer_and_encodes_what_the_answer_chose);
    RUN(an_h264_publish_names_its_profile);
    RUN(a_subscribe_offers_every_codec_and_decodes_the_one_that_answered);
    RUN(a_refused_multi_codec_offer_falls_back_and_says_so);
    RUN(a_peer_who_is_not_in_the_call_is_reported_once_and_then_quietly);
    RUN(any_other_status_is_an_error_with_its_number_on_it);
    RUN(a_gathering_that_never_finishes_times_out_and_says_so);
    RUN(a_rejected_answer_fails_the_session_and_still_owes_a_hangup);
    RUN(a_release_hangs_up_deletes_the_connection_and_is_safe_twice);
    RUN(a_session_that_never_got_a_resource_still_releases_its_connection);
    RUN(a_hangup_the_endpoint_refuses_is_reported_and_not_fatal);

    fake_ffmpeg_teardown();
    return test_report();
}
