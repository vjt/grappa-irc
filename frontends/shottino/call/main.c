/* shottino-call — the media helper for terminal calls.
 *
 * A SEPARATE PROCESS, not a plugin. shottino already works this way four
 * times over (ffmpeg, whisper-cli, stdbuf, and the MCP shim where it
 * re-execs itself), and here the reasons are sharper still:
 *
 *   - no ABI to keep stable, and no C++ runtime inside shottino;
 *   - shottino's `make check` gate stays pure C — the media code never
 *     links into the sanitized test binaries;
 *   - WebRTC is precisely the code that will segfault. Out of process
 *     that drops the call; in process it takes the IRC session with it.
 *
 * ONE OR TWO SESSIONS, because SFUs come in two shapes:
 *
 *   --whip alone         one sendrecv session. What a single-endpoint
 *                        SFU (Galène, LiveKit) expects.
 *   --whip with --whep   publish sendonly to one endpoint, subscribe
 *                        recvonly from another. What MediaMTX expects:
 *                        its WHIP is publish-ONLY and its WHEP read-only,
 *                        so a lone sendrecv POST is accepted as a publish
 *                        and simply never sends anything back — a call
 *                        with no sound and no error.
 *   --whep alone         watch a room without publishing. No camera and
 *                        no microphone are opened: "it produced no
 *                        error" is not good enough for a device light.
 *
 * Output contract:
 *   stdout — the raw rgb24 frame stream. NOTHING else writes here.
 *   stderr — one JSON object per line: {"event":…}. With --verbose,
 *            human notes are interleaved as `#` comment lines, which a
 *            parser skips on the first character.
 */
#include "media.h"
#include "whip.h"

#include <errno.h>
#include <getopt.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

#include <rtc/rtc.h>

/* The helper↔shottino contract version. shottino runs `shottino-call
 * --protocol` and refuses a number it does not know, so a helper left
 * behind by an older install fails LOUDLY instead of misbehaving. */
#define CALL_PROTOCOL 1

static volatile sig_atomic_t stop_requested;

static bool verbose;
static pthread_mutex_t out_lock = PTHREAD_MUTEX_INITIALIZER;

/* Every line out of this process goes through one of these two, so the
 * "stdout is frames only" rule cannot be broken by a stray printf. */
static void emit(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    pthread_mutex_lock(&out_lock);
    vfprintf(stderr, fmt, ap);
    fputc('\n', stderr);
    fflush(stderr);
    pthread_mutex_unlock(&out_lock);
    va_end(ap);
}

static void note(const char *fmt, ...) {
    if (!verbose) return;
    va_list ap;
    va_start(ap, fmt);
    pthread_mutex_lock(&out_lock);
    fputs("# ", stderr);
    vfprintf(stderr, fmt, ap);
    fputc('\n', stderr);
    fflush(stderr);
    pthread_mutex_unlock(&out_lock);
    va_end(ap);
}

/* JSON string escaping for the few fields that can carry server text. */
static void emit_event(const char *event, const char *key, const char *value) {
    char esc[512];
    size_t n = 0;
    for (const unsigned char *p = (const unsigned char *)(value ? value : "");
         *p && n + 7 < sizeof(esc); p++) {
        if (*p == '"' || *p == '\\') {
            esc[n++] = '\\';
            esc[n++] = (char)*p;
        } else if (*p < 0x20) {
            n += (size_t)snprintf(esc + n, sizeof(esc) - n, "\\u%04x", *p);
        } else {
            esc[n++] = (char)*p;
        }
    }
    esc[n] = 0;
    if (key) emit("{\"event\":\"%s\",\"%s\":\"%s\"}", event, key, esc);
    else emit("{\"event\":\"%s\"}", event);
}

static void on_signal(int sig) {
    (void)sig;
    stop_requested = 1;
}

/* ── One negotiated PeerConnection ────────────────────────────────────── */

struct call;

struct session {
    struct call *owner;
    const char *label; /* "publish" / "subscribe", for the events */
    int pc;
    int audio_track, video_track;
    rtcState state;
    rtcGatheringState gathering;
    /* The WHIP/WHEP session resource, for the DELETE that hangs up. */
    char resource[WHIP_MAX_URL];
    bool have_resource;
    bool active;
    /* Does THIS session's inbound media feed the decoders? Exactly one
     * session receives, whichever shape we are in — wiring both would
     * hand our own echo to the speakers. */
    bool receives;
};

struct call {
    pthread_mutex_t lock;
    pthread_cond_t cv;
    struct session pub, sub;
    struct media_leg send_audio, send_video, recv_audio, recv_video;
    /* Mute is LOCAL and instant: the capture leg keeps running and its
     * packets are dropped on the way to the track. Tearing down ffmpeg
     * instead would make unmuting take as long as a device open, and a
     * mute button with a second of lag is a mute button people talk
     * over. */
    bool muted;
    bool camera_off;
};

static void RTC_API on_state(int pc, rtcState state, void *ptr) {
    (void)pc;
    struct session *s = ptr;
    static const char *const names[] = { "new",          "connecting", "connected",
                                         "disconnected", "failed",     "closed" };
    pthread_mutex_lock(&s->owner->lock);
    s->state = state;
    pthread_cond_broadcast(&s->owner->cv);
    pthread_mutex_unlock(&s->owner->lock);
    if (state >= 0 && (size_t)state < sizeof(names) / sizeof(names[0])) {
        char msg[64];
        snprintf(msg, sizeof(msg), "%s %s", s->label, names[state]);
        emit_event("state", "value", msg);
    }
}

static void RTC_API on_gathering(int pc, rtcGatheringState state, void *ptr) {
    (void)pc;
    struct session *s = ptr;
    pthread_mutex_lock(&s->owner->lock);
    s->gathering = state;
    pthread_cond_broadcast(&s->owner->cv);
    pthread_mutex_unlock(&s->owner->lock);
}

/* An RTP packet arriving on a track, on libdatachannel's thread: hand it
 * straight to the decoder waiting for it on loopback. */
static void RTC_API on_audio_rtp(int id, const char *msg, int size, void *ptr) {
    (void)id;
    struct session *s = ptr;
    if (size > 0) media_feed(&s->owner->recv_audio, msg, (size_t)size);
}

static void RTC_API on_video_rtp(int id, const char *msg, int size, void *ptr) {
    (void)id;
    struct session *s = ptr;
    if (size > 0) media_feed(&s->owner->recv_video, msg, (size_t)size);
}

/* The other direction: whatever the capture ffmpeg packetised, onto the
 * publishing session's tracks. One thread for both legs — these are
 * datagrams on loopback and a poll over two sockets is the whole job. */
static void *pump_main(void *arg) {
    struct call *c = arg;
    static char buf[2048]; /* an RTP packet, MTU-bounded by ffmpeg */
    for (;;) {
        struct pollfd fds[2];
        int n = 0;
        int video_at = -1;
        if (c->send_audio.fd >= 0) {
            fds[n].fd = c->send_audio.fd;
            fds[n].events = POLLIN;
            n++;
        }
        if (c->send_video.fd >= 0) {
            video_at = n;
            fds[n].fd = c->send_video.fd;
            fds[n].events = POLLIN;
            n++;
        }
        if (n == 0) return NULL;
        int rc = poll(fds, (nfds_t)n, 200);
        if (stop_requested) return NULL;
        if (rc <= 0) continue;
        for (int i = 0; i < n; i++) {
            if (!(fds[i].revents & POLLIN)) continue;
            bool is_video = i == video_at;
            int track = is_video ? c->pub.video_track : c->pub.audio_track;
            /* DRAIN the socket, do not take one datagram per wakeup.
             *
             * ffmpeg emits a video frame as a BURST of RTP packets, so
             * one-per-poll delivers a fraction of each frame, the rest
             * is dropped by the socket buffer, and no keyframe ever
             * completes — the far end reports "Invalid data found" on
             * every packet and gives up at a 100% decode error rate.
             * Measured exactly that before this loop existed. */
            for (;;) {
                ssize_t got = recv(fds[i].fd, buf, sizeof(buf), MSG_DONTWAIT);
                if (got <= 0) break;
                /* Muted: dropped HERE rather than at the capture, so
                 * unmuting is instant. The socket is still drained, or
                 * a muted minute would burst on unmute. */
                if (is_video ? c->camera_off : c->muted) continue;
                if (track >= 0) rtcSendMessage(track, buf, (int)got);
            }
        }
    }
}

/* Wait until `done(c)` or the deadline. One helper for every wait, so
 * the timeout accounting cannot drift between them. */
static bool wait_until(struct call *c, bool (*done)(const struct call *), int timeout_ms) {
    struct timespec deadline;
    clock_gettime(CLOCK_REALTIME, &deadline);
    deadline.tv_sec += timeout_ms / 1000;
    deadline.tv_nsec += (long)(timeout_ms % 1000) * 1000000L;
    if (deadline.tv_nsec >= 1000000000L) {
        deadline.tv_sec++;
        deadline.tv_nsec -= 1000000000L;
    }
    bool ok;
    pthread_mutex_lock(&c->lock);
    while (!(ok = done(c)) && !stop_requested) {
        if (pthread_cond_timedwait(&c->cv, &c->lock, &deadline) == ETIMEDOUT) {
            ok = done(c);
            break;
        }
    }
    pthread_mutex_unlock(&c->lock);
    return ok;
}

static bool session_settled(const struct session *s) {
    return !s->active || s->state == RTC_CONNECTED || s->state == RTC_FAILED ||
           s->state == RTC_CLOSED;
}

static bool all_gathered(const struct call *c) {
    return (!c->pub.active || c->pub.gathering == RTC_GATHERING_COMPLETE) &&
           (!c->sub.active || c->sub.gathering == RTC_GATHERING_COMPLETE);
}

static bool all_settled(const struct call *c) {
    return session_settled(&c->pub) && session_settled(&c->sub);
}

static bool session_up(const struct session *s) { return !s->active || s->state == RTC_CONNECTED; }

/* Bring one session all the way up: tracks, offer, POST, answer.
 *
 * `dir` is what decides the shape — SENDRECV for a single-endpoint SFU,
 * SENDONLY/RECVONLY for the publish/subscribe pair. Everything else is
 * identical between them, which is why there is one of these rather than
 * two nearly-identical ones that would drift. */
static bool session_negotiate(struct session *s, const char *url, rtcDirection dir, bool video,
                              const struct media_config *mcfg, const char *stun, int timeout_ms) {
    struct whip_url endpoint;
    if (!whip_url_parse(url, &endpoint)) {
        emit_event("error", "message", "the endpoint is not an http/https URL");
        return false;
    }

    rtcConfiguration config;
    memset(&config, 0, sizeof(config));
    const char *ice[1];
    if (stun) {
        ice[0] = stun;
        config.iceServers = (const char **)ice;
        config.iceServersCount = 1;
    }
    /* One UDP port for everything, which is what the far side expects
     * and what makes a firewall rule writable. */
    config.enableIceUdpMux = true;

    s->pc = rtcCreatePeerConnection(&config);
    if (s->pc < 0) {
        emit_event("error", "message", "cannot create the peer connection");
        return false;
    }
    s->active = true;
    rtcSetUserPointer(s->pc, s);
    rtcSetStateChangeCallback(s->pc, on_state);
    rtcSetGatheringStateChangeCallback(s->pc, on_gathering);

    rtcTrackInit audio;
    memset(&audio, 0, sizeof(audio));
    audio.direction = dir;
    audio.codec = RTC_CODEC_OPUS;
    audio.payloadType = mcfg->audio_payload_type; /* the value browsers use for Opus */
    audio.ssrc = mcfg->audio_ssrc;
    audio.mid = "audio";
    audio.name = "shottino";
    audio.msid = "shottino";
    audio.trackId = "audio";
    s->audio_track = rtcAddTrackEx(s->pc, &audio);
    if (s->audio_track < 0) {
        emit_event("error", "message", "cannot add the audio track");
        return false;
    }
    rtcSetUserPointer(s->audio_track, s);
    if (s->receives) rtcSetMessageCallback(s->audio_track, on_audio_rtp);

    if (video) {
        /* VP8 is the safest common denominator: universally supported
         * and free of the licensing baggage that keeps H.264 out of
         * some distributions. The terminal renders ASCII art, so the
         * detail H.264 would buy is thrown away on arrival anyway. */
        rtcTrackInit vid;
        memset(&vid, 0, sizeof(vid));
        vid.direction = dir;
        vid.codec = RTC_CODEC_VP8;
        vid.payloadType = mcfg->video_payload_type;
        vid.ssrc = mcfg->video_ssrc;
        vid.mid = "video";
        vid.name = "shottino";
        vid.msid = "shottino";
        vid.trackId = "video";
        s->video_track = rtcAddTrackEx(s->pc, &vid);
        if (s->video_track < 0) {
            emit_event("error", "message", "cannot add the video track");
            return false;
        }
        rtcSetUserPointer(s->video_track, s);
        if (s->receives) rtcSetMessageCallback(s->video_track, on_video_rtp);
    }

    /* Vanilla ICE: gather everything, THEN offer.
     *
     * WHIP is one POST with one body, so there is nowhere to trickle a
     * late candidate to — the offer that goes in the request has to be
     * complete. (The spec has a PATCH for trickle; servers vary, and
     * needing it is not worth the second code path here.) */
    note("%s: gathering ICE candidates", s->label);
    if (rtcSetLocalDescription(s->pc, "offer") < 0) {
        emit_event("error", "message", "cannot create the offer");
        return false;
    }
    if (!wait_until(s->owner, all_gathered, timeout_ms)) {
        emit_event("error", "message", "ICE gathering did not finish in time");
        return false;
    }

    static char offer[64 * 1024];
    if (rtcGetLocalDescription(s->pc, offer, (int)sizeof(offer)) < 0) {
        emit_event("error", "message", "cannot read the local description");
        return false;
    }
    note("%s: offer is %zu bytes, posting to %s", s->label, strlen(offer), url);

    struct whip_response resp;
    char err[256] = { 0 };
    if (!whip_request(&endpoint, "POST", "application/sdp", offer, timeout_ms, &resp, err,
                      sizeof(err))) {
        emit_event("error", "message", err[0] ? err : "the request failed");
        return false;
    }
    /* 201 is what the spec says; some servers answer 200. Anything else
     * is reported WITH its status, because "it did not work" without the
     * number is the kind of message that wastes an afternoon. */
    if (resp.status != 201 && resp.status != 200) {
        char msg[128];
        snprintf(msg, sizeof(msg), "%s: the endpoint answered %d", s->label, resp.status);
        emit_event("error", "message", msg);
        whip_response_free(&resp);
        return false;
    }
    if (!resp.body || !resp.body_len) {
        emit_event("error", "message", "the endpoint returned no SDP answer");
        whip_response_free(&resp);
        return false;
    }

    /* The resource URL, for the DELETE that hangs up. Resolved now,
     * while the request URL it is relative to is still in hand. */
    s->have_resource =
        resp.location[0] && whip_resolve(&endpoint, resp.location, s->resource, sizeof(s->resource));
    if (resp.location[0] && !s->have_resource)
        note("%s: the Location header could not be resolved: %s", s->label, resp.location);

    bool ok = rtcSetRemoteDescription(s->pc, resp.body, "answer") >= 0;
    if (!ok) emit_event("error", "message", "the SDP answer was rejected");
    whip_response_free(&resp);
    return ok;
}

/* Hanging up is a DELETE, and it is owed on EVERY path that got a
 * resource — a rejected answer and a media path that never came up
 * included. An SFU that never hears it holds the slot until its own
 * timeout, which for a room somebody is trying to re-enter is the
 * difference between "call again" and "wait five minutes". */
static void session_release(struct session *s) {
    if (s->have_resource) {
        struct whip_url res;
        if (whip_url_parse(s->resource, &res)) {
            struct whip_response bye;
            char err[256] = { 0 };
            if (whip_request(&res, "DELETE", NULL, NULL, 5000, &bye, err, sizeof(err))) {
                note("%s: hangup returned %d", s->label, bye.status);
                whip_response_free(&bye);
            } else {
                note("%s: hangup failed: %s", s->label, err);
            }
        }
        s->have_resource = false;
    }
    if (s->pc >= 0) {
        rtcDeletePeerConnection(s->pc);
        s->pc = -1;
    }
    s->active = false;
}

static void usage(FILE *out) {
    fprintf(out,
            "usage: shottino-call [--whip <url>] [--whep <url>] [options]\n"
            "\n"
            "  --whip <url>     publish here. Alone, the session is sendrecv\n"
            "  --whep <url>     subscribe here. With --whip, publishing becomes\n"
            "                   sendonly and this is the receiving session — the\n"
            "                   shape MediaMTX needs. Alone, watch without\n"
            "                   publishing: no camera, no microphone\n"
            "  --stun <url>     a STUN server, e.g. stun:stun.example:19302\n"
            "  --video          negotiate a video track as well as audio\n"
            "  --timeout <ms>   how long to wait for ICE and for the answer "
            "(default 15000)\n"
            "  --audio-source <f:i>  ffmpeg capture, e.g. pulse:default\n"
            "  --video-source <f:i>  ffmpeg camera, e.g. v4l2:/dev/video0\n"
            "  --audio-sink <f:d>    where decoded audio plays, e.g. pulse:default\n"
            "  --frame <WxH>    decoded video size in PIXELS (default 320x240)\n"
            "  --fps <n>        video frame rate (default 10)\n"
            "  --verbose        interleave '#' notes on stderr\n"
            "  --protocol       print the helper protocol version and exit\n"
            "\n"
            "Control verbs on stdin, one per line: mute, unmute, camera on, camera off,\n"
            "hangup. Events are JSON lines on stderr; stdout carries rgb24 frames.\n");
}

int main(int argc, char **argv) {
    const char *whip_url = NULL;
    const char *whep_url = NULL;
    const char *stun = NULL;
    bool video = false;
    int timeout_ms = 15000;
    /* Payload types and SSRCs are declared ONCE, here, and travel to
     * both the offer and the ffmpeg legs — a second copy of "Opus is
     * 111" is a second place for it to stop being true. */
    struct media_config mcfg = { .audio_source = "pulse:default",
                                 .video_source = "v4l2:/dev/video0",
                                 .audio_sink = "pulse:default",
                                 .audio_payload_type = 111,
                                 .video_payload_type = 96,
                                 .audio_ssrc = 1,
                                 .video_ssrc = 2,
                                 .frame_w = 320,
                                 .frame_h = 240,
                                 .fps = 10,
                                 .want_video = false };

    enum { OPT_AUDIO_SRC = 1000, OPT_VIDEO_SRC, OPT_AUDIO_SINK, OPT_FRAME, OPT_FPS, OPT_WHEP };
    static const struct option opts[] = {
        { "whip", required_argument, NULL, 'w' },
        { "whep", required_argument, NULL, OPT_WHEP },
        { "stun", required_argument, NULL, 's' },
        { "video", no_argument, NULL, 'V' },
        { "timeout", required_argument, NULL, 't' },
        { "audio-source", required_argument, NULL, OPT_AUDIO_SRC },
        { "video-source", required_argument, NULL, OPT_VIDEO_SRC },
        { "audio-sink", required_argument, NULL, OPT_AUDIO_SINK },
        { "frame", required_argument, NULL, OPT_FRAME },
        { "fps", required_argument, NULL, OPT_FPS },
        { "verbose", no_argument, NULL, 'v' },
        { "protocol", no_argument, NULL, 'p' },
        { "help", no_argument, NULL, 'h' },
        { NULL, 0, NULL, 0 }
    };
    int c;
    while ((c = getopt_long(argc, argv, "w:s:Vt:vph", opts, NULL)) != -1) {
        switch (c) {
        case 'w': whip_url = optarg; break;
        case OPT_WHEP: whep_url = optarg; break;
        case 's': stun = optarg; break;
        case 'V': video = true; break;
        case 't': timeout_ms = atoi(optarg); break;
        case OPT_AUDIO_SRC: mcfg.audio_source = optarg; break;
        case OPT_VIDEO_SRC: mcfg.video_source = optarg; break;
        case OPT_AUDIO_SINK: mcfg.audio_sink = optarg; break;
        case OPT_FRAME:
            /* The helper has no terminal, so it must never guess the
             * geometry — shottino computes it from the cells it has. */
            if (sscanf(optarg, "%dx%d", &mcfg.frame_w, &mcfg.frame_h) != 2 || mcfg.frame_w <= 0 ||
                mcfg.frame_h <= 0) {
                emit_event("error", "message", "--frame wants WxH, e.g. 320x240");
                return 2;
            }
            break;
        case OPT_FPS: mcfg.fps = atoi(optarg); break;
        case 'v': verbose = true; break;
        case 'p': printf("%d\n", CALL_PROTOCOL); return 0;
        case 'h': usage(stdout); return 0;
        default: usage(stderr); return 2;
        }
    }
    if (!whip_url && !whep_url) {
        usage(stderr);
        return 2;
    }
    if (timeout_ms < 1000) timeout_ms = 1000;
    mcfg.want_video = video;
    if (mcfg.fps < 1 || mcfg.fps > 30) mcfg.fps = 10;

    /* SIGPIPE would kill the process the moment shottino closes the
     * frame pipe; the read/write paths report the error instead. */
    signal(SIGPIPE, SIG_IGN);
    signal(SIGINT, on_signal);
    signal(SIGTERM, on_signal);

    rtcInitLogger(verbose ? RTC_LOG_WARNING : RTC_LOG_NONE, NULL);

    struct call call;
    memset(&call, 0, sizeof(call));
    pthread_mutex_init(&call.lock, NULL);
    pthread_cond_init(&call.cv, NULL);
    call.pub.owner = call.sub.owner = &call;
    call.pub.label = "publish";
    call.sub.label = "subscribe";
    call.pub.pc = call.sub.pc = -1;
    call.pub.audio_track = call.pub.video_track = -1;
    call.sub.audio_track = call.sub.video_track = -1;
    call.send_audio.fd = call.send_video.fd = call.recv_audio.fd = call.recv_video.fd = -1;
    call.send_audio.pid = call.send_video.pid = call.recv_audio.pid = call.recv_video.pid = -1;

    /* Which session receives, and therefore which direction each one
     * negotiates. Decided ONCE, here, so nothing downstream has to work
     * it out again and reach a different answer. */
    bool paired = whip_url && whep_url;
    call.sub.receives = whep_url != NULL;
    call.pub.receives = whip_url && !whep_url;

    bool ok = true;
    if (whip_url)
        ok = session_negotiate(&call.pub, whip_url,
                               paired ? RTC_DIRECTION_SENDONLY : RTC_DIRECTION_SENDRECV, video,
                               &mcfg, stun, timeout_ms);
    if (ok && whep_url)
        ok = session_negotiate(&call.sub, whep_url, RTC_DIRECTION_RECVONLY, video, &mcfg, stun,
                               timeout_ms);

    bool connected = false;
    if (ok) {
        emit_event("negotiated", "resource",
                   call.pub.have_resource ? call.pub.resource : call.sub.resource);
        connected = wait_until(&call, all_settled, timeout_ms) && session_up(&call.pub) &&
                    session_up(&call.sub);
        if (!connected && !stop_requested)
            emit_event("error", "message",
                       "the media path never came up — check the SFU's advertised public IP");
    }

    pthread_t pump = 0;
    bool pumping = false;
    if (connected) {
        /* Devices open AFTER the connection is up, never before: opening
         * a microphone for a call that then fails to connect turns a
         * negotiation error into a recording light nobody asked for. A
         * watch-only session opens neither. */
        bool sending = whip_url != NULL;
        bool receiving = call.pub.receives || call.sub.receives;
        if (receiving) {
            if (!media_start_recv(&call.recv_audio, &mcfg, false, -1))
                emit_event("error", "message", "cannot start audio playback (is ffmpeg installed?)");
            if (video && !media_start_recv(&call.recv_video, &mcfg, true, STDOUT_FILENO))
                emit_event("error", "message", "cannot start video decoding");
        }
        if (sending) {
            if (!media_start_send(&call.send_audio, &mcfg, false))
                emit_event("error", "message", "cannot open the microphone");
            if (video && !media_start_send(&call.send_video, &mcfg, true))
                emit_event("error", "message", "cannot open the camera");
            pumping = pthread_create(&pump, NULL, pump_main, &call) == 0;
        }
        emit_event("media", "value",
                   sending ? (video ? "audio+video" : "audio")
                           : (video ? "watching audio+video" : "watching audio"));
    }

    /* Control lines on stdin, one verb per line. Blocking reads on a
     * pipe shottino owns; poll so a closed pipe or a signal ends the
     * call rather than parking this thread forever. */
    while (connected && !stop_requested) {
        struct pollfd in = { .fd = STDIN_FILENO, .events = POLLIN, .revents = 0 };
        int rc = poll(&in, 1, 200);
        if (rc > 0 && (in.revents & POLLIN)) {
            char line[64];
            ssize_t got = read(STDIN_FILENO, line, sizeof(line) - 1);
            if (got <= 0) break; /* shottino closed the pipe: hang up */
            line[got] = 0;
            line[strcspn(line, "\r\n")] = 0;
            if (strcmp(line, "mute") == 0) call.muted = true;
            else if (strcmp(line, "unmute") == 0) call.muted = false;
            else if (strcmp(line, "camera off") == 0) call.camera_off = true;
            else if (strcmp(line, "camera on") == 0) call.camera_off = false;
            else if (strcmp(line, "hangup") == 0) break;
            else if (line[0]) continue; /* unknown verb: never fatal */
            emit_event("control", "value", line);
        }
        pthread_mutex_lock(&call.lock);
        bool still = session_up(&call.pub) && session_up(&call.sub);
        pthread_mutex_unlock(&call.lock);
        if (!still) break;
    }

    stop_requested = 1; /* ends the pump */
    if (pumping) pthread_join(pump, NULL);
    media_stop(&call.send_audio);
    media_stop(&call.send_video);
    media_stop(&call.recv_audio);
    media_stop(&call.recv_video);
    session_release(&call.pub);
    session_release(&call.sub);
    rtcCleanup();
    emit_event("closed", NULL, NULL);
    return connected ? 0 : 1;
}
