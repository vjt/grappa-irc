/* wire.h — typed narrowing for grappa's Phoenix event surface.
 *
 * This is the C twin of cicchetto's `lib/wireNarrow.ts` (per-channel topic)
 * and `lib/userTopic.ts`'s `narrowUserEvent` (user topic). Same contract,
 * same strictness, deliberately the same field-by-field order so the two
 * can be diffed by eye when the server grows an arm.
 *
 * Why narrow at all, in C, when we could just read fields at the point of
 * use? Because the wire is a boundary. A malformed push — kind valid but a
 * required field missing or wrong-typed — must be DROPPED as a unit, not
 * half-applied to app state. Reading fields lazily at the use site means a
 * payload can pass three checks, mutate three pieces of state, then fail
 * the fourth and leave the window list describing a session that never
 * happened. `wire_narrow` either yields a fully-valid event or false.
 *
 * ## Ownership
 *
 * Narrowing BORROWS from the `json_doc` it was parsed out of: every
 * `const char *` and every `const json_value *` in `struct wire_event`
 * points into that document's arena. The event is valid exactly as long as
 * the document. Callers copy what they need into app state before freeing.
 * Nothing here allocates, so nothing here can leak or need a destructor.
 *
 * ## Arrays
 *
 * Variable-length payloads (members, whois channels, banlist entries)
 * stay as `const json_value *` plus a count, with a typed per-element
 * accessor. `wire_narrow` has ALREADY validated every element before
 * returning true — the accessors cannot fail on a narrowed event. This
 * keeps the strict "one malformed element drops the whole payload"
 * semantics of the cic narrowers without allocating a parallel array.
 *
 * ## Nullability
 *
 * The wire distinguishes "absent/null" from "present". Nullable strings
 * are `const char *` that may be NULL. Nullable numbers are a `long` plus
 * a `has_` flag, because 0 is a legitimate value for every count here.
 */
#ifndef SHOTTINO_WIRE_H
#define SHOTTINO_WIRE_H

/* The wire protocol this client is written against — `Grappa.Protocol`'s
 * `@protocol_version` at the time these parsers were last taught the
 * wire, declared to the server as `client_proto` on the upgrade URL
 * (docs/CLIENT_PROTOCOL.md §3b).
 *
 * It is a claim, not a capability list: the server refuses a number
 * below its floor with 426 and otherwise opens the socket, and the wire
 * is additive so a server newer than this number still works — what it
 * added since is simply not shown. The number exists so that the build
 * can ask the question a running client cannot: test_commands pins it
 * to lib/grappa/protocol.ex, and reddens when the server bumps, so the
 * bump is READ (what moved, does a terminal care) rather than slept
 * through — nine bumps went by unnoticed before the pin existed.
 *
 * Last read, v59 -> v60 (issue 1112): `stale_toolchain`, a fourth refusal
 * of the loopback-only `POST /admin/reload`. A terminal never calls that
 * route, so nothing it renders changed.
 *
 * Replace this note at the next bump rather than appending to it — the
 * question the pin asks is about the CURRENT gap, not a changelog. */
#define WIRE_PROTOCOL_VERSION 60

#include <stdbool.h>
#include <stddef.h>

#include "json.h"

/* ── Closed sets ───────────────────────────────────────────────────────
 * Mirrors of server-side typespecs. An unknown value is a narrowing
 * failure, never a silently-tolerated string — same rule as the project's
 * "atoms or literal unions, never untyped strings" standard. */

typedef enum {
    MSG_PRIVMSG,
    MSG_NOTICE,
    MSG_ACTION,
    MSG_JOIN,
    MSG_PART,
    MSG_QUIT,
    MSG_NICK_CHANGE,
    MSG_MODE,
    MSG_TOPIC,
    MSG_KICK,
    MSG_SERVER_EVENT
} wire_message_kind;

/* Mirror of `Grappa.Networks.Credential`'s `@connection_states`, in its
 * order. `:failing` (#1675, v5) is the session process alive with the
 * upstream link NOT registered — a backoff running, not a terminal
 * state; it was missing here, so every connection_state_changed that
 * touched it was DROPPED WHOLE and the REST seed read the row unknown.
 * The pin in test_commands now compares this table to credential.ex. */
typedef enum { CONN_CONNECTED, CONN_FAILING, CONN_PARKED, CONN_FAILED } wire_connection_state;

typedef enum { PRESENCE_ONLINE, PRESENCE_OFFLINE, PRESENCE_UNKNOWN } wire_presence;

/* Mirror of `Grappa.WindowCounts.severity/0` — high to low. Singular
 * names, matching the server atoms (`:mention`, not `:mentions`). */
typedef enum {
    COUNTS_MENTION,
    COUNTS_MESSAGE,
    COUNTS_EVENT,
    COUNTS_NONE
} wire_counts_severity;

/* Mirror of `Grappa.Session.Wire`'s `@server_reply_sources`, in its
 * order. `:admin` was missing, so every /admin reply was dropped —
 * the same omission that once took `Session.Server` down on the server
 * side (#992), one hop out. Pinned to session/wire.ex. */
typedef enum { REPLY_INFO, REPLY_VERSION, REPLY_MOTD, REPLY_ADMIN } wire_reply_source;

/* The E2E closed sets (cicchetto/src/lib/wireTypes.ts SESSION_WIRE_E2E_VERB,
 * SESSION_WIRE_E2E_DROP_REASON, E2E_PAIRING_WIRE_SIDE,
 * E2E_PAIRING_WIRE_CLOSE_REASON, E2E_REQUESTS_WIRE_WIRE_STATE), each in its
 * server order; test_commands pins the tables to those lists. An inbox
 * item is never a keyreq: grappa answers KEYREQs itself. */
typedef enum { WIRE_E2E_KEYS, WIRE_E2E_PKMSG, WIRE_E2E_MSG, WIRE_E2E_NACK } wire_e2e_verb;
typedef enum {
    WIRE_E2E_DROP_LATE,
    WIRE_E2E_DROP_SEND_FAILED,
    WIRE_E2E_DROP_SESSION_ENDED
} wire_e2e_drop_reason;
typedef enum { WIRE_PAIRING_CREATOR, WIRE_PAIRING_JOINER } wire_pairing_side;
typedef enum {
    WIRE_PAIRING_CLOSED,
    WIRE_PAIRING_EXPIRED,
    WIRE_PAIRING_REPLACED
} wire_pairing_close_reason;
typedef enum {
    WIRE_E2E_REQ_INCOMING,
    WIRE_E2E_REQ_OUTGOING,
    WIRE_E2E_REQ_ACCEPTED,
    WIRE_E2E_REQ_REFUSED,
    WIRE_E2E_REQ_EXPIRED
} wire_e2e_request_state;

const char *wire_message_kind_name(wire_message_kind k);
const char *wire_connection_state_name(wire_connection_state s);
/* The server's spelling of each E2E closed-set value; "unknown" out of range. */
const char *wire_e2e_verb_name(wire_e2e_verb v);
const char *wire_e2e_drop_reason_name(wire_e2e_drop_reason r);
const char *wire_pairing_side_name(wire_pairing_side s);
const char *wire_pairing_close_reason_name(wire_pairing_close_reason r);
const char *wire_e2e_request_state_name(wire_e2e_request_state s);
/* How many values each table holds, for the pin. */
size_t wire_e2e_verb_count(void);
size_t wire_e2e_drop_reason_count(void);
size_t wire_pairing_side_count(void);
size_t wire_pairing_close_reason_count(void);
size_t wire_e2e_request_state_count(void);

/* ── Event kinds ─────────────────────────────────────────────────────── */

typedef enum {
    WIRE_UNKNOWN = 0,
    /* per-channel topic */
    WIRE_MESSAGE,
    WIRE_TOPIC_CHANGED,
    WIRE_CHANNEL_MODES_CHANGED,
    WIRE_CHANNEL_CREATED,
    WIRE_MEMBERS_SEEDED,
    WIRE_READ_CURSOR_SET,
    WIRE_WINDOW_COUNTS,
    /* dual-topic */
    WIRE_ISUPPORT_CHANGED,
    WIRE_JOINED,
    WIRE_JOIN_FAILED,
    WIRE_KICKED,
    /* user topic */
    WIRE_CHANNELS_CHANGED,
    WIRE_QUERY_WINDOWS_LIST,
    WIRE_MENTIONS_BUNDLE,
    WIRE_AWAY_CONFIRMED,
    WIRE_CONNECTION_PROGRESS,
    WIRE_NOTIFY_LIST,
    WIRE_PRESENCE_CHANGED,
    WIRE_PRESENCE_ERROR,
    WIRE_PRESENCE_SNAPSHOT,
    WIRE_OWN_NICK_CHANGED,
    WIRE_UMODE_CHANGED,
    WIRE_SUPPORTED_UMODES_CHANGED,
    WIRE_WINDOW_PENDING,
    WIRE_WINDOW_INVITED,
    WIRE_CONNECTION_STATE_CHANGED,
    WIRE_NETWORK_ATTACHED,
    WIRE_NETWORK_DETACHED,
    WIRE_WEB_SESSION_SEVERED,
    WIRE_WINDOW_INVITE_DECLINED,
    WIRE_DCC_OFFER,
    WIRE_DCC_OFFER_RESOLVED,
    WIRE_SESSION_IDENTITY_CHANGED,
    WIRE_RECOVER_PROGRESS,
    WIRE_RECOVER_RESULT,
    WIRE_WHOIS_AVATAR_READY,
    WIRE_AUTO_AWAY_DEBOUNCE_CHANGED,
    WIRE_AUTO_AWAY_REASON_CHANGED,
    WIRE_QUIT_PART_REASON_CHANGED,
    WIRE_WHOIS_BUNDLE,
    WIRE_NAMES_REPLY,
    WIRE_WHO_REPLY,
    WIRE_SERVER_REPLY,
    WIRE_INVITE_ACK,
    WIRE_BUNDLE_HASH,
    WIRE_SERVER_SETTINGS_CHANGED,
    WIRE_PEER_AWAY,
    WIRE_LUSERS_BUNDLE,
    WIRE_WHOWAS_BUNDLE,
    WIRE_BANLIST_BUNDLE,
    WIRE_LINKS_BUNDLE,
    WIRE_ARCHIVE_CHANGED,
    WIRE_ARCHIVE_PURGED,
    WIRE_DIRECTORY_PROGRESS,
    WIRE_DIRECTORY_COMPLETE,
    WIRE_DIRECTORY_FAILED,
    WIRE_AWAY_NICK_SUFFIX_CHANGED,
    WIRE_NO_SUCH_NICK,
    /* E2E, user topic (CLIENT_PROTOCOL §4f-§4l) */
    WIRE_E2E_MESSAGE,
    WIRE_E2E_SEND_DROPPED,
    WIRE_E2E_INCOMING,
    WIRE_E2E_INCOMING_LOST,
    WIRE_E2E_PAIRING_MESSAGE,
    WIRE_E2E_PAIRING_CLOSED,
    WIRE_E2E_PAIRING_OFFERED,
    WIRE_E2E_REQUEST,
    WIRE_E2E_REQUEST_GONE
} wire_kind;

const char *wire_kind_name(wire_kind k);

/* Is `name` an event kind this client narrows? The by-NAME inverse of
 * `wire_kind_name` (the sibling `wire_kind_known` above answers the
 * same question about a payload), for the parity gate: every kind
 * cicchetto narrows must be known here, including the ones a terminal
 * deliberately drops — see test_commands. */
bool wire_kind_name_known(const char *name);

/* The connection states this client mirrors, in the server's order —
 * `wire_connection_state_name(i)` for i < this. Exported so the pin can
 * compare the table to `credential.ex` without reaching into wire.c. */
size_t wire_connection_state_count(void);

/* ── Element shapes (borrowed, per-element accessors) ────────────────── */

struct wire_member {
    const char *nick;
    const json_value *modes; /* array of mode letters, possibly empty */
    size_t mode_count;
};

struct wire_who_user {
    const char *nick;
    const char *user;
    const char *host;
    const char *server;
    const char *modes; /* raw WHO flags STRING, not a prefix list */
    const char *channel;
    long hops;
    bool has_hops;
    const char *realname; /* nullable */
};

struct wire_banlist_entry {
    const char *mask;
    const char *setter; /* nullable */
    const char *set_ts; /* nullable */
};

struct wire_links_entry {
    const char *server;
    const char *linked_to; /* nullable */
    long hopcount;
    bool has_hopcount;
    const char *description; /* nullable */
};

struct wire_whois_extra {
    long numeric;
    const char *text;
};

struct wire_mention {
    long server_time;
    const char *channel;
    const char *sender;
    const char *body; /* nullable */
    wire_message_kind kind;
};

struct wire_scrollback_message {
    long id;
    const char *network;
    const char *channel;
    long server_time;
    wire_message_kind kind;
    const char *sender;
    const char *body;         /* nullable */
    const char *dm_with;      /* nullable: nil off a DM, absent below protocol 36 */
    const json_value *meta;   /* object; opaque bag, read per call site */
    /* A presence row's facts, lifted out of `meta` once, here (server
     * Grappa.Scrollback.Meta). `body` does NOT carry them: it is null on
     * nick_change and mode, and the REASON on kick. NULL when absent. */
    const char *new_nick;     /* nick_change: the nick taken */
    const char *target;       /* kick: the nick kicked */
    const char *modes;        /* mode: "+ov" */
    const json_value *mode_args; /* mode: array of strings, or NULL */
    /* server_event (CLIENT_PROTOCOL §4f "Undeliverable"): a peer sent
     * this many encrypted messages no device of ours can read, and the
     * device they were for (a did; NULL on a row before wire v2). */
    long e2e_undeliverable;
    bool has_e2e_undeliverable;
    const char *e2e_device;
};

/* One whole E2E message for device `to_did` (`e2e_message` push, and each
 * item of `GET …/inbox`): the same shape both ways. `own` marks a copy a
 * sibling device of ours sent. `payload` is compact JSON text, never
 * logged: it is the ciphertext. */
struct wire_e2e_message {
    long id;
    const char *network;
    const char *from;
    const char *from_did; /* a did, or "*" (grappa) */
    const char *to_did;
    wire_e2e_verb verb;
    const char *msgid;
    const char *payload;
    size_t payload_len;
    bool own;
};

/* A consent request (§4i). `payload` and `expires_at` nullable. */
struct wire_e2e_request {
    long id;
    const char *peer;
    wire_e2e_request_state state;
    const char *payload;
    const char *at;
    const char *expires_at;
};

/* A mode row as it reads on IRC: "+ov carol dave". False (and `out`
 * empty) when the row carries no modes. */
bool wire_mode_text(const struct wire_scrollback_message *m, char *out, size_t out_sz);

/* ── The event ───────────────────────────────────────────────────────── */

struct wire_event {
    wire_kind kind;
    union {
        struct wire_scrollback_message message;

        struct {
            const char *network;
            const char *channel;
            const char *text;   /* nullable */
            const char *set_by; /* nullable */
            const char *set_at; /* nullable */
        } topic_changed;

        struct {
            const char *network;
            const char *channel;
            const json_value *modes; /* array of strings */
            size_t mode_count;
            const json_value *params; /* object: mode letter -> arg|null */
        } channel_modes;

        struct {
            const char *network;
            const char *channel;
            const char *created_at;
        } channel_created;

        struct {
            const char *network;
            const char *channel;
            const json_value *members; /* array; use wire_member_at */
            size_t member_count;
        } members_seeded;

        struct {
            long last_read_message_id;
            long badge_count;
        } read_cursor;

        struct {
            const char *channel;
            long messages;
            long mentions;
            long events;
            wire_counts_severity severity;
        } window_counts;

        struct {
            long network_id;
            const json_value *chanmodes_a;
            const json_value *chanmodes_b;
            const json_value *chanmodes_c;
            const json_value *chanmodes_d;
            const json_value *prefix; /* object: mode letter -> sigil */
            /* Both lenient, as wireNarrow.ts reads them: absent or
             * malformed is ABSENT, never a refused envelope. The budget
             * sizes an E2E message (§6.4); `network` is the 005 NETWORK=
             * token an order challenge names (NULL when unadvertised or
             * empty: a challenge is then answered nowhere). */
            long frame_budget_base;
            bool has_frame_budget_base;
            const char *network;
            /* CHANTYPES (005), an array of one-character strings — the
             * sigils an order challenge's channel is read against. NULL
             * when absent or malformed (lenient like the two above). */
            const json_value *chantypes;
        } isupport;

        /* joined / join_failed / kicked share a head so the common
         * (network, channel) read needs no per-kind switch. */
        struct {
            const char *network;
            const char *channel;
            const char *reason; /* join_failed + kicked; nullable */
            const char *by;     /* kicked only; nullable */
            long numeric;       /* join_failed only */
            bool has_numeric;
        } window_state;

        struct {
            const json_value *windows; /* object: nick -> array of entries */
            size_t nick_count;
        } query_windows;

        struct {
            const char *network;
            const char *away_started_at;
            const char *away_ended_at;
            const char *away_reason; /* nullable */
            const json_value *messages;
            size_t message_count;
        } mentions_bundle;

        struct {
            const char *network;
            bool away; /* state: "away" | "present" */
        } away_confirmed;

        struct {
            const char *network;
            bool connected; /* state: "connected" | "connecting" */
        } connection_progress;

        struct {
            const json_value *networks; /* object: slug -> array of entries */
            size_t network_count;
        } notify_list;

        struct {
            long network_id;
            const char *nick;
            bool online;
            bool initial;
            bool from_monitor; /* source: "monitor" | "watch" */
            const char *ts;
        } presence_changed;

        struct {
            long network_id;
            const char *detail;
        } presence_error;

        struct {
            long network_id;
            const json_value *nicks; /* object: nick -> presence string */
            size_t nick_count;
        } presence_snapshot;

        struct {
            long network_id;
            const char *nick;
        } own_nick;

        struct {
            long network_id;
            const json_value *modes; /* array of letters */
            size_t mode_count;
        } umodes;

        struct {
            const char *network;
            const char *channel;
        } window_open; /* window_pending / window_invited / window_invite_declined */

        /* web_session_severed (§6): the flood ladder revoked this bearer
         * and the socket is about to close. `code` is the snake_case
         * sever code, `rate_limit_flood` being the only one today. */
        struct {
            const char *code;
        } severed;

        /* dcc_offer (§4b, v19): a peer offered a file and the server is
         * holding the offer for a human. NOT window state and carries
         * none — `channel` is where to RENDER the prompt, very often
         * $server. */
        struct {
            const char *network;
            const char *channel;
            const char *offer_id;
            const char *from;
            const char *filename;
            long size;
        } dcc_offer;

        /* session_identity_changed (#388): whether the operator is
         * identified to services. `identified` is the VERDICT and the
         * only thing to gate on — never a mode letter, which is
         * bahamut-only. `account` is display data and nullable even
         * while identified. */
        struct {
            long network_id;
            bool identified;
            const char *account; /* nullable */
        } identity;

        /* recover_progress / recover_result: ghost recovery, step by
         * step and then its outcome. Both closed sets on the server;
         * kept as strings here because shottino only says them. */
        struct {
            const char *network;
            const char *step;   /* progress only */
            const char *status; /* progress only */
            const char *outcome; /* result only */
            const char *reason; /* nullable */
        } recover;

        /* whois_avatar_ready: a peer's avatar finished fetching. A
         * terminal has nowhere to put a face; narrowed so the kind is
         * KNOWN and deliberately ignored rather than unrecognised. */
        struct {
            const char *network;
            const char *nick;
            const char *avatar_url;
        } whois_avatar;

        /* The three settings echoes: a value this subject changed from
         * some client, pushed to the others. Each is one nullable
         * scalar. */
        struct {
            const char *text;    /* auto_away_reason / quit_part_reason */
            long seconds;        /* auto_away_debounce */
            bool has_seconds;
        } setting_echo;

        /* dcc_offer_resolved: the only take-down signal, on every
         * device. `resolution` is closed at accepted/refused/expired;
         * an unknown one still takes the banner down. */
        struct {
            const char *network;
            const char *channel;
            const char *offer_id;
            const char *resolution;
        } dcc_resolved;

        struct {
            long network_id;
            const char *network_slug;
            wire_connection_state from;
            wire_connection_state to;
            const char *reason; /* nullable */
            const char *at;     /* nullable */
            const char *nick;
            wire_connection_state state;
            const char *state_reason; /* nullable */
        } connection_state;

        /* network_attached / network_detached (§4e, v28): what moved and
         * nothing else — no state, by contract. GET /networks owns the
         * answer. */
        struct {
            long network_id;
            const char *network_slug;
        } network_link;

        struct {
            const char *network;
            const char *target;
            const char *user;
            const char *host;
            const char *realname;
            const char *server;
            const char *server_info;
            const char *oper_text;
            const char *umodes;
            const char *away_message;
            const char *actually_host;
            const char *actually_ip;
            const char *account;
            const char *secure_cipher;
            const char *certfp;
            long idle_seconds;
            bool has_idle;
            long signon;
            bool has_signon;
            bool is_operator;
            bool using_ssl;
            bool is_registered;
            bool is_admin;
            bool is_services_admin;
            bool is_helper;
            bool is_chanop;
            bool is_agent;
            bool is_java;
            bool secure;
            const json_value *channels; /* array of strings; may be absent */
            size_t channel_count;
            bool has_channels;
            const json_value *extra_lines; /* array of {numeric,text} */
            size_t extra_count;
        } whois;

        struct {
            const char *network;
            const char *channel;
            const json_value *members;
            size_t member_count;
        } names_reply;

        struct {
            const char *network;
            const char *target;
            const json_value *users;
            size_t user_count;
        } who_reply;

        struct {
            const char *network;
            wire_reply_source source;
            const json_value *lines;
            size_t line_count;
        } server_reply;

        struct {
            const char *network;
            const char *channel;
            const char *peer;
        } invite_ack;

        struct {
            const char *hash;
            const char *version; /* nullable */
        } bundle_hash;

        struct {
            const char *active_host;
            long image_cap;
            long video_cap;
            long document_cap;
            long audio_cap;
            long global_cap;
            const json_value *host_aliases; /* lenient: may be NULL */
            size_t alias_count;
        } server_settings;

        struct {
            const char *network;
            const char *peer;
            const char *message;
        } peer_away;

        struct {
            const char *network;
            /* Every count is optional; a garbled one renders "—" rather
             * than dropping the eleven good counts beside it. */
            long total_users, invisible, servers, operators, unknown_connections;
            long channels_formed, local_clients, local_servers;
            long current_local, max_local, current_global, max_global;
            bool has[12];
        } lusers;

        struct {
            const char *network;
            const char *target;
            const char *user;
            const char *host;
            const char *realname;
            const char *server;
            const char *logoff_time;
            bool not_found;
        } whowas;

        struct {
            const char *network;
            const char *channel;
            const json_value *entries;
            size_t entry_count;
        } banlist;

        struct {
            const char *network;
            const json_value *entries;
            size_t entry_count;
        } links;

        struct {
            const char *network_slug;
            const char *target; /* archive_purged only */
        } archive;

        struct {
            const char *network;
            long count;   /* progress: seen so far; complete: total */
            const char *reason; /* failed only */
        } directory;

        struct {
            /* NULL is a VALUE here, not an absence: it is how "the rename
             * is switched off" travels. The key is always present on the
             * wire; `json_str_opt` also tolerates it missing, which is the
             * same latitude every other nullable field in this file takes. */
            const char *suffix;
        } away_nick_suffix;

        struct {
            const char *network;
            const char *nick; /* RAW, as the 401 carries it */
        } no_such_nick;

        /* e2e_message (§4f): a doorbell as much as a message — cic drains
         * the inbox on it. At least once: dedupe by `id`. */
        struct wire_e2e_message e2e_message;

        /* e2e_send_dropped (v46): an accepted send dropped unsent. May
         * arrive BEFORE the 202 that names `msgid`. */
        struct {
            const char *network;
            const char *target;
            const char *msgid;
            wire_e2e_drop_reason reason;
        } e2e_send_dropped;

        /* e2e_incoming / e2e_incoming_lost (v59): a multi-line message on
         * its way, and its loss. `from` is on the first only. `to` a did
         * or "*". */
        struct {
            const char *network;
            const char *from; /* e2e_incoming only */
            const char *from_did;
            const char *to;
            const char *msgid;
        } e2e_incoming;

        /* e2e_pairing_message / e2e_pairing_closed / e2e_pairing_offered
         * (v48, v55): subject-wide, no network. */
        struct {
            const char *rendezvous_id;
            long seq;                         /* message */
            wire_pairing_side from;           /* message */
            wire_pairing_close_reason reason; /* closed */
            const char *curve;                /* offered */
            const char *expires_at;           /* offered */
        } e2e_pairing;

        /* e2e_request (v53): a request made or changed state. */
        struct {
            const char *network;
            struct wire_e2e_request request;
        } e2e_request;

        /* e2e_request_gone (v53). */
        struct {
            const char *network;
            long id;
        } e2e_request_gone;
    } u;
};

/* Index into `lusers.has[]` — one name per optional count, so a caller
 * cannot silently read the wrong flag. */
enum {
    LUSERS_TOTAL_USERS,
    LUSERS_INVISIBLE,
    LUSERS_SERVERS,
    LUSERS_OPERATORS,
    LUSERS_UNKNOWN_CONNECTIONS,
    LUSERS_CHANNELS_FORMED,
    LUSERS_LOCAL_CLIENTS,
    LUSERS_LOCAL_SERVERS,
    LUSERS_CURRENT_LOCAL,
    LUSERS_MAX_LOCAL,
    LUSERS_CURRENT_GLOBAL,
    LUSERS_MAX_GLOBAL
};

/* Resolve the PubSub subject key from an auth or profile response.
 *
 * Not a Phoenix event, but the same job as everything else here: server
 * JSON in, a typed value out — and it lives beside the narrowers so it is
 * testable without a terminal, which is what this function most needed.
 *
 * TWO wire shapes, and both must be read:
 *
 *   POST /auth/login          → {token, subject: {kind, id, name}}
 *   POST /auth/share/consume  → {token, subject: {kind, id, ...}}
 *   GET  /me                  → {kind, id, name, ...}   (subject FLAT)
 *
 * Login and share-consume are credential EXCHANGES, so they wrap the
 * subject in an envelope beside the token; `/me` IS the subject, so its
 * fields sit at the root. This prefers the nested object and falls back
 * to the root, covering all three without a per-call-site flag.
 *
 * Writes an empty string and returns false when the subject cannot be
 * resolved, so a caller reports "missing subject" rather than proceeding
 * with a half-formed key like "visitor:" that would become a topic. */
bool wire_subject_key(const json_value *root, char *out, size_t out_sz);

/* Narrow a bare scrollback row.
 *
 * The same row shape arrives two ways: nested under `message` in a WS
 * event, and as an element of the REST scrollback page. Exported so both
 * paths share ONE definition of what a scrollback row is, rather than the
 * REST side growing a second, drifting reader. */
bool wire_narrow_message(const json_value *row, struct wire_scrollback_message *out);

/* Narrow one event payload. Returns false (leaving `*ev` untouched) when
 * the payload is malformed OR the kind is one shottino does not consume —
 * the caller treats both as "drop", exactly like cic's default-null arm. */
/* Does this build recognise the payload's `kind`? Lets a caller
 * distinguish "a newer server sent something we do not implement yet"
 * (ignore it — the wire is additive-only) from "we know this kind and
 * refused its payload" (say so out loud). `kind_out` receives the raw
 * string, or NULL when there is not one. */
bool wire_kind_known(const json_value *p, const char **kind_out);

bool wire_narrow(const json_value *payload, struct wire_event *ev);

/* ── Element accessors ─────────────────────────────────────────────────
 * Valid only on arrays reached from an event that `wire_narrow` accepted;
 * every element was validated during narrowing, so these cannot fail for
 * an in-range index. */
bool wire_member_at(const json_value *members, size_t i, struct wire_member *out);
bool wire_who_user_at(const json_value *users, size_t i, struct wire_who_user *out);
bool wire_banlist_entry_at(const json_value *entries, size_t i, struct wire_banlist_entry *out);
bool wire_links_entry_at(const json_value *entries, size_t i, struct wire_links_entry *out);
bool wire_whois_extra_at(const json_value *lines, size_t i, struct wire_whois_extra *out);
bool wire_mention_at(const json_value *messages, size_t i, struct wire_mention *out);
const char *wire_string_at(const json_value *arr, size_t i);

/* Presence value of a `presence_snapshot` entry, by position. */
bool wire_presence_at(const json_value *nicks, size_t i, const char **nick, wire_presence *out);

/* ── E2E REST (CLIENT_PROTOCOL §4f-§4k) ───────────────────────────────
 * Every E2E door shottino calls, as a closed set: the method, the path
 * and the shape of a 2xx answer live in ONE table, so a door is spelled
 * once and the app glue has one call path for all of them. Paths are
 * without `/api`; `:n` is the network SLUG, already URL-encoded by the
 * caller; a did goes in raw (it is base64url). */
typedef enum {
    WIRE_E2E_DEVICE_REGISTER, /* POST   …/e2e/devices                 → device */
    WIRE_E2E_DEVICES,         /* GET    …/e2e/devices                 → {devices} */
    WIRE_E2E_DEVICE_DELETE,   /* DELETE …/e2e/devices/:did            → 204 */
    WIRE_E2E_LIST_PUT,        /* PUT    …/e2e/list                    → list */
    WIRE_E2E_LIST_GET,        /* GET    …/e2e/list                    → list | 404 */
    WIRE_E2E_KEYS_DELETE,     /* DELETE …/e2e/keys                    → 204 */
    WIRE_E2E_BUNDLE_UPLOAD,   /* POST   …/e2e/devices/:did/keys       → status */
    WIRE_E2E_BUNDLE_STATUS,   /* GET    …/e2e/devices/:did/keys       → status */
    WIRE_E2E_INBOX,           /* GET    …/e2e/devices/:did/inbox?after → {messages} */
    WIRE_E2E_INBOX_ACK,       /* POST   …/e2e/devices/:did/inbox/ack  → 204 */
    WIRE_E2E_CLAIM,           /* POST   …/e2e/devices/:did/claim      → {keys} */
    WIRE_E2E_COPY,            /* POST   …/e2e/devices/:did/copies     → {id, msgid} */
    WIRE_E2E_SEND,            /* POST   …/e2e/messages                → {msgid} */
    /* Consent requests (§4i, v53): `:id` is the request's id, in decimal,
     * passed where the device doors take a did. */
    WIRE_E2E_REQUESTS,        /* GET    …/e2e/requests                → {requests} */
    WIRE_E2E_REQUEST_ASK,     /* POST   …/e2e/requests                → {request} */
    WIRE_E2E_REQUEST_ACCEPT,  /* POST   …/e2e/requests/:id/accept     → {msgid} */
    WIRE_E2E_REQUEST_REFUSE,  /* POST   …/e2e/requests/:id/refuse     → {msgid} */
    WIRE_E2E_REQUEST_DISMISS  /* DELETE …/e2e/requests/:id            → 204 */
} wire_e2e_door;

const char *wire_e2e_door_method(wire_e2e_door d);
/* Whether a 2xx answer of the door carries a JSON body (false: 204). */
bool wire_e2e_door_has_body(wire_e2e_door d);
/* The door's path for network `slug_enc` (URL-encoded) and device `did`
 * (ignored by the doors that take none); `after` is the inbox cursor
 * (ignored elsewhere; < 0 = none). False when the path does not fit, or a
 * door that names a device was given no did. */
bool wire_e2e_door_path(wire_e2e_door d, const char *slug_enc, const char *did, long after,
                        char *out, size_t out_sz);

/* A device as grappa holds it. `last_seen_at` (v56) and `inserted_at`
 * (v57) may be absent; the first is nullable. */
struct wire_e2e_device {
    const char *did;
    const char *ed25519;
    const char *curve25519;
    const char *sig;
    const char *last_seen_at;
    const char *inserted_at;
};

/* A master's list as grappa holds it. `ver` stays the parsed number: the
 * list rule judges it (an integer value in 1..2^31-1), not this reader. */
struct wire_e2e_list {
    const char *master;
    double ver;
    const json_value *devices; /* array of strings; wire_string_at */
    size_t device_count;
    const char *sig;
};

/* Each narrows a whole 2xx body as a unit (false: not that shape). */
bool wire_narrow_e2e_device(const json_value *v, struct wire_e2e_device *out);
bool wire_narrow_e2e_devices(const json_value *root, const json_value **devices, size_t *count);
bool wire_e2e_device_at(const json_value *devices, size_t i, struct wire_e2e_device *out);
bool wire_narrow_e2e_list(const json_value *root, struct wire_e2e_list *out);
bool wire_narrow_e2e_key_status(const json_value *root, long *one_time_keys, bool *fallback);
bool wire_narrow_e2e_message(const json_value *v, struct wire_e2e_message *out);
bool wire_narrow_e2e_inbox(const json_value *root, const json_value **messages, size_t *count);
bool wire_e2e_message_at(const json_value *messages, size_t i, struct wire_e2e_message *out);
bool wire_narrow_e2e_request(const json_value *v, struct wire_e2e_request *out);
bool wire_narrow_e2e_requests(const json_value *root, const json_value **requests, size_t *count);
bool wire_e2e_request_at(const json_value *requests, size_t i, struct wire_e2e_request *out);
/* `{request: request}`, the ask door's answer. */
bool wire_narrow_e2e_asked(const json_value *root, struct wire_e2e_request *out);
bool wire_narrow_e2e_claimed(const json_value *root, const char **keys);
bool wire_narrow_e2e_copied(const json_value *root, long *id, const char **msgid);
bool wire_narrow_e2e_sent(const json_value *root, const char **msgid);
/* The `{"error": "<token>"}` of a refusal, or NULL. */
const char *wire_e2e_error(const json_value *root);

/* ── E2E pairing relay (CLIENT_PROTOCOL §4g, v48; the offer v55) ───────
 * Subject-wide, so NOT under /networks: one pairing covers every network.
 * The routes take a full session (403 client_token_scope to a per-client
 * token, 403 forbidden to an incognito visitor). A rendezvous id goes into
 * the path raw, and only when it is url-safe base64 (grappa mints 22
 * characters of it). */
typedef enum {
    WIRE_PAIR_OPEN,     /* POST   /e2e/pairings                     → {rendezvous} */
    WIRE_PAIR_OFFER,    /* GET    /e2e/pairings/offer               → {offer|null} */
    WIRE_PAIR_JOIN,     /* POST   /e2e/pairings/:id/join            → {rendezvous} */
    WIRE_PAIR_POST,     /* POST   /e2e/pairings/:id/messages        → {message} */
    WIRE_PAIR_MESSAGES, /* GET    /e2e/pairings/:id/messages?after= → {messages} */
    WIRE_PAIR_CLOSE     /* DELETE /e2e/pairings/:id                 → 204 */
} wire_pair_door;

const char *wire_pair_door_method(wire_pair_door d);
bool wire_pair_door_has_body(wire_pair_door d);
/* False when the path does not fit, or a door that names a rendezvous was
 * given no id, or one that is not ^[A-Za-z0-9_-]{1,64}$. `after` (< 0 =
 * none) is the MESSAGES cursor, ignored elsewhere. */
bool wire_pair_door_path(wire_pair_door d, const char *id, long after, char *out, size_t out_sz);
bool wire_pair_id_valid(const char *id);

struct wire_pair_rendezvous {
    const char *id;
    wire_pairing_side role;
    const char *expires_at;
};

struct wire_pair_offer {
    const char *rendezvous_id;
    const char *curve;
    const char *expires_at;
};

struct wire_pair_message {
    long seq;
    wire_pairing_side from;
    const char *payload;
};

/* `{rendezvous: {id, role, expires_at}}`. */
bool wire_narrow_pair_rendezvous(const json_value *root, struct wire_pair_rendezvous *out);
/* `{offer: {…}}` (*present true) or `{offer: null}` (*present false). */
bool wire_narrow_pair_offer(const json_value *root, bool *present, struct wire_pair_offer *out);
/* `{message: {seq, from, payload}}`, POST's answer. */
bool wire_narrow_pair_posted(const json_value *root, struct wire_pair_message *out);
/* `{messages: [{seq, from, payload}…]}`, every element valid. */
bool wire_narrow_pair_messages(const json_value *root, const json_value **messages, size_t *count);
bool wire_pair_message_at(const json_value *messages, size_t i, struct wire_pair_message *out);

/* ── Phoenix framing ───────────────────────────────────────────────────
 * A v2 socket frame is `[join_ref, ref, topic, event, payload]`. Splits it
 * without assuming any field is non-null (join_ref and ref are null on
 * server-initiated pushes). Returns false if the frame is not a v2 array. */
/* The network a topic names: what sits between `/network:` and the next
 * `/channel:` (or the end). Empty on the user topic. Filled at the
 * split because some per-channel events — window_counts, read_cursor_set
 * — carry no network of their own and are scoped by the topic they
 * arrive on; a handler that matched them by channel alone gave #chan on
 * one network the other network's badge. Copied, not borrowed: the
 * topic string is one field and the slug is a slice of it. */
#define WIRE_MAX_SLUG 128
struct wire_frame {
    const char *topic;
    const char *event;
    const json_value *payload;
    const char *ref; /* nullable */
    char network[WIRE_MAX_SLUG];
};
bool wire_frame_split(const json_value *root, struct wire_frame *out);

#endif /* SHOTTINO_WIRE_H */
