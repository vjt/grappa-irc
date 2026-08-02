/* media.h — the ffmpeg legs of a call.
 *
 * THE SPLIT: ffmpeg does codecs and RTP packetisation; this file does
 * transport only. Nothing here encodes, decodes, packetises or times a
 * frame — those are solved problems that ffmpeg is already in the tree
 * for, and a second implementation would be a second thing to get wrong.
 *
 * So each direction is an ffmpeg process joined to a libdatachannel
 * track by a loopback UDP socket:
 *
 *   send:  ffmpeg -f pulse -i default … -f rtp rtp://127.0.0.1:P
 *              → helper reads P → rtcSendMessage(track)
 *
 *   recv:  track callback → helper sends to 127.0.0.1:Q
 *              → ffmpeg -i <sdp describing Q> … → speakers, or rgb24
 *
 * The video receive leg writes its rgb24 frames to the HELPER'S OWN
 * stdout, which is the frame stream shottino reads. That is why stdout
 * is reserved and why nothing else in this program may print there: the
 * decoder is handed the descriptor directly and writes to it unmediated,
 * so there is no copy and no framing layer to desynchronise.
 *
 * Payload types and SSRCs are the ones negotiated in the offer, passed
 * in rather than repeated here — a second copy of "Opus is 111" is a
 * second place for it to stop being true.
 */
#ifndef SHOTTINO_CALL_MEDIA_H
#define SHOTTINO_CALL_MEDIA_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <sys/types.h>

/* One direction of one medium. */
struct media_leg {
    pid_t pid;   /* the ffmpeg doing the codec work, or -1 */
    int fd;      /* the loopback UDP socket this side owns, or -1 */
    int peer_port; /* recv legs: where ffmpeg is listening */
    bool video;
    /* recv legs: the SDP handed to ffmpeg, removed at stop. It CANNOT be
     * unlinked right after the spawn — the child may not have exec'd,
     * let alone opened it, and the decoder then starts on nothing and
     * produces no frames at all. */
    char sdp_path[64];
};

struct media_config {
    /* ffmpeg `format:input` spellings, exactly as shottino's /voicemsg
     * and /video already spell them, so one device setting serves both
     * features rather than two that drift. */
    const char *audio_source;
    const char *video_source;
    /* Where decoded audio is PLAYED. Its own setting rather than an
     * inference from audio_source: the two are genuinely independent,
     * and guessing one from the other breaks the moment they differ. */
    const char *audio_sink;
    int audio_payload_type;
    int video_payload_type;
    uint32_t audio_ssrc;
    uint32_t video_ssrc;
    /* The terminal's frame geometry in PIXELS, decided by shottino from
     * the cells it has and passed down, because the helper has no
     * terminal and must not guess one. */
    int frame_w;
    int frame_h;
    int fps;
    /* Audio-only calls neither open the camera nor decode video. */
    bool want_video;
};

/* Bind a loopback UDP socket on an ephemeral port. Returns the fd and
 * writes the port, or -1. Used for both directions: the send leg reads
 * what ffmpeg writes to it, the recv leg learns which port to write to. */
int media_bind_loopback(int *port_out);

/* Start capturing and packetising. The caller pumps `leg->fd` and hands
 * each datagram to the track. Returns false and leaves the leg stopped
 * if ffmpeg cannot be started. */
bool media_start_send(struct media_leg *leg, const struct media_config *cfg, bool video);

/* Start decoding. `stdout_fd` is where a VIDEO leg writes its rgb24
 * frames — normally STDOUT_FILENO; audio legs ignore it and play to the
 * system's default sink. The caller forwards each RTP packet from the
 * track to `leg->peer_port` on loopback. */
bool media_start_recv(struct media_leg *leg, const struct media_config *cfg, bool video,
                      int stdout_fd);

/* Forward one RTP packet a track delivered to the decoder. */
void media_feed(const struct media_leg *leg, const void *rtp, size_t len);

/* Stop ffmpeg and close the socket. Safe on a leg that never started,
 * and safe to call twice. */
void media_stop(struct media_leg *leg);

/* The SDP an ffmpeg receive leg is given so it knows what is arriving.
 *
 * Pure, and therefore tested: a wrong payload type or rtpmap here is a
 * decoder that sits silent with no error, which is the least debuggable
 * failure this design has. */
bool media_recv_sdp(const struct media_config *cfg, bool video, int port, char *out, size_t out_sz);

#endif /* SHOTTINO_CALL_MEDIA_H */
