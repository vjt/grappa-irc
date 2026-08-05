/* rtc_stub.h — what the fake libdatachannel saw, and how to drive it.
 *
 * The stub is not a null implementation. It MODELS the two things the
 * helper's lifetime bugs live in: a peer connection is an allocation that
 * rtcDeletePeerConnection frees along with its tracks, and rtcSendMessage
 * READS the bytes it is handed for the length it is told. Both are true of
 * the real library, and both are what turns a size or a lifetime mistake
 * in call/main.c into an ASan report instead of a passing test.
 *
 * The callbacks are driven through the pointers the helper registered,
 * never called directly, so the registration is under test too — a
 * callback wired to the wrong track is a bug the direct call cannot see.
 */
#ifndef SHOTTINO_TEST_RTC_STUB_H
#define SHOTTINO_TEST_RTC_STUB_H

#include <rtc/rtc.h>

#include <stdbool.h>
#include <stddef.h>

/* Back to a fresh library: every pc and track released, every counter and
 * every injected failure cleared. Call it between tests, or the leak
 * checker attributes one test's peer connections to the next. */
void rtc_stub_reset(void);

/* ── What the helper asked for ─────────────────────────────────────────── */

int rtc_stub_pcs_created(void);
int rtc_stub_pcs_deleted(void);
int rtc_stub_cleanups(void);

/* Calls naming an id that was never handed out, or one already deleted.
 * A counter rather than an abort: the point is to assert it is ZERO in
 * tests that tear a call down, which is where use-after-delete lives. */
int rtc_stub_bad_calls(void);

struct rtc_stub_track {
    int pc;
    bool from_sdp; /* rtcAddTrack (hand-built m-line) vs rtcAddTrackEx */
    char sdp[1024];
    rtcDirection direction;
    rtcCodec codec;
    int payload_type;
    char mid[32];
    char profile[128];
};

int rtc_stub_tracks_added(void);
/* False when `track` is not a live track id. */
bool rtc_stub_track(int track, struct rtc_stub_track *out);

/* What the helper pushed onto a track. `rtc_stub_last_sent` returns a
 * buffer of exactly the length that was passed to rtcSendMessage — so an
 * over-long size is an ASan read past the caller's buffer at the moment
 * of the send, not a mystery later. */
int rtc_stub_sent_count(int track);
const char *rtc_stub_last_sent(int track, int *size);

/* The SDP the helper handed to rtcSetRemoteDescription, or NULL. */
const char *rtc_stub_remote_description(int pc);

/* ── Injection ─────────────────────────────────────────────────────────── */

void rtc_stub_fail_next_create(void);
/* Refuse the `nth` track added from now on, counting from 1 — which is
 * how the audio track is told from the multi-codec video offer that
 * follows it, and those two failures have entirely different consequences. */
void rtc_stub_fail_track_at(int nth);
/* Default true: rtcSetLocalDescription reports gathering COMPLETE at once,
 * the way vanilla ICE resolves against a reachable STUN-less network. Off
 * is a peer that never finishes gathering, which is a real timeout. */
void rtc_stub_set_gathering_completes(bool on);
void rtc_stub_set_remote_description_ok(bool ok);
/* What rtcGetLocalDescription hands back. Defaults to a minimal offer. */
void rtc_stub_set_offer(const char *sdp);

/* ── Driving the helper's own callbacks ────────────────────────────────── */

/* Fire the state-change callback the helper registered on `pc`, with the
 * user pointer it registered. False when nothing is registered. */
bool rtc_stub_fire_state(int pc, rtcState state);
/* Deliver an RTP packet to the message callback registered on `track`. */
bool rtc_stub_deliver(int track, const void *data, int size);
/* Hand a line to the log callback the helper installed with rtcInitLogger. */
bool rtc_stub_log(rtcLogLevel level, const char *message);

#endif /* SHOTTINO_TEST_RTC_STUB_H */
