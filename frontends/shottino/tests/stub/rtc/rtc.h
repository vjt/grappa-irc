/* rtc/rtc.h — a STAND-IN for libdatachannel's C API, for the test build.
 *
 * WHY THIS EXISTS. call/main.c is the helper's whole main loop and the
 * entire libdatachannel integration, and until now nothing linked it: the
 * `call-compile` gate (#754) proves it PARSES under -Werror and says
 * nothing about a use-after-free in session_release or an out-of-bounds in
 * video_retile. Linking it into a sanitized test binary needs the rtc
 * symbols to come from somewhere, and the real ones cost cmake, a C++
 * toolchain and a multi-minute libdatachannel build — which is exactly why
 * `make call` is opt-in and why `make check` must not depend on the
 * vendored submodule having been checked out, let alone built. Every other
 * call/ suite (test_whip, test_callmedia, test_callnote) holds that line.
 *
 * So the API is declared here and implemented in tests/rtc_stub.c, and the
 * seven functions that were outside the sanitizers come inside them.
 *
 * THE DECLARATIONS ARE THE REAL ONES, and that is checked rather than
 * asserted — a stub whose shape nobody verifies is a second API, and a
 * test binary built against a second API proves things about the second
 * API. The check is a CHAIN of two compilations, because neither end is
 * enough on its own:
 *
 *   - `make check` builds tests/rtc_stub.c against THIS header, so the
 *     definitions cannot drift from these declarations;
 *   - `make call-compile` builds the same file against the VENDORED
 *     <rtc/rtc.h>, in the one job that has the submodule, so those same
 *     definitions cannot drift from upstream's.
 *
 * Between them this header cannot drift from upstream either. Verified by
 * breaking each link: a signature changed here alone fails the test build,
 * and changed here AND in rtc_stub.c together fails call-compile.
 *
 * What it deliberately does NOT cover: the C++ link driver,
 * -static-libstdc++ and the four vendored archives. Those are still proven
 * only by someone typing `make call`.
 */
#ifndef RTC_C_API
#define RTC_C_API

#include <stdbool.h>
#include <stdint.h>

/* Upstream defines these per-platform; the test build is neither Windows
 * nor a shared library, which is the branch upstream lands on here. */
#define RTC_C_EXPORT
#define RTC_API

typedef enum {
    RTC_NEW = 0,
    RTC_CONNECTING = 1,
    RTC_CONNECTED = 2,
    RTC_DISCONNECTED = 3,
    RTC_FAILED = 4,
    RTC_CLOSED = 5
} rtcState;

typedef enum {
    RTC_GATHERING_NEW = 0,
    RTC_GATHERING_INPROGRESS = 1,
    RTC_GATHERING_COMPLETE = 2
} rtcGatheringState;

typedef enum { /* Don't change, it must match plog severity */
               RTC_LOG_NONE = 0,
               RTC_LOG_FATAL = 1,
               RTC_LOG_ERROR = 2,
               RTC_LOG_WARNING = 3,
               RTC_LOG_INFO = 4,
               RTC_LOG_DEBUG = 5,
               RTC_LOG_VERBOSE = 6
} rtcLogLevel;

typedef enum {
    RTC_CERTIFICATE_DEFAULT = 0, /* ECDSA */
    RTC_CERTIFICATE_ECDSA = 1,
    RTC_CERTIFICATE_RSA = 2,
} rtcCertificateType;

typedef enum {
    /* video */
    RTC_CODEC_H264 = 0,
    RTC_CODEC_VP8 = 1,
    RTC_CODEC_VP9 = 2,
    RTC_CODEC_H265 = 3,
    RTC_CODEC_AV1 = 4,

    /* audio */
    RTC_CODEC_OPUS = 128,
    RTC_CODEC_PCMU = 129,
    RTC_CODEC_PCMA = 130,
    RTC_CODEC_AAC = 131,
    RTC_CODEC_G722 = 132,
} rtcCodec;

typedef enum {
    RTC_DIRECTION_UNKNOWN = 0,
    RTC_DIRECTION_SENDONLY = 1,
    RTC_DIRECTION_RECVONLY = 2,
    RTC_DIRECTION_SENDRECV = 3,
    RTC_DIRECTION_INACTIVE = 4
} rtcDirection;

typedef enum { RTC_TRANSPORT_POLICY_ALL = 0, RTC_TRANSPORT_POLICY_RELAY = 1 } rtcTransportPolicy;

#define RTC_ERR_SUCCESS 0
#define RTC_ERR_INVALID -1   /* invalid argument */
#define RTC_ERR_FAILURE -2   /* runtime error */
#define RTC_ERR_NOT_AVAIL -3 /* element not available */
#define RTC_ERR_TOO_SMALL -4 /* buffer too small */

typedef void(RTC_API *rtcLogCallbackFunc)(rtcLogLevel level, const char *message);
typedef void(RTC_API *rtcStateChangeCallbackFunc)(int pc, rtcState state, void *ptr);
typedef void(RTC_API *rtcGatheringStateCallbackFunc)(int pc, rtcGatheringState state, void *ptr);
typedef void(RTC_API *rtcMessageCallbackFunc)(int id, const char *message, int size, void *ptr);

RTC_C_EXPORT void rtcInitLogger(rtcLogLevel level, rtcLogCallbackFunc cb);

RTC_C_EXPORT void rtcSetUserPointer(int id, void *ptr);

typedef struct {
    const char **iceServers;
    int iceServersCount;
    const char *proxyServer; /* libnice only */
    const char *bindAddress; /* libjuice only, NULL means any */
    rtcCertificateType certificateType;
    rtcTransportPolicy iceTransportPolicy;
    bool enableIceTcp;
    bool enableIceUdpMux; /* libjuice only */
    bool disableAutoNegotiation;
    bool forceMediaTransport;
    uint16_t portRangeBegin; /* 0 means automatic */
    uint16_t portRangeEnd;   /* 0 means automatic */
    int mtu;                 /* <= 0 means automatic */
    int maxMessageSize;      /* <= 0 means default */
} rtcConfiguration;

RTC_C_EXPORT int rtcCreatePeerConnection(const rtcConfiguration *config); /* returns pc id */
RTC_C_EXPORT int rtcDeletePeerConnection(int pc);

RTC_C_EXPORT int rtcSetStateChangeCallback(int pc, rtcStateChangeCallbackFunc cb);
RTC_C_EXPORT int rtcSetGatheringStateChangeCallback(int pc, rtcGatheringStateCallbackFunc cb);

RTC_C_EXPORT int rtcSetLocalDescription(int pc, const char *type); /* type may be NULL */
RTC_C_EXPORT int rtcSetRemoteDescription(int pc, const char *sdp, const char *type);

RTC_C_EXPORT int rtcGetLocalDescription(int pc, char *buffer, int size);

typedef struct {
    rtcDirection direction;
    rtcCodec codec;
    int payloadType;
    uint32_t ssrc;
    const char *mid;
    const char *name;    /* optional */
    const char *msid;    /* optional */
    const char *trackId; /* optional, track ID used in MSID */
    const char *profile; /* optional, codec profile */
} rtcTrackInit;

RTC_C_EXPORT int rtcAddTrack(int pc, const char *mediaDescriptionSdp); /* returns tr id */
RTC_C_EXPORT int rtcAddTrackEx(int pc, const rtcTrackInit *init);      /* returns tr id */

RTC_C_EXPORT int rtcSetMessageCallback(int id, rtcMessageCallbackFunc cb);
RTC_C_EXPORT int rtcSendMessage(int id, const char *data, int size);

RTC_C_EXPORT void rtcCleanup(void);

#endif /* RTC_C_API */
