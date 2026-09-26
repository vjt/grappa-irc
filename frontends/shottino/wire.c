/* wire.c — see wire.h. Field order within each arm deliberately follows
 * the corresponding narrower in cicchetto's wireNarrow.ts / userTopic.ts. */
#include "wire.h"

#include <stdio.h>
#include <string.h>

/* ── Closed-set lookups ───────────────────────────────────────────────── */

static const char *const MESSAGE_KIND_NAMES[] = {
    "privmsg", "notice", "action", "join", "part",  "quit",
    "nick_change", "mode", "topic", "kick", "server_event"};

const char *wire_message_kind_name(wire_message_kind k) {
    size_t i = (size_t)k;
    return i < sizeof(MESSAGE_KIND_NAMES) / sizeof(MESSAGE_KIND_NAMES[0]) ? MESSAGE_KIND_NAMES[i]
                                                                          : "unknown";
}

static bool message_kind_of(const json_value *v, wire_message_kind *out) {
    const char *s = json_string(v);
    if (!s) return false;
    for (size_t i = 0; i < sizeof(MESSAGE_KIND_NAMES) / sizeof(MESSAGE_KIND_NAMES[0]); i++) {
        if (strcmp(s, MESSAGE_KIND_NAMES[i]) == 0) {
            *out = (wire_message_kind)i;
            return true;
        }
    }
    return false;
}

static const char *const CONNECTION_STATE_NAMES[] = {"connected", "failing", "parked", "failed"};
/* From the table, not from a 3 written twice: the array grows, the two
 * loops that walk it did not. The sibling message_kind_of already used
 * this idiom, which is what made the odd one out visible. */
#define CONNECTION_STATE_COUNT (sizeof(CONNECTION_STATE_NAMES) / sizeof(CONNECTION_STATE_NAMES[0]))

const char *wire_connection_state_name(wire_connection_state s) {
    size_t i = (size_t)s;
    return i < CONNECTION_STATE_COUNT ? CONNECTION_STATE_NAMES[i] : "unknown";
}

static bool connection_state_of(const json_value *v, wire_connection_state *out) {
    const char *s = json_string(v);
    if (!s) return false;
    for (size_t i = 0; i < CONNECTION_STATE_COUNT; i++) {
        if (strcmp(s, CONNECTION_STATE_NAMES[i]) == 0) {
            *out = (wire_connection_state)i;
            return true;
        }
    }
    return false;
}

static bool presence_of(const json_value *v, wire_presence *out) {
    const char *s = json_string(v);
    if (!s) return false;
    if (strcmp(s, "online") == 0) { *out = PRESENCE_ONLINE; return true; }
    if (strcmp(s, "offline") == 0) { *out = PRESENCE_OFFLINE; return true; }
    if (strcmp(s, "unknown") == 0) { *out = PRESENCE_UNKNOWN; return true; }
    return false;
}

/* Severity is deliberately LENIENT: an unrecognised value degrades to
 * "none" rather than dropping the event, because the counts are the
 * load-bearing part and a stale server mid-deploy must not blank them.
 * Mirrors narrowSeverity() in wireNarrow.ts. */
static wire_counts_severity severity_of(const json_value *v) {
    const char *s = json_string(v);
    if (!s) return COUNTS_NONE;
    if (strcmp(s, "mention") == 0) return COUNTS_MENTION;
    if (strcmp(s, "message") == 0) return COUNTS_MESSAGE;
    if (strcmp(s, "event") == 0) return COUNTS_EVENT;
    return COUNTS_NONE;
}

static const struct {
    const char *name;
    wire_kind kind;
} KIND_TABLE[] = {
    {"message", WIRE_MESSAGE},
    {"topic_changed", WIRE_TOPIC_CHANGED},
    {"channel_modes_changed", WIRE_CHANNEL_MODES_CHANGED},
    {"channel_created", WIRE_CHANNEL_CREATED},
    {"members_seeded", WIRE_MEMBERS_SEEDED},
    {"read_cursor_set", WIRE_READ_CURSOR_SET},
    {"window_counts", WIRE_WINDOW_COUNTS},
    {"isupport_changed", WIRE_ISUPPORT_CHANGED},
    {"joined", WIRE_JOINED},
    {"join_failed", WIRE_JOIN_FAILED},
    {"kicked", WIRE_KICKED},
    {"channels_changed", WIRE_CHANNELS_CHANGED},
    {"query_windows_list", WIRE_QUERY_WINDOWS_LIST},
    {"mentions_bundle", WIRE_MENTIONS_BUNDLE},
    {"away_confirmed", WIRE_AWAY_CONFIRMED},
    {"connection_progress", WIRE_CONNECTION_PROGRESS},
    {"notify_list", WIRE_NOTIFY_LIST},
    {"presence_changed", WIRE_PRESENCE_CHANGED},
    {"presence_error", WIRE_PRESENCE_ERROR},
    {"presence_snapshot", WIRE_PRESENCE_SNAPSHOT},
    {"own_nick_changed", WIRE_OWN_NICK_CHANGED},
    {"umode_changed", WIRE_UMODE_CHANGED},
    {"supported_umodes_changed", WIRE_SUPPORTED_UMODES_CHANGED},
    {"window_pending", WIRE_WINDOW_PENDING},
    {"window_invited", WIRE_WINDOW_INVITED},
    {"connection_state_changed", WIRE_CONNECTION_STATE_CHANGED},
    {"network_attached", WIRE_NETWORK_ATTACHED},
    {"network_detached", WIRE_NETWORK_DETACHED},
    {"web_session_severed", WIRE_WEB_SESSION_SEVERED},
    {"window_invite_declined", WIRE_WINDOW_INVITE_DECLINED},
    {"dcc_offer", WIRE_DCC_OFFER},
    {"dcc_offer_resolved", WIRE_DCC_OFFER_RESOLVED},
    {"session_identity_changed", WIRE_SESSION_IDENTITY_CHANGED},
    {"recover_progress", WIRE_RECOVER_PROGRESS},
    {"recover_result", WIRE_RECOVER_RESULT},
    {"whois_avatar_ready", WIRE_WHOIS_AVATAR_READY},
    {"auto_away_debounce_changed", WIRE_AUTO_AWAY_DEBOUNCE_CHANGED},
    {"auto_away_reason_changed", WIRE_AUTO_AWAY_REASON_CHANGED},
    {"quit_part_reason_changed", WIRE_QUIT_PART_REASON_CHANGED},
    {"whois_bundle", WIRE_WHOIS_BUNDLE},
    {"names_reply", WIRE_NAMES_REPLY},
    {"who_reply", WIRE_WHO_REPLY},
    {"server_reply", WIRE_SERVER_REPLY},
    {"invite_ack", WIRE_INVITE_ACK},
    {"bundle_hash", WIRE_BUNDLE_HASH},
    {"server_settings_changed", WIRE_SERVER_SETTINGS_CHANGED},
    {"peer_away", WIRE_PEER_AWAY},
    {"lusers_bundle", WIRE_LUSERS_BUNDLE},
    {"whowas_bundle", WIRE_WHOWAS_BUNDLE},
    {"banlist_bundle", WIRE_BANLIST_BUNDLE},
    {"links_bundle", WIRE_LINKS_BUNDLE},
    {"archive_changed", WIRE_ARCHIVE_CHANGED},
    {"archive_purged", WIRE_ARCHIVE_PURGED},
    {"directory_progress", WIRE_DIRECTORY_PROGRESS},
    {"directory_complete", WIRE_DIRECTORY_COMPLETE},
    {"directory_failed", WIRE_DIRECTORY_FAILED},
    {"away_nick_suffix_changed", WIRE_AWAY_NICK_SUFFIX_CHANGED},
};

const char *wire_kind_name(wire_kind k) {
    for (size_t i = 0; i < sizeof(KIND_TABLE) / sizeof(KIND_TABLE[0]); i++)
        if (KIND_TABLE[i].kind == k) return KIND_TABLE[i].name;
    return "unknown";
}

static wire_kind kind_of(const char *name) {
    for (size_t i = 0; i < sizeof(KIND_TABLE) / sizeof(KIND_TABLE[0]); i++)
        if (strcmp(KIND_TABLE[i].name, name) == 0) return KIND_TABLE[i].kind;
    return WIRE_UNKNOWN;
}

bool wire_kind_name_known(const char *name) { return kind_of(name) != WIRE_UNKNOWN; }

size_t wire_connection_state_count(void) { return CONNECTION_STATE_COUNT; }

/* ── Element validation ────────────────────────────────────────────────
 * Each `check_*` validates one element; each `validate_*_array` walks the
 * whole array and fails on the first bad element. Strictness is the point:
 * a half-typed roster row is worse than no roster. */

static bool check_string(const json_value *v) { return json_string(v) != NULL; }

static bool validate_array(const json_value *arr, bool (*check)(const json_value *)) {
    if (json_type_of(arr) != JSON_ARRAY) return false;
    size_t n = json_len(arr);
    for (size_t i = 0; i < n; i++)
        if (!check(json_at(arr, i))) return false;
    return true;
}

static bool check_member(const json_value *v) {
    if (json_type_of(v) != JSON_OBJECT) return false;
    const char *nick = NULL;
    if (!json_str_req(v, "nick", &nick)) return false;
    return validate_array(json_get(v, "modes"), check_string);
}

static bool check_who_user(const json_value *v) {
    if (json_type_of(v) != JSON_OBJECT) return false;
    const char *s = NULL;
    if (!json_str_req(v, "nick", &s) || !json_str_req(v, "user", &s) ||
        !json_str_req(v, "host", &s) || !json_str_req(v, "server", &s) ||
        !json_str_req(v, "modes", &s) || !json_str_req(v, "channel", &s))
        return false;
    long n;
    if (!json_long_opt(v, "hops", &n, NULL)) return false;
    return json_str_opt(v, "realname", &s);
}

static bool check_banlist_entry(const json_value *v) {
    if (json_type_of(v) != JSON_OBJECT) return false;
    const char *s = NULL;
    if (!json_str_req(v, "mask", &s)) return false;
    return json_str_opt(v, "setter", &s) && json_str_opt(v, "set_ts", &s);
}

static bool check_links_entry(const json_value *v) {
    if (json_type_of(v) != JSON_OBJECT) return false;
    const char *s = NULL;
    if (!json_str_req(v, "server", &s)) return false;
    if (!json_str_opt(v, "linked_to", &s)) return false;
    long n;
    if (!json_long_opt(v, "hopcount", &n, NULL)) return false;
    return json_str_opt(v, "description", &s);
}

static bool check_whois_extra(const json_value *v) {
    if (json_type_of(v) != JSON_OBJECT) return false;
    long n;
    const char *s = NULL;
    return json_long_req(v, "numeric", &n) && json_str_req(v, "text", &s);
}

static bool check_mention(const json_value *v) {
    if (json_type_of(v) != JSON_OBJECT) return false;
    long n;
    const char *s = NULL;
    wire_message_kind k;
    if (!json_long_req(v, "server_time", &n)) return false;
    if (!json_str_req(v, "channel", &s) || !json_str_req(v, "sender", &s)) return false;
    if (!json_str_opt(v, "body", &s)) return false;
    return message_kind_of(json_get(v, "kind"), &k);
}

static bool check_query_window_entry(const json_value *v) {
    if (json_type_of(v) != JSON_OBJECT) return false;
    long n;
    const char *s = NULL;
    return json_long_req(v, "network_id", &n) && json_str_req(v, "target_nick", &s) &&
           json_str_req(v, "opened_at", &s);
}

static bool check_notify_entry(const json_value *v) {
    if (json_type_of(v) != JSON_OBJECT) return false;
    long n;
    const char *s = NULL;
    return json_long_req(v, "network_id", &n) && json_str_req(v, "nick", &s) &&
           json_str_req(v, "added_at", &s);
}

/* A map whose values are arrays of a validated element shape —
 * `query_windows_list.windows` (keyed by nick) and `notify_list.networks`
 * (keyed by slug). The keys are data, so only the values are checked. */
static bool validate_map_of_arrays(const json_value *map, bool (*check)(const json_value *)) {
    if (json_type_of(map) != JSON_OBJECT) return false;
    size_t n = json_len(map);
    for (size_t i = 0; i < n; i++)
        if (!validate_array(json_value_at(map, i), check)) return false;
    return true;
}

/* ── Sub-narrowers shared across arms ─────────────────────────────────── */

bool wire_subject_key(const json_value *root, char *out, size_t out_sz) {
    if (!out || out_sz == 0) return false;
    out[0] = '\0';
    const json_value *subj = json_get(root, "subject");
    if (json_type_of(subj) != JSON_OBJECT) subj = root;

    const char *kind = json_string(json_get(subj, "kind"));
    if (kind && strcmp(kind, "visitor") == 0) {
        const char *id = json_string(json_get(subj, "id"));
        if (!id || !id[0]) return false;
        snprintf(out, out_sz, "visitor:%s", id);
        return true;
    }
    const char *name = json_string(json_get(subj, "name"));
    if (!name) name = json_string(json_get(subj, "identifier"));
    if (!name || !name[0]) return false;
    snprintf(out, out_sz, "%s", name);
    return true;
}

bool wire_narrow_message(const json_value *m, struct wire_scrollback_message *out) {
    if (json_type_of(m) != JSON_OBJECT) return false;
    struct wire_scrollback_message s = {0};
    if (!json_long_req(m, "id", &s.id)) return false;
    if (!json_str_req(m, "network", &s.network)) return false;
    if (!json_str_req(m, "channel", &s.channel)) return false;
    if (!json_long_req(m, "server_time", &s.server_time)) return false;
    if (!message_kind_of(json_get(m, "kind"), &s.kind)) return false;
    if (!json_str_req(m, "sender", &s.sender)) return false;
    if (!json_str_opt(m, "body", &s.body)) return false;
    s.meta = json_get(m, "meta");
    if (json_type_of(s.meta) != JSON_OBJECT) return false;
    *out = s;
    return true;
}

/* isupport is dual-topic (cold per-channel snapshot + live 005 edge on the
 * user topic), so it gets one narrower shared by both entry points —
 * mirror of the shared `narrowIsupportChanged` in wireNarrow.ts. */
static bool narrow_isupport(const json_value *p, struct wire_event *ev) {
    if (!json_long_req(p, "network_id", &ev->u.isupport.network_id)) return false;
    const char *const keys[] = {"chanmodes_a", "chanmodes_b", "chanmodes_c", "chanmodes_d"};
    const json_value **slots[] = {&ev->u.isupport.chanmodes_a, &ev->u.isupport.chanmodes_b,
                                  &ev->u.isupport.chanmodes_c, &ev->u.isupport.chanmodes_d};
    for (size_t i = 0; i < 4; i++) {
        const json_value *a = json_get(p, keys[i]);
        if (!validate_array(a, check_string)) return false;
        *slots[i] = a;
    }
    const json_value *prefix = json_get(p, "prefix");
    if (json_type_of(prefix) != JSON_OBJECT) return false;
    for (size_t i = 0; i < json_len(prefix); i++)
        if (!json_string(json_value_at(prefix, i))) return false;
    ev->u.isupport.prefix = prefix;
    ev->kind = WIRE_ISUPPORT_CHANGED;
    return true;
}

/* joined / join_failed / kicked — shared shape narrower so a future
 * server-side field add lands once, not once per topic. Mirror of
 * `narrowWindowStateEvent`. */
static bool narrow_window_state(const json_value *p, wire_kind kind, struct wire_event *ev) {
    struct wire_event e = {.kind = kind};
    if (!json_str_req(p, "network", &e.u.window_state.network)) return false;
    if (!json_str_req(p, "channel", &e.u.window_state.channel)) return false;
    switch (kind) {
    case WIRE_JOINED:
        if (!json_str_is(json_get(p, "state"), "joined")) return false;
        break;
    case WIRE_JOIN_FAILED:
        if (!json_str_is(json_get(p, "state"), "failed")) return false;
        if (!json_str_opt(p, "reason", &e.u.window_state.reason)) return false;
        /* numeric is legitimately null when the failing numeric was never
         * recorded; typing it required once dropped the whole reconnect
         * "failed tab" snapshot (cic S13). */
        if (!json_long_opt(p, "numeric", &e.u.window_state.numeric,
                           &e.u.window_state.has_numeric))
            return false;
        break;
    case WIRE_KICKED:
        if (!json_str_is(json_get(p, "state"), "kicked")) return false;
        if (!json_str_opt(p, "by", &e.u.window_state.by)) return false;
        if (!json_str_opt(p, "reason", &e.u.window_state.reason)) return false;
        break;
    default:
        return false;
    }
    *ev = e;
    return true;
}

/* ── The narrower ─────────────────────────────────────────────────────── */

/* Is this a kind this build knows about?
 *
 * The wire is additive-only: a server may push a kind a client has never
 * heard of, and ignoring it is CORRECT. A kind we DO know whose payload
 * we then refuse is a different animal — that is a bug, in the narrower
 * or in the server, and it must be visible rather than dropped in
 * silence. The caller can only tell the two apart by asking. */
bool wire_kind_known(const json_value *p, const char **kind_out) {
    if (json_type_of(p) != JSON_OBJECT) return false;
    const char *kind_str = json_string(json_get(p, "kind"));
    if (kind_out) *kind_out = kind_str;
    return kind_str && kind_of(kind_str) != WIRE_UNKNOWN;
}

bool wire_narrow(const json_value *p, struct wire_event *ev) {
    if (json_type_of(p) != JSON_OBJECT) return false;
    const char *kind_str = json_string(json_get(p, "kind"));
    if (!kind_str) return false;
    wire_kind kind = kind_of(kind_str);
    if (kind == WIRE_UNKNOWN) return false;

    struct wire_event e = {.kind = kind};

    switch (kind) {
    case WIRE_MESSAGE:
        if (!wire_narrow_message(json_get(p, "message"), &e.u.message)) return false;
        break;

    case WIRE_TOPIC_CHANGED: {
        if (!json_str_req(p, "network", &e.u.topic_changed.network)) return false;
        if (!json_str_req(p, "channel", &e.u.topic_changed.channel)) return false;
        const json_value *t = json_get(p, "topic");
        if (json_type_of(t) != JSON_OBJECT) return false;
        if (!json_str_opt(t, "text", &e.u.topic_changed.text)) return false;
        if (!json_str_opt(t, "set_by", &e.u.topic_changed.set_by)) return false;
        if (!json_str_opt(t, "set_at", &e.u.topic_changed.set_at)) return false;
        break;
    }

    case WIRE_CHANNEL_MODES_CHANGED: {
        if (!json_str_req(p, "network", &e.u.channel_modes.network)) return false;
        if (!json_str_req(p, "channel", &e.u.channel_modes.channel)) return false;
        const json_value *m = json_get(p, "modes");
        if (json_type_of(m) != JSON_OBJECT) return false;
        const json_value *list = json_get(m, "modes");
        if (!validate_array(list, check_string)) return false;
        const json_value *params = json_get(m, "params");
        if (json_type_of(params) != JSON_OBJECT) return false;
        e.u.channel_modes.modes = list;
        e.u.channel_modes.mode_count = json_len(list);
        e.u.channel_modes.params = params;
        break;
    }

    case WIRE_CHANNEL_CREATED:
        if (!json_str_req(p, "network", &e.u.channel_created.network)) return false;
        if (!json_str_req(p, "channel", &e.u.channel_created.channel)) return false;
        if (!json_str_req(p, "created_at", &e.u.channel_created.created_at)) return false;
        break;

    case WIRE_MEMBERS_SEEDED: {
        if (!json_str_req(p, "network", &e.u.members_seeded.network)) return false;
        if (!json_str_req(p, "channel", &e.u.members_seeded.channel)) return false;
        const json_value *m = json_get(p, "members");
        if (!validate_array(m, check_member)) return false;
        e.u.members_seeded.members = m;
        e.u.members_seeded.member_count = json_len(m);
        break;
    }

    case WIRE_READ_CURSOR_SET:
        if (!json_long_req(p, "last_read_message_id", &e.u.read_cursor.last_read_message_id))
            return false;
        /* badge_count defaults to 0 — the cursor sync is load-bearing and
         * must not drop because a stale server omitted a badge field. */
        e.u.read_cursor.badge_count = 0;
        if (!json_long_opt(p, "badge_count", &e.u.read_cursor.badge_count, NULL)) {
            e.u.read_cursor.badge_count = 0;
        }
        break;

    case WIRE_WINDOW_COUNTS:
        if (!json_str_req(p, "channel", &e.u.window_counts.channel)) return false;
        if (!json_long_req(p, "messages", &e.u.window_counts.messages)) return false;
        if (!json_long_req(p, "mentions", &e.u.window_counts.mentions)) return false;
        if (!json_long_req(p, "events", &e.u.window_counts.events)) return false;
        e.u.window_counts.severity = severity_of(json_get(p, "severity"));
        break;

    case WIRE_ISUPPORT_CHANGED:
        return narrow_isupport(p, ev);

    case WIRE_JOINED:
    case WIRE_JOIN_FAILED:
    case WIRE_KICKED:
        return narrow_window_state(p, kind, ev);

    case WIRE_CHANNELS_CHANGED:
        break; /* bare signal — cic refetches; no fields to validate */

    case WIRE_QUERY_WINDOWS_LIST: {
        const json_value *w = json_get(p, "windows");
        if (!validate_map_of_arrays(w, check_query_window_entry)) return false;
        e.u.query_windows.windows = w;
        e.u.query_windows.nick_count = json_len(w);
        break;
    }

    case WIRE_MENTIONS_BUNDLE: {
        if (!json_str_req(p, "network", &e.u.mentions_bundle.network)) return false;
        if (!json_str_req(p, "away_started_at", &e.u.mentions_bundle.away_started_at)) return false;
        if (!json_str_req(p, "away_ended_at", &e.u.mentions_bundle.away_ended_at)) return false;
        if (!json_str_opt(p, "away_reason", &e.u.mentions_bundle.away_reason)) return false;
        const json_value *msgs = json_get(p, "messages");
        if (!validate_array(msgs, check_mention)) return false;
        e.u.mentions_bundle.messages = msgs;
        e.u.mentions_bundle.message_count = json_len(msgs);
        break;
    }

    case WIRE_AWAY_CONFIRMED: {
        if (!json_str_req(p, "network", &e.u.away_confirmed.network)) return false;
        const json_value *st = json_get(p, "state");
        if (json_str_is(st, "away")) e.u.away_confirmed.away = true;
        else if (json_str_is(st, "present")) e.u.away_confirmed.away = false;
        else return false;
        break;
    }

    case WIRE_CONNECTION_PROGRESS: {
        if (!json_str_req(p, "network", &e.u.connection_progress.network)) return false;
        const json_value *st = json_get(p, "state");
        if (json_str_is(st, "connected")) e.u.connection_progress.connected = true;
        else if (json_str_is(st, "connecting")) e.u.connection_progress.connected = false;
        else return false;
        break;
    }

    case WIRE_NOTIFY_LIST: {
        const json_value *n = json_get(p, "networks");
        if (!validate_map_of_arrays(n, check_notify_entry)) return false;
        e.u.notify_list.networks = n;
        e.u.notify_list.network_count = json_len(n);
        break;
    }

    case WIRE_PRESENCE_CHANGED: {
        if (!json_long_req(p, "network_id", &e.u.presence_changed.network_id)) return false;
        if (!json_str_req(p, "nick", &e.u.presence_changed.nick)) return false;
        const json_value *pr = json_get(p, "presence");
        if (json_str_is(pr, "online")) e.u.presence_changed.online = true;
        else if (json_str_is(pr, "offline")) e.u.presence_changed.online = false;
        else return false;
        if (!json_bool_req(p, "initial", &e.u.presence_changed.initial)) return false;
        const json_value *src = json_get(p, "source");
        if (json_str_is(src, "monitor")) e.u.presence_changed.from_monitor = true;
        else if (json_str_is(src, "watch")) e.u.presence_changed.from_monitor = false;
        else return false;
        if (!json_str_req(p, "ts", &e.u.presence_changed.ts)) return false;
        break;
    }

    case WIRE_PRESENCE_ERROR:
        if (!json_long_req(p, "network_id", &e.u.presence_error.network_id)) return false;
        if (!json_str_is(json_get(p, "reason"), "list_full")) return false;
        if (!json_str_req(p, "detail", &e.u.presence_error.detail)) return false;
        break;

    case WIRE_PRESENCE_SNAPSHOT: {
        if (!json_long_req(p, "network_id", &e.u.presence_snapshot.network_id)) return false;
        const json_value *nicks = json_get(p, "nicks");
        if (json_type_of(nicks) != JSON_OBJECT) return false;
        for (size_t i = 0; i < json_len(nicks); i++) {
            wire_presence pr;
            if (!presence_of(json_value_at(nicks, i), &pr)) return false;
        }
        e.u.presence_snapshot.nicks = nicks;
        e.u.presence_snapshot.nick_count = json_len(nicks);
        break;
    }

    case WIRE_OWN_NICK_CHANGED:
        if (!json_long_req(p, "network_id", &e.u.own_nick.network_id)) return false;
        if (!json_str_req(p, "nick", &e.u.own_nick.nick)) return false;
        break;

    case WIRE_UMODE_CHANGED:
    case WIRE_SUPPORTED_UMODES_CHANGED: {
        if (!json_long_req(p, "network_id", &e.u.umodes.network_id)) return false;
        const json_value *m = json_get(p, "modes");
        if (!validate_array(m, check_string)) return false;
        e.u.umodes.modes = m;
        e.u.umodes.mode_count = json_len(m);
        break;
    }

    case WIRE_WINDOW_PENDING:
    case WIRE_WINDOW_INVITED:
        if (!json_str_req(p, "network", &e.u.window_open.network)) return false;
        if (!json_str_req(p, "channel", &e.u.window_open.channel)) return false;
        if (!json_str_is(json_get(p, "state"),
                         kind == WIRE_WINDOW_PENDING ? "pending" : "invited"))
            return false;
        break;

    case WIRE_WEB_SESSION_SEVERED:
        if (!json_str_req(p, "code", &e.u.severed.code)) return false;
        break;

    case WIRE_SESSION_IDENTITY_CHANGED:
        if (!json_long_req(p, "network_id", &e.u.identity.network_id)) return false;
        if (!json_bool_req(p, "identified", &e.u.identity.identified)) return false;
        if (!json_str_opt(p, "account", &e.u.identity.account)) return false;
        break;

    case WIRE_RECOVER_PROGRESS:
        if (!json_str_req(p, "network", &e.u.recover.network)) return false;
        if (!json_str_req(p, "step", &e.u.recover.step)) return false;
        if (!json_str_req(p, "status", &e.u.recover.status)) return false;
        if (!json_str_opt(p, "reason", &e.u.recover.reason)) return false;
        break;

    case WIRE_RECOVER_RESULT:
        if (!json_str_req(p, "network", &e.u.recover.network)) return false;
        if (!json_str_req(p, "outcome", &e.u.recover.outcome)) return false;
        if (!json_str_opt(p, "reason", &e.u.recover.reason)) return false;
        break;

    case WIRE_WHOIS_AVATAR_READY:
        if (!json_str_req(p, "network", &e.u.whois_avatar.network)) return false;
        if (!json_str_req(p, "nick", &e.u.whois_avatar.nick)) return false;
        if (!json_str_req(p, "avatar_url", &e.u.whois_avatar.avatar_url)) return false;
        break;

    case WIRE_AUTO_AWAY_DEBOUNCE_CHANGED:
        e.u.setting_echo.has_seconds =
            json_long(json_get(p, "auto_away_debounce_seconds"), &e.u.setting_echo.seconds);
        break;

    case WIRE_AUTO_AWAY_REASON_CHANGED:
        if (!json_str_opt(p, "auto_away_reason", &e.u.setting_echo.text)) return false;
        break;

    case WIRE_QUIT_PART_REASON_CHANGED:
        if (!json_str_opt(p, "quit_part_reason", &e.u.setting_echo.text)) return false;
        break;

    case WIRE_DCC_OFFER:
        if (!json_str_req(p, "network", &e.u.dcc_offer.network)) return false;
        if (!json_str_req(p, "channel", &e.u.dcc_offer.channel)) return false;
        if (!json_str_req(p, "offer_id", &e.u.dcc_offer.offer_id)) return false;
        if (!json_str_req(p, "from", &e.u.dcc_offer.from)) return false;
        if (!json_str_req(p, "filename", &e.u.dcc_offer.filename)) return false;
        if (!json_long_req(p, "size", &e.u.dcc_offer.size)) return false;
        break;

    case WIRE_DCC_OFFER_RESOLVED:
        if (!json_str_req(p, "network", &e.u.dcc_resolved.network)) return false;
        if (!json_str_req(p, "channel", &e.u.dcc_resolved.channel)) return false;
        if (!json_str_req(p, "offer_id", &e.u.dcc_resolved.offer_id)) return false;
        if (!json_str_req(p, "resolution", &e.u.dcc_resolved.resolution)) return false;
        break;

    case WIRE_WINDOW_INVITE_DECLINED:
        if (!json_str_req(p, "network", &e.u.window_open.network)) return false;
        if (!json_str_req(p, "channel", &e.u.window_open.channel)) return false;
        break;

    case WIRE_NETWORK_ATTACHED:
    case WIRE_NETWORK_DETACHED:
        if (!json_long_req(p, "network_id", &e.u.network_link.network_id)) return false;
        if (!json_str_req(p, "network_slug", &e.u.network_link.network_slug)) return false;
        break;

    case WIRE_CONNECTION_STATE_CHANGED: {
        /* user_id is nullable (a visitor credential has visitor_id set and
         * user_id null — the XOR FK) and is diagnostic only, so it is
         * validated for type but not stored. */
        const char *ignored = NULL;
        if (!json_str_opt(p, "user_id", &ignored)) return false;
        if (!json_long_req(p, "network_id", &e.u.connection_state.network_id)) return false;
        if (!json_str_req(p, "network_slug", &e.u.connection_state.network_slug)) return false;
        if (!connection_state_of(json_get(p, "from"), &e.u.connection_state.from)) return false;
        if (!connection_state_of(json_get(p, "to"), &e.u.connection_state.to)) return false;
        if (!json_str_opt(p, "reason", &e.u.connection_state.reason)) return false;
        if (!json_str_opt(p, "at", &e.u.connection_state.at)) return false;
        const json_value *net = json_get(p, "network");
        if (json_type_of(net) != JSON_OBJECT) return false;
        const char *slug = NULL;
        if (!json_str_req(net, "slug", &slug)) return false;
        if (!json_str_req(net, "nick", &e.u.connection_state.nick)) return false;
        if (!connection_state_of(json_get(net, "connection_state"), &e.u.connection_state.state))
            return false;
        if (!json_str_opt(net, "connection_state_reason", &e.u.connection_state.state_reason))
            return false;
        const char *changed_at = NULL;
        if (!json_str_opt(net, "connection_state_changed_at", &changed_at)) return false;
        break;
    }

    case WIRE_WHOIS_BUNDLE: {
        struct wire_event w = {.kind = WIRE_WHOIS_BUNDLE};
        if (!json_str_req(p, "network", &w.u.whois.network)) return false;
        if (!json_str_req(p, "target", &w.u.whois.target)) return false;
        const struct {
            const char *key;
            const char **slot;
        } opt_strings[] = {
            {"user", &w.u.whois.user},
            {"host", &w.u.whois.host},
            {"realname", &w.u.whois.realname},
            {"server", &w.u.whois.server},
            {"server_info", &w.u.whois.server_info},
            {"oper_text", &w.u.whois.oper_text},
            {"umodes", &w.u.whois.umodes},
            {"away_message", &w.u.whois.away_message},
            {"actually_host", &w.u.whois.actually_host},
            {"actually_ip", &w.u.whois.actually_ip},
            {"account", &w.u.whois.account},
            {"secure_cipher", &w.u.whois.secure_cipher},
            {"certfp", &w.u.whois.certfp},
        };
        for (size_t i = 0; i < sizeof(opt_strings) / sizeof(opt_strings[0]); i++)
            if (!json_str_opt(p, opt_strings[i].key, opt_strings[i].slot)) return false;

        const struct {
            const char *key;
            bool *slot;
        } flags[] = {
            {"is_operator", &w.u.whois.is_operator},
            {"using_ssl", &w.u.whois.using_ssl},
            {"is_registered", &w.u.whois.is_registered},
            {"is_admin", &w.u.whois.is_admin},
            {"is_services_admin", &w.u.whois.is_services_admin},
            {"is_helper", &w.u.whois.is_helper},
            {"is_chanop", &w.u.whois.is_chanop},
            {"is_agent", &w.u.whois.is_agent},
            {"is_java", &w.u.whois.is_java},
            {"secure", &w.u.whois.secure},
        };
        /* DEFAULTED, not required. The wire is additive-only and a
         * client must tolerate a field it does not get: these are the
         * WHOIS legs an ircd may simply never send, and the server's own
         * contract is "booleans default to false". Requiring them meant
         * one absent flag threw away the WHOLE bundle — a /whois that
         * answers with nothing at all, which reads as the command having
         * failed rather than as a missing leg. */
        for (size_t i = 0; i < sizeof(flags) / sizeof(flags[0]); i++)
            if (!json_bool_dflt(p, flags[i].key, false, flags[i].slot)) return false;

        if (!json_long_opt(p, "idle_seconds", &w.u.whois.idle_seconds, &w.u.whois.has_idle))
            return false;
        if (!json_long_opt(p, "signon", &w.u.whois.signon, &w.u.whois.has_signon)) return false;

        const json_value *chans = json_get(p, "channels");
        if (!json_is_null(chans)) {
            if (!validate_array(chans, check_string)) return false;
            w.u.whois.channels = chans;
            w.u.whois.channel_count = json_len(chans);
            w.u.whois.has_channels = true;
        }
        const json_value *extra = json_get(p, "extra_lines");
        if (!json_is_null(extra)) {
            if (!validate_array(extra, check_whois_extra)) return false;
            w.u.whois.extra_lines = extra;
            w.u.whois.extra_count = json_len(extra);
        }
        *ev = w;
        return true;
    }

    case WIRE_NAMES_REPLY: {
        if (!json_str_req(p, "network", &e.u.names_reply.network)) return false;
        if (!json_str_req(p, "channel", &e.u.names_reply.channel)) return false;
        const json_value *m = json_get(p, "members");
        if (!validate_array(m, check_member)) return false;
        e.u.names_reply.members = m;
        e.u.names_reply.member_count = json_len(m);
        break;
    }

    case WIRE_WHO_REPLY: {
        if (!json_str_req(p, "network", &e.u.who_reply.network)) return false;
        if (!json_str_req(p, "target", &e.u.who_reply.target)) return false;
        const json_value *u = json_get(p, "users");
        if (!validate_array(u, check_who_user)) return false;
        e.u.who_reply.users = u;
        e.u.who_reply.user_count = json_len(u);
        break;
    }

    case WIRE_SERVER_REPLY: {
        if (!json_str_req(p, "network", &e.u.server_reply.network)) return false;
        const json_value *src = json_get(p, "source");
        if (json_str_is(src, "info")) e.u.server_reply.source = REPLY_INFO;
        else if (json_str_is(src, "version")) e.u.server_reply.source = REPLY_VERSION;
        else if (json_str_is(src, "motd")) e.u.server_reply.source = REPLY_MOTD;
        else if (json_str_is(src, "admin")) e.u.server_reply.source = REPLY_ADMIN;
        else return false;
        const json_value *lines = json_get(p, "lines");
        if (!validate_array(lines, check_string)) return false;
        e.u.server_reply.lines = lines;
        e.u.server_reply.line_count = json_len(lines);
        break;
    }

    case WIRE_INVITE_ACK:
        if (!json_str_req(p, "network", &e.u.invite_ack.network)) return false;
        if (!json_str_req(p, "channel", &e.u.invite_ack.channel)) return false;
        if (!json_str_req(p, "peer", &e.u.invite_ack.peer)) return false;
        break;

    case WIRE_BUNDLE_HASH: {
        if (!json_str_req(p, "hash", &e.u.bundle_hash.hash)) return false;
        if (e.u.bundle_hash.hash[0] == '\0') return false;
        /* version is optional on the wire; absent/empty normalises to NULL
         * so the consumer always sees the same two-state shape. */
        const char *v = NULL;
        if (json_str_opt(p, "version", &v) && v && v[0] != '\0') e.u.bundle_hash.version = v;
        break;
    }

    case WIRE_SERVER_SETTINGS_CHANGED: {
        const json_value *up = json_get(p, "upload");
        if (json_type_of(up) != JSON_OBJECT) return false;
        if (!json_str_req(up, "active_host", &e.u.server_settings.active_host)) return false;
        const struct {
            const char *key;
            long *slot;
        } caps[] = {
            {"image_per_file_cap_bytes", &e.u.server_settings.image_cap},
            {"video_per_file_cap_bytes", &e.u.server_settings.video_cap},
            {"document_per_file_cap_bytes", &e.u.server_settings.document_cap},
            {"audio_per_file_cap_bytes", &e.u.server_settings.audio_cap},
            {"global_cap_bytes", &e.u.server_settings.global_cap},
        };
        for (size_t i = 0; i < sizeof(caps) / sizeof(caps[0]); i++) {
            if (!json_long_req(up, caps[i].key, caps[i].slot)) return false;
            if (*caps[i].slot <= 0) return false; /* positive integers only */
        }
        /* Host aliases are LENIENT by design: a malformed list degrades to
         * none rather than stranding the upload caps that ride along. */
        const json_value *aliases = json_get(p, "http_host_aliases");
        if (validate_array(aliases, check_string)) {
            e.u.server_settings.host_aliases = aliases;
            e.u.server_settings.alias_count = json_len(aliases);
        }
        break;
    }

    case WIRE_PEER_AWAY:
        if (!json_str_req(p, "network", &e.u.peer_away.network)) return false;
        if (!json_str_req(p, "peer", &e.u.peer_away.peer)) return false;
        if (!json_str_req(p, "message", &e.u.peer_away.message)) return false;
        break;

    case WIRE_LUSERS_BUNDLE: {
        if (!json_str_req(p, "network", &e.u.lusers.network)) return false;
        const struct {
            const char *key;
            long *slot;
        } counts[] = {
            {"total_users", &e.u.lusers.total_users},
            {"invisible", &e.u.lusers.invisible},
            {"servers", &e.u.lusers.servers},
            {"operators", &e.u.lusers.operators},
            {"unknown_connections", &e.u.lusers.unknown_connections},
            {"channels_formed", &e.u.lusers.channels_formed},
            {"local_clients", &e.u.lusers.local_clients},
            {"local_servers", &e.u.lusers.local_servers},
            {"current_local", &e.u.lusers.current_local},
            {"max_local", &e.u.lusers.max_local},
            {"current_global", &e.u.lusers.current_global},
            {"max_global", &e.u.lusers.max_global},
        };
        /* Per-count coercion rather than whole-payload rejection: this is a
         * display-only card, and one garbled optional count should render
         * as "—", not blow away the eleven good counts beside it. */
        for (size_t i = 0; i < sizeof(counts) / sizeof(counts[0]); i++)
            e.u.lusers.has[i] = json_long(json_get(p, counts[i].key), counts[i].slot);
        break;
    }

    case WIRE_WHOWAS_BUNDLE:
        if (!json_str_req(p, "network", &e.u.whowas.network)) return false;
        if (!json_str_req(p, "target", &e.u.whowas.target)) return false;
        if (!json_bool_req(p, "not_found", &e.u.whowas.not_found)) return false;
        if (!json_str_opt(p, "user", &e.u.whowas.user)) return false;
        if (!json_str_opt(p, "host", &e.u.whowas.host)) return false;
        if (!json_str_opt(p, "realname", &e.u.whowas.realname)) return false;
        if (!json_str_opt(p, "server", &e.u.whowas.server)) return false;
        if (!json_str_opt(p, "logoff_time", &e.u.whowas.logoff_time)) return false;
        break;

    case WIRE_BANLIST_BUNDLE: {
        if (!json_str_req(p, "network", &e.u.banlist.network)) return false;
        if (!json_str_req(p, "channel", &e.u.banlist.channel)) return false;
        const json_value *entries = json_get(p, "entries");
        if (!validate_array(entries, check_banlist_entry)) return false;
        e.u.banlist.entries = entries;
        e.u.banlist.entry_count = json_len(entries);
        break;
    }

    case WIRE_LINKS_BUNDLE: {
        if (!json_str_req(p, "network", &e.u.links.network)) return false;
        const json_value *entries = json_get(p, "entries");
        /* An EMPTY array is valid — it is the restricted/hidden-topology
         * signal, not a malformed payload. */
        if (!validate_array(entries, check_links_entry)) return false;
        e.u.links.entries = entries;
        e.u.links.entry_count = json_len(entries);
        break;
    }

    case WIRE_ARCHIVE_CHANGED:
        if (!json_str_req(p, "network_slug", &e.u.archive.network_slug)) return false;
        break;

    case WIRE_ARCHIVE_PURGED:
        if (!json_str_req(p, "network_slug", &e.u.archive.network_slug)) return false;
        if (!json_str_req(p, "target", &e.u.archive.target)) return false;
        break;

    case WIRE_DIRECTORY_PROGRESS:
        if (!json_str_req(p, "network", &e.u.directory.network)) return false;
        if (!json_long_req(p, "count", &e.u.directory.count)) return false;
        break;

    case WIRE_DIRECTORY_COMPLETE:
        if (!json_str_req(p, "network", &e.u.directory.network)) return false;
        if (!json_long_req(p, "total", &e.u.directory.count)) return false;
        break;

    case WIRE_DIRECTORY_FAILED:
        if (!json_str_req(p, "network", &e.u.directory.network)) return false;
        if (!json_str_req(p, "reason", &e.u.directory.reason)) return false;
        break;

    case WIRE_AWAY_NICK_SUFFIX_CHANGED:
        if (!json_str_opt(p, "away_nick_suffix", &e.u.away_nick_suffix.suffix)) return false;
        break;

    case WIRE_UNKNOWN:
        return false;
    }

    *ev = e;
    return true;
}

/* ── Element accessors ────────────────────────────────────────────────── */

bool wire_member_at(const json_value *members, size_t i, struct wire_member *out) {
    const json_value *m = json_at(members, i);
    if (!m) return false;
    out->nick = json_string(json_get(m, "nick"));
    out->modes = json_get(m, "modes");
    out->mode_count = json_len(out->modes);
    return out->nick != NULL;
}

bool wire_who_user_at(const json_value *users, size_t i, struct wire_who_user *out) {
    const json_value *u = json_at(users, i);
    if (!u) return false;
    struct wire_who_user w = {0};
    w.nick = json_string(json_get(u, "nick"));
    w.user = json_string(json_get(u, "user"));
    w.host = json_string(json_get(u, "host"));
    w.server = json_string(json_get(u, "server"));
    w.modes = json_string(json_get(u, "modes"));
    w.channel = json_string(json_get(u, "channel"));
    w.has_hops = json_long(json_get(u, "hops"), &w.hops);
    w.realname = json_string(json_get(u, "realname"));
    if (!w.nick) return false;
    *out = w;
    return true;
}

bool wire_banlist_entry_at(const json_value *entries, size_t i, struct wire_banlist_entry *out) {
    const json_value *b = json_at(entries, i);
    if (!b) return false;
    out->mask = json_string(json_get(b, "mask"));
    out->setter = json_string(json_get(b, "setter"));
    out->set_ts = json_string(json_get(b, "set_ts"));
    return out->mask != NULL;
}

bool wire_links_entry_at(const json_value *entries, size_t i, struct wire_links_entry *out) {
    const json_value *l = json_at(entries, i);
    if (!l) return false;
    struct wire_links_entry w = {0};
    w.server = json_string(json_get(l, "server"));
    w.linked_to = json_string(json_get(l, "linked_to"));
    w.has_hopcount = json_long(json_get(l, "hopcount"), &w.hopcount);
    w.description = json_string(json_get(l, "description"));
    if (!w.server) return false;
    *out = w;
    return true;
}

bool wire_whois_extra_at(const json_value *lines, size_t i, struct wire_whois_extra *out) {
    const json_value *l = json_at(lines, i);
    if (!l) return false;
    if (!json_long(json_get(l, "numeric"), &out->numeric)) return false;
    out->text = json_string(json_get(l, "text"));
    return out->text != NULL;
}

bool wire_mention_at(const json_value *messages, size_t i, struct wire_mention *out) {
    const json_value *m = json_at(messages, i);
    if (!m) return false;
    struct wire_mention w = {0};
    if (!json_long(json_get(m, "server_time"), &w.server_time)) return false;
    w.channel = json_string(json_get(m, "channel"));
    w.sender = json_string(json_get(m, "sender"));
    w.body = json_string(json_get(m, "body"));
    if (!message_kind_of(json_get(m, "kind"), &w.kind)) return false;
    if (!w.channel || !w.sender) return false;
    *out = w;
    return true;
}

const char *wire_string_at(const json_value *arr, size_t i) { return json_string(json_at(arr, i)); }

bool wire_presence_at(const json_value *nicks, size_t i, const char **nick, wire_presence *out) {
    const char *key = json_key_at(nicks, i);
    if (!key) return false;
    if (!presence_of(json_value_at(nicks, i), out)) return false;
    *nick = key;
    return true;
}

/* ── Phoenix framing ──────────────────────────────────────────────────── */

bool wire_frame_split(const json_value *root, struct wire_frame *out) {
    if (json_type_of(root) != JSON_ARRAY || json_len(root) < 5) return false;
    const char *topic = json_string(json_at(root, 2));
    const char *event = json_string(json_at(root, 3));
    if (!topic || !event) return false;
    out->ref = json_string(json_at(root, 1)); /* null on server pushes */
    out->topic = topic;
    out->event = event;
    out->payload = json_at(root, 4);
    out->network[0] = 0;
    const char *net = strstr(topic, "/network:");
    if (net) {
        net += strlen("/network:");
        const char *end = strstr(net, "/channel:");
        size_t n = end ? (size_t)(end - net) : strlen(net);
        if (n >= sizeof(out->network)) n = sizeof(out->network) - 1;
        memcpy(out->network, net, n);
        out->network[n] = 0;
    }
    return true;
}
