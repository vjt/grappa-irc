/* rtc_stub.c — the fake libdatachannel that tests/test_callmain.c links.
 *
 * See tests/stub/rtc/rtc.h for why a stub and not the real library, and
 * tests/rtc_stub.h for the shape of what it records.
 *
 * The two modelled behaviours are deliberate, and they are the reason the
 * sanitizers have anything to bite on:
 *
 *   - a peer connection is an ALLOCATION. rtcDeletePeerConnection frees it
 *     and every track that belongs to it, exactly as the real library
 *     invalidates them. Naming one afterwards is counted, never followed —
 *     the stub must report the helper's mistake, not crash on it.
 *   - rtcSendMessage READS `size` bytes from `data`. A helper that passes a
 *     length its own buffer does not have is an ASan read past that buffer,
 *     at the call, with the helper's frame on the report.
 *
 * Ids are two disjoint ranges so a peer-connection id used where a track id
 * belongs lands in bad_calls instead of quietly addressing something.
 */
#include "rtc_stub.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define STUB_MAX_PCS 64
#define STUB_MAX_TRACKS 256
#define STUB_PC_BASE 1
#define STUB_TRACK_BASE 10000

struct stub_pc {
    void *user_ptr;
    rtcStateChangeCallbackFunc state_cb;
    rtcGatheringStateCallbackFunc gathering_cb;
    char *remote_sdp;
};

struct stub_track {
    int pc;
    void *user_ptr;
    rtcMessageCallbackFunc message_cb;
    struct rtc_stub_track info;
    int sent_count;
    char *last_sent;
    int last_sent_size;
};

static struct stub_pc *pcs[STUB_MAX_PCS];
static struct stub_track *tracks[STUB_MAX_TRACKS];

static int pcs_created, pcs_deleted, tracks_added, cleanups, bad_calls;
static bool fail_next_create;
static int fail_track_at, track_attempts;
static bool gathering_completes = true;
static bool remote_description_ok = true;
static char offer_sdp[4096] = "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n";
static rtcLogCallbackFunc log_cb;

static struct stub_pc *pc_at(int id) {
    if (id < STUB_PC_BASE || id >= STUB_PC_BASE + STUB_MAX_PCS) return NULL;
    return pcs[id - STUB_PC_BASE];
}

static struct stub_track *track_at(int id) {
    if (id < STUB_TRACK_BASE || id >= STUB_TRACK_BASE + STUB_MAX_TRACKS) return NULL;
    return tracks[id - STUB_TRACK_BASE];
}

static void track_free(int index) {
    struct stub_track *t = tracks[index];
    if (!t) return;
    free(t->last_sent);
    free(t);
    tracks[index] = NULL;
}

void rtc_stub_reset(void) {
    for (int i = 0; i < STUB_MAX_TRACKS; i++) track_free(i);
    for (int i = 0; i < STUB_MAX_PCS; i++) {
        if (!pcs[i]) continue;
        free(pcs[i]->remote_sdp);
        free(pcs[i]);
        pcs[i] = NULL;
    }
    pcs_created = pcs_deleted = tracks_added = cleanups = bad_calls = 0;
    fail_next_create = false;
    fail_track_at = track_attempts = 0;
    gathering_completes = true;
    remote_description_ok = true;
    log_cb = NULL;
    snprintf(offer_sdp, sizeof(offer_sdp), "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n");
}

int rtc_stub_pcs_created(void) { return pcs_created; }
int rtc_stub_pcs_deleted(void) { return pcs_deleted; }
int rtc_stub_cleanups(void) { return cleanups; }
int rtc_stub_bad_calls(void) { return bad_calls; }
int rtc_stub_tracks_added(void) { return tracks_added; }

bool rtc_stub_track(int track, struct rtc_stub_track *out) {
    struct stub_track *t = track_at(track);
    if (!t || !out) return false;
    *out = t->info;
    return true;
}

int rtc_stub_sent_count(int track) {
    struct stub_track *t = track_at(track);
    return t ? t->sent_count : -1;
}

const char *rtc_stub_last_sent(int track, int *size) {
    struct stub_track *t = track_at(track);
    if (!t) return NULL;
    if (size) *size = t->last_sent_size;
    return t->last_sent;
}

const char *rtc_stub_remote_description(int pc) {
    struct stub_pc *p = pc_at(pc);
    return p ? p->remote_sdp : NULL;
}

void rtc_stub_fail_next_create(void) { fail_next_create = true; }
void rtc_stub_fail_track_at(int nth) {
    fail_track_at = nth;
    track_attempts = 0;
}
void rtc_stub_set_gathering_completes(bool on) { gathering_completes = on; }
void rtc_stub_set_remote_description_ok(bool ok) { remote_description_ok = ok; }

void rtc_stub_set_offer(const char *sdp) {
    snprintf(offer_sdp, sizeof(offer_sdp), "%s", sdp ? sdp : "");
}

bool rtc_stub_fire_state(int pc, rtcState state) {
    struct stub_pc *p = pc_at(pc);
    if (!p || !p->state_cb) return false;
    p->state_cb(pc, state, p->user_ptr);
    return true;
}

bool rtc_stub_deliver(int track, const void *data, int size) {
    struct stub_track *t = track_at(track);
    if (!t || !t->message_cb) return false;
    t->message_cb(track, (const char *)data, size, t->user_ptr);
    return true;
}

bool rtc_stub_log(rtcLogLevel level, const char *message) {
    if (!log_cb) return false;
    log_cb(level, message);
    return true;
}

/* ── The API itself ────────────────────────────────────────────────────── */

void rtcInitLogger(rtcLogLevel level, rtcLogCallbackFunc cb) {
    (void)level;
    log_cb = cb;
}

void rtcSetUserPointer(int id, void *ptr) {
    struct stub_pc *p = pc_at(id);
    if (p) {
        p->user_ptr = ptr;
        return;
    }
    struct stub_track *t = track_at(id);
    if (t) {
        t->user_ptr = ptr;
        return;
    }
    bad_calls++;
}

int rtcCreatePeerConnection(const rtcConfiguration *config) {
    (void)config;
    if (fail_next_create) {
        fail_next_create = false;
        return RTC_ERR_FAILURE;
    }
    for (int i = 0; i < STUB_MAX_PCS; i++) {
        if (pcs[i]) continue;
        pcs[i] = calloc(1, sizeof(*pcs[i]));
        if (!pcs[i]) return RTC_ERR_FAILURE;
        pcs_created++;
        return STUB_PC_BASE + i;
    }
    return RTC_ERR_FAILURE;
}

int rtcDeletePeerConnection(int pc) {
    struct stub_pc *p = pc_at(pc);
    if (!p) {
        bad_calls++;
        return RTC_ERR_INVALID;
    }
    /* The real library invalidates a peer connection's tracks with it, so
     * a helper that sends on one afterwards must not find a live object
     * here either — that is the teardown-ordering bug this suite is for. */
    for (int i = 0; i < STUB_MAX_TRACKS; i++)
        if (tracks[i] && tracks[i]->pc == pc) track_free(i);
    free(p->remote_sdp);
    free(p);
    pcs[pc - STUB_PC_BASE] = NULL;
    pcs_deleted++;
    return RTC_ERR_SUCCESS;
}

int rtcSetStateChangeCallback(int pc, rtcStateChangeCallbackFunc cb) {
    struct stub_pc *p = pc_at(pc);
    if (!p) {
        bad_calls++;
        return RTC_ERR_INVALID;
    }
    p->state_cb = cb;
    return RTC_ERR_SUCCESS;
}

int rtcSetGatheringStateChangeCallback(int pc, rtcGatheringStateCallbackFunc cb) {
    struct stub_pc *p = pc_at(pc);
    if (!p) {
        bad_calls++;
        return RTC_ERR_INVALID;
    }
    p->gathering_cb = cb;
    return RTC_ERR_SUCCESS;
}

int rtcSetLocalDescription(int pc, const char *type) {
    (void)type;
    struct stub_pc *p = pc_at(pc);
    if (!p) {
        bad_calls++;
        return RTC_ERR_INVALID;
    }
    /* Vanilla ICE against a reachable network: gathering finishes, and it
     * finishes on the caller's thread. Turned off, this is a peer that
     * never gathers — which is a timeout the helper has to survive. */
    if (gathering_completes && p->gathering_cb)
        p->gathering_cb(pc, RTC_GATHERING_COMPLETE, p->user_ptr);
    return RTC_ERR_SUCCESS;
}

int rtcSetRemoteDescription(int pc, const char *sdp, const char *type) {
    (void)type;
    struct stub_pc *p = pc_at(pc);
    if (!p) {
        bad_calls++;
        return RTC_ERR_INVALID;
    }
    if (!remote_description_ok) return RTC_ERR_INVALID;
    free(p->remote_sdp);
    p->remote_sdp = sdp ? strdup(sdp) : NULL;
    return RTC_ERR_SUCCESS;
}

int rtcGetLocalDescription(int pc, char *buffer, int size) {
    struct stub_pc *p = pc_at(pc);
    if (!p) {
        bad_calls++;
        return RTC_ERR_INVALID;
    }
    int len = (int)strlen(offer_sdp);
    if (!buffer || size <= len) return RTC_ERR_TOO_SMALL;
    memcpy(buffer, offer_sdp, (size_t)len + 1);
    return len;
}

static int track_add(int pc, const struct rtc_stub_track *info) {
    struct stub_pc *p = pc_at(pc);
    if (!p) {
        bad_calls++;
        return RTC_ERR_INVALID;
    }
    if (fail_track_at > 0 && ++track_attempts == fail_track_at) return RTC_ERR_FAILURE;
    for (int i = 0; i < STUB_MAX_TRACKS; i++) {
        if (tracks[i]) continue;
        tracks[i] = calloc(1, sizeof(*tracks[i]));
        if (!tracks[i]) return RTC_ERR_FAILURE;
        tracks[i]->pc = pc;
        tracks[i]->info = *info;
        tracks_added++;
        return STUB_TRACK_BASE + i;
    }
    return RTC_ERR_FAILURE;
}

int rtcAddTrack(int pc, const char *mediaDescriptionSdp) {
    struct rtc_stub_track info;
    memset(&info, 0, sizeof(info));
    info.pc = pc;
    info.from_sdp = true;
    snprintf(info.sdp, sizeof(info.sdp), "%s", mediaDescriptionSdp ? mediaDescriptionSdp : "");
    return track_add(pc, &info);
}

int rtcAddTrackEx(int pc, const rtcTrackInit *init) {
    if (!init) {
        bad_calls++;
        return RTC_ERR_INVALID;
    }
    struct rtc_stub_track info;
    memset(&info, 0, sizeof(info));
    info.pc = pc;
    info.direction = init->direction;
    info.codec = init->codec;
    info.payload_type = init->payloadType;
    snprintf(info.mid, sizeof(info.mid), "%s", init->mid ? init->mid : "");
    snprintf(info.profile, sizeof(info.profile), "%s", init->profile ? init->profile : "");
    return track_add(pc, &info);
}

int rtcSetMessageCallback(int id, rtcMessageCallbackFunc cb) {
    struct stub_track *t = track_at(id);
    if (!t) {
        bad_calls++;
        return RTC_ERR_INVALID;
    }
    t->message_cb = cb;
    return RTC_ERR_SUCCESS;
}

int rtcSendMessage(int id, const char *data, int size) {
    struct stub_track *t = track_at(id);
    if (!t) {
        bad_calls++;
        return RTC_ERR_INVALID;
    }
    t->sent_count++;
    free(t->last_sent);
    t->last_sent = NULL;
    t->last_sent_size = size;
    if (!data || size <= 0) return RTC_ERR_SUCCESS;
    /* The copy IS the check: `size` bytes are read from the caller's
     * buffer, so a length the caller does not have is a read past it. */
    t->last_sent = malloc((size_t)size);
    if (t->last_sent) memcpy(t->last_sent, data, (size_t)size);
    return size;
}

void rtcCleanup(void) { cleanups++; }
