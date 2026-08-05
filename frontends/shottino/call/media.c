/* media.c — see media.h for the ffmpeg-does-codecs split. */
#include "media.h"

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>

#define MEDIA_MAX_ARGS 64

const char *media_video_codec_name(enum media_video_codec codec) {
    return codec == MEDIA_VIDEO_H264 ? "H264" : "VP8";
}

bool media_video_codec_parse(const char *word, enum media_video_codec *out) {
    if (!word || !out) return false;
    if (strcmp(word, "vp8") == 0 || strcmp(word, "VP8") == 0) {
        *out = MEDIA_VIDEO_VP8;
        return true;
    }
    if (strcmp(word, "h264") == 0 || strcmp(word, "H264") == 0 || strcmp(word, "H.264") == 0) {
        *out = MEDIA_VIDEO_H264;
        return true;
    }
    return false;
}

int media_bind_loopback(int *port_out) {
    int fd = socket(AF_INET, SOCK_DGRAM, 0);
    if (fd < 0) return -1;
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = 0; /* the kernel picks; asking for a fixed one is how
                        * two calls on one machine collide */
    if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
        close(fd);
        return -1;
    }
    socklen_t len = sizeof(addr);
    if (getsockname(fd, (struct sockaddr *)&addr, &len) != 0) {
        close(fd);
        return -1;
    }
    if (port_out) *port_out = ntohs(addr.sin_port);
    return fd;
}

/* Split shottino's `format:input` spelling, which is what /voicemsg and
 * /video already use, so one device setting serves every feature. A
 * source without a colon is taken as an input with ffmpeg's default
 * demuxer, which is what a bare file path wants. */
static void split_source(const char *source, const char **fmt, const char **input,
                         char *scratch, size_t scratch_sz) {
    snprintf(scratch, scratch_sz, "%s", source ? source : "");
    char *colon = strchr(scratch, ':');
    if (colon) {
        *colon = 0;
        *fmt = scratch;
        *input = colon + 1;
    } else {
        *fmt = NULL;
        *input = scratch;
    }
}

/* fork+exec ffmpeg with stdout wired to `stdout_fd` (or /dev/null) and
 * stderr discarded.
 *
 * ffmpeg's own diagnostics are dropped rather than merged into stderr:
 * stderr here is the JSON event stream shottino parses, and ffmpeg's
 * progress lines would be garbage in it. A failure shows as the process
 * dying, which the caller sees. */
static pid_t spawn_ffmpeg(char *const argv[], int stdout_fd) {
    pid_t pid = fork();
    if (pid < 0) return -1;
    if (pid == 0) {
        int devnull = open("/dev/null", O_RDWR);
        if (devnull >= 0) {
            dup2(devnull, STDIN_FILENO);
            dup2(stdout_fd >= 0 ? stdout_fd : devnull, STDOUT_FILENO);
            dup2(devnull, STDERR_FILENO);
            if (devnull > STDERR_FILENO) close(devnull);
        }
        execvp("ffmpeg", argv);
        _exit(127);
    }
    return pid;
}

bool media_start_send(struct media_leg *leg, const struct media_config *cfg, bool video) {
    memset(leg, 0, sizeof(*leg));
    leg->pid = -1;
    leg->fd = -1;
    leg->video = video;
    if (!cfg) return false;

    int port = 0;
    leg->fd = media_bind_loopback(&port);
    if (leg->fd < 0) return false;

    char scratch[256];
    const char *fmt = NULL, *input = NULL;
    split_source(video ? cfg->video_source : cfg->audio_source, &fmt, &input, scratch,
                 sizeof(scratch));

    char dest[64], pt[16], ssrc[16], rate[16], bitrate[16], vfilter[160], gop[16];
    snprintf(dest, sizeof(dest), "rtp://127.0.0.1:%d", port);
    snprintf(pt, sizeof(pt), "%d", video ? cfg->video_payload_type : cfg->audio_payload_type);
    snprintf(ssrc, sizeof(ssrc), "%u", (unsigned)(video ? cfg->video_ssrc : cfg->audio_ssrc));
    /* CAPTURE geometry, never the render box: see media.h. */
    int cw = cfg->capture_w > 0 ? cfg->capture_w : 640;
    int ch = cfg->capture_h > 0 ? cfg->capture_h : 480;
    int cfps = cfg->capture_fps > 0 ? cfg->capture_fps : 20;
    snprintf(rate, sizeof(rate), "%d", cfps);
    snprintf(vfilter, sizeof(vfilter), "fps=%d,scale=%d:%d:force_original_aspect_ratio=decrease,"
                                       "pad=%d:%d:(ow-iw)/2:(oh-ih)/2",
             cfps, cw, ch, cw, ch);
    /* Audio is Opus at conversational quality; video is whatever the
     * sender was told to spend, because the RECEIVER decides what it
     * can use and a browser can use a great deal more than a terminal. */
    if (video) snprintf(bitrate, sizeof(bitrate), "%dk", cfg->video_kbps > 0 ? cfg->video_kbps : 800);
    else snprintf(bitrate, sizeof(bitrate), "24k");
    /* A keyframe every two seconds, for BOTH codecs.
     *
     * This is what a late joiner costs: a decoder that attaches to a
     * stream mid-flight shows nothing until the next keyframe, and the
     * defaults are hopeless for a call — x264's keyint is 250 frames,
     * twelve seconds at this rate, and there is no PLI path here to ask
     * for one. In a group call somebody is ALWAYS joining late, and the
     * video mix restarts on a re-tile besides. Two seconds of black is
     * a hiccup; twelve is a bug report. */
    snprintf(gop, sizeof(gop), "%d", cfps * 2);

    char *argv[MEDIA_MAX_ARGS];
    size_t n = 0;
    argv[n++] = (char *)"ffmpeg";
    argv[n++] = (char *)"-nostdin";
    argv[n++] = (char *)"-loglevel";
    argv[n++] = (char *)"error";
    if (fmt && fmt[0]) {
        argv[n++] = (char *)"-f";
        argv[n++] = (char *)fmt;
    }
    argv[n++] = (char *)"-i";
    argv[n++] = (char *)input;
    if (video) {
        /* Rate and size are enforced in the FILTER graph, never as input
         * options. `-framerate`/`-video_size` are demuxer-specific: v4l2
         * takes them, lavfi refuses them outright ("Option framerate not
         * found"), and the capture then dies with its stderr discarded —
         * a silent leg producing no packets. A filter works for every
         * input, and it also guarantees the encoder gets exactly the
         * geometry that was promised whatever the device felt like
         * giving. */
        argv[n++] = (char *)"-vf";
        argv[n++] = vfilter;
        argv[n++] = (char *)"-an";
        argv[n++] = (char *)"-c:v";
        if (cfg->video_codec == MEDIA_VIDEO_H264) {
            argv[n++] = (char *)"libx264";
            argv[n++] = (char *)"-b:v";
            argv[n++] = bitrate;
            /* Real time beats quality: a frame that arrives late is
             * worse than a frame that arrived rough. */
            argv[n++] = (char *)"-preset";
            argv[n++] = (char *)"ultrafast";
            argv[n++] = (char *)"-tune";
            argv[n++] = (char *)"zerolatency";
            /* Constrained Baseline, which is what libdatachannel offers
             * (profile-level-id=42e01f) and what every browser and phone
             * decodes. A stream whose profile is above what the offer
             * promised is one the far end is entitled to drop. */
            argv[n++] = (char *)"-profile:v";
            argv[n++] = (char *)"baseline";
            argv[n++] = (char *)"-pix_fmt";
            argv[n++] = (char *)"yuv420p";
            /* SPS/PPS in front of every keyframe, not once at the start.
             * There is no out-of-band sprop-parameter-sets on this path,
             * so a decoder that attached late has no other way to learn
             * the parameter sets and stays blank forever. */
            argv[n++] = (char *)"-bsf:v";
            argv[n++] = (char *)"dump_extra";
        } else {
            argv[n++] = (char *)"libvpx";
            argv[n++] = (char *)"-b:v";
            argv[n++] = bitrate;
            argv[n++] = (char *)"-deadline";
            argv[n++] = (char *)"realtime";
            argv[n++] = (char *)"-cpu-used";
            argv[n++] = (char *)"8";
        }
        argv[n++] = (char *)"-g";
        argv[n++] = gop;
    } else {
        argv[n++] = (char *)"-vn";
        argv[n++] = (char *)"-c:a";
        argv[n++] = (char *)"libopus";
        argv[n++] = (char *)"-b:a";
        argv[n++] = bitrate;
        argv[n++] = (char *)"-ar";
        argv[n++] = (char *)"48000";
        argv[n++] = (char *)"-ac";
        argv[n++] = (char *)"2";
    }
    argv[n++] = (char *)"-payload_type";
    argv[n++] = pt;
    argv[n++] = (char *)"-ssrc";
    argv[n++] = ssrc;
    argv[n++] = (char *)"-f";
    argv[n++] = (char *)"rtp";
    /* RTP payloads small enough to SURVIVE the transport.
     *
     * ffmpeg's RTP muxer defaults to 1472 bytes, sized for a bare
     * 1500-byte Ethernet MTU with room for UDP and IP. WebRTC then adds
     * DTLS-SRTP on top, and the result no longer fits: libjuice refuses
     * it outright with "Send failed, datagram is too large" and the
     * packet never leaves the machine.
     *
     * It only ever bit VIDEO, which is why it survived this long. Opus
     * frames are a hundred-odd bytes and never came close, so audio
     * calls worked perfectly while video produced no picture and no
     * error anybody saw — the failure was a libdatachannel log line on
     * a stream that was being discarded. 1200 is the number every
     * browser uses for the same reason. */
    argv[n++] = (char *)"-pkt_size";
    argv[n++] = (char *)"1200";
    argv[n++] = dest;
    argv[n] = NULL;

    leg->pid = spawn_ffmpeg(argv, -1);
    if (leg->pid < 0) {
        close(leg->fd);
        leg->fd = -1;
        return false;
    }
    return true;
}

bool media_recv_sdp_audio(int port, int payload_type, char *out, size_t out_sz) {
    if (!out || out_sz == 0 || port <= 0 || payload_type < 0) return false;
    /* c= is the loopback the helper writes to; the rtpmap must match
     * what the offer negotiated or the decoder sits silent with no
     * error, which is the least debuggable failure this design has. */
    int w = snprintf(out, out_sz,
                     "v=0\r\n"
                     "o=- 0 0 IN IP4 127.0.0.1\r\n"
                     "s=shottino\r\n"
                     "c=IN IP4 127.0.0.1\r\n"
                     "t=0 0\r\n"
                     "m=audio %d RTP/AVP %d\r\n"
                     "a=rtpmap:%d opus/48000/2\r\n",
                     port, payload_type, payload_type);
    return w > 0 && (size_t)w < out_sz;
}

bool media_recv_sdp_video(int port, enum media_video_codec codec, int payload_type, char *out,
                          size_t out_sz) {
    if (!out || out_sz == 0 || port <= 0 || payload_type < 0) return false;
    /* H.264 additionally needs its packetization mode spelled out: a
     * depacketiser told nothing assumes single-NAL, and a real sender
     * fragments (FU-A) the moment a frame exceeds the MTU — which is
     * every keyframe. The result is a decoder that reports nothing and
     * shows nothing. VP8 carries no such ambiguity, so it gets no fmtp
     * rather than an empty one. */
    char fmtp[64] = { 0 };
    if (codec == MEDIA_VIDEO_H264)
        snprintf(fmtp, sizeof(fmtp), "a=fmtp:%d packetization-mode=1\r\n", payload_type);
    int w = snprintf(out, out_sz,
                     "v=0\r\n"
                     "o=- 0 0 IN IP4 127.0.0.1\r\n"
                     "s=shottino\r\n"
                     "c=IN IP4 127.0.0.1\r\n"
                     "t=0 0\r\n"
                     "m=video %d RTP/AVP %d\r\n"
                     "a=rtpmap:%d %s/90000\r\n"
                     "%s",
                     port, payload_type, payload_type, media_video_codec_name(codec), fmtp);
    return w > 0 && (size_t)w < out_sz;
}

bool media_video_offer_mline(int vp8_payload_type, int h264_payload_type, char *out,
                             size_t out_sz) {
    if (!out || out_sz == 0 || vp8_payload_type < 0 || h264_payload_type < 0) return false;
    if (vp8_payload_type == h264_payload_type) return false; /* one number, two meanings */
    /* Port 9 and the discard address are what an offer carries before
     * ICE has said anything; libdatachannel fills in the rest. The
     * rtcp-fb lines are the ones it emits itself for a video codec, and
     * a server that sees them knows it may ask for a keyframe — which
     * matters here, since a subscriber joins mid-stream. */
    int w = snprintf(out, out_sz,
                     "m=video 9 UDP/TLS/RTP/SAVPF %d %d\r\n"
                     "c=IN IP4 0.0.0.0\r\n"
                     "a=mid:video\r\n"
                     "a=recvonly\r\n"
                     "a=rtcp-mux\r\n"
                     "a=rtpmap:%d VP8/90000\r\n"
                     "a=rtcp-fb:%d nack\r\n"
                     "a=rtcp-fb:%d nack pli\r\n"
                     "a=rtcp-fb:%d goog-remb\r\n"
                     "a=rtpmap:%d H264/90000\r\n"
                     "a=fmtp:%d profile-level-id=42e01f;packetization-mode=1;"
                     "level-asymmetry-allowed=1\r\n"
                     "a=rtcp-fb:%d nack\r\n"
                     "a=rtcp-fb:%d nack pli\r\n"
                     "a=rtcp-fb:%d goog-remb\r\n",
                     vp8_payload_type, h264_payload_type, vp8_payload_type, vp8_payload_type,
                     vp8_payload_type, vp8_payload_type, h264_payload_type, h264_payload_type,
                     h264_payload_type, h264_payload_type, h264_payload_type);
    return w > 0 && (size_t)w < out_sz;
}

/* The start of the line `name` introduces, within [p, end). */
static const char *sdp_find_line(const char *p, const char *end, const char *name) {
    size_t n = strlen(name);
    while (p && p < end) {
        if ((size_t)(end - p) >= n && strncmp(p, name, n) == 0) return p;
        const char *nl = memchr(p, '\n', (size_t)(end - p));
        if (!nl) return NULL;
        p = nl + 1;
    }
    return NULL;
}

bool media_sdp_video_codec(const char *sdp, enum media_video_codec *codec, int *payload_type) {
    if (!sdp || !codec || !payload_type) return false;
    const char *end = sdp + strlen(sdp);
    const char *m = sdp;
    /* The VIDEO m-line, and only the attributes belonging to it: an
     * a=rtpmap under the audio section would otherwise be read as the
     * video codec, which is how a call ends up decoding Opus as VP8. */
    for (;;) {
        m = sdp_find_line(m, end, "m=");
        if (!m) return false;
        if (strncmp(m, "m=video ", 8) == 0) break;
        const char *nl = memchr(m, '\n', (size_t)(end - m));
        if (!nl) return false;
        m = nl + 1;
    }
    int port = 0;
    if (sscanf(m, "m=video %d", &port) != 1) return false;
    /* Port 0 means the far end REJECTED the media. Reporting that as
     * "no video" rather than falling through to a default is the whole
     * reason this returns a bool. */
    if (port == 0) return false;

    /* This section ends where the next m-line begins. */
    const char *nl = memchr(m, '\n', (size_t)(end - m));
    const char *section = nl ? nl + 1 : end;
    const char *next = section;
    for (;;) {
        next = sdp_find_line(next, end, "m=");
        if (!next || next >= section) break;
    }
    const char *sec_end = next ? next : end;

    /* The FIRST rtpmap we recognise wins: an answer lists what the
     * server settled on, and where it lists several the order is its
     * preference. */
    const char *p = section;
    while (p < sec_end) {
        const char *line = sdp_find_line(p, sec_end, "a=rtpmap:");
        if (!line || line >= sec_end) break;
        int pt = 0;
        char name[32] = "";
        if (sscanf(line, "a=rtpmap:%d %31[^/]", &pt, name) == 2 && pt >= 0) {
            enum media_video_codec found;
            if (media_video_codec_parse(name, &found)) {
                *codec = found;
                *payload_type = pt;
                return true;
            }
        }
        const char *ln = memchr(line, '\n', (size_t)(sec_end - line));
        if (!ln) break;
        p = ln + 1;
    }
    return false;
}

/* Round down to even. The composited frame is drawn as half blocks —
 * two pixel rows per cell — so an odd height loses its bottom row, and
 * an odd width upsets every scaler that ever meets a chroma plane. */
static int even_down(int v) { return v & ~1; }

/* Smallest k with k*k >= n, for n up to the peer cap. */
static int grid_cols_for(int n) {
    int k = 1;
    while (k * k < n) k++;
    return k;
}

int media_grid_layout(const int *slots, int n, int frame_w, int frame_h, struct media_tile *out,
                      int max) {
    if (n <= 0 || max <= 0 || !out || !slots || frame_w <= 0 || frame_h <= 0) return 0;
    if (n > max) n = max;

    /* Wider than tall: one row of two beats a column of two, because a
     * terminal cell is about twice as tall as it is wide and the
     * pictures are landscape to begin with. */
    int cols = grid_cols_for(n);
    int rows = (n + cols - 1) / cols;
    int cw = even_down(frame_w / cols), ch = even_down(frame_h / rows);
    /* Below this a cell carries nothing a viewer could read — this
     * becomes ASCII art of a face — so rather than lay out confetti,
     * drop back to a coarser grid and report fewer. */
    while ((cw < 16 || ch < 12) && n > 1) {
        n--;
        cols = grid_cols_for(n);
        rows = (n + cols - 1) / cols;
        cw = even_down(frame_w / cols);
        ch = even_down(frame_h / rows);
    }
    if (cw <= 0 || ch <= 0) return 0;

    for (int i = 0; i < n; i++) {
        out[i].slot = slots[i];
        out[i].w = cw;
        out[i].h = ch;
        out[i].x = (i % cols) * cw;
        out[i].y = (i / cols) * ch;
    }
    return n;
}

bool media_mix_filter(const struct media_tile *tiles, int n, int fps, int frame_w, int frame_h,
                      char *out, size_t out_sz) {
    if (!tiles || n <= 0 || !out || out_sz == 0 || frame_w <= 0 || frame_h <= 0) return false;
    if (fps < 1) fps = 10;
    size_t at = 0;
    /* Every input scaled and padded into its cell. setsar=1 because an
     * overlay refuses to compose sources whose sample aspect ratios
     * disagree, and a camera that reports a non-square one otherwise
     * kills the whole graph rather than just looking wrong.
     *
     * The FIRST one is padded twice: once into its cell, then out to
     * the whole frame at that cell's position, so it becomes the canvas
     * the rest are overlaid onto. Without the second pad the canvas is
     * one cell and every other peer is clipped off the edge of it — an
     * output silently a quarter of the size it should be. Doing it this
     * way rather than with a synthetic colour source keeps the input
     * count equal to the peer count, which is what the tile indices and
     * the -i order both assume. */
    for (int i = 0; i < n; i++) {
        int w = tiles[i].w > 0 ? tiles[i].w : 2, h = tiles[i].h > 0 ? tiles[i].h : 2;
        char canvas[64] = "";
        if (i == 0)
            snprintf(canvas, sizeof(canvas), "pad=%d:%d:%d:%d,", frame_w, frame_h, tiles[0].x,
                     tiles[0].y);
        int k = snprintf(out + at, out_sz - at,
                         "[%d:v]fps=%d,scale=%d:%d:force_original_aspect_ratio=decrease,"
                         "pad=%d:%d:(ow-iw)/2:(oh-ih)/2,%ssetsar=1[t%d];",
                         i, fps, w, h, w, h, canvas, i);
        if (k < 0 || (size_t)k >= out_sz - at) return false;
        at += (size_t)k;
    }
    if (n == 1) {
        /* One peer: the scaled input IS the output. A one-input overlay
         * chain would be a no-op stage that still has to be parsed. */
        int k = snprintf(out + at, out_sz - at, "[t0]null[out]");
        return k > 0 && (size_t)k < out_sz - at;
    }
    /* Thumbnails overlaid on the focused peer, in order.
     *
     * eof_action=pass so a peer who hangs up leaves the call running
     * instead of ending everybody's picture, and repeatlast so their
     * last frame stays put rather than the tile going black-then-absent
     * while the supervisor notices and re-tiles. */
    for (int i = 1; i < n; i++) {
        char base[16], sink[16];
        /* The first overlay reads the focused peer; every later one
         * reads what the previous overlay produced. The last writes the
         * name the caller maps, and the others write a link. */
        if (i == 1) snprintf(base, sizeof(base), "[t0]");
        else snprintf(base, sizeof(base), "[m%d]", i - 1);
        if (i == n - 1) snprintf(sink, sizeof(sink), "[out]");
        else snprintf(sink, sizeof(sink), "[m%d];", i);
        int k = snprintf(out + at, out_sz - at,
                         "%s[t%d]overlay=%d:%d:eof_action=pass:repeatlast=1%s", base, i,
                         tiles[i].x, tiles[i].y, sink);
        if (k < 0 || (size_t)k >= out_sz - at) return false;
        at += (size_t)k;
    }
    return true;
}

bool media_tiles_describe(const struct media_tile *tiles, int n, int frame_w, int frame_h,
                          char *out, size_t out_sz) {
    if (!out || out_sz == 0) return false;
    out[0] = 0;
    if (!tiles || n < 0) return false;
    /* Measured on what snprintf WOULD have written, every record, rather
     * than on a constant reserved per record. A constant is a guess at a
     * record's worst case, and the day it guesses low the cursor walks
     * past the end of the buffer and the terminator is written there. */
    size_t at = 0;
    int w = snprintf(out, out_sz, "%dx%d", frame_w, frame_h);
    if (w < 0 || (size_t)w >= out_sz) {
        out[0] = 0;
        return false;
    }
    at = (size_t)w;
    for (int i = 0; i < n; i++) {
        w = snprintf(out + at, out_sz - at, ";%d,%d,%d,%d,%d", tiles[i].slot, tiles[i].x,
                     tiles[i].y, tiles[i].w, tiles[i].h);
        if (w < 0 || (size_t)w >= out_sz - at) {
            out[0] = 0;
            return false;
        }
        at += (size_t)w;
    }
    return true;
}

/* Give a leg a loopback port and an SDP, without starting anything.
 * The port SURVIVES a re-tile: the RTP callback keeps writing to it
 * while the decoder behind it is being replaced, so a focus change
 * costs a moment of dropped packets rather than a renumbering the
 * callback cannot see. */
static bool leg_prepare(struct media_leg *leg, const struct media_config *cfg, bool video) {
    if (leg->peer_port > 0 && leg->fd >= 0 && leg->sdp_path[0]) return true; /* already has one */
    leg->video = video;
    int port = 0;
    int probe = media_bind_loopback(&port);
    if (probe < 0) return false;
    close(probe); /* ffmpeg opens it itself */

    /* For video the codec is the LEG'S, negotiated with that peer — not
     * the call's preference. Two people in one room can publish
     * different codecs and each subscribe settles separately, so a
     * global answer here would decode one of them as the other. */
    char sdp[512];
    bool made = video ? media_recv_sdp_video(port, leg->codec, leg->payload_type, sdp, sizeof(sdp))
                      : media_recv_sdp_audio(port, cfg->audio_payload_type, sdp, sizeof(sdp));
    if (!made) return false;
    char path[] = "/tmp/shottino-mix-XXXXXX";
    int fd = mkstemp(path);
    if (fd < 0) return false;
    size_t len = strlen(sdp);
    bool wrote = write(fd, sdp, len) == (ssize_t)len;
    close(fd);
    if (!wrote) {
        unlink(path);
        return false;
    }
    snprintf(leg->sdp_path, sizeof(leg->sdp_path), "%s", path);
    leg->peer_port = port;
    if (leg->fd < 0) leg->fd = socket(AF_INET, SOCK_DGRAM, 0);
    return leg->fd >= 0;
}

bool media_start_audio_mix(struct media_mix *mix, const int *slots, int n,
                           const struct media_config *cfg) {
    if (!mix || !slots || n <= 0 || !cfg) return false;
    if (n > MEDIA_MAX_PEERS) n = MEDIA_MAX_PEERS;

    media_mix_stop(mix); /* a rebuild replaces the decoder, not the ports */

    for (int i = 0; i < n; i++) {
        int slot = slots[i];
        if (slot < 0 || slot >= MEDIA_MAX_PEERS) return false;
        if (!leg_prepare(&mix->legs[slot], cfg, false)) return false;
    }

    char *argv[MEDIA_MAX_ARGS + MEDIA_MAX_PEERS * 4];
    size_t a = 0;
    argv[a++] = (char *)"ffmpeg";
    argv[a++] = (char *)"-nostdin";
    argv[a++] = (char *)"-loglevel";
    argv[a++] = (char *)"error";
    for (int i = 0; i < n; i++) {
        /* The same #451 posture as every other untrusted input. */
        argv[a++] = (char *)"-protocol_whitelist";
        argv[a++] = (char *)"file,udp,rtp";
        argv[a++] = (char *)"-i";
        argv[a++] = mix->legs[slots[i]].sdp_path;
    }

    char filter[64];
    /* normalize=0: with normalising, one person speaking is quieter the
     * more silent people are in the room, which is exactly backwards. */
    snprintf(filter, sizeof(filter), "amix=inputs=%d:normalize=0", n);
    argv[a++] = (char *)"-filter_complex";
    argv[a++] = filter;
    argv[a++] = (char *)"-vn";
    char sink[256];
    const char *fmt = NULL, *dev = NULL;
    /* pulse, matching the capture default. These disagreed — capture
     * through pulse, playback through ALSA — which on a pulse desktop
     * is playback that fails or seizes the device exclusively, i.e. a
     * call you cannot hear. Two halves of one path should not default
     * to two different audio systems. */
    split_source(cfg->audio_sink && cfg->audio_sink[0] ? cfg->audio_sink : "pulse:default", &fmt,
                 &dev, sink, sizeof(sink));
    argv[a++] = (char *)"-f";
    argv[a++] = (char *)(fmt && fmt[0] ? fmt : "pulse");
    argv[a++] = (char *)(dev && dev[0] ? dev : "default");
    argv[a] = NULL;

    mix->pid = spawn_ffmpeg(argv, -1);
    return mix->pid > 0;
}

/* Reap `pid` if it dies within `ms`; false means it is still running. */
static bool wait_bounded(pid_t pid, int ms) {
    for (int waited = 0; waited < ms; waited += 25) {
        pid_t r = waitpid(pid, NULL, WNOHANG);
        if (r == pid) return true;
        if (r < 0 && errno != EINTR) return true; /* already reaped or gone */
        struct timespec tick = { .tv_sec = 0, .tv_nsec = 25 * 1000 * 1000 };
        nanosleep(&tick, NULL);
    }
    return false;
}

/* Ask ffmpeg to stop, then insist.
 *
 * SIGTERM is a REQUEST, and ffmpeg can be slow to honour it or miss it
 * entirely — one wedged inside PulseAudio ignored it indefinitely, which
 * left this function's old unbounded wait blocked forever. That in turn
 * blocked shottino's wait for THIS process, and the client froze: three
 * waits in a row with no bound between them and a UI thread at the end.
 *
 * SIGKILL cannot be caught or deferred, so the ladder always ends. */
static void ffmpeg_stop(pid_t pid) {
    if (pid <= 0) return;
    kill(pid, SIGTERM);
    if (wait_bounded(pid, 1000)) return;
    kill(pid, SIGKILL);
    (void)wait_bounded(pid, 2000);
}

void media_mix_stop(struct media_mix *mix) {
    if (!mix || mix->pid <= 0) return;
    ffmpeg_stop(mix->pid);
    mix->pid = -1;
}

void media_mix_free(struct media_mix *mix) {
    if (!mix) return;
    media_mix_stop(mix);
    for (int i = 0; i < MEDIA_MAX_PEERS; i++) media_stop(&mix->legs[i]);
    mix->tile_count = 0;
}

bool media_start_video_mix(struct media_mix *mix, const struct media_config *cfg, int stdout_fd) {
    if (!mix || !cfg || mix->tile_count <= 0) return false;
    int n = mix->tile_count;
    if (n > MEDIA_MAX_PEERS) n = MEDIA_MAX_PEERS;

    media_mix_stop(mix); /* a re-tile replaces the decoder, not the ports */

    for (int i = 0; i < n; i++) {
        int slot = mix->tiles[i].slot;
        if (slot < 0 || slot >= MEDIA_MAX_PEERS) return false;
        if (!leg_prepare(&mix->legs[slot], cfg, true)) return false;
    }

    /* Eight peers of scale-and-pad plus an overlay chain. Measured at
     * about 130 bytes per input, so this has room for twice the cap. */
    char filter[4096];
    if (!media_mix_filter(mix->tiles, n, cfg->fps, cfg->frame_w, cfg->frame_h, filter,
                          sizeof(filter)))
        return false;

    char *argv[MEDIA_MAX_ARGS + MEDIA_MAX_PEERS * 4];
    size_t a = 0;
    argv[a++] = (char *)"ffmpeg";
    argv[a++] = (char *)"-nostdin";
    argv[a++] = (char *)"-loglevel";
    argv[a++] = (char *)"error";
    /* INPUTS IN TILE ORDER, which is why the filter can name them by
     * index: input i is tiles[i], and tiles[0] is whoever is focused. */
    for (int i = 0; i < n; i++) {
        /* The same #451 posture as every other untrusted input. */
        argv[a++] = (char *)"-protocol_whitelist";
        argv[a++] = (char *)"file,udp,rtp";
        argv[a++] = (char *)"-i";
        argv[a++] = mix->legs[mix->tiles[i].slot].sdp_path;
    }
    argv[a++] = (char *)"-filter_complex";
    argv[a++] = filter;
    argv[a++] = (char *)"-map";
    argv[a++] = (char *)"[out]";
    argv[a++] = (char *)"-an";
    argv[a++] = (char *)"-f";
    argv[a++] = (char *)"rawvideo";
    argv[a++] = (char *)"-pix_fmt";
    argv[a++] = (char *)"rgb24";
    argv[a++] = (char *)"pipe:1";
    argv[a] = NULL;

    mix->pid = spawn_ffmpeg(argv, stdout_fd);
    return mix->pid > 0;
}

void media_feed(const struct media_leg *leg, const void *rtp, size_t len) {
    if (!leg || leg->fd < 0 || leg->peer_port <= 0 || !rtp || len == 0) return;
    struct sockaddr_in to;
    memset(&to, 0, sizeof(to));
    to.sin_family = AF_INET;
    to.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    to.sin_port = htons((uint16_t)leg->peer_port);
    /* Best effort by design: this is RTP. A datagram the decoder was not
     * ready for is a lost packet, which is a thing RTP already expects
     * and a thing blocking here would turn into a stalled call. */
    (void)sendto(leg->fd, rtp, len, MSG_DONTWAIT, (struct sockaddr *)&to, sizeof(to));
}

void media_stop(struct media_leg *leg) {
    if (!leg) return;
    if (leg->pid > 0) {
        /* Reaped here rather than left to init: a call that is restarted
         * a few times would otherwise leave a zombie per leg. Bounded,
         * then insistent — see ffmpeg_stop. */
        ffmpeg_stop(leg->pid);
        leg->pid = -1;
    }
    if (leg->fd >= 0) {
        close(leg->fd);
        leg->fd = -1;
    }
    if (leg->sdp_path[0]) {
        unlink(leg->sdp_path);
        leg->sdp_path[0] = 0;
    }
    leg->peer_port = 0;
}
