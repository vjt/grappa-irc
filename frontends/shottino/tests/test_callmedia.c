/* test_callmedia — the one pure thing in the media legs.
 *
 * Everything else in media.c is fork+exec and sockets, verified by
 * running it (see docs/CALLS.md). The SDP is the exception and the one
 * that most deserves a test: a wrong payload type or rtpmap here is a
 * decoder that sits SILENT with no error at all, which is the least
 * debuggable failure this design has.
 *
 * Links media.c only — no libdatachannel — so the default gate never
 * depends on the opt-in submodule having been built.
 */
#include "../call/media.h"

#include <string.h>

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

    CHECK(media_recv_sdp(&cfg, true, 45123, sdp, sizeof(sdp)));
    CHECK(strstr(sdp, "m=video 45123 RTP/AVP 96") != NULL);
    CHECK(strstr(sdp, "a=rtpmap:96 VP8/90000") != NULL);
    /* Loopback, because that is the only place the helper writes. */
    CHECK(strstr(sdp, "c=IN IP4 127.0.0.1") != NULL);

    CHECK(media_recv_sdp(&cfg, false, 45125, sdp, sizeof(sdp)));
    CHECK(strstr(sdp, "m=audio 45125 RTP/AVP 111") != NULL);
    CHECK(strstr(sdp, "a=rtpmap:111 opus/48000/2") != NULL);

    /* The payload type FOLLOWS the negotiation rather than being spelled
     * again here: the offer and the decoder have to agree, and two
     * copies of "Opus is 111" is one of them going stale. */
    cfg.audio_payload_type = 120;
    cfg.video_payload_type = 100;
    CHECK(media_recv_sdp(&cfg, true, 1, sdp, sizeof(sdp)));
    CHECK(strstr(sdp, "RTP/AVP 100") != NULL);
    CHECK(strstr(sdp, "a=rtpmap:100 VP8/90000") != NULL);
    CHECK(media_recv_sdp(&cfg, false, 1, sdp, sizeof(sdp)));
    CHECK(strstr(sdp, "a=rtpmap:120 opus/48000/2") != NULL);

    /* Refused rather than half-written: a truncated SDP is a decoder
     * that starts and then understands nothing. */
    char tiny[16];
    CHECK(!media_recv_sdp(&cfg, true, 45123, tiny, sizeof(tiny)));
    CHECK(!media_recv_sdp(&cfg, true, 0, sdp, sizeof(sdp)));
    CHECK(!media_recv_sdp(NULL, true, 45123, sdp, sizeof(sdp)));
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

int main(void) {
    RUN(the_receive_sdp_describes_what_was_negotiated);
    RUN(loopback_ports_are_distinct_and_reported);
    return test_report();
}
