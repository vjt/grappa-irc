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

/* Which video codec a call speaks.
 *
 * A closed set rather than a string, because it decides THREE things
 * that have to agree exactly: the codec named in the SDP offer, the
 * ffmpeg encoder on the capture leg, and the rtpmap the decoder is
 * handed. Any two of the three agreeing and the third not is a call
 * that connects and shows nothing, with no error anywhere.
 *
 * VP8 is the default and the safe choice: every browser has it, it is
 * free of the licensing baggage that keeps H.264 out of some
 * distributions, and the terminal throws away the extra detail anyway.
 * H.264 is here because the far end does not always get a vote — an SFU
 * does not transcode, so a browser or a phone that publishes H.264 is
 * one this helper can either speak to or not see at all. */
enum media_video_codec {
    MEDIA_VIDEO_VP8 = 0,
    MEDIA_VIDEO_H264
};

/* The wire name, for an rtpmap or an offer. */
const char *media_video_codec_name(enum media_video_codec codec);

/* Parse the spelling a user types. Returns false on anything else
 * rather than falling back to a default: silently getting VP8 when you
 * asked for H.264 is the failure this whole enum exists to prevent. */
bool media_video_codec_parse(const char *word, enum media_video_codec *out);

/* The video m-line to OFFER when subscribing, listing every codec we
 * can decode so the server can answer with the one that peer actually
 * publishes.
 *
 * This is what makes a room with mixed codecs work. An SFU does not
 * transcode, so the codec is a property of each PUBLISHER, not of the
 * room: one person on a browser that speaks H.264 and another on a
 * terminal sending VP8 is an ordinary situation, and a subscriber that
 * offers only its own preference sees a black tile for half the call.
 * Since every peer is a separate WHEP session, each one can settle on
 * a different answer, which is exactly the granularity needed.
 *
 * Built by hand rather than via rtcAddTrackEx because that API takes
 * ONE codec per track, and the whole point here is to name several. */
bool media_video_offer_mline(int vp8_payload_type, int h264_payload_type, char *out,
                             size_t out_sz);

/* Which video codec an SDP ANSWER settled on, and under which payload
 * type. Pure, so the thing that decides how a peer's picture is decoded
 * can be asserted without a server.
 *
 * Returns false when the answer carries no video we can decode — a
 * rejected m-line (port 0), or one naming only codecs we did not offer.
 * That is a real answer to report, not a parse failure to guess past:
 * guessing here means feeding an H.264 stream to a VP8 decoder, which
 * produces silence and no error. */
bool media_sdp_video_codec(const char *sdp, enum media_video_codec *codec, int *payload_type);

/* One direction of one medium. */
struct media_leg {
    pid_t pid;   /* the ffmpeg doing the codec work, or -1 */
    int fd;      /* the loopback UDP socket this side owns, or -1 */
    int peer_port; /* recv legs: where ffmpeg is listening */
    bool video;
    /* What THIS leg carries, as negotiated for THIS peer — not what the
     * call as a whole prefers. Two peers in one call can be decoded
     * differently, and the decoder has to be told which is which. */
    enum media_video_codec codec;
    int payload_type;
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
    /* What we DECODE to: the terminal's frame geometry in PIXELS,
     * decided by shottino from the cells it has, because the helper has
     * no terminal and must not guess one. */
    int frame_w;
    int frame_h;
    int fps;
    /* What we SEND. Deliberately NOT the same numbers.
     *
     * These were one setting, so the video leaving the machine was
     * sized from the local picture-in-picture box — 320x240 because
     * THIS terminal draws ASCII. The far end may be a browser on a
     * large screen or a terminal with real bitmaps, and none of that is
     * any business of how we happen to render theirs. Resizing your own
     * window would also have changed what everybody else received. */
    int capture_w;
    int capture_h;
    int capture_fps;
    int video_kbps;
    /* What both ends of the video path speak. See the enum. */
    enum media_video_codec video_codec;
    /* Audio-only calls neither open the camera nor decode video. */
    bool want_video;
};

/* How many other people one call carries. The helper's own cap lives
 * here rather than beside it, because the leg arrays below are sized by
 * it and two constants that must be equal are one waiting to not be. */
#define MEDIA_MAX_PEERS 8

/* Where one peer's picture goes in the composited frame, in pixels. */
struct media_tile {
    int slot; /* which peer, i.e. which leg feeds it */
    int x, y, w, h;
};

/* The video receive path: N peers, ONE decoder, one composited frame.
 *
 * `legs` is indexed by PEER SLOT so the RTP callback can find its leg
 * without a search; `tiles` is in DRAW order, which is a different
 * order, because tiles[0] is whoever is focused. The process is held
 * here rather than hidden in legs[0] as the audio mix does it: focus
 * changes which slot draws first, and a pid living in a slot that moves
 * is a pid that gets lost. */
struct media_mix {
    pid_t pid;
    struct media_leg legs[MEDIA_MAX_PEERS];
    struct media_tile tiles[MEDIA_MAX_PEERS];
    int tile_count;
};

/* Lay N peers out as an EVEN GRID filling the frame.
 *
 * Even, and — the whole point — INDEPENDENT OF WHO IS FOCUSED. An
 * earlier version composited the focused peer full-size with the rest
 * as thumbnails, which meant every focus change rebuilt the graph and
 * restarted the decoder. That is measured at seconds, because ffmpeg
 * opens live RTP inputs sequentially (see CALL_TILE_MAX), so "show me
 * the other person" cost a pause every time.
 *
 * With the grid, the decoder opens its inputs ONCE per call. Which peer
 * is big is then purely a drawing decision on shottino's side: it
 * samples the focused cell into a large box and the others into small
 * ones. Nothing restarts, so focus is instant.
 *
 * The grid is therefore also a CONTRACT, not just an internal layout —
 * the caller publishes these rectangles so the other end knows which
 * pixels belong to whom.
 *
 * `slots` is WHICH peers to draw and in what order — not 0..n-1. The
 * set is a subset with holes in it: a peer with their camera off, or
 * one who has not started sending, is dropped from the mix entirely
 * (ffmpeg's filter graph stalls waiting on an input that never
 * produces a frame, so a silent peer would freeze everybody).
 *
 * Returns the number laid out, which can be less than `n` when the
 * frame has no room for another usable cell. The caller must report the
 * difference — a silent cap reads as "everyone is here". */
int media_grid_layout(const int *slots, int n, int frame_w, int frame_h, struct media_tile *out,
                      int max);

/* The ffmpeg filter graph that composites `tiles`, in tile order: input
 * i is tiles[i]. Pure, and therefore tested — a wrong label here is
 * ffmpeg exiting with a parse error onto a discarded stderr, i.e. a
 * video call that shows nothing and says nothing.
 *
 * `frame_w`/`frame_h` are the size of the COMPOSITED picture, and they
 * are not optional: the overlay chain needs a canvas that size, which
 * it makes by padding the first tile out to it. Taking the first tile
 * as the canvas instead only works when that tile covers the frame —
 * true of a focused-big layout, false of a grid, and the failure is an
 * output silently the size of ONE CELL with every other peer clipped
 * off it. */
bool media_mix_filter(const struct media_tile *tiles, int n, int fps, int frame_w, int frame_h,
                      char *out, size_t out_sz);

/* THE GRID, PUBLISHED. Not a status line — a contract.
 *
 *     <frame_w>x<frame_h>;slot,x,y,w,h;slot,x,y,w,h...
 *
 * The composited frame is one picture on a byte pipe, so without these
 * rectangles the other end cannot tell whose face is where. With them it
 * can sample any cell into any box, which is what makes focus a drawing
 * decision there instead of a decoder restart here. The slot number is
 * enough to label a cell: shottino built the subscribe list, so it knows
 * which nick each slot is.
 *
 * COMPLETE OR REFUSED — returns false and leaves `out` EMPTY when the
 * whole grid does not fit. The other end adopts a grid wholesale or not
 * at all, because a short one draws faces under the wrong names, which
 * is worse than drawing none. Pure, and therefore tested. */
bool media_tiles_describe(const struct media_tile *tiles, int n, int frame_w, int frame_h,
                          char *out, size_t out_sz);

/* Start (or restart) the composited video decoder. Ports already bound
 * in `mix->legs` are KEPT, so RTP arriving during a re-tile lands
 * somewhere valid rather than on a closed socket. Caller fills
 * mix->tiles / mix->tile_count first. */
bool media_start_video_mix(struct media_mix *mix, const struct media_config *cfg, int stdout_fd);

/* Stop a mix decoder but KEEP the legs and their ports, so a rebuild
 * does not renumber the loopback ports under the RTP callback. Used by
 * both mixes. */
void media_mix_stop(struct media_mix *mix);

/* Stop it AND release every leg. For teardown. */
void media_mix_free(struct media_mix *mix);

/* Bind a loopback UDP socket on an ephemeral port. Returns the fd and
 * writes the port, or -1. Used for both directions: the send leg reads
 * what ffmpeg writes to it, the recv leg learns which port to write to. */
int media_bind_loopback(int *port_out);

/* Start capturing and packetising. The caller pumps `leg->fd` and hands
 * each datagram to the track. Returns false and leaves the leg stopped
 * if ffmpeg cannot be started.
 *
 * WHICH INCLUDES AN FFMPEG THAT IS NOT INSTALLED, and that is the whole
 * value of the bool: a fork that succeeds says nothing about the exec
 * that follows it, so this used to return true on a machine with no
 * ffmpeg and the caller's error message was unreachable code. Every
 * start function here answers the same question the same way — see
 * spawn_ffmpeg for how the exec reports back, and for the failure it
 * still does not cover (a child that starts and dies later). */
bool media_start_send(struct media_leg *leg, const struct media_config *cfg, bool video);

/* Forward one RTP packet a track delivered to the decoder. */
void media_feed(const struct media_leg *leg, const void *rtp, size_t len);

/* ONE decoder for every peer: N inputs, amix, one output.
 *
 * N voices used to be N ffmpeg processes, each playing to the same sink
 * and letting the audio system mix them. That works and does not scale:
 * a call is 2N processes, and the count is what hurts long before the
 * CPU does. ffmpeg reads all N SDPs itself and `amix` does the job one
 * process, so an N-way call costs the same as a two-way one.
 *
 * `slots` is WHICH peers to mix, exactly as the video grid takes them,
 * and for the same reason: the set has holes and it CHANGES. A peer who
 * joins after the call started has a slot number nobody reserved, and
 * an audio mix fixed at connect time leaves them audible to nobody —
 * which is half of what "the late joiner is not there" looked like. */
bool media_start_audio_mix(struct media_mix *mix, const int *slots, int n,
                           const struct media_config *cfg);

/* Stop ffmpeg and close the socket. Safe on a leg that never started,
 * and safe to call twice. */
void media_stop(struct media_leg *leg);

/* The SDP an ffmpeg receive leg is given so it knows what is arriving.
 *
 * Pure, and therefore tested: a wrong payload type or rtpmap here is a
 * decoder that sits silent with no error, which is the least debuggable
 * failure this design has.
 *
 * Two functions rather than one with a `video` flag, because since
 * codecs became per-peer they no longer take the same arguments: video
 * needs the codec THIS peer negotiated, audio is always Opus. A shared
 * signature would have carried a parameter that is meaningless in half
 * its calls. */
bool media_recv_sdp_audio(int port, int payload_type, char *out, size_t out_sz);
bool media_recv_sdp_video(int port, enum media_video_codec codec, int payload_type, char *out,
                          size_t out_sz);

#endif /* SHOTTINO_CALL_MEDIA_H */
