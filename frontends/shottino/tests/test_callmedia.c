/* test_callmedia — the pure parts of the media legs, and the one
 * question about the impure part that can be asked without a call: does
 * a spawn that fails SAY so.
 *
 * The rest of media.c is sockets and codec behaviour, verified by
 * running it (see docs/CALLS.md). The SDP is the part that most deserves
 * a test: a wrong payload type or rtpmap there is a decoder that sits
 * SILENT with no error at all, which is the least debuggable failure
 * this design has — and a spawn reported as started when it was not is
 * the same failure one layer down.
 *
 * Links media.c only — no libdatachannel — so the default gate never
 * depends on the opt-in submodule having been built.
 */
#include "../call/media.h"

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

#include "test.h"

TEST(the_receive_sdp_describes_what_was_negotiated) {
    struct media_config cfg = { .audio_source = "pulse:default",
                                .video_source = "v4l2:/dev/video0",
                                .audio_sink = "pulse:default",
                                .audio_payload_type = 111,
                                .video_payload_type = 96,
                                .audio_ssrc = 1,
                                .video_ssrc = 2,
                                .frame_w = 320,
                                .frame_h = 240,
                                .fps = 10,
                                .want_video = true };
    char sdp[512];

    CHECK(media_recv_sdp_video(45123, cfg.video_codec, cfg.video_payload_type, sdp, sizeof(sdp)));
    CHECK(strstr(sdp, "m=video 45123 RTP/AVP 96") != NULL);
    CHECK(strstr(sdp, "a=rtpmap:96 VP8/90000") != NULL);
    /* Loopback, because that is the only place the helper writes. */
    CHECK(strstr(sdp, "c=IN IP4 127.0.0.1") != NULL);

    CHECK(media_recv_sdp_audio(45125, cfg.audio_payload_type, sdp, sizeof(sdp)));
    CHECK(strstr(sdp, "m=audio 45125 RTP/AVP 111") != NULL);
    CHECK(strstr(sdp, "a=rtpmap:111 opus/48000/2") != NULL);

    /* The payload type FOLLOWS the negotiation rather than being spelled
     * again here: the offer and the decoder have to agree, and two
     * copies of "Opus is 111" is one of them going stale. */
    cfg.audio_payload_type = 120;
    cfg.video_payload_type = 100;
    CHECK(media_recv_sdp_video(1, cfg.video_codec, cfg.video_payload_type, sdp, sizeof(sdp)));
    CHECK(strstr(sdp, "RTP/AVP 100") != NULL);
    CHECK(strstr(sdp, "a=rtpmap:100 VP8/90000") != NULL);
    CHECK(media_recv_sdp_audio(1, cfg.audio_payload_type, sdp, sizeof(sdp)));
    CHECK(strstr(sdp, "a=rtpmap:120 opus/48000/2") != NULL);

    /* Refused rather than half-written: a truncated SDP is a decoder
     * that starts and then understands nothing. */
    char tiny[16];
    CHECK(!media_recv_sdp_video(45123, cfg.video_codec, cfg.video_payload_type, tiny, sizeof(tiny)));
    CHECK(!media_recv_sdp_video(0, cfg.video_codec, cfg.video_payload_type, sdp, sizeof(sdp)));
    CHECK(!media_recv_sdp_video(45123, cfg.video_codec, cfg.video_payload_type, NULL, 0));
}

/* An SFU does not transcode, so the codec is not ours to pick alone: a
 * far end publishing H.264 to a helper that offered VP8 is a call that
 * connects, reports nothing wrong, and shows no picture. The decoder
 * has to be told the same thing the offer said. */
TEST(the_receive_sdp_follows_the_negotiated_video_codec) {
    struct media_config cfg = { .video_payload_type = 96, .video_codec = MEDIA_VIDEO_VP8 };
    char sdp[512];

    CHECK(media_recv_sdp_video(5000, cfg.video_codec, cfg.video_payload_type, sdp, sizeof(sdp)));
    CHECK(strstr(sdp, "a=rtpmap:96 VP8/90000") != NULL);
    /* VP8 gets NO fmtp rather than an empty one. */
    CHECK(strstr(sdp, "a=fmtp:") == NULL);

    cfg.video_codec = MEDIA_VIDEO_H264;
    CHECK(media_recv_sdp_video(5000, cfg.video_codec, cfg.video_payload_type, sdp, sizeof(sdp)));
    CHECK(strstr(sdp, "a=rtpmap:96 H264/90000") != NULL);
    /* Without this the depacketiser assumes single-NAL and drops every
     * fragmented keyframe — i.e. all of them. */
    CHECK(strstr(sdp, "a=fmtp:96 packetization-mode=1") != NULL);

    /* Audio is unaffected by the video codec. */
    cfg.audio_payload_type = 111;
    CHECK(media_recv_sdp_audio(5001, cfg.audio_payload_type, sdp, sizeof(sdp)));
    CHECK(strstr(sdp, "a=rtpmap:111 opus/48000/2") != NULL);
    CHECK(strstr(sdp, "H264") == NULL);
}

/* The spelling a user types, and the one wrong answer that must not be
 * given: falling back to a default when asked for something specific. */
TEST(the_video_codec_is_parsed_or_refused) {
    enum media_video_codec got = MEDIA_VIDEO_H264;
    CHECK(media_video_codec_parse("vp8", &got) && got == MEDIA_VIDEO_VP8);
    CHECK(media_video_codec_parse("VP8", &got) && got == MEDIA_VIDEO_VP8);
    CHECK(media_video_codec_parse("h264", &got) && got == MEDIA_VIDEO_H264);
    CHECK(media_video_codec_parse("H.264", &got) && got == MEDIA_VIDEO_H264);

    CHECK(!media_video_codec_parse("vp9", &got));
    CHECK(!media_video_codec_parse("", &got));
    CHECK(!media_video_codec_parse(NULL, &got));
    /* Refused means UNCHANGED: a rejected word that had already
     * overwritten the setting would be the silent-default bug wearing a
     * return value. */
    CHECK(got == MEDIA_VIDEO_H264);

    CHECK(strcmp(media_video_codec_name(MEDIA_VIDEO_VP8), "VP8") == 0);
    CHECK(strcmp(media_video_codec_name(MEDIA_VIDEO_H264), "H264") == 0);
}

/* A room where different people publish different codecs is the
 * ordinary case, not an edge one: an SFU does not transcode, so the
 * codec belongs to each PUBLISHER. Offering only our own preference
 * means a black tile for half the room, with no error anywhere. */
TEST(the_subscribe_offer_names_every_codec_we_decode) {
    char m[768];
    CHECK(media_video_offer_mline(96, 97, m, sizeof(m)));
    /* Both codecs on ONE m-line, both payload types in the format list
     * — a server picks from that list, so a codec missing from it is a
     * codec we will never be sent. */
    CHECK(strstr(m, "m=video 9 UDP/TLS/RTP/SAVPF 96 97") != NULL);
    CHECK(strstr(m, "a=rtpmap:96 VP8/90000") != NULL);
    CHECK(strstr(m, "a=rtpmap:97 H264/90000") != NULL);
    /* H.264 without packetization-mode is one a peer may decline or
     * read as single-NAL. */
    CHECK(strstr(m, "a=fmtp:97 profile-level-id=42e01f;packetization-mode=1") != NULL);
    /* Receive-only: this is a subscribe, and saying sendrecv would
     * invite the server to expect media we are not sending. */
    CHECK(strstr(m, "a=recvonly") != NULL);
    /* Keyframe requests, because a subscriber always joins mid-stream. */
    CHECK(strstr(m, "a=rtcp-fb:96 nack pli") != NULL);
    CHECK(strstr(m, "a=rtcp-fb:97 nack pli") != NULL);

    /* One number cannot mean two codecs. */
    CHECK(!media_video_offer_mline(96, 96, m, sizeof(m)));
    CHECK(!media_video_offer_mline(-1, 97, m, sizeof(m)));
    char tiny[32];
    CHECK(!media_video_offer_mline(96, 97, tiny, sizeof(tiny)));
}

/* And reading back what the server settled on. Guessing here means
 * feeding an H.264 stream to a VP8 decoder: silence, and no error. */
TEST(the_answer_says_which_codec_this_peer_publishes) {
    enum media_video_codec c = MEDIA_VIDEO_H264;
    int pt = 0;

    const char *vp8 = "v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\n"
                      "m=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\n"
                      "m=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 VP8/90000\r\n";
    CHECK(media_sdp_video_codec(vp8, &c, &pt));
    CHECK(c == MEDIA_VIDEO_VP8 && pt == 96);

    /* The SAME room, a different peer: H.264 under a payload type we
     * did not choose. Both halves have to be carried through — a right
     * codec with a wrong payload type decodes nothing either. */
    const char *h264 = "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 102\r\n"
                       "a=rtpmap:102 H264/90000\r\n"
                       "a=fmtp:102 packetization-mode=1\r\n";
    CHECK(media_sdp_video_codec(h264, &c, &pt));
    CHECK(c == MEDIA_VIDEO_H264 && pt == 102);

    /* Audio first, video second — the ordinary shape. */
    const char *audio_first = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n"
                              "a=rtpmap:111 opus/48000/2\r\n"
                              "m=video 9 UDP/TLS/RTP/SAVPF 97\r\n"
                              "a=rtpmap:97 H264/90000\r\n";
    CHECK(media_sdp_video_codec(audio_first, &c, &pt));
    CHECK(c == MEDIA_VIDEO_H264 && pt == 97);

    /* The rtpmap must be read from the VIDEO SECTION, not from wherever
     * it first appears in the file.
     *
     * The case above does not actually prove that — it passes either
     * way, because "opus" is simply not a codec we recognise, so a
     * whole-file search steps over it and lands on the right line by
     * luck. This one has a VIDEO codec named in the AUDIO section,
     * which a whole-file search reads as the answer and gets both the
     * codec and the payload type wrong. */
    const char *misleading = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 96\r\n"
                             "a=rtpmap:96 VP8/90000\r\n"
                             "m=video 9 UDP/TLS/RTP/SAVPF 97\r\n"
                             "a=rtpmap:97 H264/90000\r\n";
    CHECK(media_sdp_video_codec(misleading, &c, &pt));
    CHECK(c == MEDIA_VIDEO_H264 && pt == 97);

    /* A REJECTED video m-line is port 0. Reported as no video rather
     * than silently decoded as the default, which would be a decoder
     * running on a stream that does not exist. */
    const char *rejected = "v=0\r\nm=video 0 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 VP8/90000\r\n";
    CHECK(!media_sdp_video_codec(rejected, &c, &pt));

    /* A codec we cannot decode is not a codec. */
    const char *av1 = "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 45\r\na=rtpmap:45 AV1/90000\r\n";
    CHECK(!media_sdp_video_codec(av1, &c, &pt));

    /* Audio-only answers, and nonsense. */
    CHECK(!media_sdp_video_codec("v=0\r\nm=audio 9 RTP/AVP 111\r\na=rtpmap:111 opus/48000/2\r\n",
                                 &c, &pt));
    CHECK(!media_sdp_video_codec("", &c, &pt));
    CHECK(!media_sdp_video_codec(NULL, &c, &pt));
    CHECK(!media_sdp_video_codec(vp8, NULL, &pt));
    CHECK(!media_sdp_video_codec(vp8, &c, NULL));
}

/* An EVEN grid, and — the property the whole design rests on — one
 * that does NOT depend on who is focused. If it did, every focus change
 * would rebuild the filter graph and restart the decoder, which is
 * measured in seconds because ffmpeg opens live RTP inputs
 * sequentially. Focus is a drawing decision at the other end; this only
 * has to say which pixels belong to whom. */
TEST(the_grid_is_even_and_independent_of_focus) {
    struct media_tile t[MEDIA_MAX_PEERS];
    /* Deliberately NOT 0,1,2,3: the live set has holes in it — a peer
     * with the camera off is dropped from the mix — and a layout that
     * quietly assumed contiguous slots would draw the wrong people. */
    const int slots[4] = { 0, 2, 5, 7 };

    /* One peer fills the frame. */
    CHECK(media_grid_layout(slots, 1, 640, 480, t, MEDIA_MAX_PEERS) == 1);
    CHECK(t[0].slot == 0 && t[0].x == 0 && t[0].y == 0 && t[0].w == 640 && t[0].h == 480);

    /* Two side by side, not stacked: a terminal cell is about twice as
     * tall as it is wide, and the pictures are landscape already. */
    CHECK(media_grid_layout(slots, 2, 640, 480, t, MEDIA_MAX_PEERS) == 2);
    CHECK(t[0].slot == 0 && t[1].slot == 2);
    CHECK(t[0].w == 320 && t[1].w == 320);
    CHECK(t[0].h == 480 && t[1].h == 480);
    CHECK(t[0].x == 0 && t[1].x == 320);
    CHECK(t[0].y == 0 && t[1].y == 0);

    /* Four in a 2x2, in slot order, tiling the frame exactly. */
    int n = media_grid_layout(slots, 4, 640, 480, t, MEDIA_MAX_PEERS);
    CHECK(n == 4);
    for (int i = 0; i < 4; i++) CHECK(t[i].slot == slots[i]);
    CHECK(t[0].x == 0 && t[0].y == 0);
    CHECK(t[1].x == 320 && t[1].y == 0);
    CHECK(t[2].x == 0 && t[2].y == 240);
    CHECK(t[3].x == 320 && t[3].y == 240);

    /* Cells never overlap and never leave the frame — the two ways a
     * grid can lie about which pixels are whose. */
    for (int i = 0; i < n; i++) {
        CHECK(t[i].x >= 0 && t[i].y >= 0);
        CHECK(t[i].x + t[i].w <= 640 && t[i].y + t[i].h <= 480);
        for (int j = i + 1; j < n; j++) {
            bool apart = t[i].x + t[i].w <= t[j].x || t[j].x + t[j].w <= t[i].x ||
                         t[i].y + t[i].h <= t[j].y || t[j].y + t[j].h <= t[i].y;
            CHECK(apart);
        }
    }

    /* Every dimension even: the frame is drawn as half blocks, two
     * pixel rows to a cell, so an odd height loses its bottom row. */
    n = media_grid_layout(slots, 3, 641, 481, t, MEDIA_MAX_PEERS);
    for (int i = 0; i < n; i++) CHECK(t[i].w % 2 == 0 && t[i].h % 2 == 0);

    /* Both sides of the floor, because "it degrades somehow" is not a
     * contract. A 40x30 frame splits four ways into 20x14 cells, which
     * clears the 16x12 minimum, so all four are laid out... */
    CHECK(media_grid_layout(slots, 4, 40, 30, t, MEDIA_MAX_PEERS) == 4);
    /* ...and a 30x20 frame does not: every arrangement of two or more
     * is below it, so it falls back to ONE picture rather than laying
     * out ASCII confetti. Reporting fewer than asked is how the caller
     * knows to say so instead of implying everybody is on screen. */
    CHECK(media_grid_layout(slots, 4, 30, 20, t, MEDIA_MAX_PEERS) == 1);
    CHECK(t[0].w == 30 && t[0].h == 20);

    CHECK(media_grid_layout(slots, 0, 640, 480, t, MEDIA_MAX_PEERS) == 0);
    CHECK(media_grid_layout(slots, 2, 0, 480, t, MEDIA_MAX_PEERS) == 0);
    CHECK(media_grid_layout(slots, 2, 640, 480, NULL, MEDIA_MAX_PEERS) == 0);
    CHECK(media_grid_layout(NULL, 2, 640, 480, t, MEDIA_MAX_PEERS) == 0);
}

/* A wrong label here is ffmpeg exiting on a parse error onto a
 * discarded stderr: a video call that shows nothing and says nothing. */
TEST(the_mix_filter_chains_every_tile_into_one_output) {
    struct media_tile t[MEDIA_MAX_PEERS];
    const int slots[4] = { 0, 2, 5, 7 };
    char f[4096];

    /* One input needs no overlay at all, but still has to produce the
     * label the caller maps. */
    CHECK(media_grid_layout(slots, 1, 320, 240, t, MEDIA_MAX_PEERS) == 1);
    CHECK(media_mix_filter(t, 1, 10, 640, 480, f, sizeof(f)));
    CHECK(strstr(f, "[0:v]fps=10,") != NULL);
    CHECK(strstr(f, "[out]") != NULL);
    CHECK(strstr(f, "overlay") == NULL);

    /* Two: one overlay, straight to the output. */
    CHECK(media_grid_layout(slots, 2, 640, 480, t, MEDIA_MAX_PEERS) == 2);
    CHECK(media_mix_filter(t, 2, 12, 640, 480, f, sizeof(f)));
    /* THE CANVAS. The first tile is padded out to the whole frame,
     * because the overlay chain composes onto it. Taking that tile as
     * the canvas unpadded only works when it covers the frame — true of
     * a focused-big layout, false of a grid — and the failure mode is
     * an output silently the size of ONE CELL with every other peer
     * clipped off the edge of it. Shipped exactly that for an hour. */
    CHECK(strstr(f, "pad=640:480:0:0") != NULL);
    CHECK(strstr(f, "[t0][t1]overlay=") != NULL);
    CHECK(strstr(f, "eof_action=pass") != NULL);
    CHECK(strstr(f, "[out]") != NULL);
    /* No dangling intermediate link when the chain is one stage long. */
    CHECK(strstr(f, "[m1]") == NULL);

    /* Four: the chain must thread m1, m2 and end at [out] — the case
     * where an off-by-one leaves a link nothing reads and ffmpeg
     * refuses the whole graph. */
    CHECK(media_grid_layout(slots, 4, 640, 480, t, MEDIA_MAX_PEERS) == 4);
    CHECK(media_mix_filter(t, 4, 10, 640, 480, f, sizeof(f)));
    CHECK(strstr(f, "[t0][t1]overlay=") != NULL);
    CHECK(strstr(f, "[m1][t2]overlay=") != NULL);
    CHECK(strstr(f, "[m2][t3]overlay=") != NULL);
    CHECK(strstr(f, "[m3]") == NULL);
    /* Exactly one output, and it is the last thing in the graph. */
    const char *out = strstr(f, "[out]");
    CHECK(out != NULL && strstr(out + 1, "[out]") == NULL);
    CHECK(strcmp(out, "[out]") == 0);
    /* Every input appears, each with its own scale-and-pad. */
    for (int i = 0; i < 4; i++) {
        /* Sized so any int provably fits: eleven digits plus the eight
         * literal bytes and the terminator. */
        char want[24];
        snprintf(want, sizeof(want), "[%d:v]fps=", i);
        CHECK(strstr(f, want) != NULL);
    }

    /* Refused rather than half-written: a truncated graph is ffmpeg
     * failing to parse, which reaches nobody. */
    char tiny[32];
    CHECK(!media_mix_filter(t, 4, 10, 640, 480, tiny, sizeof(tiny)));
    CHECK(!media_mix_filter(t, 0, 10, 640, 480, f, sizeof(f)));
    CHECK(!media_mix_filter(NULL, 2, 10, 640, 480, f, sizeof(f)));
}

/* The grid, as shottino is told about it. The other end adopts it
 * WHOLESALE or not at all, so the only two honest outcomes here are a
 * complete grid and no grid — a short one draws faces under the wrong
 * names, which is worse than drawing none. */
TEST(the_published_grid_is_complete_or_refused) {
    struct media_tile t[MEDIA_MAX_PEERS];
    const int slots[4] = { 0, 2, 5, 7 };
    char g[320];

    CHECK(media_grid_layout(slots, 1, 640, 480, t, MEDIA_MAX_PEERS) == 1);
    CHECK(media_tiles_describe(t, 1, 640, 480, g, sizeof(g)));
    CHECK_STR(g, "640x480;0,0,0,640,480");

    CHECK(media_grid_layout(slots, 4, 640, 480, t, MEDIA_MAX_PEERS) == 4);
    CHECK(media_tiles_describe(t, 4, 640, 480, g, sizeof(g)));
    CHECK_STR(g, "640x480;0,0,0,320,240;2,320,0,320,240;5,0,240,320,240;7,320,240,320,240");

    /* A layout that fitted nobody — media_grid_layout refuses a frame
     * with no room for even one usable cell — still publishes the frame
     * size. The other end needs it to know what it is not drawing. */
    CHECK(media_tiles_describe(t, 0, 640, 480, g, sizeof(g)));
    CHECK_STR(g, "640x480");

    /* REFUSED, not shortened. The buffer holds the header and the first
     * record and nothing more; a builder that stops when it runs out
     * hands over a grid that says one peer is in the call when four
     * are. Reachable the day CALL_TILE_MAX is raised. */
    char small[32];
    CHECK(media_grid_layout(slots, 4, 640, 480, t, MEDIA_MAX_PEERS) == 4);
    CHECK(!media_tiles_describe(t, 4, 640, 480, g, 32));
    CHECK(!media_tiles_describe(t, 4, 640, 480, small, sizeof(small)));
    /* Emptied on refusal, so a caller that ignores the answer publishes
     * nothing rather than the half it happened to fit. */
    CHECK_STR(small, "");

    /* Not even the header fits: still refused, still empty, still no
     * write past the end — the one that ASan is here for. */
    char nano[4];
    CHECK(!media_tiles_describe(t, 1, 640, 480, nano, sizeof(nano)));
    CHECK_STR(nano, "");

    /* A record wider than any slack the old length guard reserved. The
     * builder must measure what snprintf WOULD have written, not assume
     * a record's worst case: the guard was a constant, and a constant
     * that is smaller than the truth is an out-of-bounds terminator. */
    struct media_tile wide[1] = { { 2147483647, 2147483647, 2147483647, 2147483647, 2147483647 } };
    char sixty[64];
    CHECK(!media_tiles_describe(wide, 1, 2147483647, 2147483647, sixty, sizeof(sixty)));
    CHECK_STR(sixty, "");

    CHECK(!media_tiles_describe(NULL, 2, 640, 480, g, sizeof(g)));
    CHECK(!media_tiles_describe(t, 1, 640, 480, NULL, sizeof(g)));
    CHECK(!media_tiles_describe(t, 1, 640, 480, g, 0));
}

/* Two legs must never be handed the same port, and the port has to be
 * one the caller can actually tell ffmpeg about. */
TEST(loopback_ports_are_distinct_and_reported) {
    int a = 0, b = 0;
    int fd_a = media_bind_loopback(&a);
    int fd_b = media_bind_loopback(&b);
    CHECK(fd_a >= 0);
    CHECK(fd_b >= 0);
    CHECK(a > 0);
    CHECK(b > 0);
    CHECK(a != b);
    if (fd_a >= 0) close(fd_a);
    if (fd_b >= 0) close(fd_b);
}

/* A PATH containing exactly what `fake_ffmpeg` says — a script named
 * `ffmpeg`, or nothing at all. The directory name is written back so the
 * caller can take it down again.
 *
 * PATH rather than a real ffmpeg either way: the suite must decide the
 * outcome itself, and "is ffmpeg installed on the machine running the
 * tests" is exactly the question that must not affect it. */
static bool path_holding_ffmpeg(const char *fake_ffmpeg, char *dir, size_t dir_sz) {
    snprintf(dir, dir_sz, "/tmp/shottino-callmedia-XXXXXX");
    if (!mkdtemp(dir)) return false;
    if (fake_ffmpeg) {
        char path[128];
        snprintf(path, sizeof(path), "%s/ffmpeg", dir);
        FILE *f = fopen(path, "w");
        if (!f) return false;
        fputs(fake_ffmpeg, f);
        fclose(f);
        if (chmod(path, 0755) != 0) return false;
    }
    return setenv("PATH", dir, 1) == 0;
}

static void path_restore(const char *dir, const char *saved) {
    char path[128];
    snprintf(path, sizeof(path), "%s/ffmpeg", dir);
    unlink(path);
    rmdir(dir);
    setenv("PATH", saved, 1);
}

/* Exactly how main.c prepares a mix before starting it. A memset-zeroed
 * one is NOT the same thing: its legs would own fd 0. */
static void mix_init(struct media_mix *mix) {
    memset(mix, 0, sizeof(*mix));
    mix->pid = -1;
    for (int i = 0; i < MEDIA_MAX_PEERS; i++) {
        mix->legs[i].fd = -1;
        mix->legs[i].pid = -1;
    }
}

static struct media_config spawn_test_config(void) {
    struct media_config cfg = { .audio_source = "pulse:default",
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
                                .want_video = true };
    return cfg;
}

/* AN FFMPEG THAT CANNOT BE EXEC'D IS A START THAT FAILED.
 *
 * The helper is opt-in and its README does not make ffmpeg a hard
 * dependency, so "not installed" is the ordinary case, not an exotic
 * one. A fork that succeeds and an exec that does not is a child that
 * exits 127 with its stderr discarded, and every caller's error message
 * hangs off the false branch these functions were not returning: the
 * call window opens, the tiles publish, and the user gets silence and a
 * black rectangle with no diagnostic anywhere.
 *
 * All three start functions, because all three spawn and all three have
 * their own message on the far side of the bool. */
TEST(a_start_reports_an_ffmpeg_that_cannot_be_exec_d) {
    char saved[4096];
    snprintf(saved, sizeof(saved), "%s", getenv("PATH") ? getenv("PATH") : "");
    char dir[64];
    CHECK(path_holding_ffmpeg(NULL, dir, sizeof(dir)));

    struct media_config cfg = spawn_test_config();
    int slots[1] = { 0 };

    struct media_leg leg;
    CHECK(!media_start_send(&leg, &cfg, false));
    /* And stopped, not half-started: the socket the capture would have
     * been read from is closed, so nothing polls a leg that has no
     * writer. */
    CHECK(leg.pid == -1);
    CHECK(leg.fd == -1);

    struct media_mix amix;
    mix_init(&amix);
    CHECK(!media_start_audio_mix(&amix, slots, 1, &cfg));
    CHECK(amix.pid == -1);
    media_mix_free(&amix);

    struct media_mix vmix;
    mix_init(&vmix);
    vmix.tile_count = media_grid_layout(slots, 1, cfg.frame_w, cfg.frame_h, vmix.tiles,
                                        MEDIA_MAX_PEERS);
    CHECK(vmix.tile_count == 1);
    CHECK(!media_start_video_mix(&vmix, &cfg, -1));
    CHECK(vmix.pid == -1);
    media_mix_free(&vmix);

    /* AND NOT A CORPSE LEFT ANYWHERE. Nothing waits for a leg the caller
     * was told does not exist, and the supervisor rebuilds both mixes on
     * every tick — so on the machine this whole issue is about, a start
     * that does not reap its own failed child leaks a zombie per tick
     * for the length of the call. */
    CHECK(waitpid(-1, NULL, WNOHANG) == -1 && errno == ECHILD);

    path_restore(dir, saved);
}

/* The other half of the same question, and the reason the one above
 * means anything: a start that CAN exec still succeeds.
 *
 * Without this, "returns false" is satisfied just as well by a function
 * that refuses everything. */
TEST(a_start_succeeds_when_ffmpeg_is_on_the_path) {
    char saved[4096];
    snprintf(saved, sizeof(saved), "%s", getenv("PATH") ? getenv("PATH") : "");
    char dir[64];
    /* Anything that execs and STAYS UP: this is the spawn contract under
     * test, not ffmpeg's own behaviour.
     *
     * The inner PATH is not decoration. This one runs with PATH pointing
     * at the scratch directory and nothing else, so a bare `sleep` is
     * not found — the script then exits immediately, the check below
     * still passes on a pid that is already a zombie, and the control
     * proves nothing. Measured, not assumed. */
    CHECK(path_holding_ffmpeg("#!/bin/sh\nPATH=/usr/bin:/bin\nexec sleep 30\n", dir, sizeof(dir)));

    struct media_config cfg = spawn_test_config();
    int slots[1] = { 0 };

    struct media_leg leg;
    CHECK(media_start_send(&leg, &cfg, false));
    CHECK(leg.pid > 0);
    /* RUNNING, not merely forked. A child that exited the instant it
     * started satisfies pid > 0 exactly as well — which is what made the
     * bug this suite is about survive in the first place. */
    int status = 0;
    CHECK(waitpid(leg.pid, &status, WNOHANG) == 0);
    media_stop(&leg);
    CHECK(leg.pid == -1);

    struct media_mix amix;
    mix_init(&amix);
    CHECK(media_start_audio_mix(&amix, slots, 1, &cfg));
    CHECK(amix.pid > 0);
    CHECK(waitpid(amix.pid, &status, WNOHANG) == 0);
    media_mix_free(&amix);

    path_restore(dir, saved);
}

int main(void) {
    RUN(the_receive_sdp_describes_what_was_negotiated);
    RUN(the_receive_sdp_follows_the_negotiated_video_codec);
    RUN(the_video_codec_is_parsed_or_refused);
    RUN(the_subscribe_offer_names_every_codec_we_decode);
    RUN(the_answer_says_which_codec_this_peer_publishes);
    RUN(the_grid_is_even_and_independent_of_focus);
    RUN(the_mix_filter_chains_every_tile_into_one_output);
    RUN(the_published_grid_is_complete_or_refused);
    RUN(loopback_ports_are_distinct_and_reported);
    RUN(a_start_reports_an_ffmpeg_that_cannot_be_exec_d);
    RUN(a_start_succeeds_when_ffmpeg_is_on_the_path);
    return test_report();
}
