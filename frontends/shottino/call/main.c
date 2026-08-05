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

/* How many other people one call can carry. A mesh of subscribes is
 * cheap here because the render target is ASCII — a peer costs ~24 kbps
 * of Opus and ~150 kbps of tiny VP8 — but it is not free, and a cap is
 * how "the channel had forty people in it" fails as a clear message
 * rather than as a machine that stops responding.
 *
 * Taken from media.h rather than spelled again: the leg and tile arrays
 * there are sized by it, and two constants that must be equal are one
 * waiting to not be. */
#define CALL_MAX_PEERS MEDIA_MAX_PEERS

/* How often the video mix is re-examined, and how many quiet ticks it
 * takes to conclude a peer has stopped sending. See video_supervise(). */
#define CALL_TILE_TICK_SECS 1
#define CALL_TILE_MISSES 3

/* How often an absent peer is asked again. See the resubscribe loop:
 * one peer per interval, so this is also the pace at which a channel's
 * worth of absent members is cycled through. */
#define CALL_RESUB_SECS 5

/* How many pictures the mix will composite at once. NOT a layout limit
 * — the layout would happily fit four — but a MEASURED one.
 *
 * ffmpeg opens live RTP inputs SEQUENTIALLY, and each open blocks long
 * enough that the sockets already opened overflow and have to resync.
 * The cost is therefore not linear in the number of pictures, it
 * roughly doubles per picture. Measured on an idle 8-core box, time
 * from spawning the mix to its first composited frame:
 *
 *     1 picture   0.3s      3 pictures   5.7s
 *     2 pictures  2.2s      4 pictures  12.4s      6+  never (>15s)
 *
 * Established as the cause rather than assumed: four inputs opened with
 * NO filter graph at all and only one of them mapped still took 14s, so
 * it is the opening and not the compositing. It is also unaffected by
 * -analyzeduration/-probesize (either direction), by setpts alignment
 * of the inputs, by the keyframe interval (a shorter one is worse), and
 * by whether the helper or a hand-run shell spawns it.
 *
 * Three is where the curve is still tolerable. Beyond it, peers stay in
 * the call with their audio and are reported as not drawn — which is
 * the same honest degradation a peer with their camera off already
 * gets, rather than a call that appears to hang. */
#define CALL_TILE_MAX 3

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

/* libdatachannel's own diagnostics, onto STDERR where they belong.
 *
 * Given no callback it logs to STDOUT, which here is the raw rgb24
 * frame stream — so a single warning writes text into the middle of a
 * picture and everything downstream reads it as pixels. Caught against
 * a real server, where the log said "Track is not open" and the frame
 * file turned out to be plain text.
 *
 * Routed through note(), so it obeys the same rule as everything else
 * this program prints: one `#` comment line, on stderr, skippable by a
 * parser on the first character. */
static void RTC_API on_rtc_log(rtcLogLevel level, const char *message) {
    (void)level;
    note("libdatachannel: %s", message ? message : "");
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
    /* Does THIS session's inbound media feed the decoders? Publishing
     * feeds them only in the single-endpoint shape; wiring both ends of
     * a pair would hand our own echo to the speakers. */
    bool receives;
    /* Which peer this is, and therefore which decoder its RTP belongs
     * to. Every subscriber has its OWN legs: N people are N streams,
     * and one decoder fed from several would be a blender. */
    int slot;
};

struct call {
    pthread_mutex_t lock;
    pthread_cond_t cv;
    struct session pub;
    struct session sub[CALL_MAX_PEERS];
    int sub_count;
    struct media_leg send_audio, send_video;
    /* One audio decoder per peer, all playing to the SAME sink — the
     * mixing is the audio system's job and it already does it, which is
     * why N voices need no mixer here.
     *
     * Video is ONE tile, from the first peer. N tiles means a layout
     * policy in the draw path, and that is a deliberate next step
     * rather than something to guess at. */
    struct media_mix amix;
    /* Video is ONE decoder for everybody, compositing the peers into a
     * single frame: the focused one full size with the rest as
     * thumbnails along the bottom. N decoders would be N processes and
     * N pipes, and the process count is what hurts long before the CPU
     * does — the same reason the audio is one amix.
     *
     * `vlock` is held by the RTP callbacks with TRYLOCK and never
     * waited on: a re-tile forks and reaps ffmpeg, which is far longer
     * than a media thread may be parked, and a dropped RTP packet
     * during a deliberate re-tile is exactly what RTP is for. */
    struct media_mix vmix;
    pthread_mutex_t vlock;
    /* Which peers are actually sending pictures, and the packet
     * counters that decide it. A filter graph STALLS on an input that
     * never produces a frame, so one peer with their camera off would
     * otherwise freeze everybody's video — the set has to be live, not
     * assumed from who connected. */
    _Atomic unsigned long vpkts[CALL_MAX_PEERS];
    unsigned long vseen[CALL_MAX_PEERS];
    int vmisses[CALL_MAX_PEERS];
    bool vlive[CALL_MAX_PEERS];
    /* The same, for voices. The audio mix used to be built ONCE at
     * connect over a contiguous 0..n-1, which meant a peer who joined
     * afterwards landed on a slot nobody had prepared and was audible
     * to nobody — half of what "the late joiner is not there" was. */
    _Atomic unsigned long apkts[CALL_MAX_PEERS];
    unsigned long aseen[CALL_MAX_PEERS];
    int amisses[CALL_MAX_PEERS];
    bool alive[CALL_MAX_PEERS];
    bool want_video;
    int frame_fd;
    /* Borrowed from main's frame, which outlives every thread here. The
     * `frame` verb edits the geometry in it, so a re-tile picks up the
     * new size without a second copy to keep in step. */
    struct media_config *cfg;
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
    if (size > 0 && s->slot >= 0 && s->slot < CALL_MAX_PEERS)
        {
        struct call *c = s->owner;
        c->apkts[s->slot]++;
        if (pthread_mutex_trylock(&c->vlock) != 0) return;
        media_feed(&c->amix.legs[s->slot], msg, (size_t)size);
        pthread_mutex_unlock(&c->vlock);
        }
}

static void RTC_API on_video_rtp(int id, const char *msg, int size, void *ptr) {
    (void)id;
    struct session *s = ptr;
    if (size <= 0 || s->slot < 0 || s->slot >= CALL_MAX_PEERS) return;
    struct call *c = s->owner;
    /* Counted BEFORE the lock and unconditionally: this is what tells
     * the supervisor the peer is alive, and a packet dropped because a
     * re-tile was in progress is still proof they are sending. */
    c->vpkts[s->slot]++;
    /* TRYLOCK, never lock. The only thing holding this is a re-tile,
     * which forks and reaps ffmpeg — far longer than a media thread may
     * be parked. Dropping a datagram is what RTP already expects;
     * stalling libdatachannel's thread is not. */
    if (pthread_mutex_trylock(&c->vlock) != 0) return;
    media_feed(&c->vmix.legs[s->slot], msg, (size_t)size);
    pthread_mutex_unlock(&c->vlock);
}

/* Rebuild the composited picture: who is in it, and who is big.
 *
 * ONE path for three different reasons — a peer started or stopped
 * sending, Tab moved the focus, or shottino resized the window. They
 * are the same operation (new tiles, new decoder, same ports), so they
 * are the same function rather than three that would drift. */
static void video_retile(struct call *c) {
    if (!c->want_video) return;
    int slots[CALL_MAX_PEERS];
    int n = 0;
    for (int i = 0; i < CALL_MAX_PEERS; i++)
        if (c->vlive[i]) slots[n++] = i;

    pthread_mutex_lock(&c->vlock);
    if (n == 0) {
        /* Nobody is sending a picture. The decoder is stopped rather
         * than left running on inputs that produce nothing, which is
         * what makes an audio-only participant cost nothing. */
        media_mix_stop(&c->vmix);
        c->vmix.tile_count = 0;
        pthread_mutex_unlock(&c->vlock);
        emit_event("tiles", "value", "");
        return;
    }
    c->vmix.tile_count =
        media_grid_layout(slots, n, c->cfg->frame_w, c->cfg->frame_h, c->vmix.tiles,
                          CALL_TILE_MAX);
    bool ok = media_start_video_mix(&c->vmix, c->cfg, c->frame_fd);
    /* THE GRID, PUBLISHED. Not a status line — a contract.
     *
     * The composited frame is one picture on a byte pipe, so without
     * these rectangles the other end cannot tell whose face is where.
     * With them it can sample any cell into any box, which is what
     * makes focus a drawing decision there instead of a decoder restart
     * here.
     *
     *     <frame_w>x<frame_h>;slot,x,y,w,h;slot,x,y,w,h...
     *
     * shottino knows which nick each slot is — it built the subscribe
     * list — so the slot number is enough to label a cell. Fewer tiles
     * here than peers in the call is also how the cap is REPORTED
     * rather than silently applied. */
    char shown[64 + CALL_MAX_PEERS * 32];
    size_t at = 0;
    int drawn = c->vmix.tile_count;
    at += (size_t)snprintf(shown + at, sizeof(shown) - at, "%dx%d", c->cfg->frame_w,
                           c->cfg->frame_h);
    for (int i = 0; i < drawn && at + 40 < sizeof(shown); i++)
        at += (size_t)snprintf(shown + at, sizeof(shown) - at, ";%d,%d,%d,%d,%d",
                               c->vmix.tiles[i].slot, c->vmix.tiles[i].x, c->vmix.tiles[i].y,
                               c->vmix.tiles[i].w, c->vmix.tiles[i].h);
    shown[at] = 0;
    pthread_mutex_unlock(&c->vlock);

    if (!ok) {
        emit_event("error", "message", "cannot start video decoding");
        return;
    }
    emit_event("tiles", "value", shown);
    if (drawn < n)
        note("video: %d of %d pictures shown — the window has no room for more", drawn, n);
}

/* Rebuild the audio mix over whoever is actually speaking-capable.
 *
 * Same shape as video_retile and for the same reason: the set changes
 * when somebody joins late or mutes their microphone at the source, and
 * an ffmpeg amix stalls on an input that never delivers a frame. */
static void audio_retile(struct call *c) {
    int slots[CALL_MAX_PEERS];
    int n = 0;
    for (int i = 0; i < CALL_MAX_PEERS; i++)
        if (c->alive[i]) slots[n++] = i;

    pthread_mutex_lock(&c->vlock);
    if (n == 0) {
        media_mix_stop(&c->amix);
        pthread_mutex_unlock(&c->vlock);
        return;
    }
    bool ok = media_start_audio_mix(&c->amix, slots, n, c->cfg);
    pthread_mutex_unlock(&c->vlock);
    if (!ok) emit_event("error", "message", "cannot start audio playback (is ffmpeg installed?)");
    else note("audio: mixing %d voice%s", n, n == 1 ? "" : "s");
}

/* Who is sending a picture right now, re-examined on a slow tick.
 *
 * Not derived from who CONNECTED: a peer whose camera is off is
 * connected and silent on the video track, and an ffmpeg filter graph
 * blocks forever on an input that never delivers a first frame. One
 * such peer would freeze the whole mix, so membership is measured from
 * arriving packets and nothing else.
 *
 * Asymmetric on purpose: a peer is added the moment a packet arrives,
 * and dropped only after several quiet ticks. Adding late costs a
 * moment of missing thumbnail; dropping early costs a re-tile, and a
 * re-tile on every jittery second is worse than a stale tile. */
static bool liveness_step(_Atomic unsigned long *pkts, unsigned long *seen, int *misses,
                          bool *live) {
    bool changed = false;
    for (int i = 0; i < CALL_MAX_PEERS; i++) {
        unsigned long now = pkts[i];
        bool moving = now != seen[i];
        seen[i] = now;
        if (moving) {
            misses[i] = 0;
            if (!live[i]) {
                live[i] = true;
                changed = true;
            }
        } else if (live[i] && ++misses[i] >= CALL_TILE_MISSES) {
            live[i] = false;
            changed = true;
        }
    }
    return changed;
}

static void media_supervise(struct call *c) {
    if (liveness_step(c->apkts, c->aseen, c->amisses, c->alive)) audio_retile(c);
    if (c->want_video && liveness_step(c->vpkts, c->vseen, c->vmisses, c->vlive)) video_retile(c);
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
    if (c->pub.active && c->pub.gathering != RTC_GATHERING_COMPLETE) return false;
    for (int i = 0; i < c->sub_count; i++)
        if (c->sub[i].active && c->sub[i].gathering != RTC_GATHERING_COMPLETE) return false;
    return true;
}

/* The PUBLISH is what a call depends on; a peer that never came up is a
 * person who is not here, not a broken call. So the wait ends when
 * publishing has settled and every subscribe has stopped moving. */
static bool all_settled(const struct call *c) {
    if (!session_settled(&c->pub)) return false;
    for (int i = 0; i < c->sub_count; i++)
        if (!session_settled(&c->sub[i])) return false;
    return true;
}

static bool session_up(const struct session *s) { return !s->active || s->state == RTC_CONNECTED; }

static bool publish_up(const struct call *c) { return session_up(&c->pub); }

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
    /* NO UDP mux.
     *
     * It looked like the tidy choice — one local port, one firewall
     * rule — and with TWO peer connections in one process it is a
     * collision: both ask libjuice for the same muxed socket and the
     * second never completes ICE, which the SFU reports as "deadline
     * exceeded while waiting connection" and the user sees as a call
     * with sound one way. The mux that matters is the SERVER's
     * (webrtcLocalUDPAddress), and that is unaffected: our side dialling
     * out from ephemeral ports is what every browser already does. */

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
        /* RECEIVING: offer EVERY codec we can decode and let the server
         * answer with the one this peer actually publishes.
         *
         * The codec is a property of the PUBLISHER, not of the room. An
         * SFU does not transcode, so a browser sending H.264 and a
         * terminal sending VP8 in the same call is ordinary — and a
         * subscriber that offered only its own preference would see a
         * black tile for half the people in the room, with no error
         * anywhere. Every peer is a separate WHEP session, so each one
         * settles independently, which is exactly the granularity the
         * problem has.
         *
         * SENDING is the opposite case and stays a choice: we have to
         * encode SOMETHING, so `call.video_codec` decides, and offering
         * a list there would only be ambiguous.
         *
         * The multi-codec m-line is built by hand because rtcAddTrackEx
         * takes one codec per track. If that is refused we fall back to
         * the single-codec track rather than losing video entirely —
         * reported, never silent, because it means this peer is only
         * watchable if they happen to publish what we guessed. */
        bool receiving = dir == RTC_DIRECTION_RECVONLY;
        s->video_track = -1;
        if (receiving) {
            char mline[768];
            if (media_video_offer_mline(mcfg->video_payload_type, mcfg->video_payload_type + 1,
                                        mline, sizeof(mline)))
                s->video_track = rtcAddTrack(s->pc, mline);
            if (s->video_track < 0)
                note("%s: the multi-codec offer was refused — falling back to %s only", s->label,
                     media_video_codec_name(mcfg->video_codec));
        }
        if (s->video_track < 0) {
            rtcTrackInit vid;
            memset(&vid, 0, sizeof(vid));
            vid.direction = dir;
            if (mcfg->video_codec == MEDIA_VIDEO_H264) {
                vid.codec = RTC_CODEC_H264;
                /* Spelled out rather than left NULL: the C API turns a
                 * NULL profile into NO fmtp line at all, and an H.264
                 * m-line without packetization-mode is one a browser may
                 * decline or read as single-NAL. Constrained Baseline
                 * 3.1 is what the capture leg is told to produce. */
                vid.profile =
                    "profile-level-id=42e01f;packetization-mode=1;level-asymmetry-allowed=1";
            } else {
                vid.codec = RTC_CODEC_VP8;
            }
            vid.payloadType = mcfg->video_payload_type;
            vid.ssrc = mcfg->video_ssrc;
            vid.mid = "video";
            vid.name = "shottino";
            vid.msid = "shottino";
            vid.trackId = "video";
            s->video_track = rtcAddTrackEx(s->pc, &vid);
        }
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

    /* The whole answer, at --verbose. Everything that goes wrong past
     * this point — a codec we did not expect, a track that never
     * carries RTP, a media section the server declined — is decided by
     * these few hundred bytes, and without them the symptom is always
     * the same silent black window. */
    note("%s: answer\n%s", s->label, resp.body);

    bool ok = rtcSetRemoteDescription(s->pc, resp.body, "answer") >= 0;
    if (!ok) emit_event("error", "message", "the SDP answer was rejected");

    /* WHAT THIS PEER ACTUALLY PUBLISHES, read out of their answer.
     *
     * The offer named every codec we can decode; the answer says which
     * one the server settled on, and under which payload type. That is
     * per-peer information and it has to reach that peer's decoder — a
     * global setting would decode one participant as another. Read
     * before the body is freed, and only for a session that receives.
     *
     * An answer with no video we recognise leaves the leg on the
     * configured default and SAYS SO. It is not fatal: their audio
     * still works, and the alternative — dropping the peer — turns a
     * codec we did not expect into a person who vanished. */
    if (ok && video && s->receives && s->slot >= 0 && s->slot < CALL_MAX_PEERS) {
        struct media_leg *leg = &s->owner->vmix.legs[s->slot];
        enum media_video_codec got;
        int pt = 0;
        if (media_sdp_video_codec(resp.body, &got, &pt)) {
            leg->codec = got;
            leg->payload_type = pt;
            note("%s %d: publishing %s (payload type %d)", s->label, s->slot,
                 media_video_codec_name(got), pt);
        } else {
            note("%s %d: the answer named no video codec we can decode — assuming %s",
                 s->label, s->slot, media_video_codec_name(leg->codec));
        }
    }
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

/* Put a session back to the state session_negotiate expects.
 *
 * A retry cannot reuse what the last attempt left behind: the gathering
 * state in particular, because all_gathered() is what the negotiate
 * waits on, and a stale COMPLETE from the previous attempt makes it
 * return before the NEW connection has gathered anything at all. */
static void session_reset(struct session *s) {
    s->pc = -1;
    s->audio_track = s->video_track = -1;
    s->state = RTC_NEW;
    s->gathering = RTC_GATHERING_NEW;
    s->have_resource = false;
    s->active = false;
    s->resource[0] = 0;
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
            "  --frame <WxH>    what we DECODE to, in pixels (default 320x240)\n"
            "  --capture <WxH[@fps]>  what we SEND (default 640x480@20) — the far end\n"
            "                   may be a browser, so this is not the render size\n"
            "  --bitrate <kbps> video bitrate we send (default 800)\n"
            "  --video-codec <c>  what we SEND: vp8 (default) or h264. Receiving needs\n"
            "                   no setting — every codec we decode is offered and each\n"
            "                   peer is decoded as whatever their answer settled on\n"
            "  --fps <n>        video frame rate (default 10)\n"
            "  --verbose        interleave '#' notes on stderr\n"
            "  --protocol       print the helper protocol version and exit\n"
            "\n"
            "Control verbs on stdin, one per line: mute, unmute, camera on, camera off,\n"
            "hangup. Events are JSON lines on stderr; stdout carries rgb24 frames.\n");
}

int main(int argc, char **argv) {
    const char *whip_url = NULL;
    const char *whep_urls[CALL_MAX_PEERS];
    int whep_count = 0;
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
                                 .capture_w = 640,
                                 .capture_h = 480,
                                 .capture_fps = 20,
                                 .video_kbps = 800,
                                 .video_codec = MEDIA_VIDEO_VP8,
                                 .want_video = false };

    enum { OPT_AUDIO_SRC = 1000, OPT_VIDEO_SRC, OPT_AUDIO_SINK, OPT_FRAME, OPT_FPS, OPT_WHEP,
           OPT_CAPTURE, OPT_KBPS, OPT_VCODEC };
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
        { "capture", required_argument, NULL, OPT_CAPTURE },
        { "bitrate", required_argument, NULL, OPT_KBPS },
        { "video-codec", required_argument, NULL, OPT_VCODEC },
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
        case OPT_WHEP:
            /* Repeatable: one per person in the call. */
            if (whep_count < CALL_MAX_PEERS) whep_urls[whep_count++] = optarg;
            else emit_event("error", "message", "too many peers — extra --whep ignored");
            break;
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
        case OPT_CAPTURE:
            if (sscanf(optarg, "%dx%d@%d", &mcfg.capture_w, &mcfg.capture_h, &mcfg.capture_fps) < 2 ||
                mcfg.capture_w <= 0 || mcfg.capture_h <= 0) {
                emit_event("error", "message", "--capture wants WxH or WxH@fps, e.g. 640x480@20");
                return 2;
            }
            break;
        case OPT_KBPS: mcfg.video_kbps = atoi(optarg); break;
        case OPT_VCODEC:
            /* Refused rather than defaulted: asking for h264 and
             * silently getting VP8 is the exact failure this is for. */
            if (!media_video_codec_parse(optarg, &mcfg.video_codec)) {
                emit_event("error", "message", "--video-codec wants vp8 or h264");
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
    if (!whip_url && whep_count == 0) {
        usage(stderr);
        return 2;
    }
    if (timeout_ms < 1000) timeout_ms = 1000;
    mcfg.want_video = video;
    if (mcfg.fps < 1 || mcfg.fps > 30) mcfg.fps = 10;
    if (mcfg.capture_fps < 1 || mcfg.capture_fps > 60) mcfg.capture_fps = 20;

    /* SIGPIPE would kill the process the moment shottino closes the
     * frame pipe; the read/write paths report the error instead. */
    signal(SIGPIPE, SIG_IGN);
    signal(SIGINT, on_signal);
    signal(SIGTERM, on_signal);

    rtcInitLogger(verbose ? RTC_LOG_WARNING : RTC_LOG_NONE, on_rtc_log);

    struct call call;
    memset(&call, 0, sizeof(call));
    pthread_mutex_init(&call.lock, NULL);
    pthread_cond_init(&call.cv, NULL);
    call.pub.owner = &call;
    call.pub.label = "publish";
    call.pub.pc = -1;
    call.pub.audio_track = call.pub.video_track = -1;
    call.pub.slot = -1;
    call.sub_count = whep_count;
    for (int i = 0; i < CALL_MAX_PEERS; i++) {
        call.sub[i].owner = &call;
        call.sub[i].label = "subscribe";
        call.sub[i].pc = -1;
        call.sub[i].audio_track = call.sub[i].video_track = -1;
        call.sub[i].slot = i;

    }
    call.send_audio.fd = call.send_video.fd = -1;
    call.send_audio.pid = call.send_video.pid = -1;
    pthread_mutex_init(&call.vlock, NULL);
    call.vmix.pid = -1;
    call.amix.pid = -1;
    for (int i = 0; i < MEDIA_MAX_PEERS; i++) {
        call.amix.legs[i].fd = -1;
        call.amix.legs[i].pid = -1;
        call.vmix.legs[i].fd = -1;
        call.vmix.legs[i].pid = -1;
        /* Until this peer's answer says otherwise. Every leg is
         * overwritten from its own answer during negotiation; this is
         * only what an answer that named nothing we understand falls
         * back to, so that a leg is never prepared with a codec of
         * zero-by-accident. */
        call.vmix.legs[i].codec = mcfg.video_codec;
        call.vmix.legs[i].payload_type = mcfg.video_payload_type;
    }
    call.want_video = video;
    call.frame_fd = STDOUT_FILENO;
    call.cfg = &mcfg;

    /* Which session receives, and therefore which direction each one
     * negotiates. Decided ONCE, here, so nothing downstream has to work
     * it out again and reach a different answer. */
    bool paired = whip_url && whep_count > 0;
    for (int i = 0; i < whep_count; i++) call.sub[i].receives = true;
    call.pub.receives = whip_url && whep_count == 0;

    pthread_t pump = 0;
    bool pumping = false;
    bool ok = true;
    if (whip_url)
        ok = session_negotiate(&call.pub, whip_url,
                               paired ? RTC_DIRECTION_SENDONLY : RTC_DIRECTION_SENDRECV, video,
                               &mcfg, stun, timeout_ms);
    /* Capture starts as soon as the SFU has ACCEPTED the publish, not
     * after the connection completes.
     *
     * MediaMTX allows about two seconds from peer-connection to first
     * RTP and then drops the publisher with "deadline exceeded while
     * waiting tracks" — after which every WHEP read is a 404 and the
     * failure looks like a subscribe bug. ffmpeg cannot fork, exec, open
     * a device and encode a first frame inside that window if it only
     * starts once ICE is done, so it gets its head start while ICE runs
     * and the pump delivers the moment the track is up.
     *
     * The device still does not open until the SFU said yes, which is
     * the gate that matters: a call nobody accepted never lights the
     * microphone. */
    if (ok && whip_url) {
        if (!media_start_send(&call.send_audio, &mcfg, false))
            emit_event("error", "message", "cannot open the microphone");
        if (video && !media_start_send(&call.send_video, &mcfg, true))
            emit_event("error", "message", "cannot open the camera");
        pumping = pthread_create(&pump, NULL, pump_main, &call) == 0;
    }

    /* The subscribe waits for the publish to be CONNECTED, not merely
     * accepted.
     *
     * An SFU that separates the two has nothing to read until a
     * publisher is actually live: MediaMTX answers the WHEP POST with a
     * 404 if the path has no active publisher, and the publish is not
     * active the instant its own POST returns — ICE still has to
     * complete. Measured against a real server, which is the only place
     * this shows: a stub answers the same either way. */
    if (ok && whep_count > 0 && whip_url) {
        note("subscribe: waiting for the publish to come up");
        if (!wait_until(&call, publish_up, timeout_ms)) {
            emit_event("error", "message",
                       "the publish never connected — check the SFU's advertised public IP");
            ok = false;
        }
    }
    /* Every peer gets its own session, and a peer that FAILS does not
     * fail the call: in a channel most members are not in it, so their
     * path has no publisher and the SFU rightly says 404. That is a
     * person who is not here, reported and stepped over. */
    int joined = 0;
    for (int i = 0; ok && i < whep_count; i++) {
        /* EVERY peer gets a video track, not just the first.
         *
         * `video && i == 0` was right when the picture was one tile
         * taken from one peer, and it silently outlived that: the mix
         * composites up to CALL_TILE_MAX pictures, but only slot 0 ever
         * had a video track to receive on, so a group call could never
         * show more than one person however good the grid was. Caught
         * against the real SFU, where two publishers produced exactly
         * one tile. */
        if (session_negotiate(&call.sub[i], whep_urls[i], RTC_DIRECTION_RECVONLY, video, &mcfg,
                              stun, timeout_ms)) {
            joined++;
        } else {
            note("subscribe %d: not in the call", i);
            /* RELEASED, not merely reported.
             *
             * session_negotiate marks a session active the moment it
             * creates the peer connection, which is before the POST that
             * can refuse it. Left active, a peer who is simply not in
             * the call yet is a session that never reaches a settled
             * state, so all_settled() waits for it until the timeout and
             * the whole call is then declared dead — with a message
             * blaming the SFU's public IP.
             *
             * That is the NORMAL case for a channel: most members are
             * not in the call, so most subscribes are refused with a
             * 404. Measured against a real server, where the first
             * caller in a room killed their own call waiting for the
             * second to arrive. */
            session_release(&call.sub[i]);
        }
    }
    if (whep_count > 0 && joined == 0 && !whip_url) {
        emit_event("error", "message", "nobody is in this call yet");
        ok = false;
    }

    bool connected = false;
    if (ok) {
        emit_event("negotiated", "resource",
                   call.pub.have_resource ? call.pub.resource : call.sub[0].resource);
        /* Connected means OUR end is up. A peer who never answered is
         * absent, not a failure — otherwise one silent member of a
         * channel would end everybody else's call. */
        connected = wait_until(&call, all_settled, timeout_ms) && session_up(&call.pub);
        if (!connected && !stop_requested)
            emit_event("error", "message",
                       "the media path never came up — check the SFU's advertised public IP");
    }

    if (connected) {
        /* Devices open AFTER the connection is up, never before: opening
         * a microphone for a call that then fails to connect turns a
         * negotiation error into a recording light nobody asked for. A
         * watch-only session opens neither. */
        bool sending = whip_url != NULL;
        /* NEITHER mix is started here. Both are built by the supervisor
         * a tick later, from the peers whose RTP is actually arriving —
         * which is the same path that adds a late joiner and drops
         * somebody who muted or turned their camera off. Building them
         * here over whoever happened to be connected at this instant is
         * exactly what left a late joiner inaudible. */
        emit_event("media", "value",
                   sending ? (video ? "audio+video" : "audio")
                           : (video ? "watching audio+video" : "watching audio"));
    }

    /* Control lines on stdin, one verb per line. Blocking reads on a
     * pipe shottino owns; poll so a closed pipe or a signal ends the
     * call rather than parking this thread forever. */
    time_t last_tile_check = 0;
    time_t last_resub = 0;
    int resub_next = 0;
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
            /* NO `focus` verb, deliberately. Who is big is decided
             * where the drawing happens, by sampling a cell out of the
             * published grid — the helper composites the same even grid
             * either way. Handling focus here is what used to make it
             * cost a decoder restart. */
            else if (strncmp(line, "frame ", 6) == 0) {
                /* The window changed size or the call moved between the
                 * corner box and its own window. The helper still never
                 * GUESSES a geometry — it is told one, exactly as at
                 * startup — but it is no longer told only once. */
                int w = 0, h = 0;
                if (sscanf(line + 6, "%dx%d", &w, &h) == 2 && w > 0 && h > 0) {
                    mcfg.frame_w = w;
                    mcfg.frame_h = h;
                    video_retile(&call);
                }
            }
            else if (line[0]) continue; /* unknown verb: never fatal */
            emit_event("control", "value", line);
        }
        /* Who is sending, on a slow tick. See media_supervise():
         * membership cannot be assumed from who connected, or one peer
         * with the camera off freezes the mix. */
        time_t now = time(NULL);
        if (connected && now - last_tile_check >= CALL_TILE_TICK_SECS) {
            last_tile_check = now;
            media_supervise(&call);
        }

        /* THE RESUBSCRIBE LOOP: retry the peers who were not there.
         *
         * A subscribe is refused with a 404 when that person has no
         * publisher, and until now that was final — so whoever placed
         * the call subscribed to an empty room, was told no, and never
         * asked again. The FIRST person in every call saw nobody, for
         * as long as the call lasted, while everyone who arrived after
         * them saw everyone. That asymmetry was the whole bug.
         *
         * One peer per tick, round-robin, rather than all of them:
         * session_negotiate is synchronous and gathers ICE before it
         * posts, so retrying a channel's worth of absent members in one
         * pass would stall the control verbs behind it. A query has one
         * peer and therefore retries every interval; a big channel
         * cycles, which is the right trade — the absent are many and
         * each is cheap to miss once more.
         *
         * Success needs no further wiring: the new session's RTP starts
         * arriving, the supervisor sees the packets on the next tick,
         * and both mixes rebuild to include them. */
        if (connected && whep_count > 0 && now - last_resub >= CALL_RESUB_SECS) {
            last_resub = now;
            for (int tries = 0; tries < whep_count; tries++) {
                int i = resub_next % whep_count;
                resub_next++;
                if (call.sub[i].active) continue; /* already here */
                session_reset(&call.sub[i]);
                if (session_negotiate(&call.sub[i], whep_urls[i], RTC_DIRECTION_RECVONLY, video,
                                      &mcfg, stun, timeout_ms)) {
                    note("subscribe %d: joined late", i);
                    emit_event("peer", "value", "joined");
                } else {
                    session_release(&call.sub[i]); /* still not there */
                }
                break; /* ONE per tick, whatever the outcome */
            }
        }
        pthread_mutex_lock(&call.lock);
        bool still = session_up(&call.pub);
        pthread_mutex_unlock(&call.lock);
        if (!still) break;
    }

    /* TEARDOWN IS AN ORDER, and the order is: stop everything that can
     * TOUCH a resource before releasing the resource.
     *
     * Every one of the three writers here reaches the media legs, and
     * each is silenced in turn:
     *
     *   - the pump thread, joined;
     *   - the RTP callbacks, which run on libdatachannel's threads and
     *     stop only when the peer connections are gone and rtcCleanup()
     *     has joined the pool;
     *   - this thread, which then closes the sockets with nobody left
     *     to race.
     *
     * The legs USED to go first, while the peer connections were still
     * alive two lines below. media_stop() closes a leg's fd and blanks
     * it as two separate stores, and media_feed()'s `fd < 0` guard is
     * read before the sendto — so an RTP packet arriving during hangup
     * could pass the guard, have the fd closed under it, and then write
     * to a descriptor number session_release() had already recycled for
     * its hangup socket. The callbacks take `vlock` with TRYLOCK, which
     * is a BACKPRESSURE primitive (a re-tile is in progress, drop the
     * packet) and not a lifetime barrier: teardown never held it, so it
     * always succeeded, and the guard read as protection it was not
     * giving.
     *
     * Wrapping the media teardown in `vlock` would also have closed the
     * window, and is what the report suggested. Ordering is preferred
     * because it deletes the concurrency instead of synchronising it:
     * there is no window left to reason about, no future callback that
     * has to remember the lock, and no interval during which live peer
     * connections point at legs that have already been freed. The cost
     * is that the decoders now outlive the hangup DELETEs by however
     * long the SFU takes to answer them — ffmpeg processes reading
     * loopback sockets that have gone quiet, killed a moment later. */
    stop_requested = 1; /* ends the pump */
    if (pumping) pthread_join(pump, NULL);
    session_release(&call.pub);
    for (int i = 0; i < CALL_MAX_PEERS; i++) session_release(&call.sub[i]);
    rtcCleanup();
    media_stop(&call.send_audio);
    media_stop(&call.send_video);
    media_mix_free(&call.amix);
    media_mix_free(&call.vmix);
    emit_event("closed", NULL, NULL);
    return connected ? 0 : 1;
}
