/* test_e2eapp — the E2E identity doors, end to end, against a fake grappa.
 *
 * e2e.c decides (test_e2e covers that); shottino.c's job is the doors
 * around the decisions: which requests go, in which order, what is stored
 * before what leaves, and what the user is told. That cannot be asserted
 * from the inside, so this suite compiles shottino.c, points it at a
 * grappa on loopback (one thread, one request per connection — shottino
 * sends `Connection: close`), and judges it by what reached that grappa
 * and what the record on disk holds afterwards.
 *
 * The fake grappa keeps the identity state the real one keeps for the
 * doors involved (lib/grappa/e2e_keys.ex): registered devices with their
 * key counts, the list with its rules (master_mismatch, stale_list,
 * unknown_device, the cap of three devices), and it checks every
 * signature it is handed with the same vodozemac the client signs with —
 * a client that uploads a key it did not sign fails here, not in prod.
 *
 * Pairing (§4g): the fake grappa also runs the blind relay, and the HOLDER
 * on the other end is scripted here the way cicchetto's holderPairing
 * behaves, from vodozemac and hand-written JSON only — it does not use
 * e2e.c's pairing code, so what it accepts is the joiner's bytes judged
 * independently: the base64url of the initial message, the hello, the
 * join's id block and its S1 over the offered master, the done.
 */
#define main shottino_main_unused
#include "../shottino.c"
#undef main

#include "test.h"

/* ── the fake grappa ──────────────────────────────────────────────────── */

#define FG_MAX_DEV 8

typedef struct {
    char key[64], sig[128];
} fg_key;

typedef struct {
    char did[16], ed[64], curve[64], sig[128];
    long otks;
    bool fallback;
    /* the keys themselves, as uploaded: what a KEYS or a claim hands out */
    fg_key otk[64];
    size_t notk;
    fg_key fb;
} fg_device;

/* One inbox entry: the e2e_message as grappa holds it for device `to`. */
typedef struct {
    long id;
    char to[16];
    char *json;
    bool acked;
    e2e_verb verb;
} fg_item;

#define FG_INBOX_MAX 64
#define FG_SENT_MAX 64

static struct {
    int fd;
    char port[16];
    pthread_t thread;
    pthread_mutex_t lock;
    bool stop;
    /* identity state */
    bool has_list;
    char master[64];
    long ver;
    char devices[E2E_MAX_DEVICES][64];
    size_t ndevices;
    char list_sig[128];
    fg_device dev[FG_MAX_DEV];
    size_t ndev;
    /* refusals scripted by a test: the next request of that door */
    int fail_put_status;
    char fail_put_error[32];
    int fail_upload_status;
    /* the pairing relay: one rendezvous, the holder (creator) in-process */
    struct {
        bool live, joined;
        char id[32], curve[64], expires[32];
        struct {
            long seq;
            wire_pairing_side from;
            char payload[8192];
        } msg[16];
        size_t n;
        int fail_join_status;
        char fail_join_error[32];
    } rv;
    /* the inboxes, the send door and the copy door */
    fg_item inbox[FG_INBOX_MAX];
    size_t ninbox;
    long next_inbox_id;
    char *sent[FG_SENT_MAX]; /* request bodies of POST …/messages, in order */
    char sent_msgid[FG_SENT_MAX][12]; /* the msgid each was answered with */
    /* What the disk held when each was posted: history rows, and how many
     * sent records the saved state carried (the crash-safe order). */
    size_t sent_disk_rows[FG_SENT_MAX];
    long sent_disk_records[FG_SENT_MAX];
    size_t nsent;
    /* The send door's next answer, scripted (0: accept); the frame
     * budget it sizes payloads with (0: unchecked), as grappa's 413. */
    int fail_send_status;
    /* Make the watched slot dir read-only once the next payload is taken:
     * the record saved BEFORE it left is on disk, the one after cannot be. */
    bool lock_disk_on_send;
    char fail_send_error[32];
    long budget;
    /* The PLAINTEXT door (POST …/channels/:c/messages): every body. */
    char *plain[FG_SENT_MAX];
    size_t nplain;
    long next_msgid;
    char acks[2048]; /* each ack's ids, "[1,2]\n" */
    /* What the disk held when each ack arrived (the slot dir, set by a
     * test): the record's watermark and the history's rows. */
    char watch_dir[PATH_MAX];
    long ack_disk_inbox[16];
    size_t ack_disk_rows[16];
    size_t nack_disk;
    /* every request, "METHOD path\n" */
    char log[32768];
    size_t requests;
    /* the consent requests (§4i), and every body their doors took,
     * "METHOD path body\n" ("-" for none) */
    struct {
        long id;
        char peer[32], state[12], expires[32];
    } req[16];
    size_t nreq;
    long next_req;
    char req_bodies[8192];
} fg;

static void fg_reset(void) {
    pthread_mutex_lock(&fg.lock);
    fg.has_list = false;
    fg.ndevices = 0;
    fg.ndev = 0;
    fg.fail_put_status = 0;
    fg.fail_upload_status = 0;
    memset(&fg.rv, 0, sizeof(fg.rv));
    for (size_t i = 0; i < fg.ninbox; i++) free(fg.inbox[i].json);
    fg.ninbox = 0;
    for (size_t i = 0; i < fg.nsent; i++) free(fg.sent[i]);
    fg.nsent = 0;
    for (size_t i = 0; i < fg.nplain; i++) free(fg.plain[i]);
    fg.nplain = 0;
    fg.fail_send_status = 0;
    fg.lock_disk_on_send = false;
    fg.budget = 0;
    fg.acks[0] = 0;
    fg.watch_dir[0] = 0;
    fg.nack_disk = 0;
    fg.log[0] = 0;
    fg.requests = 0;
    fg.nreq = 0;
    fg.req_bodies[0] = 0;
    pthread_mutex_unlock(&fg.lock);
}

static void fg_msgid(char out[12]) { snprintf(out, 12, "m%010ld", ++fg.next_msgid); }

/* An inbox entry for device `to` (a did), as grappa's e2e_message shape.
 * Under fg.lock. Answers its id. */
static long fg_inbox_push_locked(const char *to, const char *from, const char *from_did,
                                 e2e_verb verb, const char *msgid, const char *payload, bool own) {
    if (fg.ninbox >= FG_INBOX_MAX) return 0;
    fg_item *it = &fg.inbox[fg.ninbox++];
    it->id = ++fg.next_inbox_id;
    snprintf(it->to, sizeof(it->to), "%s", to);
    it->acked = false;
    it->verb = verb;
    char *f = json_escape(from), *p = json_escape(payload);
    it->json = xasprintf("{\"kind\":\"e2e_message\",\"id\":%ld,\"network\":\"azzurra\",\"from\":"
                         "\"%s\",\"from_did\":\"%s\",\"to_did\":\"%s\",\"verb\":\"%s\",\"msgid\":"
                         "\"%s\",\"payload\":\"%s\",\"own\":%s}",
                         it->id, f, from_did, to, e2e_verb_name(verb), msgid, p,
                         own ? "true" : "false");
    free(f);
    free(p);
    return it->id;
}

static long fg_inbox_push(const char *to, const char *from, const char *from_did, e2e_verb verb,
                          const char *msgid, const char *payload, bool own) {
    pthread_mutex_lock(&fg.lock);
    long id = fg_inbox_push_locked(to, from, from_did, verb, msgid, payload, own);
    pthread_mutex_unlock(&fg.lock);
    return id;
}

/* grappa's KEYS (lib/grappa/e2e_keys.ex): the list it holds and each
 * listed device's id block with its oldest one-time key (spent) or its
 * fallback — only `only`'s on a claim. Under fg.lock. */
static char *fg_keys_locked(const char *only) {
    e2e_keys_build_entry entries[E2E_MAX_DEVICES];
    fg_key spent[E2E_MAX_DEVICES];
    size_t n = 0;
    const char *devs[E2E_MAX_DEVICES];
    for (size_t i = 0; i < fg.ndevices; i++) {
        devs[i] = fg.devices[i];
        fg_device *d = NULL;
        for (size_t k = 0; k < fg.ndev; k++)
            if (strcmp(fg.dev[k].ed, fg.devices[i]) == 0) d = &fg.dev[k];
        if (!d || (only && strcmp(d->did, only) != 0)) continue;
        e2e_keys_build_entry *e = &entries[n];
        memset(e, 0, sizeof(*e));
        e->curve25519 = d->curve;
        e->ed25519 = d->ed;
        e->sig = d->sig;
        if (d->notk > 0) {
            spent[n] = d->otk[0];
            memmove(d->otk, d->otk + 1, (d->notk - 1) * sizeof(d->otk[0]));
            d->notk--;
            d->otks--;
            e->otk_key = spent[n].key;
            e->otk_sig = spent[n].sig;
        } else {
            e->otk_key = d->fb.key;
            e->otk_sig = d->fb.sig;
            e->otk_fallback = true;
        }
        n++;
    }
    return e2e_keys_payload(fg.master, fg.ver, devs, fg.ndevices, fg.list_sig, entries, n);
}

/* What reached disk, read as the next run would (no store: the app holds
 * its lock): the record's watermark, and the rows of every chat. */
static void fg_disk_locked(long *inbox, long *records, size_t *nrows) {
    char *path = xasprintf("%s/record.json", fg.watch_dir);
    FILE *f = fopen(path, "r");
    free(path);
    *inbox = *records = -1;
    if (f) {
        static char buf[1 << 20];
        size_t n = fread(buf, 1, sizeof(buf), f);
        fclose(f);
        e2e_record rec;
        if (e2e_record_from_json(buf, n, &rec)) {
            *inbox = rec.state.inbox;
            *records = (long)rec.state.nsent;
            e2e_record_free(&rec);
        }
    }
    char *dir = xasprintf("%s/chats", fg.watch_dir);
    e2e_rows rows;
    *nrows = 0;
    if (e2e_chat_load(dir, &rows, NULL, 0)) *nrows = rows.n;
    e2e_rows_free(&rows);
    free(dir);
}

static void fg_watch_locked(void) {
    if (!fg.watch_dir[0] || fg.nack_disk >= 16) return;
    long inbox, records;
    size_t nrows;
    fg_disk_locked(&inbox, &records, &nrows);
    fg.ack_disk_inbox[fg.nack_disk] = inbox;
    fg.ack_disk_rows[fg.nack_disk] = nrows;
    fg.nack_disk++;
}

static fg_device *fg_device_by_did(const char *did) {
    for (size_t i = 0; i < fg.ndev; i++)
        if (strcmp(fg.dev[i].did, did) == 0) return &fg.dev[i];
    return NULL;
}

static bool fg_listed(const char *ed) {
    for (size_t i = 0; i < fg.ndevices; i++)
        if (strcmp(fg.devices[i], ed) == 0) return true;
    return false;
}

static char *fg_list_json(void) {
    json_buf b;
    jb_init(&b);
    jb_obj_open(&b);
    jb_key(&b, "master");
    jb_str(&b, fg.master);
    jb_key(&b, "ver");
    jb_num(&b, (double)fg.ver);
    jb_key(&b, "devices");
    jb_arr_open(&b);
    for (size_t i = 0; i < fg.ndevices; i++) jb_str(&b, fg.devices[i]);
    jb_arr_close(&b);
    jb_key(&b, "sig");
    jb_str(&b, fg.list_sig);
    jb_obj_close(&b);
    return jb_take(&b);
}

static char *fg_device_json(const fg_device *d) {
    return xasprintf("{\"did\":\"%s\",\"ed25519\":\"%s\",\"curve25519\":\"%s\",\"sig\":\"%s\","
                     "\"last_seen_at\":null,\"inserted_at\":\"2026-11-07T10:00:00Z\"}",
                     d->did, d->ed, d->curve, d->sig);
}

#define FG_ERR(st, token)                                                                          \
    do {                                                                                           \
        *status = (st);                                                                            \
        return xasprintf("{\"error\":\"%s\"}", token);                                             \
    } while (0)


/* grappa's payload rule (lib/grappa/e2e_pairing.ex): base64 of either
 * alphabet, at most 16 KiB. */
static bool fg_payload_ok(const char *p) {
    size_t n = p ? strlen(p) : 0;
    if (n == 0 || n > 16384) return false;
    size_t i = 0;
    while (i < n && (isalnum((unsigned char)p[i]) || p[i] == '+' || p[i] == '/' || p[i] == '-' ||
                     p[i] == '_'))
        i++;
    size_t pad = n - i;
    if (pad > 2) return false;
    for (; i < n; i++)
        if (p[i] != '=') return false;
    return true;
}

static char *fg_rendezvous_json(const char *role) {
    return xasprintf("{\"rendezvous\":{\"id\":\"%s\",\"role\":\"%s\",\"expires_at\":\"%s\"}}",
                     fg.rv.id, role, fg.rv.expires);
}

/* The relay's six doors, seen from the joiner's bearer (every HTTP
 * request here is the joiner's: the holder is in-process). */
static char *fg_pairing(const char *method, const char *rest, const char *body, int *status) {
    *status = 200;
    if (strcmp(rest, "/offer") == 0 && strcmp(method, "GET") == 0) {
        if (!fg.rv.live || fg.rv.joined) return xasprintf("{\"offer\":null}");
        return xasprintf("{\"offer\":{\"rendezvous_id\":\"%s\",\"curve\":\"%s\",\"expires_at\":"
                         "\"%s\"}}",
                         fg.rv.id, fg.rv.curve, fg.rv.expires);
    }
    if (rest[0] != '/') FG_ERR(404, "not_found");
    char id[64] = "";
    size_t n = strcspn(rest + 1, "/?");
    if (n >= sizeof(id)) FG_ERR(404, "not_found");
    memcpy(id, rest + 1, n);
    id[n] = 0;
    const char *tail = rest + 1 + n;
    if (!fg.rv.live || strcmp(id, fg.rv.id) != 0) FG_ERR(404, "not_found");
    if (strcmp(tail, "/join") == 0 && strcmp(method, "POST") == 0) {
        if (fg.rv.fail_join_status) {
            *status = fg.rv.fail_join_status;
            return xasprintf("{\"error\":\"%s\"}", fg.rv.fail_join_error);
        }
        if (fg.rv.joined) FG_ERR(409, "pairing_already_joined");
        fg.rv.joined = true;
        return fg_rendezvous_json("joiner");
    }
    if (strcmp(tail, "/messages") == 0 && strcmp(method, "POST") == 0) {
        json_doc *doc = body ? json_parse(body, strlen(body), NULL, 0) : NULL;
        const char *payload = doc ? json_string(json_get(json_root(doc), "payload")) : NULL;
        char *out;
        if (!fg.rv.joined) {
            *status = 409;
            out = xasprintf("{\"error\":\"pairing_not_joined\"}");
        } else if (!fg_payload_ok(payload)) {
            *status = 422;
            out = xasprintf("{\"error\":\"bad_request\"}");
        } else if (fg.rv.n >= sizeof(fg.rv.msg) / sizeof(fg.rv.msg[0]) ||
                   strlen(payload) >= sizeof(fg.rv.msg[0].payload)) {
            *status = 413;
            out = xasprintf("{\"error\":\"pairing_full\"}");
        } else {
            long seq = (long)fg.rv.n + 1;
            fg.rv.msg[fg.rv.n].seq = seq;
            fg.rv.msg[fg.rv.n].from = WIRE_PAIRING_JOINER;
            snprintf(fg.rv.msg[fg.rv.n].payload, sizeof(fg.rv.msg[0].payload), "%s", payload);
            fg.rv.n++;
            *status = 201;
            out = xasprintf("{\"message\":{\"seq\":%ld,\"from\":\"joiner\",\"payload\":\"%s\"}}",
                            seq, payload);
        }
        json_free(doc);
        return out;
    }
    if (strncmp(tail, "/messages", 9) == 0 && strcmp(method, "GET") == 0) {
        const char *after = strstr(tail, "?after=");
        long from = after ? strtol(after + 7, NULL, 10) : 0;
        char *out = xasprintf("{\"messages\":[");
        bool first = true;
        for (size_t i = 0; i < fg.rv.n; i++) {
            if (fg.rv.msg[i].seq <= from || fg.rv.msg[i].from != WIRE_PAIRING_CREATOR) continue;
            char *joined = xasprintf("%s%s{\"seq\":%ld,\"from\":\"creator\",\"payload\":\"%s\"}",
                                     out, first ? "" : ",", fg.rv.msg[i].seq, fg.rv.msg[i].payload);
            free(out);
            out = joined;
            first = false;
        }
        char *closed = xasprintf("%s]}", out);
        free(out);
        return closed;
    }
    if (!tail[0] && strcmp(method, "DELETE") == 0) {
        fg.rv.live = false;
        *status = 204;
        return xasprintf("%s", "");
    }
    FG_ERR(404, "not_found");
}

/* One request, under fg.lock. Returns the body (malloc'd, may be "") and
 * sets the status. */
/* A request as grappa's wire has it. */
static char *fg_req_json_locked(size_t i) {
    return xasprintf("{\"id\":%ld,\"peer\":\"%s\",\"state\":\"%s\",\"payload\":null,"
                     "\"at\":\"2026-11-07T10:00:00Z\",\"expires_at\":%s%s%s}",
                     fg.req[i].id, fg.req[i].peer, fg.req[i].state,
                     fg.req[i].expires[0] ? "\"" : "", fg.req[i].expires[0] ? fg.req[i].expires : "null",
                     fg.req[i].expires[0] ? "\"" : "");
}

static long fg_req_add(const char *peer, const char *state, const char *expires) {
    pthread_mutex_lock(&fg.lock);
    size_t i = fg.nreq++;
    fg.req[i].id = ++fg.next_req;
    snprintf(fg.req[i].peer, sizeof(fg.req[0].peer), "%s", peer);
    snprintf(fg.req[i].state, sizeof(fg.req[0].state), "%s", state);
    snprintf(fg.req[i].expires, sizeof(fg.req[0].expires), "%s", expires ? expires : "");
    long id = fg.req[i].id;
    pthread_mutex_unlock(&fg.lock);
    return id;
}

static ssize_t fg_req_index_locked(long id) {
    for (size_t i = 0; i < fg.nreq; i++)
        if (fg.req[i].id == id) return (ssize_t)i;
    return -1;
}

static void fg_req_remove_locked(size_t i) { fg.req[i] = fg.req[--fg.nreq]; }

/* …/e2e/requests, as lib/grappa/e2e_requests.ex answers for the cases here:
 * a consent line needs a did grappa lists and the payload as a string. */
static char *fg_requests(const char *method, const char *tail, const char *body,
                         const json_value *root, int *status) {
    size_t at = strlen(fg.req_bodies);
    snprintf(fg.req_bodies + at, sizeof(fg.req_bodies) - at, "%s %s %s\n", method,
             tail[0] ? tail : "/", body && body[0] ? body : "-");
    const char *from = json_string(json_get(root, "from"));
    const char *payload = json_string(json_get(root, "payload"));
    bool line = from && payload && fg_device_by_did(from);
    if (!tail[0] && strcmp(method, "GET") == 0) {
        char *out = xasprintf("{\"requests\":[");
        for (size_t i = 0; i < fg.nreq; i++) {
            char *r = fg_req_json_locked(i);
            char *j = xasprintf("%s%s%s", out, i ? "," : "", r);
            free(out);
            free(r);
            out = j;
        }
        char *c = xasprintf("%s]}", out);
        free(out);
        return c;
    }
    if (!tail[0] && strcmp(method, "POST") == 0) {
        const char *target = json_string(json_get(root, "target"));
        if (!target || !line) FG_ERR(400, "bad_request");
        size_t i = fg.nreq++;
        fg.req[i].id = ++fg.next_req;
        snprintf(fg.req[i].peer, sizeof(fg.req[0].peer), "%s", target);
        snprintf(fg.req[i].state, sizeof(fg.req[0].state), "outgoing");
        snprintf(fg.req[i].expires, sizeof(fg.req[0].expires), "2099-01-01T00:00:00Z");
        *status = 202;
        char *r = fg_req_json_locked(i);
        char *out = xasprintf("{\"request\":%s}", r);
        free(r);
        return out;
    }
    long id = strtol(tail + 1, NULL, 10);
    ssize_t i = fg_req_index_locked(id);
    if (i < 0) FG_ERR(404, "not_found");
    const char *verb = strchr(tail + 1, '/');
    if (verb && strcmp(method, "POST") == 0 &&
        (strcmp(verb, "/accept") == 0 || strcmp(verb, "/refuse") == 0)) {
        if (strcmp(fg.req[i].state, "incoming") != 0) FG_ERR(409, "request_state");
        if (strcmp(verb, "/accept") == 0 && !line) FG_ERR(400, "bad_request");
        fg_req_remove_locked((size_t)i);
        *status = 202;
        char msgid[12];
        fg_msgid(msgid);
        return xasprintf("{\"msgid\":\"%s\"}", msgid);
    }
    if (!verb && strcmp(method, "DELETE") == 0) {
        if (strcmp(fg.req[i].state, "outgoing") == 0 && !line) FG_ERR(400, "bad_request");
        fg_req_remove_locked((size_t)i);
        *status = 204;
        return xasprintf("%s", "");
    }
    FG_ERR(404, "not_found");
}

static char *fg_handle(const char *method, const char *path, const char *body, int *status) {
    const char *prefix = "/networks/azzurra/e2e";
    *status = 200;
    if (strcmp(path, "/api/config") == 0) return xasprintf("{\"protocol_version\":59}");
    if (strncmp(path, "/e2e/pairings", 13) == 0) return fg_pairing(method, path + 13, body, status);
    if (strncmp(path, "/networks/azzurra/channels/", 27) == 0 && strcmp(method, "POST") == 0) {
        /* The clear door: kept, so a test can prove nothing went there. */
        if (fg.nplain < FG_SENT_MAX) fg.plain[fg.nplain++] = xasprintf("%s", body ? body : "");
        *status = 202;
        return xasprintf("{}");
    }
    if (strncmp(path, prefix, strlen(prefix)) != 0) FG_ERR(404, "not_found");
    const char *rest = path + strlen(prefix);
    json_doc *doc = body && body[0] ? json_parse(body, strlen(body), NULL, 0) : NULL;
    const json_value *root = doc ? json_root(doc) : NULL;
    char *out = NULL;

    if (strncmp(rest, "/requests", 9) == 0) {
        out = fg_requests(method, rest + 9, body, root, status);
        goto end;
    }
    if (strcmp(rest, "/list") == 0 && strcmp(method, "GET") == 0) {
        if (!fg.has_list) {
            *status = 404;
            out = xasprintf("{\"error\":\"not_found\"}");
        } else {
            out = fg_list_json();
        }
    } else if (strcmp(rest, "/list") == 0 && strcmp(method, "PUT") == 0) {
        if (fg.fail_put_status) {
            *status = fg.fail_put_status;
            out = xasprintf("{\"error\":\"%s\"}", fg.fail_put_error);
            fg.fail_put_status = 0;
            goto end;
        }
        struct wire_e2e_list l;
        if (!root || !wire_narrow_e2e_list(root, &l) || l.device_count > E2E_MAX_DEVICES) {
            *status = 400;
            out = xasprintf("{\"error\":\"bad_request\"}");
            goto end;
        }
        e2e_master_list m = {.ed25519 = l.master, .ver = l.ver, .ndevices = l.device_count,
                             .sig = l.sig};
        for (size_t i = 0; i < l.device_count; i++) m.devices[i] = wire_string_at(l.devices, i);
        if (!e2e_valid_master_list(&m) || l.device_count > E2E_DEVICE_CAP) {
            *status = 400;
            out = xasprintf("{\"error\":\"bad_request\"}");
        } else if (fg.has_list && strcmp(fg.master, l.master) != 0) {
            *status = 409;
            out = xasprintf("{\"error\":\"master_mismatch\"}");
        } else if (fg.has_list && (long)l.ver <= fg.ver) {
            *status = 409;
            out = xasprintf("{\"error\":\"stale_list\"}");
        } else {
            for (size_t i = 0; i < l.device_count; i++) {
                bool known = false;
                for (size_t k = 0; k < fg.ndev; k++)
                    if (strcmp(fg.dev[k].ed, m.devices[i]) == 0) known = true;
                if (!known) {
                    *status = 422;
                    out = xasprintf("{\"error\":\"unknown_device\"}");
                    goto end;
                }
            }
            /* A device the held list named and this one does not is
             * revoked: grappa forgets it with everything stored. */
            for (size_t k = 0; fg.has_list && k < fg.ndevices; k++) {
                bool kept = false;
                for (size_t i = 0; i < l.device_count; i++)
                    kept = kept || strcmp(fg.devices[k], m.devices[i]) == 0;
                for (size_t d = 0; !kept && d < fg.ndev; d++) {
                    if (strcmp(fg.dev[d].ed, fg.devices[k]) != 0) continue;
                    memmove(&fg.dev[d], &fg.dev[d + 1], (fg.ndev - d - 1) * sizeof(fg.dev[0]));
                    fg.ndev--;
                    break;
                }
            }
            fg.has_list = true;
            snprintf(fg.master, sizeof(fg.master), "%s", l.master);
            fg.ver = (long)l.ver;
            fg.ndevices = l.device_count;
            for (size_t i = 0; i < l.device_count; i++)
                snprintf(fg.devices[i], sizeof(fg.devices[i]), "%s", m.devices[i]);
            snprintf(fg.list_sig, sizeof(fg.list_sig), "%s", l.sig);
            out = fg_list_json();
        }
    } else if (strcmp(rest, "/messages") == 0 && strcmp(method, "POST") == 0) {
        /* The send door: accepted, named, kept for the test to carry. */
        if (!root || !json_string(json_get(root, "verb")) || fg.nsent >= FG_SENT_MAX) {
            *status = 400;
            out = xasprintf("{\"error\":\"bad_request\"}");
            goto end;
        }
        if (fg.fail_send_status) {
            *status = fg.fail_send_status;
            out = xasprintf("{\"error\":\"%s\"}", fg.fail_send_error);
            fg.fail_send_status = 0;
            goto end;
        }
        const char *verb = json_string(json_get(root, "verb"));
        const char *payload = json_string(json_get(root, "payload"));
        if (fg.budget > 0 && payload && strcmp(verb, "keyreq") != 0 &&
            e2e_lines_needed(e2e_verb_parse(verb), payload,
                             e2e_line_budget(fg.budget, json_string(json_get(root, "target"))),
                             json_string(json_get(root, "from")),
                             json_string(json_get(root, "to"))) > E2E_MAX_FRAGMENTS) {
            *status = 413;
            out = xasprintf("{\"error\":\"too_large\"}");
            goto end;
        }
        size_t k = fg.nsent;
        fg.sent[fg.nsent++] = xasprintf("%s", body);
        fg_msgid(fg.sent_msgid[k]);
        long inbox;
        fg.sent_disk_rows[k] = 0;
        fg.sent_disk_records[k] = -1;
        if (fg.watch_dir[0]) fg_disk_locked(&inbox, &fg.sent_disk_records[k], &fg.sent_disk_rows[k]);
        if (fg.lock_disk_on_send && fg.watch_dir[0]) {
            chmod(fg.watch_dir, 0500);
            fg.lock_disk_on_send = false;
        }
        *status = 202;
        out = xasprintf("{\"msgid\":\"%s\"}", fg.sent_msgid[k]);
    } else if (strcmp(rest, "/devices") == 0 && strcmp(method, "POST") == 0) {
        const char *ed = json_string(json_get(root, "ed25519"));
        const char *curve = json_string(json_get(root, "curve25519"));
        const char *sig = json_string(json_get(root, "sig"));
        char did[E2E_DID_LEN + 1];
        if (!ed || !curve || !sig || !e2e_did(ed, did)) {
            *status = 400;
            out = xasprintf("{\"error\":\"bad_request\"}");
            goto end;
        }
        fg_device *d = fg_device_by_did(did);
        if (!d) {
            if (fg.ndev >= E2E_DEVICE_CAP) {
                *status = 409;
                out = xasprintf("{\"error\":\"too_many_devices\"}");
                goto end;
            }
            d = &fg.dev[fg.ndev++];
            memset(d, 0, sizeof(*d));
        }
        snprintf(d->did, sizeof(d->did), "%s", did);
        snprintf(d->ed, sizeof(d->ed), "%s", ed);
        snprintf(d->curve, sizeof(d->curve), "%s", curve);
        snprintf(d->sig, sizeof(d->sig), "%s", sig);
        out = fg_device_json(d);
    } else if (strcmp(rest, "/devices") == 0 && strcmp(method, "GET") == 0) {
        out = xasprintf("{\"devices\":[");
        for (size_t i = 0; i < fg.ndev; i++) {
            char *one = fg_device_json(&fg.dev[i]);
            char *joined = xasprintf("%s%s%s", out, i ? "," : "", one);
            free(one);
            free(out);
            out = joined;
        }
        char *closed = xasprintf("%s]}", out);
        free(out);
        out = closed;
    } else if (strncmp(rest, "/devices/", 9) == 0) {
        char did[32] = "";
        const char *p = rest + 9;
        size_t n = strcspn(p, "/");
        if (n >= sizeof(did)) n = sizeof(did) - 1;
        memcpy(did, p, n);
        did[n] = 0;
        const char *tail = p + n;
        fg_device *d = fg_device_by_did(did);
        if (!d) {
            *status = 404;
            out = xasprintf("{\"error\":\"not_found\"}");
        } else if (!tail[0] && strcmp(method, "DELETE") == 0) {
            if (fg_listed(d->ed)) {
                *status = 409;
                out = xasprintf("{\"error\":\"listed_device\"}");
            } else {
                *d = fg.dev[--fg.ndev];
                *status = 204;
                out = xasprintf("%s", "");
            }
        } else if (strncmp(tail, "/inbox?after=", 13) == 0 && strcmp(method, "GET") == 0) {
            long after = strtol(tail + 13, NULL, 10);
            out = xasprintf("{\"messages\":[");
            size_t n = 0;
            for (size_t i = 0; i < fg.ninbox && n < 100; i++) {
                fg_item *it = &fg.inbox[i];
                if (it->acked || it->id <= after || strcmp(it->to, did) != 0) continue;
                char *joined = xasprintf("%s%s%s", out, n ? "," : "", it->json);
                free(out);
                out = joined;
                n++;
            }
            char *closed = xasprintf("%s]}", out);
            free(out);
            out = closed;
        } else if (strcmp(tail, "/inbox/ack") == 0 && strcmp(method, "POST") == 0) {
            const json_value *ids = json_get(root, "ids");
            if (json_type_of(ids) != JSON_ARRAY || json_len(ids) == 0 || json_len(ids) > 100) {
                *status = 400;
                out = xasprintf("{\"error\":\"bad_request\"}");
                goto end;
            }
            fg_watch_locked();
            size_t at = strlen(fg.acks);
            json_write(ids, fg.acks + at, sizeof(fg.acks) - at - 1);
            at = strlen(fg.acks);
            snprintf(fg.acks + at, sizeof(fg.acks) - at, "\n");
            for (size_t k = 0; k < json_len(ids); k++) {
                long id = 0;
                json_long(json_at(ids, k), &id);
                for (size_t i = 0; i < fg.ninbox; i++)
                    if (fg.inbox[i].id == id && strcmp(fg.inbox[i].to, did) == 0)
                        fg.inbox[i].acked = true;
            }
            *status = 204;
            out = xasprintf("%s", "");
        } else if (strcmp(tail, "/claim") == 0 && strcmp(method, "POST") == 0) {
            const char *from = json_string(json_get(root, "from_did"));
            if (!from || !fg_device_by_did(from)) {
                *status = 422;
                out = xasprintf("{\"error\":\"unknown_device\"}");
            } else if (strcmp(from, did) == 0) {
                *status = 409;
                out = xasprintf("{\"error\":\"same_device\"}");
            } else if (!fg_listed(d->ed)) {
                *status = 404;
                out = xasprintf("{\"error\":\"not_found\"}");
            } else {
                char *keys = fg_keys_locked(did);
                char *k = json_escape(keys);
                out = xasprintf("{\"keys\":\"%s\"}", k);
                free(k);
                free(keys);
            }
        } else if (strcmp(tail, "/copies") == 0 && strcmp(method, "POST") == 0) {
            const char *from = json_string(json_get(root, "from_did"));
            const char *verb = json_string(json_get(root, "verb"));
            const char *payload = json_string(json_get(root, "payload"));
            if (!from || !verb || !payload) {
                *status = 400;
                out = xasprintf("{\"error\":\"bad_request\"}");
                goto end;
            }
            char msgid[12];
            fg_msgid(msgid);
            long id = fg_inbox_push_locked(did, "vjt", from, e2e_verb_parse(verb), msgid, payload,
                                           true);
            *status = 202;
            out = xasprintf("{\"id\":%ld,\"msgid\":\"%s\"}", id, msgid);
        } else if (strcmp(tail, "/keys") == 0 && strcmp(method, "GET") == 0) {
            out = xasprintf("{\"one_time_keys\":%ld,\"fallback\":%s}", d->otks,
                            d->fallback ? "true" : "false");
        } else if (strcmp(tail, "/keys") == 0 && strcmp(method, "POST") == 0) {
            if (fg.fail_upload_status) {
                *status = fg.fail_upload_status;
                fg.fail_upload_status = 0;
                out = xasprintf("{\"error\":\"db_unavailable\"}");
                goto end;
            }
            const json_value *otks = json_get(root, "one_time_keys");
            const json_value *fb = json_get(root, "fallback");
            /* Every key is signed by the device it is filed under (S2). */
            for (size_t i = 0; i < json_len(otks); i++) {
                const json_value *k = json_at(otks, i);
                char *text = e2e_otk_sig_text(json_string(json_get(k, "key")));
                bool good = vz_verify_ed25519(d->ed, text,
                                              json_string(json_get(k, "sig"))) == 1;
                free(text);
                if (!good) {
                    *status = 400;
                    out = xasprintf("{\"error\":\"bad_request\"}");
                    goto end;
                }
            }
            if (d->otks + (long)json_len(otks) > E2E_MAX_HOSTED_ONE_TIME_KEYS) {
                *status = 413;
                out = xasprintf("{\"error\":\"too_large\"}");
                goto end;
            }
            d->otks += (long)json_len(otks);
            for (size_t i = 0; i < json_len(otks) && d->notk < 64; i++) {
                const json_value *k = json_at(otks, i);
                snprintf(d->otk[d->notk].key, sizeof(d->otk[0].key), "%s",
                         json_string(json_get(k, "key")));
                snprintf(d->otk[d->notk].sig, sizeof(d->otk[0].sig), "%s",
                         json_string(json_get(k, "sig")));
                d->notk++;
            }
            if (json_type_of(fb) == JSON_OBJECT) {
                d->fallback = true;
                snprintf(d->fb.key, sizeof(d->fb.key), "%s", json_string(json_get(fb, "key")));
                snprintf(d->fb.sig, sizeof(d->fb.sig), "%s", json_string(json_get(fb, "sig")));
            }
            out = xasprintf("{\"one_time_keys\":%ld,\"fallback\":%s}", d->otks,
                            d->fallback ? "true" : "false");
        } else {
            *status = 404;
            out = xasprintf("{\"error\":\"not_found\"}");
        }
    } else {
        *status = 404;
        out = xasprintf("{\"error\":\"not_found\"}");
    }
end:
    json_free(doc);
    return out;
}

static void fg_serve(int c) {
    char buf[65536];
    size_t used = 0;
    char *body = NULL;
    size_t want = 0;
    for (;;) {
        ssize_t n = recv(c, buf + used, sizeof(buf) - 1 - used, 0);
        if (n <= 0) return;
        used += (size_t)n;
        buf[used] = 0;
        char *end = strstr(buf, "\r\n\r\n");
        if (!end) continue;
        const char *cl = find_ci(buf, "Content-Length:");
        size_t len = cl ? (size_t)strtoul(cl + 15, NULL, 10) : 0;
        body = end + 4;
        want = (size_t)(body - buf) + len;
        if (used >= want) break;
    }
    buf[want] = 0;
    char method[16] = "", path[512] = "";
    sscanf(buf, "%15s %511s", method, path);
    pthread_mutex_lock(&fg.lock);
    size_t at = strlen(fg.log);
    snprintf(fg.log + at, sizeof(fg.log) - at, "%s %s\n", method, path);
    fg.requests++;
    int status;
    char *reply = fg_handle(method, path, body, &status);
    pthread_mutex_unlock(&fg.lock);
    char *head = xasprintf("HTTP/1.1 %d X\r\nContent-Type: application/json\r\n"
                           "Content-Length: %zu\r\nConnection: close\r\n\r\n",
                           status, strlen(reply));
    ssize_t w = send(c, head, strlen(head), 0);
    w = send(c, reply, strlen(reply), 0);
    (void)w;
    free(head);
    free(reply);
}

static void *fg_main(void *arg) {
    (void)arg;
    for (;;) {
        int c = accept(fg.fd, NULL, NULL);
        if (c < 0) return NULL;
        pthread_mutex_lock(&fg.lock);
        bool stop = fg.stop;
        pthread_mutex_unlock(&fg.lock);
        if (stop) {
            close(c);
            return NULL;
        }
        fg_serve(c);
        close(c);
    }
}

static bool fg_start(void) {
    pthread_mutex_init(&fg.lock, NULL);
    fg.fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fg.fd < 0) return false;
    struct sockaddr_in a = {.sin_family = AF_INET, .sin_addr.s_addr = htonl(INADDR_LOOPBACK)};
    if (bind(fg.fd, (struct sockaddr *)&a, sizeof(a)) != 0 || listen(fg.fd, 8) != 0) return false;
    socklen_t len = sizeof(a);
    getsockname(fg.fd, (struct sockaddr *)&a, &len);
    snprintf(fg.port, sizeof(fg.port), "%d", ntohs(a.sin_port));
    return pthread_create(&fg.thread, NULL, fg_main, NULL) == 0;
}

static void fg_stop(void) {
    pthread_mutex_lock(&fg.lock);
    fg.stop = true;
    pthread_mutex_unlock(&fg.lock);
    /* Wake the accept with one last connection. */
    int c = socket(AF_INET, SOCK_STREAM, 0);
    struct sockaddr_in a = {.sin_family = AF_INET, .sin_addr.s_addr = htonl(INADDR_LOOPBACK),
                            .sin_port = htons((uint16_t)atoi(fg.port))};
    if (c >= 0 && connect(c, (struct sockaddr *)&a, sizeof(a)) == 0) close(c);
    else if (c >= 0) close(c);
    pthread_join(fg.thread, NULL);
    close(fg.fd);
    pthread_mutex_destroy(&fg.lock);
}

static bool fg_logged(const char *line) {
    pthread_mutex_lock(&fg.lock);
    bool found = strstr(fg.log, line) != NULL;
    pthread_mutex_unlock(&fg.lock);
    return found;
}

/* No request of `method` at all since the last reset. */
static bool fg_no(const char *method) {
    char needle[24];
    snprintf(needle, sizeof(needle), "%s ", method);
    pthread_mutex_lock(&fg.lock);
    bool none = true;
    for (const char *p = fg.log; *p; p = strchr(p, '\n') ? strchr(p, '\n') + 1 : p + strlen(p))
        if (strncmp(p, needle, strlen(needle)) == 0) none = false;
    pthread_mutex_unlock(&fg.lock);
    return none;
}

/* ── the client ───────────────────────────────────────────────────────── */

static struct app *e2e_app(const char *subject) {
    struct app *app = calloc(1, sizeof(*app));
    if (!app) return NULL;
    pthread_mutex_init(&app->lock, NULL);
    pthread_mutex_init(&app->jobs_lock, NULL);
    pthread_cond_init(&app->jobs_cond, NULL);
    snprintf(app->subject, sizeof(app->subject), "%s", subject);
    snprintf(app->url.host, sizeof(app->url.host), "127.0.0.1");
    snprintf(app->url.port, sizeof(app->url.port), "%s", fg.port);
    snprintf(app->url.base, sizeof(app->url.base), "http://127.0.0.1:%s", fg.port);
    app->url.tls = false;
    app->server_protocol = 59;
    struct network *n = &app->networks[app->network_count++];
    snprintf(n->slug, sizeof(n->slug), "azzurra");
    snprintf(n->nick, sizeof(n->nick), "vjt");
    n->id = 1;
    return app;
}

static void free_e2e_app(struct app *app) {
    e2e_slots_free(app);
    for (size_t i = 0; i < app->log_count; i++) free(app->log[i]);
    free(app->hidden_ids);
    pthread_mutex_destroy(&app->lock);
    pthread_mutex_destroy(&app->jobs_lock);
    pthread_cond_destroy(&app->jobs_cond);
    free(app);
}

static bool said(struct app *app, const char *needle) {
    for (size_t i = 0; i < app->log_count; i++)
        if (strstr(app->log[i], needle)) return true;
    return false;
}

static void run_job(struct app *app, enum job_kind kind) {
    struct job job = {.kind = kind};
    snprintf(job.network, sizeof(job.network), "azzurra");
    e2e_job(app, &job);
}

static struct e2e_view view_of(struct app *app) {
    struct e2e_view v;
    memset(&v, 0, sizeof(v));
    pthread_mutex_lock(&app->lock);
    struct e2e_slot *s = e2e_slot_by_slug_locked(app, "azzurra");
    if (s) v = s->view;
    pthread_mutex_unlock(&app->lock);
    return v;
}

static bool status_says(struct app *app, const char *needle) {
    struct e2e_view v = view_of(app);
    char lines[2][MAX_LINE];
    size_t n = e2e_status_lines("azzurra", &v, lines);
    for (size_t i = 0; i < n; i++)
        if (strstr(lines[i], needle)) return true;
    fprintf(stderr, "  status: %s\n", n ? lines[0] : "(none)");
    return false;
}

/* What the record on disk holds, read as the next run would read it —
 * the app's store must be closed first, the lock is exclusive. */
static bool disk_record(struct app *app, e2e_record *out) {
    struct e2e_slot *s = &app->e2e[0];
    char dir[PATH_MAX];
    e2e_slot_dir(app, s, dir, sizeof(dir));
    e2e_store *st;
    char err[256];
    if (e2e_store_open(dir, &st, err, sizeof(err)) != E2E_STORE_OK) return false;
    bool ok = e2e_store_load(st, out, err, sizeof(err)) == E2E_LOAD_OK;
    e2e_store_close(st);
    return ok;
}

/* ── tests ────────────────────────────────────────────────────────────── */

/* No identity anywhere: a sync looks and writes NOTHING — creating one
 * is the user's decision, not the boot's. */
TEST(no_identity_is_left_alone) {
    fg_reset();
    struct app *app = e2e_app("user:none");
    run_job(app, JOB_E2E_SYNC);
    CHECK(view_of(app).state == E2E_SLOT_NONE);
    CHECK(fg_logged("GET /networks/azzurra/e2e/list"));
    CHECK(fg_no("POST") && fg_no("PUT") && fg_no("DELETE"));
    CHECK(status_says(app, "none"));
    CHECK(status_says(app, "/e2e init azzurra"));
    free_e2e_app(app);
}

/* /e2e init: register, list at v1, publish a full bundle — in that order,
 * with the master stored before grappa hears of it. */
TEST(init_makes_this_device_the_first) {
    fg_reset();
    struct app *app = e2e_app("user:init");
    run_job(app, JOB_E2E_INIT);
    struct e2e_view v = view_of(app);
    CHECK(v.state == E2E_SLOT_READY);
    CHECK(v.holder);
    CHECK_LONG(v.list_ver, 1);
    CHECK_LONG(v.list_devices, 1);
    CHECK(v.keys_known);
    CHECK_LONG(v.one_time_keys, E2E_MAX_HOSTED_ONE_TIME_KEYS);
    CHECK(v.fallback);
    pthread_mutex_lock(&fg.lock);
    const char *reg = strstr(fg.log, "POST /networks/azzurra/e2e/devices\n");
    const char *put = strstr(fg.log, "PUT /networks/azzurra/e2e/list\n");
    char upload[128];
    snprintf(upload, sizeof(upload), "POST /networks/azzurra/e2e/devices/%s/keys\n", v.did);
    const char *up = strstr(fg.log, upload);
    CHECK(reg && put && up && reg < put && put < up);
    CHECK(fg.has_list && fg.ver == 1 && fg.ndevices == 1);
    CHECK_STR(fg.master, v.master);
    CHECK(fg.ndev == 1 && fg.dev[0].otks == E2E_MAX_HOSTED_ONE_TIME_KEYS && fg.dev[0].fallback);
    pthread_mutex_unlock(&fg.lock);
    CHECK(status_says(app, "holder"));
    CHECK(status_says(app, "list v1, 1 device,"));
    CHECK(status_says(app, "50 one-time keys + fallback"));
    CHECK(status_says(app, v.master));
    CHECK(said(app, "encrypted identity created on azzurra"));

    /* What the next run reads: the master, the place, and keys marked
     * published (vodozemac answers none unpublished). */
    e2e_slots_free(app);
    e2e_record rec;
    CHECK(disk_record(app, &rec));
    CHECK(rec.master != NULL);
    CHECK(rec.own != NULL && strcmp(rec.own->did, v.did) == 0);
    char *pending = rec.account ? vz_account_one_time_keys(rec.account) : NULL;
    CHECK(pending && strcmp(pending, "[]") == 0);
    vz_str_free(pending);
    e2e_record_free(&rec);

    free_e2e_app(app);
}

/* A restart: the device is listed, the bundle is full, so a sync reads
 * and writes nothing; once peers spent keys it tops them up. */
TEST(sync_tops_the_bundle_up) {
    fg_reset();
    struct app *app = e2e_app("user:topup");
    run_job(app, JOB_E2E_INIT);
    struct e2e_view v = view_of(app);
    CHECK(v.state == E2E_SLOT_READY);
    e2e_slots_free(app);

    pthread_mutex_lock(&fg.lock);
    fg.log[0] = 0;
    pthread_mutex_unlock(&fg.lock);
    run_job(app, JOB_E2E_SYNC);
    CHECK(view_of(app).state == E2E_SLOT_READY);
    char keys[128];
    snprintf(keys, sizeof(keys), "GET /networks/azzurra/e2e/devices/%s/keys", v.did);
    CHECK(fg_logged(keys));
    CHECK(fg_no("POST") && fg_no("PUT") && fg_no("DELETE"));

    /* Peers claimed twelve. */
    pthread_mutex_lock(&fg.lock);
    fg.dev[0].otks -= 12;
    fg.log[0] = 0;
    pthread_mutex_unlock(&fg.lock);
    run_job(app, JOB_E2E_SYNC);
    pthread_mutex_lock(&fg.lock);
    CHECK_LONG(fg.dev[0].otks, E2E_MAX_HOSTED_ONE_TIME_KEYS);
    pthread_mutex_unlock(&fg.lock);
    CHECK_LONG(view_of(app).one_time_keys, E2E_MAX_HOSTED_ONE_TIME_KEYS);

    /* An upload grappa refuses: the keys stay unpublished and go again,
     * the same ones, next sync. */
    pthread_mutex_lock(&fg.lock);
    fg.dev[0].otks -= 5;
    fg.fail_upload_status = 503;
    pthread_mutex_unlock(&fg.lock);
    run_job(app, JOB_E2E_SYNC);
    CHECK(said(app, "key upload refused (HTTP 503 db_unavailable)"));
    CHECK_LONG(view_of(app).one_time_keys, E2E_MAX_HOSTED_ONE_TIME_KEYS - 5);
    struct e2e_slot *s = &app->e2e[0];
    char *pending = vz_account_one_time_keys(s->rec.account);
    json_doc *pd = pending ? json_parse(pending, strlen(pending), NULL, 0) : NULL;
    CHECK_LONG(json_len(pd ? json_root(pd) : NULL), 5);
    json_free(pd);
    vz_str_free(pending);
    run_job(app, JOB_E2E_SYNC);
    pthread_mutex_lock(&fg.lock);
    CHECK_LONG(fg.dev[0].otks, E2E_MAX_HOSTED_ONE_TIME_KEYS);
    pthread_mutex_unlock(&fg.lock);
    free_e2e_app(app);
}

/* grappa lost the list while the master is here: list again, one above. */
TEST(lost_list_is_relisted_by_the_holder) {
    fg_reset();
    struct app *app = e2e_app("user:relist");
    run_job(app, JOB_E2E_INIT);
    CHECK(view_of(app).state == E2E_SLOT_READY);
    fg_reset();
    run_job(app, JOB_E2E_SYNC);
    struct e2e_view v = view_of(app);
    CHECK(v.state == E2E_SLOT_READY);
    CHECK_LONG(v.list_ver, 2);
    pthread_mutex_lock(&fg.lock);
    CHECK(fg.has_list && fg.ver == 2 && fg.ndev == 1);
    pthread_mutex_unlock(&fg.lock);
    CHECK(said(app, "listed this device again at v2"));
    free_e2e_app(app);
}

/* An identity that is not ours: nothing written, init refused, status
 * says where to go. */
TEST(identity_elsewhere_is_never_touched) {
    fg_reset();
    /* Somebody else's first device. */
    struct app *other = e2e_app("user:elsewhere-a");
    run_job(other, JOB_E2E_INIT);
    CHECK(view_of(other).state == E2E_SLOT_READY);
    free_e2e_app(other);

    pthread_mutex_lock(&fg.lock);
    fg.log[0] = 0;
    pthread_mutex_unlock(&fg.lock);
    struct app *app = e2e_app("user:elsewhere-b");
    run_job(app, JOB_E2E_SYNC);
    struct e2e_view v = view_of(app);
    CHECK(v.state == E2E_SLOT_ELSEWHERE);
    CHECK(v.plan == E2E_SYNC_ELSEWHERE_NO_KEYS);
    CHECK(status_says(app, "elsewhere, no-keys"));
    CHECK(status_says(app, "list v1, 1 device"));
    CHECK(status_says(app, "pair this device from cicchetto"));
    CHECK(said(app, "does not include this device"));
    run_job(app, JOB_E2E_INIT);
    CHECK(said(app, "refused — the account already has an encrypted identity here"));
    CHECK(fg_no("POST") && fg_no("PUT") && fg_no("DELETE"));
    /* The UI door refuses without a round trip. */
    size_t before = fg.requests;
    e2e_command(app, "init azzurra");
    CHECK(said(app, "it is never replaced from shottino"));
    CHECK_LONG(fg.requests, before);
    free_e2e_app(app);
}

/* A list put that fails drops the registration it followed — and only
 * that one. The orphans of a full account are reported, never deleted. */
TEST(failed_enlist_rolls_back_and_never_deletes_others) {
    fg_reset();
    pthread_mutex_lock(&fg.lock);
    fg.fail_put_status = 422;
    snprintf(fg.fail_put_error, sizeof(fg.fail_put_error), "unknown_device");
    pthread_mutex_unlock(&fg.lock);
    struct app *app = e2e_app("user:rollback");
    run_job(app, JOB_E2E_INIT);
    CHECK(view_of(app).state == E2E_SLOT_NONE);
    CHECK(said(app, "failed — putting the device list: HTTP 422 unknown_device"));
    CHECK(fg_logged("DELETE /networks/azzurra/e2e/devices/"));
    pthread_mutex_lock(&fg.lock);
    CHECK_LONG(fg.ndev, 0);
    pthread_mutex_unlock(&fg.lock);
    /* The record took the master back out: the next sync is NONE, not a
     * relist of an identity that never was. */
    run_job(app, JOB_E2E_SYNC);
    CHECK(view_of(app).state == E2E_SLOT_NONE);
    free_e2e_app(app);

    /* Three orphans fill the account. */
    fg_reset();
    pthread_mutex_lock(&fg.lock);
    for (int i = 0; i < 3; i++) {
        vz_account *a = vz_account_new();
        char *ed = vz_account_ed25519_key(a);
        fg_device *d = &fg.dev[fg.ndev++];
        memset(d, 0, sizeof(*d));
        e2e_did(ed, d->did);
        snprintf(d->ed, sizeof(d->ed), "%s", ed);
        snprintf(d->curve, sizeof(d->curve), "%s", ed);
        snprintf(d->sig, sizeof(d->sig), "x");
        vz_str_free(ed);
        vz_account_free(a);
    }
    pthread_mutex_unlock(&fg.lock);
    app = e2e_app("user:full");
    run_job(app, JOB_E2E_INIT);
    CHECK(said(app, "the most devices this account may have"));
    CHECK(fg_no("DELETE") && fg_no("PUT"));
    pthread_mutex_lock(&fg.lock);
    CHECK_LONG(fg.ndev, 3);
    pthread_mutex_unlock(&fg.lock);
    free_e2e_app(app);
}

/* Another shottino holds the device: this one says so and stays off. */
TEST(a_held_device_is_not_fought) {
    fg_reset();
    struct app *app = e2e_app("user:busy");
    struct e2e_slot *s = e2e_slot_for(app, "azzurra");
    char dir[PATH_MAX];
    e2e_slot_dir(app, s, dir, sizeof(dir));
    e2e_store *holder;
    char err[256];
    CHECK(e2e_store_open(dir, &holder, err, sizeof(err)) == E2E_STORE_OK);
    run_job(app, JOB_E2E_SYNC);
    CHECK(view_of(app).state == E2E_SLOT_BUSY);
    CHECK(said(app, "another shottino holds this device"));
    CHECK(status_says(app, "another shottino holds this device"));
    CHECK_LONG(fg.requests, 0);
    run_job(app, JOB_E2E_INIT);
    CHECK(said(app, "/e2e init azzurra: refused"));
    CHECK_LONG(fg.requests, 0);
    e2e_store_close(holder);
    free_e2e_app(app);
}

/* Below protocol 49 the server has no device identities: off, and not a
 * single request asks. */
TEST(an_old_server_keeps_e2e_off) {
    fg_reset();
    struct app *app = e2e_app("user:old");
    app->server_protocol = 48;
    run_job(app, JOB_E2E_SYNC);
    CHECK(view_of(app).state == E2E_SLOT_OFF);
    CHECK(status_says(app, "protocol v48"));
    e2e_command(app, "init azzurra");
    CHECK(said(app, "encrypted queries need protocol v49"));
    CHECK_LONG(fg.requests, 0);
    app->server_protocol = -1;
    run_job(app, JOB_E2E_SYNC);
    CHECK(status_says(app, "protocol version is unknown"));
    CHECK_LONG(fg.requests, 0);
    free_e2e_app(app);
}

/* The command's own doors: bare /e2e lists every network, a name it does
 * not know is said, and an unknown verb gets the usage. */
TEST(the_command_reads_its_arguments) {
    fg_reset();
    struct app *app = e2e_app("user:cmd");
    e2e_command(app, "");
    CHECK(said(app, "e2e azzurra: not looked at yet"));
    e2e_command(app, "status nowhere");
    CHECK(said(app, "/e2e: no network nowhere"));
    e2e_command(app, "frobnicate");
    CHECK(said(app, "usage: /e2e"));
    free_e2e_app(app);
}

/* ── the holder: cicchetto's holderPairing, scripted ──────────────────── */

#define TH_ID "Rv0123456789abcdefghij"

static struct {
    vz_account *master, *device;
    char m[64], e[64];
    vz_ecies *ecies;
    char curve[64];
    vz_established_ecies *link;
    long seen; /* the last joiner seq read */
    int code;
} th;

static char *th_vz(char *s) {
    char *out = s ? strdup(s) : NULL;
    vz_str_free(s);
    return out;
}

static void th_free(void) {
    vz_account_free(th.master);
    vz_account_free(th.device);
    vz_ecies_free(th.ecies);
    vz_established_ecies_free(th.link);
    memset(&th, 0, sizeof(th));
}

static void iso_in(long secs, char *out, size_t out_sz) {
    time_t t = time(NULL) + secs;
    struct tm tm;
    gmtime_r(&t, &tm);
    strftime(out, out_sz, "%Y-%m-%dT%H:%M:%SZ", &tm);
}

/* The account's identity on azzurra, made on the holder (cic's
 * bootstrap): its device registered, the list v1 naming it alone. */
static void th_identity(void) {
    th_free();
    th.master = vz_account_new();
    th.device = vz_account_new();
    char *m = th_vz(vz_account_ed25519_key(th.master));
    char *e = th_vz(vz_account_ed25519_key(th.device));
    char *c = th_vz(vz_account_curve25519_key(th.device));
    snprintf(th.m, sizeof(th.m), "%s", m);
    snprintf(th.e, sizeof(th.e), "%s", e);
    char text[256];
    snprintf(text, sizeof(text), "irc-e2e:v2:id:%s:%s", c, m);
    char *s1 = th_vz(vz_account_sign(th.device, text));
    snprintf(text, sizeof(text), "irc-e2e:v2:list:1:%s", e);
    char *ls = th_vz(vz_account_sign(th.master, text));
    pthread_mutex_lock(&fg.lock);
    fg_device *d = &fg.dev[fg.ndev++];
    memset(d, 0, sizeof(*d));
    e2e_did(e, d->did);
    snprintf(d->ed, sizeof(d->ed), "%s", e);
    snprintf(d->curve, sizeof(d->curve), "%s", c);
    snprintf(d->sig, sizeof(d->sig), "%s", s1);
    fg.has_list = true;
    snprintf(fg.master, sizeof(fg.master), "%s", m);
    fg.ver = 1;
    fg.ndevices = 1;
    snprintf(fg.devices[0], sizeof(fg.devices[0]), "%s", e);
    snprintf(fg.list_sig, sizeof(fg.list_sig), "%s", ls);
    pthread_mutex_unlock(&fg.lock);
    free(m);
    free(e);
    free(c);
    free(s1);
    free(ls);
}

/* "add a device": a fresh ECIES, its key on the open (v55's offer). */
static void th_open(long lifetime) {
    vz_ecies_free(th.ecies);
    vz_established_ecies_free(th.link);
    th.link = NULL;
    th.seen = 0;
    th.ecies = vz_ecies_new(E2E_PAIRING_INFO);
    char *k = th_vz(vz_ecies_public_key(th.ecies));
    snprintf(th.curve, sizeof(th.curve), "%s", k);
    free(k);
    pthread_mutex_lock(&fg.lock);
    memset(&fg.rv, 0, sizeof(fg.rv));
    fg.rv.live = true;
    snprintf(fg.rv.id, sizeof(fg.rv.id), "%s", TH_ID);
    snprintf(fg.rv.curve, sizeof(fg.rv.curve), "%s", th.curve);
    iso_in(lifetime, fg.rv.expires, sizeof(fg.rv.expires));
    pthread_mutex_unlock(&fg.lock);
}

/* The next payload the joiner posted, or NULL. */
static char *th_next(void) {
    char *out = NULL;
    pthread_mutex_lock(&fg.lock);
    for (size_t i = 0; i < fg.rv.n && !out; i++) {
        if (fg.rv.msg[i].from != WIRE_PAIRING_JOINER || fg.rv.msg[i].seq <= th.seen) continue;
        th.seen = fg.rv.msg[i].seq;
        out = strdup(fg.rv.msg[i].payload);
    }
    pthread_mutex_unlock(&fg.lock);
    return out;
}

static void th_post_raw(const char *payload) {
    pthread_mutex_lock(&fg.lock);
    size_t i = fg.rv.n++;
    fg.rv.msg[i].seq = (long)fg.rv.n;
    fg.rv.msg[i].from = WIRE_PAIRING_CREATOR;
    snprintf(fg.rv.msg[i].payload, sizeof(fg.rv.msg[i].payload), "%s", payload);
    pthread_mutex_unlock(&fg.lock);
}

static void th_post(const char *plaintext) {
    char *ct = th_vz(vz_established_ecies_encrypt(th.link, (const uint8_t *)plaintext,
                                                  strlen(plaintext)));
    th_post_raw(ct);
    free(ct);
}

/* The joiner's next message, opened; NULL when none or it does not open. */
static char *th_read(void) {
    char *payload = th_next();
    if (!payload || !th.link) {
        free(payload);
        return NULL;
    }
    vz_buf plain;
    int rc = vz_established_ecies_decrypt(th.link, payload, &plain);
    free(payload);
    if (rc != 0) return NULL;
    char *out = strndup((const char *)plain.ptr, plain.len);
    vz_buf_free(plain);
    return out;
}

/* The holder's `hello` step (unwrapInitial + establish_inbound): true when
 * the joiner's first payload is base64url of an initial message sealed to
 * this pairing's key, carrying exactly {"v":1,"t":"hello"}. */
static bool th_hello(void) {
    char *payload = th_next();
    if (!payload) return false;
    bool ok = strspn(payload, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_") ==
              strlen(payload);
    for (char *p = payload; *p; p++) {
        if (*p == '-') *p = '+';
        if (*p == '_') *p = '/';
    }
    vz_buf raw;
    ok = ok && vz_base64_decode(payload, &raw) == 0;
    free(payload);
    if (!ok) return false;
    char *initial = strndup((const char *)raw.ptr, raw.len);
    vz_buf_free(raw);
    vz_buf plain;
    vz_ecies *once = th.ecies;
    th.ecies = NULL;
    th.link = vz_ecies_establish_inbound(once, initial, &plain);
    free(initial);
    if (!th.link) return false;
    ok = plain.len == strlen("{\"v\":1,\"t\":\"hello\"}") &&
         memcmp(plain.ptr, "{\"v\":1,\"t\":\"hello\"}", plain.len) == 0;
    vz_buf_free(plain);
    th.code = vz_established_ecies_check_code(th.link);
    return ok;
}

static void th_offer(void) {
    char *offer = xasprintf("{\"v\":1,\"t\":\"offer\",\"networks\":[{\"network\":\"azzurra\","
                            "\"master\":\"%s\"}],\"full\":[]}",
                            th.m);
    th_post(offer);
    free(offer);
}

/* The holder's reading of `join` (pairingMessages decode + issueDevice's
 * checks): one device on azzurra whose keys are canonical and whose S1
 * vouches for this master; its key into *joiner. */
static bool th_join(char joiner[64]) {
    char *text = th_read();
    json_doc *d = text ? json_parse(text, strlen(text), NULL, 0) : NULL;
    free(text);
    const json_value *o = d ? json_root(d) : NULL;
    double v;
    bool ok = o && json_number(json_get(o, "v"), &v) && v == 1 &&
              json_str_is(json_get(o, "t"), "join");
    const json_value *devs = json_get(o, "devices");
    const json_value *skipped = json_get(o, "skipped");
    ok = ok && json_type_of(devs) == JSON_ARRAY && json_len(devs) == 1 &&
         json_type_of(skipped) == JSON_ARRAY && json_len(skipped) == 0;
    const json_value *dev = json_at(devs, 0);
    const json_value *id = json_get(dev, "id");
    const char *curve = json_string(json_get(id, "curve25519"));
    const char *ed = json_string(json_get(id, "ed25519"));
    const char *sig = json_string(json_get(id, "sig"));
    ok = ok && json_str_is(json_get(dev, "network"), "azzurra") && curve && ed && sig;
    if (ok) {
        char *cc = th_vz(vz_canonical_curve25519(curve)), *ce = th_vz(vz_canonical_ed25519(ed));
        ok = cc && ce && strcmp(cc, curve) == 0 && strcmp(ce, ed) == 0;
        free(cc);
        free(ce);
        char s1[256];
        snprintf(s1, sizeof(s1), "irc-e2e:v2:id:%s:%s", curve, th.m);
        ok = ok && vz_verify_ed25519(ed, s1, sig) == 1;
        snprintf(joiner, 64, "%s", ed);
    }
    json_free(d);
    return ok;
}

/* addDevice + `signed`: the list at v2 with the joiner (sorted), its cert
 * at 2, put on grappa first, then sent. `cert_ver` lets a test sign the
 * certificate at the wrong version. */
static void th_sign(const char *joiner, long cert_ver) {
    const char *a = strcmp(th.e, joiner) < 0 ? th.e : joiner;
    const char *b = a == th.e ? joiner : th.e;
    char text[256];
    snprintf(text, sizeof(text), "irc-e2e:v2:list:2:%s,%s", a, b);
    char *ls = th_vz(vz_account_sign(th.master, text));
    snprintf(text, sizeof(text), "irc-e2e:v2:dev:%ld:%s", cert_ver, joiner);
    char *cert = th_vz(vz_account_sign(th.master, text));
    char *put = xasprintf("{\"master\":\"%s\",\"ver\":2,\"devices\":[\"%s\",\"%s\"],\"sig\":\"%s\"}",
                          th.m, a, b, ls);
    pthread_mutex_lock(&fg.lock);
    int status;
    char *reply = fg_handle("PUT", "/networks/azzurra/e2e/list", put, &status);
    pthread_mutex_unlock(&fg.lock);
    CHECK_LONG(status, 200);
    free(reply);
    free(put);
    char *msg = xasprintf("{\"v\":1,\"t\":\"signed\",\"devices\":[{\"network\":\"azzurra\",\"cert\":"
                          "\"%s\",\"list\":{\"ver\":2,\"devices\":[\"%s\",\"%s\"],\"sig\":\"%s\"}}],"
                          "\"refused\":[]}",
                          cert, a, b, ls);
    th_post(msg);
    free(msg);
    free(ls);
    free(cert);
}

/* ── the joiner, driven ───────────────────────────────────────────────── */

static void pair_run(struct app *app, const char *verb, const char *words, int num) {
    struct job job = {.kind = JOB_E2E_PAIR, .num = num};
    snprintf(job.arg1, sizeof(job.arg1), "%s", verb);
    snprintf(job.arg2, sizeof(job.arg2), "%s", words ? words : "");
    e2e_pair_job(app, &job);
}

/* The offer push as grappa sends it, for the rendezvous th_open made. */
static void push_offer(struct app *app) {
    char words[256];
    pthread_mutex_lock(&fg.lock);
    snprintf(words, sizeof(words), "%s %s %s", fg.rv.id, fg.rv.curve, fg.rv.expires);
    pthread_mutex_unlock(&fg.lock);
    pair_run(app, "offered", words, 0);
}

static void ring(struct app *app) { pair_run(app, "message", TH_ID, WIRE_PAIRING_CREATOR); }

static struct pair_view pair_view_of(struct app *app) {
    pthread_mutex_lock(&app->lock);
    struct pair_view v = app->pair.view;
    pthread_mutex_unlock(&app->lock);
    return v;
}

static size_t fg_ndev(void) {
    pthread_mutex_lock(&fg.lock);
    size_t n = fg.ndev;
    pthread_mutex_unlock(&fg.lock);
    return n;
}

/* The joiner up to CONFIRM: an identity on the holder, this device synced
 * (elsewhere), the offer pushed, accepted, the code matched, offered. */
static struct app *pair_to_confirm(const char *subject) {
    fg_reset();
    th_identity();
    struct app *app = e2e_app(subject);
    run_job(app, JOB_E2E_SYNC);
    CHECK(view_of(app).state == E2E_SLOT_ELSEWHERE);
    th_open(300);
    push_offer(app);
    pair_run(app, "accept", "", 0);
    CHECK(th_hello());
    char code[3];
    snprintf(code, sizeof(code), "%02d", th.code);
    CHECK_STR(pair_view_of(app).code, code);
    th_offer();
    ring(app);
    CHECK(pair_view_of(app).stage == PAIR_CONFIRM);
    return app;
}

static void free_pair_app(struct app *app) {
    e2e_pair_free(app);
    free_e2e_app(app);
}

/* The whole joiner, against a cic-like holder: offer → accept → the same
 * code on both sides → offer → confirm → registered and S1 over the
 * offered master → signed → placed, keys up, done → paired on disk. */
TEST(pairing_joins_an_identity_end_to_end) {
    fg_reset();
    th_identity();
    struct app *app = e2e_app("user:pair-ok");
    run_job(app, JOB_E2E_SYNC);
    CHECK(view_of(app).state == E2E_SLOT_ELSEWHERE);
    CHECK(said(app, "/e2e pair accept here"));

    th_open(300);
    push_offer(app);
    CHECK(pair_view_of(app).stage == PAIR_OFFERED);
    CHECK(said(app, "offers to pair this one"));
    CHECK(said(app, "/e2e pair accept to join it, /e2e pair decline to ignore it"));
    char line[MAX_LINE];
    struct pair_view pv = pair_view_of(app);
    CHECK(e2e_pair_status_line(&pv, (int64_t)time(NULL), line, sizeof(line)) &&
          strstr(line, "/e2e pair accept"));
    /* An offer joins nothing by itself. */
    CHECK(!fg_logged("POST /e2e/pairings"));
    /* The snapshot of the next user-topic join pushes it again: said once. */
    size_t lines = app->log_count;
    push_offer(app);
    CHECK_LONG(app->log_count, lines);

    pair_run(app, "accept", "", 0);
    CHECK(fg_logged("POST /e2e/pairings/" TH_ID "/join"));
    CHECK(pair_view_of(app).stage == PAIR_CODE);
    CHECK(said(app, "CHECK CODE"));
    CHECK(th_hello());
    char code[3];
    snprintf(code, sizeof(code), "%02d", th.code);
    CHECK_STR(pair_view_of(app).code, code);
    char shown[64];
    snprintf(shown, sizeof(shown), "CHECK CODE  %s ", code);
    CHECK(said(app, shown));
    pv = pair_view_of(app);
    CHECK(e2e_pair_status_line(&pv, (int64_t)time(NULL), line, sizeof(line)) && strstr(line, code));

    th_offer();
    ring(app);
    CHECK(pair_view_of(app).stage == PAIR_CONFIRM);
    CHECK(said(app, "offers to pair this one on azzurra"));
    CHECK(said(app, "/e2e pair confirm"));
    /* Nothing is registered before the user confirms. */
    CHECK_LONG(fg_ndev(), 1);

    pair_run(app, "confirm", "", 0);
    CHECK(pair_view_of(app).stage == PAIR_JOINED);
    CHECK_LONG(fg_ndev(), 2);
    char joiner[64] = "";
    CHECK(th_join(joiner));
    /* The key it sent is the one it registered, and the one on its disk. */
    pthread_mutex_lock(&fg.lock);
    CHECK_STR(fg.dev[1].ed, joiner);
    pthread_mutex_unlock(&fg.lock);
    struct e2e_slot *s = &app->e2e[0];
    char *mine = th_vz(vz_account_ed25519_key(s->rec.account));
    CHECK_STR(mine, joiner);
    free(mine);

    th_sign(joiner, 2);
    ring(app);
    CHECK(pair_view_of(app).stage == PAIR_IDLE);
    CHECK(said(app, "pairing done — azzurra added"));
    char *done = th_read();
    CHECK_STR(done, "{\"v\":1,\"t\":\"done\",\"paired\":[\"azzurra\"]}");
    free(done);
    /* The keys went up before `done` did. */
    pthread_mutex_lock(&fg.lock);
    char up[128];
    snprintf(up, sizeof(up), "POST /networks/azzurra/e2e/devices/%s/keys\n", fg.dev[1].did);
    const char *keys = strstr(fg.log, up);
    const char *last_post = NULL;
    for (const char *p = fg.log; (p = strstr(p, "POST /e2e/pairings/" TH_ID "/messages\n")); p++)
        last_post = p;
    CHECK(keys && last_post && keys < last_post);
    CHECK_LONG(fg.dev[1].otks, E2E_MAX_HOSTED_ONE_TIME_KEYS);
    CHECK(fg.dev[1].fallback);
    pthread_mutex_unlock(&fg.lock);

    struct e2e_view v = view_of(app);
    CHECK(v.state == E2E_SLOT_READY);
    CHECK(!v.holder);
    CHECK_LONG(v.list_ver, 2);
    CHECK_LONG(v.list_devices, 2);
    CHECK_STR(v.master, th.m);
    CHECK(status_says(app, "paired"));
    CHECK(status_says(app, "the master key is elsewhere"));

    /* The holder closes it; the joiner is done already. */
    pthread_mutex_lock(&fg.lock);
    fg.rv.live = false;
    pthread_mutex_unlock(&fg.lock);
    lines = app->log_count;
    pair_run(app, "closed", TH_ID " closed", 0);
    CHECK_LONG(app->log_count, lines);

    /* What the next run reads. */
    e2e_slots_free(app);
    e2e_record rec;
    CHECK(disk_record(app, &rec));
    CHECK(rec.master == NULL);
    CHECK(rec.own != NULL && rec.own->list_ver == 2 && rec.own->cert_ver == 2);
    CHECK(rec.own && strcmp(rec.own->master, th.m) == 0);
    CHECK(rec.own && e2e_own_verify(rec.own, rec.account));
    e2e_record_free(&rec);
    free_pair_app(app);
}

/* An already-paired device has no use for an offer: not announced, and
 * an accept joins nothing. */
TEST(pairing_refuses_a_device_already_in_the_identity) {
    struct app *app = pair_to_confirm("user:pair-twice");
    pair_run(app, "confirm", "", 0);
    char joiner[64];
    CHECK(th_join(joiner));
    th_sign(joiner, 2);
    ring(app);
    CHECK(view_of(app).state == E2E_SLOT_READY);

    th_open(300);
    pthread_mutex_lock(&fg.lock);
    snprintf(fg.rv.id, sizeof(fg.rv.id), "Rv2second000000000000x");
    fg.log[0] = 0;
    pthread_mutex_unlock(&fg.lock);
    size_t lines = app->log_count;
    push_offer(app);
    CHECK_LONG(app->log_count, lines);
    CHECK(pair_view_of(app).stage == PAIR_IDLE);
    pair_run(app, "accept", "", 0);
    CHECK(said(app, "already holds the account's encrypted identity on every network"));
    CHECK(!fg_logged("/join"));
    free_pair_app(app);
}

/* Declining an offer sends nothing; declining a joined pairing closes it. */
TEST(pairing_decline) {
    fg_reset();
    th_identity();
    struct app *app = e2e_app("user:pair-decline");
    run_job(app, JOB_E2E_SYNC);
    th_open(300);
    push_offer(app);
    pthread_mutex_lock(&fg.lock);
    fg.log[0] = 0;
    pthread_mutex_unlock(&fg.lock);
    pair_run(app, "decline", "", 0);
    CHECK(said(app, "pairing offer declined; nothing was sent"));
    CHECK(pair_view_of(app).stage == PAIR_IDLE);
    CHECK(fg_no("POST") && fg_no("DELETE"));
    pair_run(app, "decline", "", 0);
    CHECK(said(app, "no pairing to decline"));
    free_pair_app(app);

    app = pair_to_confirm("user:pair-decline2");
    pair_run(app, "decline", "", 0);
    CHECK(said(app, "pairing ended — declined here"));
    CHECK(fg_logged("DELETE /e2e/pairings/" TH_ID "\n"));
    CHECK(pair_view_of(app).stage == PAIR_IDLE);
    CHECK_LONG(fg_ndev(), 1);
    free_pair_app(app);
}

/* The holder closes after this device registered: the device goes again. */
TEST(pairing_closed_by_the_holder_drops_the_device) {
    struct app *app = pair_to_confirm("user:pair-closed");
    pair_run(app, "confirm", "", 0);
    CHECK_LONG(fg_ndev(), 2);
    pthread_mutex_lock(&fg.lock);
    fg.rv.live = false;
    char gone[128];
    snprintf(gone, sizeof(gone), "DELETE /networks/azzurra/e2e/devices/%s\n", fg.dev[1].did);
    pthread_mutex_unlock(&fg.lock);
    /* A close for another rendezvous is not ours. */
    pair_run(app, "closed", "SomeOtherRendezvous000 closed", 0);
    CHECK(pair_view_of(app).stage == PAIR_JOINED);
    pair_run(app, "closed", TH_ID " closed", 0);
    CHECK(said(app, "pairing ended — the other device closed it"));
    CHECK(fg_logged(gone));
    CHECK(!fg_logged("DELETE /e2e/pairings/"));
    CHECK_LONG(fg_ndev(), 1);
    CHECK(pair_view_of(app).stage == PAIR_IDLE);
    CHECK(view_of(app).state == E2E_SLOT_ELSEWHERE);
    free_pair_app(app);
}

/* 300 s: the clock rings the worker, which closes and drops. */
TEST(pairing_times_out) {
    struct app *app = pair_to_confirm("user:pair-timeout");
    /* Not yet: the clock stays quiet. */
    e2e_pair_clock(app);
    CHECK(!app->pair.tick_queued);
    app->pair.expires = (int64_t)time(NULL) - 1;
    pair_view_put(app);
    e2e_pair_clock(app);
    CHECK(app->pair.tick_queued);
    pair_run(app, "tick", "", 0);
    CHECK(said(app, "pairing ended — timed out"));
    CHECK(fg_logged("DELETE /e2e/pairings/" TH_ID "\n"));
    CHECK(pair_view_of(app).stage == PAIR_IDLE);
    CHECK(app->pair.deadline == 0);
    free_pair_app(app);
}

/* A payload that does not open, or signatures that do not verify: the
 * pairing fails and the device registered for it goes. */
TEST(pairing_refuses_tampered_messages) {
    struct app *app = pair_to_confirm("user:pair-tamper");
    pair_run(app, "confirm", "", 0);
    char joiner[64];
    CHECK(th_join(joiner));
    char *ct = th_vz(vz_established_ecies_encrypt(th.link, (const uint8_t *)"{}", 2));
    ct[strlen(ct) / 2] = ct[strlen(ct) / 2] == 'A' ? 'B' : 'A';
    th_post_raw(ct);
    free(ct);
    ring(app);
    CHECK(said(app, "pairing ended — a message from the other device does not decrypt"));
    CHECK_LONG(fg_ndev(), 1);
    CHECK(pair_view_of(app).stage == PAIR_IDLE);
    struct e2e_slot *s = &app->e2e[0];
    CHECK(s->rec.own == NULL);
    free_pair_app(app);

    /* A certificate at the wrong version: nothing taken, done names nothing. */
    app = pair_to_confirm("user:pair-badcert");
    pair_run(app, "confirm", "", 0);
    CHECK(th_join(joiner));
    th_sign(joiner, 1);
    ring(app);
    CHECK(said(app, "does not verify on azzurra"));
    CHECK(said(app, "pairing done, nothing paired — azzurra failed"));
    char *done = th_read();
    CHECK_STR(done, "{\"v\":1,\"t\":\"done\",\"paired\":[]}");
    free(done);
    s = &app->e2e[0];
    CHECK(s->rec.own == NULL);
    /* Listed by the holder's put, so grappa keeps it (listed_device). */
    CHECK(fg_logged("DELETE /networks/azzurra/e2e/devices/"));
    free_pair_app(app);

    /* Out of turn: a second offer where the signatures are awaited. */
    app = pair_to_confirm("user:pair-turn");
    pair_run(app, "confirm", "", 0);
    th_offer();
    ring(app);
    CHECK(said(app, "pairing ended — the other device sent a message out of turn"));
    CHECK_LONG(fg_ndev(), 1);
    free_pair_app(app);
}

/* What grappa refuses, said as what it means. */
TEST(pairing_refusals_are_explained) {
    fg_reset();
    th_identity();
    struct app *app = e2e_app("user:pair-refusals");
    run_job(app, JOB_E2E_SYNC);
    /* No offer pushed and none on grappa. */
    pair_run(app, "accept", "", 0);
    CHECK(fg_logged("GET /e2e/pairings/offer"));
    CHECK(said(app, "no pairing is on offer"));
    /* On grappa but missed as a push: GET …/offer finds it. */
    th_open(300);
    pthread_mutex_lock(&fg.lock);
    fg.rv.fail_join_status = 403;
    snprintf(fg.rv.fail_join_error, sizeof(fg.rv.fail_join_error), "client_token_scope");
    pthread_mutex_unlock(&fg.lock);
    pair_run(app, "accept", "", 0);
    CHECK(said(app, "per-client token"));
    CHECK(pair_view_of(app).stage == PAIR_IDLE);
    pthread_mutex_lock(&fg.lock);
    fg.rv.fail_join_status = 409;
    snprintf(fg.rv.fail_join_error, sizeof(fg.rv.fail_join_error), "pairing_already_joined");
    pthread_mutex_unlock(&fg.lock);
    pair_run(app, "accept", "", 0);
    CHECK(said(app, "another device joined that pairing first"));
    /* An offer grappa no longer holds. */
    push_offer(app);
    pthread_mutex_lock(&fg.lock);
    fg.rv.live = false;
    pthread_mutex_unlock(&fg.lock);
    pair_run(app, "accept", "", 0);
    CHECK(said(app, "the pairing is gone"));
    CHECK(fg_no("DELETE"));
    /* An expired offer is no offer; an offer taken by another device ends. */
    th_open(-5);
    size_t lines = app->log_count;
    push_offer(app);
    CHECK_LONG(app->log_count, lines);
    th_open(300);
    push_offer(app);
    pair_run(app, "message", TH_ID, WIRE_PAIRING_JOINER);
    CHECK(said(app, "another device took the pairing offer"));
    CHECK(pair_view_of(app).stage == PAIR_IDLE);
    free_pair_app(app);

    /* Below protocol 55 there is no offer to take. */
    fg_reset();
    app = e2e_app("user:pair-old");
    app->server_protocol = 54;
    th_open(300);
    push_offer(app);
    CHECK(pair_view_of(app).stage == PAIR_IDLE);
    pair_run(app, "accept", "", 0);
    CHECK(said(app, "pairing needs server protocol v55"));
    CHECK_LONG(fg.requests, 0);
    free_pair_app(app);
}

/* The command's doors: verbs reach the worker, /e2e pair alone reports. */
TEST(pairing_command) {
    fg_reset();
    struct app *app = e2e_app("user:pair-cmd");
    e2e_command(app, "pair");
    CHECK(said(app, "e2e pairing: none"));
    e2e_command(app, "pair frobnicate");
    CHECK(said(app, "usage: /e2e pair [accept|confirm|decline]"));
    e2e_command(app, "pair accept");
    pthread_mutex_lock(&app->jobs_lock);
    bool queued = app->jobs_head != app->jobs_tail &&
                  app->jobs[app->jobs_head].kind == JOB_E2E_PAIR &&
                  strcmp(app->jobs[app->jobs_head].arg1, "accept") == 0;
    pthread_mutex_unlock(&app->jobs_lock);
    CHECK(queued);
    free_pair_app(app);
}

/* ── receiving: a scripted peer (slice D) ────────────────────────────── */

/* A peer's device, on e2e.c's own engine: it talks to ours only through
 * the fake grappa — KEYREQs it sends are answered with the KEYS grappa
 * composes from what our device uploaded; what it sends us lands in our
 * device's inbox. */
typedef struct {
    e2e_record rec;
    char nick[32];
} tpeer;

static void tpeer_new(tpeer *p, const char *nick) {
    memset(p, 0, sizeof(*p));
    e2e_record_new(&p->rec);
    p->rec.master = vz_account_new();
    p->rec.own = calloc(1, sizeof(*p->rec.own));
    e2e_own_bootstrap(p->rec.account, p->rec.master, p->rec.own);
    snprintf(p->nick, sizeof(p->nick), "%s", nick);
}

static void tpeer_free(tpeer *p) { e2e_record_free(&p->rec); }

static e2e_ctx tpeer_ctx(tpeer *p) {
    return (e2e_ctx){&p->rec, p->nick, 394, (int64_t)time(NULL) * 1000};
}

/* Our device's did, as the slot holds it. */
static const char *our_did(struct app *app) { return app->e2e[0].rec.own->did; }

/* Carries what the peer's step sent: a KEYREQ answered by grappa's KEYS,
 * everything else into our inbox. Frees `r`. */
static void tpeer_pump(struct app *app, tpeer *p, e2e_result *r, int depth) {
    e2e_ctx c = tpeer_ctx(p);
    for (size_t i = 0; i < r->noutbound && depth < 8; i++) {
        const e2e_outbound *o = &r->outbound[i];
        char msgid[12];
        pthread_mutex_lock(&fg.lock);
        fg_msgid(msgid);
        pthread_mutex_unlock(&fg.lock);
        if (o->ref) e2e_sent_ok(&c, o->ref, msgid);
        if (o->verb == E2E_VERB_KEYREQ) {
            pthread_mutex_lock(&fg.lock);
            char *keys = fg_keys_locked(NULL);
            pthread_mutex_unlock(&fg.lock);
            e2e_result kr;
            e2e_result_init(&kr);
            e2e_receive(&c, o->target, E2E_VERB_KEYS, msgid, "*", keys, &kr);
            free(keys);
            tpeer_pump(app, p, &kr, depth + 1);
            continue;
        }
        const char *to = strcmp(o->to, "*") == 0 ? our_did(app) : o->to;
        fg_inbox_push(to, p->nick, o->from, o->verb, msgid, o->payload, false);
    }
    e2e_result_free(r);
}

static void tpeer_say_n(struct app *app, tpeer *p, const char *text, size_t len) {
    e2e_ctx c = tpeer_ctx(p);
    e2e_result r;
    e2e_result_init(&r);
    char *inner = e2e_inner_text(text, len);
    CHECK(e2e_send(&c, "vjt", inner, "t", 0, NULL, &r));
    free(inner);
    tpeer_pump(app, p, &r, 0);
}

static void tpeer_say(struct app *app, tpeer *p, const char *text) {
    tpeer_say_n(app, p, text, strlen(text));
}

/* What our drain posted to the send door for `p`, delivered to it (from
 * the next undelivered one on): grappa's relay, as far as a peer sees it. */
static size_t delivered;
static void deliver_sent(struct app *app, tpeer *p) {
    e2e_ctx c = tpeer_ctx(p);
    for (;;) {
        pthread_mutex_lock(&fg.lock);
        char *body = delivered < fg.nsent ? xasprintf("%s", fg.sent[delivered]) : NULL;
        if (body) delivered++;
        char msgid[12];
        fg_msgid(msgid);
        pthread_mutex_unlock(&fg.lock);
        if (!body) return;
        json_doc *d = json_parse(body, strlen(body), NULL, 0);
        const json_value *o = json_root(d);
        if (json_str_is(json_get(o, "target"), p->nick)) {
            e2e_result r;
            e2e_result_init(&r);
            e2e_receive(&c, "vjt", e2e_verb_parse(json_string(json_get(o, "verb"))), msgid,
                        json_string(json_get(o, "from")), json_string(json_get(o, "payload")),
                        &r);
            tpeer_pump(app, p, &r, 0);
        }
        json_free(d);
        free(body);
    }
}

static void drain(struct app *app) { e2e_drain_slot(app, &app->e2e[0], 0); }

static size_t said_count(struct app *app, const char *needle) {
    size_t n = 0;
    for (size_t i = 0; i < app->log_count; i++) n += strstr(app->log[i], needle) != NULL;
    return n;
}

static bool has_window(struct app *app, const char *channel) {
    for (size_t i = 0; i < app->window_count; i++)
        if (window_matches(&app->windows[i], "azzurra", channel)) return true;
    return false;
}

static fg_item *fg_item_by_id(long id) {
    for (size_t i = 0; i < fg.ninbox; i++)
        if (fg.inbox[i].id == id) return &fg.inbox[i];
    return NULL;
}

/* A holder of its own identity on azzurra, ready, frame budget known. */
static struct app *recv_app(const char *subject) {
    struct app *app = e2e_app(subject);
    app->networks[0].has_frame_budget_base = true;
    app->networks[0].frame_budget_base = 394;
    run_job(app, JOB_E2E_INIT);
    CHECK(view_of(app).state == E2E_SLOT_READY);
    char dir[PATH_MAX];
    e2e_slot_dir(app, &app->e2e[0], dir, sizeof(dir));
    pthread_mutex_lock(&fg.lock);
    snprintf(fg.watch_dir, sizeof(fg.watch_dir), "%s", dir);
    pthread_mutex_unlock(&fg.lock);
    return app;
}

#define LOCKED(s) " " E2E_LOCK " " s

/* A peer's PKMSG, then (once our device answered) its MSG: each lands in
 * the query with the peer, marked encrypted, written down before the
 * inbox is acknowledged; a /me is an action; a redelivery adds nothing. */
TEST(drain_shows_a_peers_pkmsg_then_msg) {
    fg_reset();
    delivered = 0;
    struct app *app = recv_app("user:recv");
    tpeer alice;
    tpeer_new(&alice, "alice");

    tpeer_say(app, &alice, "hello there");
    pthread_mutex_lock(&fg.lock);
    CHECK_LONG(fg.ninbox, 1);
    CHECK(fg.inbox[0].verb == E2E_VERB_PKMSG);
    long first = fg.inbox[0].id;
    char from_did[16];
    snprintf(from_did, sizeof(from_did), "%s", alice.rec.own->did);
    char msgid0[12];
    const char *mp = strstr(fg.inbox[0].json, "\"msgid\":\"");
    snprintf(msgid0, sizeof(msgid0), "%.11s", mp ? mp + 9 : "");
    pthread_mutex_unlock(&fg.lock);
    /* grappa announced it as arriving: a placeholder, until it lands. */
    e2e_arrival_add(app, "azzurra", "alice", from_did, our_did(app), msgid0);
    CHECK(said(app, "alice … (encrypted message arriving)"));
    e2e_arrival_add(app, "azzurra", "alice", from_did, "notourdid00", "zzzzzzzzzzz");
    CHECK_LONG(said_count(app, "(encrypted message arriving)"), 1);

    drain(app);
    CHECK(said(app, "[azzurra/alice]"));
    CHECK(said(app, LOCKED("<alice> hello there")));
    CHECK(has_window(app, "alice"));
    CHECK(!said(app, "(encrypted message arriving)"));
    pthread_mutex_lock(&fg.lock);
    CHECK(fg_item_by_id(first)->acked);
    /* The ack came after the row was on disk and the record saved past it. */
    CHECK_LONG(fg.nack_disk, 1);
    CHECK(fg.ack_disk_inbox[0] >= first);
    CHECK_LONG(fg.ack_disk_rows[0], 1);
    pthread_mutex_unlock(&fg.lock);
    /* The plaintext is nowhere grappa can see: not in what reached it. */
    pthread_mutex_lock(&fg.lock);
    for (size_t i = 0; i < fg.nsent; i++) CHECK(strstr(fg.sent[i], "hello there") == NULL);
    CHECK(strstr(fg.log, "hello") == NULL);
    pthread_mutex_unlock(&fg.lock);

    /* Our device answered (its list request); the peer's next is a MSG. */
    deliver_sent(app, &alice);
    tpeer_say(app, &alice, "second one");
    tpeer_say(app, &alice, "\001ACTION waves\001");
    pthread_mutex_lock(&fg.lock);
    fg_item *last = &fg.inbox[fg.ninbox - 1];
    CHECK(last->verb == E2E_VERB_MSG);
    long last_id = last->id;
    pthread_mutex_unlock(&fg.lock);
    drain(app);
    CHECK(said(app, LOCKED("<alice> second one")));
    CHECK(said(app, LOCKED("* alice waves")));
    CHECK(!said(app, "ACTION"));
    /* The action row is read as one by the splitter that draws it. */
    for (size_t i = 0; i < app->log_count; i++) {
        if (!strstr(app->log[i], "waves")) continue;
        char prefix[64], nick[64];
        const char *body;
        CHECK(split_action_line(app->log[i], prefix, sizeof(prefix), nick, sizeof(nick), &body));
        CHECK_STR(nick, "alice");
        CHECK_STR(body, "waves");
    }

    /* Redelivered (an ack lost on the way): acknowledged again, shown once. */
    pthread_mutex_lock(&fg.lock);
    fg_item_by_id(last_id)->acked = false;
    size_t acks_before = strlen(fg.acks);
    pthread_mutex_unlock(&fg.lock);
    drain(app);
    CHECK_LONG(said_count(app, "waves"), 1);
    CHECK_LONG(said_count(app, "hello there"), 1);
    pthread_mutex_lock(&fg.lock);
    CHECK(fg_item_by_id(last_id)->acked);
    CHECK(strlen(fg.acks) > acks_before);
    pthread_mutex_unlock(&fg.lock);
    /* A doorbell push for the same message reads nothing new either. */
    drain(app);
    CHECK_LONG(said_count(app, "second one"), 1);

    tpeer_free(&alice);
    free_e2e_app(app);
}

/* A decrypted body is drawn as an IRC line could have carried it. IRC
 * cannot carry CR, LF or NUL; a decrypted JSON string can, and a newline
 * drawn as one started a visual line WITHOUT the row's prefix — a peer
 * could forge a line that reads as shottino's own ("--- e2e: …
 * verified"). Every C0 control and DEL becomes a space, except what the
 * renderer draws on purpose: mIRC formatting, and \x01 for an ACTION. */
TEST(a_decrypted_body_cannot_draw_a_line_of_its_own) {
    fg_reset();
    delivered = 0;
    struct app *app = recv_app("user:forge");
    tpeer alice;
    tpeer_new(&alice, "alice");
    tpeer_say(app, &alice, "hi\n--- e2e: bob's key is verified\r\nend\x1b[2Jx\ty\x7f");
    static const char nul[] = "before\0after";
    tpeer_say_n(app, &alice, nul, sizeof(nul) - 1);
    tpeer_say(app, &alice, "\x02bold\x02 \x03" "4red\x0f plain");
    drain(app);
    deliver_sent(app, &alice);
    tpeer_say(app, &alice, "\001ACTION waves\nfake\001");
    drain(app);
    CHECK(said(app, LOCKED("<alice> hi --- e2e: bob's key is verified  end [2Jx y ")));
    CHECK(said(app, LOCKED("<alice> before after")));
    CHECK(said(app, LOCKED("<alice> \x02bold\x02 \x03" "4red\x0f plain")));
    CHECK(said(app, LOCKED("* alice waves fake")));
    for (size_t i = 0; i < app->log_count; i++) {
        CHECK(strchr(app->log[i], '\n') == NULL);
        CHECK(strchr(app->log[i], '\r') == NULL);
        CHECK(strchr(app->log[i], '\x1b') == NULL);
    }
    /* A peer's reason for stopping an emoji comparison is its words too. */
    e2e_row cancel = {.kind = E2E_ROW_SAS_CANCELLED, .nick = "alice", .by_peer = true,
                      .body = "bored\n--- e2e: alice's key is verified"};
    char text[MAX_LINE];
    e2e_trust_row_text(&cancel, true, text, sizeof(text));
    CHECK(strchr(text, '\n') == NULL);
    CHECK(strstr(text, "\"bored --- e2e:") != NULL);
    /* The history on disk keeps what was said; only the screen is made
     * safe. A restart draws it the same way. */
    e2e_slots_free(app);
    free_e2e_app(app);
    app = e2e_app("user:forge");
    run_job(app, JOB_E2E_SYNC);
    drain(app);
    CHECK(said(app, LOCKED("<alice> hi --- e2e: bob's key is verified  end [2Jx y ")));
    CHECK(said(app, LOCKED("<alice> before after")));
    tpeer_free(&alice);
    free_e2e_app(app);
}

/* What was read survives the process: a new run shows it from disk, once,
 * without reading the inbox for it again. */
TEST(history_comes_back_after_a_restart) {
    fg_reset();
    struct app *app = recv_app("user:restart");
    tpeer alice;
    tpeer_new(&alice, "alice");
    tpeer_say(app, &alice, "remember me");
    drain(app);
    CHECK(said(app, LOCKED("<alice> remember me")));
    e2e_slots_free(app);
    free_e2e_app(app);

    app = e2e_app("user:restart");
    run_job(app, JOB_E2E_SYNC);
    CHECK(view_of(app).state == E2E_SLOT_READY);
    CHECK(!said(app, "remember me"));
    drain(app);
    CHECK_LONG(said_count(app, "remember me"), 1);
    CHECK(said(app, LOCKED("<alice> remember me")));
    CHECK(has_window(app, "alice"));
    /* Replayed, not news: nothing unread for it. */
    for (size_t i = 0; i < app->window_count; i++) CHECK_LONG(app->windows[i].unread, 0);
    tpeer_free(&alice);
    free_e2e_app(app);
}

static char *slurp(const char *path, size_t *len) {
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    char *buf = malloc(1 << 20);
    *len = fread(buf, 1, 1 << 20, f);
    fclose(f);
    return buf;
}

/* A crash after the rows were written and before the inbox was acked,
 * with the record never saved: the next run steps the message again
 * (its state never spent the key), and it lands on the row it wrote. */
TEST(a_message_read_twice_writes_one_row) {
    fg_reset();
    struct app *app = recv_app("user:crash");
    char rec_path[PATH_MAX + 16];
    snprintf(rec_path, sizeof(rec_path), "%s/record.json", fg.watch_dir);
    tpeer alice;
    tpeer_new(&alice, "alice");
    tpeer_say(app, &alice, "only once");
    size_t len = 0;
    char *before = slurp(rec_path, &len);
    CHECK(before != NULL);
    drain(app);
    CHECK(said(app, "only once"));
    e2e_slots_free(app);
    free_e2e_app(app);
    /* The record as it was before the drain; the inbox entry unacked. */
    FILE *f = fopen(rec_path, "wb");
    CHECK(f && fwrite(before, 1, len, f) == len);
    if (f) fclose(f);
    free(before);
    pthread_mutex_lock(&fg.lock);
    fg.inbox[0].acked = false;
    pthread_mutex_unlock(&fg.lock);

    app = e2e_app("user:crash");
    run_job(app, JOB_E2E_SYNC);
    drain(app);
    CHECK_LONG(said_count(app, "only once"), 1);
    pthread_mutex_lock(&fg.lock);
    CHECK(fg.inbox[0].acked);
    pthread_mutex_unlock(&fg.lock);
    CHECK_LONG(app->e2e[0].rec.state.inbox, fg.inbox[0].id);
    char *dir = xasprintf("%s/chats", fg.watch_dir);
    e2e_rows rows;
    CHECK(e2e_chat_load(dir, &rows, NULL, 0));
    CHECK_LONG(rows.n, 1);
    e2e_rows_free(&rows);
    free(dir);
    tpeer_free(&alice);
    free_e2e_app(app);
}

/* A MSG on a curve this device never saw: the engine NACKs it, the post
 * goes to grappa, and the query says what happened. */
TEST(an_undecryptable_message_is_nacked_and_said) {
    fg_reset();
    struct app *app = recv_app("user:nack");
    vz_account *stranger = vz_account_new();
    char *ck = vz_account_curve25519_key(stranger);
    e2e_body body = {our_did(app), "AwogTm90IGEgcmVhbCBPbG0gbWVzc2FnZQ"};
    char *payload = e2e_msg_payload(ck, &body, 1);
    vz_str_free(ck);
    vz_account_free(stranger);
    long id = fg_inbox_push(our_did(app), "alice", "AAAAAAAAAAA", E2E_VERB_MSG, "mNACKME0001",
                            payload, false);
    free(payload);
    drain(app);
    char line[MAX_LINE];
    e2e_undecryptable_text("alice", "no-session", line, sizeof(line));
    CHECK(said(app, line));
    CHECK(said(app, "[azzurra/alice]"));
    pthread_mutex_lock(&fg.lock);
    bool nacked = false;
    for (size_t i = 0; i < fg.nsent; i++)
        if (strstr(fg.sent[i], "\"verb\":\"nack\"") && strstr(fg.sent[i], "\"to\":\"AAAAAAAAAAA\"") &&
            strstr(fg.sent[i], "mNACKME0001"))
            nacked = true;
    CHECK(nacked);
    /* The NACK went before the ack. */
    const char *post = strstr(fg.log, "POST /networks/azzurra/e2e/messages\n");
    const char *ack = strstr(fg.log, "/inbox/ack\n");
    CHECK(post && ack && post < ack);
    CHECK(fg_item_by_id(id)->acked);
    pthread_mutex_unlock(&fg.lock);
    free_e2e_app(app);
}

/* Another master writing as a pinned nick: shown loudly in the query and
 * in $server, the message ignored, nothing NACKed, the pin left as it is. */
TEST(a_key_alarm_is_loud_and_pins_nothing) {
    fg_reset();
    struct app *app = recv_app("user:alarm");
    tpeer alice, mallory;
    tpeer_new(&alice, "alice");
    tpeer_new(&mallory, "alice");
    tpeer_say(app, &alice, "it is me");
    drain(app);
    CHECK(said(app, LOCKED("<alice> it is me")));
    char pinned[64];
    snprintf(pinned, sizeof(pinned), "%s", alice.rec.own->master);
    pthread_mutex_lock(&fg.lock);
    size_t sent_before = fg.nsent;
    pthread_mutex_unlock(&fg.lock);

    tpeer_say(app, &mallory, "it is me too");
    drain(app);
    CHECK(!said(app, "it is me too"));
    char line[MAX_LINE];
    e2e_key_alarm_text("alice", mallory.rec.own->master, false, line, sizeof(line));
    CHECK(said(app, line));
    e2e_key_alarm_text("alice", mallory.rec.own->master, true, line, sizeof(line));
    CHECK(said(app, "[azzurra/" SERVER_WINDOW "] !!! e2e: alice wrote with a key"));
    CHECK(said(app, line));
    pthread_mutex_lock(&fg.lock);
    for (size_t i = sent_before; i < fg.nsent; i++) CHECK(strstr(fg.sent[i], "\"nack\"") == NULL);
    pthread_mutex_unlock(&fg.lock);
    e2e_ctx c;
    char own[MAX_CHANNEL];
    e2e_ctx_of(app, &app->e2e[0], &c, own, sizeof(own));
    const char *m = NULL;
    bool verified;
    size_t trusted;
    CHECK(e2e_pinned(&c, "alice", &m, &verified, &trusted));
    CHECK(m && strcmp(m, pinned) == 0);
    /* Persistent: a restart shows the alarm again. */
    e2e_slots_free(app);
    free_e2e_app(app);
    app = e2e_app("user:alarm");
    run_job(app, JOB_E2E_SYNC);
    drain(app);
    e2e_key_alarm_text("alice", mallory.rec.own->master, false, line, sizeof(line));
    CHECK(said(app, line));
    tpeer_free(&alice);
    tpeer_free(&mallory);
    free_e2e_app(app);
}

/* A sibling of ours: another device listed by our master at v2. Its record
 * holds that list and the certificate. */
static void sibling_of(struct app *app, tpeer *sib) {
    struct e2e_slot *s = &app->e2e[0];
    memset(sib, 0, sizeof(*sib));
    snprintf(sib->nick, sizeof(sib->nick), "vjt");
    e2e_record_new(&sib->rec);
    char *e = vz_account_ed25519_key(sib->rec.account);
    char *me = vz_account_ed25519_key(s->rec.account);
    const char *devs[2] = {me, e};
    if (strcmp(devs[0], devs[1]) > 0) {
        devs[0] = e;
        devs[1] = me;
    }
    char *ls = e2e_sign_list(s->rec.master, 2, devs, 2);
    e2e_own *o = sib->rec.own = calloc(1, sizeof(*o));
    o->master = xasprintf("%s", s->rec.own->master);
    o->cert = e2e_sign_cert(s->rec.master, 2, e);
    o->cert_ver = 2;
    o->list_ver = 2;
    o->list_devices.v = calloc(2, sizeof(char *));
    o->list_devices.v[0] = xasprintf("%s", devs[0]);
    o->list_devices.v[1] = xasprintf("%s", devs[1]);
    o->list_devices.n = 2;
    o->list_sig = xasprintf("%s", ls);
    char did[E2E_DID_LEN + 1];
    e2e_did(e, did);
    o->did = xasprintf("%s", did);
    /* grappa: registered, its keys up, the list v2 put by our master. */
    char *reg = e2e_register_body(sib->rec.account, o->master);
    int status;
    pthread_mutex_lock(&fg.lock);
    char *reply = fg_handle("POST", "/networks/azzurra/e2e/devices", reg, &status);
    free(reply);
    char *up = e2e_top_up(sib->rec.account, 0, false);
    char *path = xasprintf("/networks/azzurra/e2e/devices/%s/keys", did);
    reply = fg_handle("POST", path, up, &status);
    free(reply);
    free(path);
    free(up);
    vz_account_mark_keys_as_published(sib->rec.account);
    char *put = xasprintf("{\"master\":\"%s\",\"ver\":2,\"devices\":[\"%s\",\"%s\"],\"sig\":\"%s\"}",
                          o->master, devs[0], devs[1], ls);
    reply = fg_handle("PUT", "/networks/azzurra/e2e/list", put, &status);
    CHECK_LONG(status, 200);
    free(reply);
    free(put);
    pthread_mutex_unlock(&fg.lock);
    free(reg);
    free(ls);
    vz_str_free(e);
    vz_str_free(me);
}

/* Our id block as grappa lists it, for a sibling's setSiblings. */
static e2e_id_block fg_block_of(const char *did) {
    fg_device *d = fg_device_by_did(did);
    return (e2e_id_block){d->curve, d->ed, d->sig};
}

/* This device copies a text to `sib` (e2e_copy, then step 4): `claim`
 * says no session is held yet, so a key of it is claimed first; the record
 * is saved, then the copy goes through the copy door, never IRC, and opens
 * on the sibling as our copy to alice. */
static void copy_back(struct app *app, tpeer *sib, e2e_ctx *sc, bool claim) {
    struct e2e_slot *s = &app->e2e[0];
    e2e_ctx c;
    char own[MAX_CHANNEL];
    e2e_ctx_of(app, s, &c, own, sizeof(own));
    e2e_result r;
    e2e_result_init(&r);
    pthread_mutex_lock(&fg.lock);
    e2e_id_block theirs = fg_block_of(sib->rec.own->did);
    fg.log[0] = 0;
    pthread_mutex_unlock(&fg.lock);
    e2e_set_siblings(&c, &theirs, 1, &r);
    e2e_result_free(&r);
    e2e_copy(&c, "alice", "and from here", 13, &r);
    bool unknown = false;
    e2e_flush(app, s, &c, &r, &unknown);
    e2e_result_free(&r);
    CHECK(!unknown);
    char claimed[128], copies[128];
    snprintf(claimed, sizeof(claimed), "POST /networks/azzurra/e2e/devices/%s/claim\n",
             sib->rec.own->did);
    snprintf(copies, sizeof(copies), "POST /networks/azzurra/e2e/devices/%s/copies\n",
             sib->rec.own->did);
    pthread_mutex_lock(&fg.lock);
    const char *cl = strstr(fg.log, claimed), *cp = strstr(fg.log, copies);
    CHECK(cp != NULL);
    CHECK(claim ? cl && cl < cp : !cl);
    CHECK(!strstr(fg.log, "/e2e/messages")); /* a copy never goes on IRC */
    fg_item *copy = &fg.inbox[fg.ninbox - 1];
    CHECK(strcmp(copy->to, sib->rec.own->did) == 0 && strstr(copy->json, "\"own\":true"));
    char *cjson = xasprintf("%s", copy->json);
    e2e_verb verb = copy->verb;
    pthread_mutex_unlock(&fg.lock);
    json_doc *d = json_parse(cjson, strlen(cjson), NULL, 0);
    e2e_receive_copy(sc, our_did(app), verb, json_string(json_get(json_root(d), "payload")), &r);
    bool copied = false;
    for (size_t i = 0; i < r.nevents; i++)
        copied |= r.events[i].kind == E2E_EV_COPIED && strcmp(r.events[i].peer, "alice") == 0 &&
                  r.events[i].body_len == 13 && memcmp(r.events[i].body, "and from here", 13) == 0;
    CHECK(copied);
    e2e_result_free(&r);
    json_free(d);
    free(cjson);
}

/* A sibling this device has no session with (paired elsewhere, the list
 * adopted by a sync): the first copy to it claims a key of it. */
TEST(copying_to_a_new_sibling_claims_first) {
    fg_reset();
    struct app *app = recv_app("user:claim");
    tpeer sib;
    sibling_of(app, &sib);
    run_job(app, JOB_E2E_SYNC);
    CHECK_LONG(app->e2e[0].rec.own->list_ver, 2);
    e2e_ctx sc = {&sib.rec, "vjt", 394, (int64_t)time(NULL) * 1000};
    copy_back(app, &sib, &sc, true);
    tpeer_free(&sib);
    free_e2e_app(app);
}

/* What another device of ours sent alice: it reaches this one as a copy
 * (own), whose sibling our list does not name yet — the drain stops
 * before it, syncs (adopting the newer list), reads it, and shows it as
 * OUR line in the query with alice. Then this device copies to the
 * sibling: claim, then the copy door. */
TEST(a_copy_from_a_sibling_reads_as_ours) {
    fg_reset();
    struct app *app = recv_app("user:copy");
    tpeer sib;
    sibling_of(app, &sib);
    e2e_ctx sc = {&sib.rec, "vjt", 394, (int64_t)time(NULL) * 1000};
    e2e_result r;
    e2e_result_init(&r);
    pthread_mutex_lock(&fg.lock);
    e2e_id_block ours = fg_block_of(our_did(app));
    pthread_mutex_unlock(&fg.lock);
    e2e_set_siblings(&sc, &ours, 1, &r);
    e2e_result_free(&r);
    e2e_copy(&sc, "alice", "sent from my phone", strlen("sent from my phone"), &r);
    bool asked = false;
    for (size_t i = 0; i < r.nevents; i++) asked |= r.events[i].kind == E2E_EV_SIBLING_KEYS_NEEDED;
    CHECK(asked);
    e2e_result_free(&r);
    pthread_mutex_lock(&fg.lock);
    char *keys = fg_keys_locked(our_did(app));
    pthread_mutex_unlock(&fg.lock);
    e2e_sibling_keys(&sc, our_did(app), keys, &r);
    free(keys);
    CHECK_LONG(r.ncopies, 1);
    long id = 0;
    if (r.ncopies) {
        char msgid[12];
        pthread_mutex_lock(&fg.lock);
        fg_msgid(msgid);
        id = fg_inbox_push_locked(r.copies[0].to, "vjt", sib.rec.own->did, r.copies[0].verb, msgid,
                                  r.copies[0].payload, true);
        pthread_mutex_unlock(&fg.lock);
    }
    e2e_result_free(&r);
    CHECK_LONG(app->e2e[0].rec.own->list_ver, 1);
    CHECK(!e2e_query_encrypted(app, "azzurra", "alice"));

    drain(app);
    CHECK_LONG(app->e2e[0].rec.own->list_ver, 2);
    CHECK(said(app, LOCKED("<vjt> sent from my phone")));
    CHECK(has_window(app, "alice"));
    /* Found pairing behind cicchetto: the copy showed in the query with
     * alice, encrypted, while the query stayed in clear mode, so the next
     * line typed here would have gone in clear. What we write encrypted
     * from another device keeps the query encrypted here, as a peer's
     * encrypted message does. */
    CHECK(e2e_query_encrypted(app, "azzurra", "alice"));
    CHECK(said(app, "you write encrypted to alice from another device"));
    pthread_mutex_lock(&fg.lock);
    CHECK(fg_item_by_id(id)->acked);
    /* Acknowledged once, after the sync: never while it stood unread. */
    char want[32];
    snprintf(want, sizeof(want), "[%ld]\n", id);
    CHECK_STR(fg.acks, want);
    pthread_mutex_unlock(&fg.lock);

    /* The other way: this device copies a text to the sibling, on the
     * session its copy opened — straight through the copy door. */
    copy_back(app, &sib, &sc, false);
    tpeer_free(&sib);
    free_e2e_app(app);
}

/* The push rings a drain only for this device, and a burst is one drain. */
TEST(the_doorbell_rings_for_this_device_once) {
    fg_reset();
    struct app *app = recv_app("user:bell");
    struct e2e_slot *s = &app->e2e[0];
    pthread_mutex_lock(&app->jobs_lock);
    app->jobs_head = app->jobs_tail;
    pthread_mutex_unlock(&app->jobs_lock);
    s->drain_queued = false;
    struct wire_e2e_message m = {.id = 9, .network = "azzurra", .from = "alice",
                                 .from_did = "AAAAAAAAAAA", .to_did = "someoneelse",
                                 .verb = WIRE_E2E_MSG, .msgid = "x", .payload = "{}"};
    e2e_doorbell(app, &m);
    CHECK(app->jobs_head == app->jobs_tail);
    m.to_did = our_did(app);
    e2e_doorbell(app, &m);
    e2e_doorbell(app, &m);
    pthread_mutex_lock(&app->jobs_lock);
    size_t queued = (app->jobs_tail + JOB_QUEUE - app->jobs_head) % JOB_QUEUE;
    bool drain_job = queued == 1 && app->jobs[app->jobs_head].kind == JOB_E2E_DRAIN &&
                     strcmp(app->jobs[app->jobs_head].network, "azzurra") == 0;
    pthread_mutex_unlock(&app->jobs_lock);
    CHECK(drain_job);
    /* The worker takes it: the next push rings again. */
    struct job job;
    CHECK(dequeue_job(app, &job));
    e2e_drain_job(app, &job);
    CHECK(!s->drain_queued);
    e2e_doorbell(app, &m);
    CHECK(s->drain_queued);
    /* A lost arrival takes its placeholder with it. */
    e2e_arrival_add(app, "azzurra", "bob", "BBBBBBBBBBB", "*", "mLOST000001");
    CHECK(said(app, "bob … (encrypted message arriving)"));
    e2e_arrival_done(app, "azzurra", "BBBBBBBBBBB", "mLOST000001");
    CHECK(!said(app, "(encrypted message arriving)"));
    free_e2e_app(app);
}

/* ── sending: typed lines in an encrypted query (slice E) ────────────── */

/* What the worker would do with every job queued so far, in order (the
 * UI thread enqueues; the worker owns the slot). */
static void run_jobs(struct app *app) {
    for (int guard = 0; guard < 64; guard++) {
        pthread_mutex_lock(&app->jobs_lock);
        bool any = app->jobs_head != app->jobs_tail;
        pthread_mutex_unlock(&app->jobs_lock);
        if (!any) return;
        struct job job;
        dequeue_job(app, &job);
        switch (job.kind) {
        case JOB_E2E_SEND: e2e_send_job(app, &job); break;
        case JOB_E2E_DRAIN: e2e_drain_job(app, &job); break;
        case JOB_E2E_SYNC:
        case JOB_E2E_INIT: e2e_job(app, &job); break;
        case JOB_SEND: send_message_target(app, job.network, job.channel, job.arg1); break;
        default: break;
        }
    }
}

/* Typed into the focused window, as Enter takes it. */
static void type_line(struct app *app, const char *line) {
    pthread_mutex_lock(&app->lock);
    snprintf(app->input, sizeof(app->input), "%s", line);
    app->input_len = strlen(app->input);
    app->input_pos = app->input_len;
    pthread_mutex_unlock(&app->lock);
    handle_enter(app);
}

/* The log row holding `needle` (the last one), or -1. */
static long row_of(struct app *app, const char *needle) {
    for (size_t i = app->log_count; i > 0; i--)
        if (strstr(app->log[i - 1], needle)) return (long)(i - 1);
    return -1;
}

static bool row_pending(struct app *app, const char *needle) {
    long i = row_of(app, needle);
    return i >= 0 && app->log_pending[i] != 0;
}

/* A device of a peer's identity, with its master's list naming `n`
 * devices: devs[0] holds the master; each other is listed at v2 with a
 * certificate, the way a pairing leaves them. */
static void tpeer_identity(tpeer *devs, size_t n, const char *nick) {
    tpeer_new(&devs[0], nick);
    if (n < 2) return;
    tpeer *m = &devs[0];
    char *keys[E2E_MAX_DEVICES];
    for (size_t i = 0; i < n; i++) {
        if (i) {
            memset(&devs[i], 0, sizeof(devs[i]));
            e2e_record_new(&devs[i].rec);
            snprintf(devs[i].nick, sizeof(devs[i].nick), "%s", nick);
        }
        keys[i] = vz_account_ed25519_key(devs[i].rec.account);
    }
    const char *sorted[E2E_MAX_DEVICES];
    for (size_t i = 0; i < n; i++) sorted[i] = keys[i];
    for (size_t i = 0; i < n; i++)
        for (size_t k = i + 1; k < n; k++)
            if (strcmp(sorted[i], sorted[k]) > 0) {
                const char *t = sorted[i];
                sorted[i] = sorted[k];
                sorted[k] = t;
            }
    char *sig = e2e_sign_list(m->rec.master, 2, sorted, n);
    for (size_t i = 0; i < n; i++) {
        e2e_own *o = devs[i].rec.own;
        if (!o) {
            o = devs[i].rec.own = calloc(1, sizeof(*o));
            o->master = xasprintf("%s", m->rec.own->master);
            o->cert = e2e_sign_cert(m->rec.master, 2, keys[i]);
            o->cert_ver = 2;
            char did[E2E_DID_LEN + 1];
            e2e_did(keys[i], did);
            o->did = xasprintf("%s", did);
        } else {
            for (size_t k = 0; k < o->list_devices.n; k++) free(o->list_devices.v[k]);
            free(o->list_devices.v);
            free(o->list_sig);
        }
        o->list_ver = 2;
        o->list_devices.v = calloc(n, sizeof(char *));
        for (size_t k = 0; k < n; k++) o->list_devices.v[k] = xasprintf("%s", sorted[k]);
        o->list_devices.n = n;
        o->list_sig = xasprintf("%s", sig);
    }
    free(sig);
    for (size_t i = 0; i < n; i++) vz_str_free(keys[i]);
}

/* The KEYS the peer's grappa answers a KEYREQ with: its master's list and
 * one fresh one-time key per device. */
static char *tpeer_keys(tpeer *devs, size_t n) {
    e2e_keys_build_entry entries[E2E_MAX_DEVICES];
    json_doc *ids[E2E_MAX_DEVICES], *ups[E2E_MAX_DEVICES];
    char *regs[E2E_MAX_DEVICES], *upl[E2E_MAX_DEVICES];
    const e2e_own *m = devs[0].rec.own;
    for (size_t i = 0; i < n; i++) {
        regs[i] = e2e_register_body(devs[i].rec.account, m->master);
        upl[i] = e2e_top_up(devs[i].rec.account, E2E_MAX_HOSTED_ONE_TIME_KEYS - 1, true);
        vz_account_mark_keys_as_published(devs[i].rec.account);
        ids[i] = json_parse(regs[i], strlen(regs[i]), NULL, 0);
        ups[i] = json_parse(upl[i], strlen(upl[i]), NULL, 0);
        const json_value *id = json_root(ids[i]);
        const json_value *otk = json_at(json_get(json_root(ups[i]), "one_time_keys"), 0);
        entries[i] = (e2e_keys_build_entry){json_string(json_get(id, "curve25519")),
                                            json_string(json_get(id, "ed25519")),
                                            json_string(json_get(id, "sig")),
                                            json_string(json_get(otk, "key")),
                                            json_string(json_get(otk, "sig")), false};
    }
    char *keys = e2e_keys_payload(m->master, m->list_ver, (const char *const *)m->list_devices.v,
                                  m->list_devices.n, m->list_sig, entries, n);
    for (size_t i = 0; i < n; i++) {
        json_free(ids[i]);
        json_free(ups[i]);
        free(regs[i]);
        free(upl[i]);
    }
    return keys;
}

/* What reached the peer: each of our posts to its nick from `carried` on.
 * A KEYREQ is answered (the peer's grappa's KEYS, in our inbox); a PKMSG
 * or MSG opens on every device it carries a body for, and the texts they
 * read are counted in `heard` (one row per device, the last kept). */
static size_t carried;
static char heard[E2E_MAX_DEVICES][8192];
static size_t heard_n[E2E_MAX_DEVICES];
/* The sas.* inners the peer read, in order (slice F). */
static char heard_sas[32][1024];
static size_t nheard_sas;
/* The ACK nonces the peer read, in order (slice G). */
static char heard_ack[8][64];
static size_t nheard_ack;
static void tpeer_carry(struct app *app, tpeer *devs, size_t n) {
    for (;;) {
        pthread_mutex_lock(&fg.lock);
        char *body = carried < fg.nsent ? xasprintf("%s", fg.sent[carried]) : NULL;
        char msgid[12] = "";
        if (body) snprintf(msgid, sizeof(msgid), "%s", fg.sent_msgid[carried++]);
        pthread_mutex_unlock(&fg.lock);
        if (!body) return;
        json_doc *d = json_parse(body, strlen(body), NULL, 0);
        const json_value *o = json_root(d);
        const char *verb = json_string(json_get(o, "verb"));
        const char *payload = json_string(json_get(o, "payload"));
        if (json_str_is(json_get(o, "target"), devs[0].nick)) {
            if (strcmp(verb, "keyreq") == 0) {
                char *keys = tpeer_keys(devs, n);
                char kid[12];
                pthread_mutex_lock(&fg.lock);
                fg_msgid(kid);
                pthread_mutex_unlock(&fg.lock);
                fg_inbox_push(our_did(app), devs[0].nick, "*", E2E_VERB_KEYS, kid, keys, false);
                free(keys);
            } else if (strcmp(verb, "pkmsg") == 0 || strcmp(verb, "msg") == 0) {
                for (size_t i = 0; i < n; i++) {
                    e2e_payload p;
                    bool undec;
                    if (!e2e_payload_parse(e2e_verb_parse(verb), payload, &p, &undec, NULL, 0))
                        continue;
                    bool mine = e2e_payload_body(&p, devs[i].rec.own->did) != NULL;
                    e2e_payload_free(&p);
                    if (!mine) continue;
                    e2e_ctx c = tpeer_ctx(&devs[i]);
                    e2e_result r;
                    e2e_result_init(&r);
                    e2e_receive(&c, "vjt", e2e_verb_parse(verb), msgid,
                                json_string(json_get(o, "from")), payload, &r);
                    for (size_t k = 0; k < r.nevents; k++) {
                        e2e_inner in;
                        if (r.events[k].kind != E2E_EV_RECEIVED ||
                            !e2e_inner_parse(r.events[k].inner, strlen(r.events[k].inner), &in))
                            continue;
                        if (in.type == E2E_INNER_TEXT) {
                            snprintf(heard[i], sizeof(heard[i]), "%.*s", (int)in.body_len, in.body);
                            heard_n[i]++;
                        } else if (in.type == E2E_INNER_ACK && in.nonce && nheard_ack < 8) {
                            snprintf(heard_ack[nheard_ack++], sizeof(heard_ack[0]), "%s",
                                     in.nonce);
                        } else if (in.type >= E2E_INNER_SAS_START &&
                                   in.type <= E2E_INNER_SAS_CANCEL && nheard_sas < 32) {
                            snprintf(heard_sas[nheard_sas++], sizeof(heard_sas[0]), "%s",
                                     r.events[k].inner);
                        }
                        e2e_inner_free(&in);
                    }
                    tpeer_pump(app, &devs[i], &r, 0);
                }
            }
        }
        json_free(d);
        free(body);
    }
}

/* How many posts since `from` carry `verb`; the last such body (borrowed). */
static size_t posted(size_t from, const char *verb, const char **last) {
    char needle[32];
    snprintf(needle, sizeof(needle), "\"verb\":\"%s\"", verb);
    size_t n = 0;
    pthread_mutex_lock(&fg.lock);
    for (size_t i = from; i < fg.nsent; i++)
        if (strstr(fg.sent[i], needle)) {
            n++;
            if (last) *last = fg.sent[i];
        }
    pthread_mutex_unlock(&fg.lock);
    return n;
}

static bool grappa_saw(const char *text) {
    pthread_mutex_lock(&fg.lock);
    bool seen = strstr(fg.log, text) != NULL;
    for (size_t i = 0; i < fg.nsent; i++) seen |= strstr(fg.sent[i], text) != NULL;
    for (size_t i = 0; i < fg.nplain; i++) seen |= strstr(fg.plain[i], text) != NULL;
    pthread_mutex_unlock(&fg.lock);
    return seen;
}

static bool prompt_locked(struct app *app) {
    char prompt[MAX_CHANNEL + 16];
    pthread_mutex_lock(&app->lock);
    input_prompt_locked(app, &app->windows[focused_window_locked(app)], prompt, sizeof(prompt));
    pthread_mutex_unlock(&app->lock);
    return strncmp(prompt, E2E_LOCK " ", strlen(E2E_LOCK) + 1) == 0;
}

/* A ready holder with the query with `nick` focused; carried/heard reset. */
static struct app *send_app(const char *subject, const char *nick) {
    fg_reset();
    struct app *app = recv_app(subject);
    run_jobs(app);
    add_window_ex(app, "azzurra", nick, true);
    pthread_mutex_lock(&fg.lock);
    carried = fg.nsent;
    pthread_mutex_unlock(&fg.lock);
    memset(heard, 0, sizeof(heard));
    memset(heard_n, 0, sizeof(heard_n));
    return app;
}

/* /e2e on, a typed line: KEYREQ, KEYS, then the PKMSG the peer reads; the
 * row pending until grappa took it, written down (and the state saved)
 * before it left; never anything in clear. Then a MSG once the peer
 * answered, and a /me as an encrypted ACTION. */
TEST(a_typed_line_in_an_encrypted_query_goes_encrypted) {
    struct app *app = send_app("user:send", "alice");
    tpeer alice;
    tpeer_new(&alice, "alice");
    CHECK(!prompt_locked(app));
    handle_command(app, "/e2e on");
    CHECK(said(app, "encrypted mode ON"));
    CHECK(prompt_locked(app));
    run_jobs(app);
    CHECK(said(app, "asking alice for their keys"));
    CHECK_LONG(posted(carried, "keyreq", NULL), 1);

    type_line(app, "hello alice");
    CHECK(said(app, "[azzurra/alice]"));
    CHECK(said(app, LOCKED("<vjt> hello alice")));
    CHECK(row_pending(app, "hello alice"));
    run_jobs(app);
    /* Waiting for the keys: still pending, nothing but the KEYREQ out. */
    CHECK(row_pending(app, "hello alice"));
    CHECK_LONG(posted(carried, "pkmsg", NULL), 0);
    size_t before = fg.nsent;
    tpeer_carry(app, &alice, 1);
    drain(app);
    run_jobs(app);
    const char *pk = NULL;
    CHECK_LONG(posted(before, "pkmsg", &pk), 1);
    CHECK(!row_pending(app, "hello alice"));
    CHECK(said(app, "alice answered with their key"));
    /* Written down, and the state that spent the step saved, before it left. */
    pthread_mutex_lock(&fg.lock);
    for (size_t i = before; i < fg.nsent; i++) {
        if (!strstr(fg.sent[i], "\"pkmsg\"")) continue;
        CHECK(fg.sent_disk_rows[i] >= 1);
        CHECK(fg.sent_disk_records[i] >= 1);
    }
    pthread_mutex_unlock(&fg.lock);
    tpeer_carry(app, &alice, 1);
    CHECK_STR(heard[0], "hello alice");
    CHECK(!grappa_saw("hello alice"));
    CHECK_LONG(fg.nplain, 0);
    char *dir = xasprintf("%s/chats", fg.watch_dir);
    e2e_rows rows;
    CHECK(e2e_chat_load(dir, &rows, NULL, 0));
    bool out = false;
    for (size_t i = 0; i < rows.n; i++)
        out |= rows.v[i].kind == E2E_ROW_OUT && strncmp(rows.v[i].id, "out:", 4) == 0 &&
               strcmp(rows.v[i].body, "hello alice") == 0 && strcmp(rows.v[i].nick, "alice") == 0;
    CHECK(out);
    e2e_rows_free(&rows);
    free(dir);

    /* alice answers; our next goes on the session she has read: a MSG. */
    tpeer_say(app, &alice, "hi back");
    drain(app);
    before = fg.nsent;
    type_line(app, "second line");
    run_jobs(app);
    CHECK_LONG(posted(before, "msg", NULL), 1);
    CHECK_LONG(posted(before, "pkmsg", NULL), 0);
    CHECK(!row_pending(app, "second line"));
    tpeer_carry(app, &alice, 1);
    CHECK_STR(heard[0], "second line");

    /* /me: an ACTION, encrypted, drawn as one. */
    handle_command(app, "/me waves");
    CHECK(said(app, LOCKED("* vjt waves")));
    run_jobs(app);
    tpeer_carry(app, &alice, 1);
    CHECK_STR(heard[0], "\001ACTION waves\001");
    CHECK(!grappa_saw("waves"));
    CHECK_LONG(fg.nplain, 0);
    tpeer_free(&alice);
    free_e2e_app(app);
}

/* A long line fits grappa's 64 lines on the network's budget (the fake
 * grappa 413s what does not); on a budget too small for it, it fails
 * before anything leaves and before any session moves. */
TEST(a_long_line_is_sized_on_the_networks_budget) {
    struct app *app = send_app("user:long", "alice");
    tpeer alice;
    tpeer_new(&alice, "alice");
    tpeer_say(app, &alice, "hi");
    drain(app);
    pthread_mutex_lock(&fg.lock);
    fg.budget = 394;
    pthread_mutex_unlock(&fg.lock);
    char line[1000];
    memset(line, 'x', sizeof(line) - 1);
    line[sizeof(line) - 1] = 0;
    line[0] = 'L';
    size_t before = fg.nsent;
    type_line(app, line);
    run_jobs(app);
    CHECK_LONG(posted(before, "msg", NULL), 1);
    CHECK(!said(app, "failed:"));
    tpeer_carry(app, &alice, 1);
    CHECK_STR(heard[0], line);

    char *rec_before = e2e_record_to_json(&app->e2e[0].rec);
    pthread_mutex_lock(&app->lock);
    app->networks[0].frame_budget_base = 60;
    pthread_mutex_unlock(&app->lock);
    before = fg.nsent;
    line[0] = 'M';
    type_line(app, line);
    run_jobs(app);
    CHECK_LONG(fg.nsent, before);
    CHECK(said(app, "(failed: too long for one encrypted message"));
    CHECK(!row_pending(app, "Mxxx"));
    /* No session stepped for a message that never left. */
    char *rec_after = e2e_record_to_json(&app->e2e[0].rec);
    char *s1 = strstr(rec_before, "\"sessions\""), *s2 = strstr(rec_after, "\"sessions\"");
    char *e1 = strstr(rec_before, "\"seen\""), *e2 = strstr(rec_after, "\"seen\"");
    CHECK(s1 && s2 && e1 && e2 && e1 - s1 == e2 - s2 && memcmp(s1, s2, (size_t)(e1 - s1)) == 0);
    free(rec_before);
    free(rec_after);
    tpeer_free(&alice);
    free_e2e_app(app);
}

/* Found live against cicchetto and the irc-olm bot: both send encrypted
 * lines of 1 KiB and more, and shottino read theirs whole, but a line
 * typed here stopped at 1023 bytes — the input buffer dropped the rest
 * without a word and the peer read the cut text. An encrypted line is
 * bounded by grappa's 64 lines, not by the buffer; a clear line or a
 * command still goes through 1 KiB buffers, so one too long for them is
 * refused out loud and left in the input, never cut. */
TEST(a_line_past_a_clear_lines_size_goes_whole_when_encrypted) {
    struct app *app = send_app("user:longer", "alice");
    tpeer alice;
    tpeer_new(&alice, "alice");
    tpeer_say(app, &alice, "hi");
    drain(app);
    /* 1 + 1500 × "è" (2 bytes) + the end mark: 3005 bytes, multibyte. */
    char line[3100] = "L";
    for (int i = 0; i < 1500; i++) strcat(line, "\xc3\xa8");
    strcat(line, " end");
    CHECK(strlen(line) > 2 * MAX_LINE);
    size_t before = fg.nsent;
    size_t hist = app->history_count;
    type_line(app, line);
    run_jobs(app);
    CHECK_LONG(posted(before, "msg", NULL), 1);
    CHECK(!said(app, "failed:"));
    tpeer_carry(app, &alice, 1);
    CHECK_STR(heard[0], line);
    CHECK(!grappa_saw("\xc3\xa8\xc3\xa8\xc3\xa8 end"));
    /* Up never brings back a copy of it cut to the history's size. */
    CHECK_LONG((long)app->history_count, (long)hist);

    /* The same length as a command, then in clear: refused, kept, unsent. */
    char cmd[3200];
    snprintf(cmd, sizeof(cmd), "/me %s", line);
    before = fg.nsent;
    type_line(app, cmd);
    run_jobs(app);
    CHECK(said(app, "too long"));
    CHECK_LONG(fg.nsent, before);
    CHECK_STR(app->input, cmd);
    handle_command(app, "/e2e off");
    run_jobs(app);
    size_t plain = fg.nplain;
    type_line(app, line);
    run_jobs(app);
    CHECK_LONG(fg.nplain, plain);
    CHECK_LONG(fg.nsent, before);
    CHECK_STR(app->input, line);
    tpeer_free(&alice);
    free_e2e_app(app);
}

/* A peer with two devices: one payload, a body for each; both read it. */
TEST(a_peer_with_two_devices_gets_one_payload_two_bodies) {
    struct app *app = send_app("user:two", "alice");
    tpeer alice[2];
    tpeer_identity(alice, 2, "alice");
    handle_command(app, "/e2e on");
    run_jobs(app);
    type_line(app, "to both of you");
    run_jobs(app);
    size_t before = fg.nsent;
    tpeer_carry(app, alice, 2);
    drain(app);
    const char *pk = NULL;
    CHECK_LONG(posted(before, "pkmsg", &pk), 1);
    if (pk) {
        json_doc *d = json_parse(pk, strlen(pk), NULL, 0);
        e2e_payload p;
        bool undec;
        CHECK(e2e_payload_parse(E2E_VERB_PKMSG, json_string(json_get(json_root(d), "payload")), &p,
                                &undec, NULL, 0));
        CHECK_LONG(p.nbodies, 2);
        CHECK(json_str_is(json_get(json_root(d), "to"), "*"));
        e2e_payload_free(&p);
        json_free(d);
    }
    tpeer_carry(app, alice, 2);
    CHECK_STR(heard[0], "to both of you");
    CHECK_STR(heard[1], "to both of you");
    CHECK(!row_pending(app, "to both of you"));
    tpeer_free(&alice[0]);
    tpeer_free(&alice[1]);
    free_e2e_app(app);
}

/* The queue for queued messages is the engine's (90 s): once it gives up
 * — or the server says the nick is gone — the row fails, nothing ever
 * goes in clear, and the query STAYS encrypted: neither is the user's
 * word, and a network that could turn the mode off by withholding keys or
 * answering 401 could make the next line go in clear. Only /e2e off does;
 * the user is told so, loudly. */
static void age_queues(struct app *app) {
    e2e_state *st = &app->e2e[0].rec.state;
    for (size_t i = 0; i < st->npeers; i++)
        for (size_t k = 0; k < st->peers[i].noutq; k++) st->peers[i].outq[k].at -= E2E_OUTQ_TTL_MS + 1000;
    for (size_t i = 0; i < app->e2e[0].nawaiting; i++)
        app->e2e[0].awaiting[i].until -= E2E_OUTQ_TTL_MS + 1000;
}

/* KEYREQs are one per nick per 30 s, whatever a KEYS did: the clock's. */
static void age_keyreqs(struct app *app) {
    e2e_state *st = &app->e2e[0].rec.state;
    for (size_t i = 0; i < st->npeers; i++) st->peers[i].keyreq_sent_at -= E2E_KEYREQ_RETRY_MS + 1000;
}

static void tick(struct app *app) {
    e2e_send_enqueue(app, "azzurra", "", "tick", "", 0);
    run_jobs(app);
}

TEST(no_keys_fails_the_row_and_nothing_goes_in_clear) {
    struct app *app = send_app("user:nokeys", "bob");
    handle_command(app, "/e2e on");
    run_jobs(app);
    type_line(app, "a secret for bob");
    run_jobs(app);
    CHECK(row_pending(app, "a secret for bob"));
    CHECK(said(app, "asked bob for their keys"));
    CHECK(app->e2e[0].clock);
    /* The main loop's clock rings the engine's tick. */
    app->e2e[0].ticked_at = 0;
    e2e_send_clock(app);
    age_queues(app);
    run_jobs(app);
    CHECK(said(app, "(failed: no keys came from them in 90 s"));
    CHECK(!row_pending(app, "a secret for bob"));
    CHECK(said(app, "bob has no encrypted identity on azzurra"));
    CHECK(said(app, "encrypted mode stays ON"));
    CHECK(said(app, "/e2e off to write in clear"));
    CHECK(!said(app, "OFF again"));
    CHECK(prompt_locked(app));
    CHECK(e2e_query_encrypted(app, "azzurra", "bob"));
    CHECK(!grappa_saw("a secret for bob"));
    CHECK_LONG(fg.nplain, 0);
    /* The record — what a restart reads — still says encrypted. */
    CHECK(e2e_record_encrypted(&app->e2e[0].rec, "bob"));
    /* The next line still goes nowhere in clear. */
    type_line(app, "another for bob");
    run_jobs(app);
    CHECK(!grappa_saw("another for bob"));
    CHECK_LONG(fg.nplain, 0);

    /* The 401 (no_such_nick, v54) fails what waits at once. */
    handle_command(app, "/e2e on carol");
    run_jobs(app);
    add_window_ex(app, "azzurra", "carol", true);
    type_line(app, "for carol");
    run_jobs(app);
    e2e_absent_enqueue(app, "azzurra", "carol");
    run_jobs(app);
    CHECK(said(app, "(failed: no such nick on the network"));
    CHECK(said(app, "carol is not on azzurra"));
    CHECK(e2e_query_encrypted(app, "azzurra", "carol"));
    CHECK(prompt_locked(app));
    CHECK(!grappa_saw("for carol"));
    type_line(app, "still for carol");
    run_jobs(app);
    CHECK(!grappa_saw("still for carol"));
    CHECK_LONG(fg.nplain, 0);
    /* Only the user's word turns it off. */
    handle_command(app, "/e2e off");
    run_jobs(app);
    CHECK(!e2e_query_encrypted(app, "azzurra", "carol"));
    free_e2e_app(app);
}

/* Every message of this run still on its way is a row the user is
 * waiting on: a full table never gives one of them up to make room — the
 * NEW one is refused, said on its row, and nothing goes in clear. */
TEST(a_full_table_refuses_a_new_message_and_keeps_every_pending_one) {
    struct app *app = send_app("user:outs", "p0");
    const char *peers[] = {"p0", "p1", "p2", "p3"};
    char body[32];
    for (size_t k = 0; k < 4; k++) {
        char cmd[32];
        snprintf(cmd, sizeof(cmd), "/e2e on %s", peers[k]);
        handle_command(app, cmd);
        run_jobs(app);
        for (int i = 0; i < E2E_OUTQ_MAX; i++) {
            snprintf(body, sizeof(body), "for %s %d", peers[k], i);
            e2e_type(app, "azzurra", peers[k], body);
            run_jobs(app);
        }
    }
    CHECK_LONG(app->e2e[0].nouts, E2E_OUTS_MAX);
    for (size_t i = 0; i < app->e2e[0].nouts; i++)
        CHECK(app->e2e[0].outs[i].state == E2E_OUT_PENDING);
    handle_command(app, "/e2e on p4");
    run_jobs(app);
    e2e_type(app, "azzurra", "p4", "one too many");
    run_jobs(app);
    CHECK(!row_pending(app, "one too many"));
    CHECK(said(app, "one too many (failed: " "64 encrypted messages are still on their way"));
    CHECK_LONG(app->e2e[0].nouts, E2E_OUTS_MAX);
    for (size_t i = 0; i < app->e2e[0].nouts; i++)
        CHECK(app->e2e[0].outs[i].state == E2E_OUT_PENDING);
    /* The oldest is still tracked, so its row will settle. */
    bool oldest = false;
    for (size_t i = 0; i < app->e2e[0].nouts; i++)
        oldest |= strcmp(app->e2e[0].outs[i].body, "for p0 0") == 0;
    CHECK(oldest);
    CHECK(row_pending(app, "for p0 0"));
    CHECK(!grappa_saw("one too many"));
    CHECK_LONG(fg.nplain, 0);
    free_e2e_app(app);
}

/* What leaves is recorded after it left (the second save of a step): if
 * the disk refuses that one, it is said loudly, and the in-memory record —
 * which tells the truth about what left — is kept rather than read back to
 * a state that predates the send. The next step's save, which comes before
 * anything else leaves, writes it. */
TEST(a_record_that_cannot_be_stored_after_a_send_is_said) {
    struct app *app = send_app("user:latesave", "bob");
    pthread_mutex_lock(&fg.lock);
    fg.lock_disk_on_send = true;
    pthread_mutex_unlock(&fg.lock);
    handle_command(app, "/e2e on");
    run_jobs(app);
    CHECK_LONG(posted(carried, "keyreq", NULL), 1);
    CHECK(said(app, "could not store this device's record"));
    CHECK(said(app, "what was just sent left, but the record of it could not be stored"));
    CHECK(view_of(app).state == E2E_SLOT_READY);
    CHECK(app->e2e[0].have_rec);
    CHECK(e2e_query_encrypted(app, "azzurra", "bob"));
    pthread_mutex_lock(&fg.lock);
    chmod(fg.watch_dir, 0700);
    pthread_mutex_unlock(&fg.lock);
    free_e2e_app(app);
}

/* The NACK in (§5.7): from a device the message went to, the engine
 * re-keys that device and sends again, once; a second NACK fails it. */
static void nack_from(struct app *app, tpeer *p, const char *ref) {
    char *payload = e2e_nack_payload(ref);
    char id[12];
    pthread_mutex_lock(&fg.lock);
    fg_msgid(id);
    pthread_mutex_unlock(&fg.lock);
    fg_inbox_push(our_did(app), p ? p->nick : "alice", p ? p->rec.own->did : "*", E2E_VERB_NACK, id,
                  payload, false);
    free(payload);
}

/* Both ways: our KEYREQ answered (alice's list held, so nothing of ours
 * waits for more keys), then a line of hers read. */
static void meet(struct app *app, tpeer *p) {
    handle_command(app, "/e2e on");
    run_jobs(app);
    tpeer_carry(app, p, 1);
    drain(app);
    tpeer_say(app, p, "hi");
    drain(app);
    tpeer_carry(app, p, 1);
    drain(app);
    run_jobs(app);
}

/* The msgid our last text post (a PKMSG or MSG) got. */
static void last_text_msgid(char out[12]) {
    out[0] = 0;
    pthread_mutex_lock(&fg.lock);
    for (size_t i = 0; i < fg.nsent; i++)
        if (strstr(fg.sent[i], "\"verb\":\"msg\"") || strstr(fg.sent[i], "\"verb\":\"pkmsg\""))
            snprintf(out, 12, "%s", fg.sent_msgid[i]);
    pthread_mutex_unlock(&fg.lock);
}

TEST(a_nack_rekeys_and_resends_once_then_fails) {
    struct app *app = send_app("user:nackin", "alice");
    tpeer alice;
    tpeer_new(&alice, "alice");
    meet(app, &alice);
    type_line(app, "read me");
    run_jobs(app);
    char ref[12];
    last_text_msgid(ref);
    CHECK(ref[0]);
    pthread_mutex_lock(&fg.lock);
    carried = fg.nsent;
    pthread_mutex_unlock(&fg.lock);
    nack_from(app, &alice, ref);
    size_t before = fg.nsent;
    drain(app);
    CHECK(said(app, "a device of alice could not read your message"));
    /* The KEYREQ for the new session waits out the 30 s since meet's. */
    CHECK_LONG(posted(before, "keyreq", NULL), 0);
    age_keyreqs(app);
    tick(app);
    CHECK_LONG(posted(before, "keyreq", NULL), 1);
    before = fg.nsent;
    tpeer_carry(app, &alice, 1);
    drain(app);
    CHECK_LONG(posted(before, "pkmsg", NULL), 1);
    tpeer_carry(app, &alice, 1);
    CHECK_STR(heard[0], "read me");
    CHECK(!said(app, "not delivered"));
    /* The resend NACKed too: that was its last send. */
    last_text_msgid(ref);
    nack_from(app, &alice, ref);
    before = fg.nsent;
    drain(app);
    CHECK(said(app, "not delivered: \"read me\" (it could not be read even after a resend)"));
    CHECK_LONG(posted(before, "pkmsg", NULL) + posted(before, "msg", NULL), 0);
    CHECK_LONG(fg.nplain, 0);
    tpeer_free(&alice);
    free_e2e_app(app);
}

/* A NACK from `*` (v52: no device of theirs could read it): never re-keyed
 * on its own. The user is asked; /e2e rekey asks for new keys and sends it
 * again once they come. */
TEST(a_nack_from_star_asks_the_user) {
    struct app *app = send_app("user:star", "alice");
    tpeer alice;
    tpeer_new(&alice, "alice");
    meet(app, &alice);
    type_line(app, "lost one");
    run_jobs(app);
    char ref[12];
    last_text_msgid(ref);
    pthread_mutex_lock(&fg.lock);
    carried = fg.nsent;
    pthread_mutex_unlock(&fg.lock);
    nack_from(app, NULL, ref);
    size_t before = fg.nsent;
    drain(app);
    CHECK(said(app, "alice cannot read your last message on any device — /e2e rekey alice"));
    CHECK(said(app, "not delivered: \"lost one\""));
    CHECK_LONG(fg.nsent, before);
    handle_command(app, "/e2e rekey");
    age_keyreqs(app);
    run_jobs(app);
    CHECK(said(app, "asked alice for new keys"));
    CHECK_LONG(posted(before, "keyreq", NULL), 1);
    tpeer_carry(app, &alice, 1);
    drain(app);
    tpeer_carry(app, &alice, 1);
    CHECK_STR(heard[0], "lost one");
    CHECK(!row_pending(app, "lost one"));
    tpeer_free(&alice);
    free_e2e_app(app);
}

/* e2e_send_dropped (v46): what grappa took and then dropped unsent fails
 * its row; /e2e resend sends it again. Another device's msgid is nothing. */
TEST(a_dropped_send_fails_and_resend_sends_it_again) {
    struct app *app = send_app("user:dropped", "alice");
    tpeer alice;
    tpeer_new(&alice, "alice");
    meet(app, &alice);
    type_line(app, "drop me");
    run_jobs(app);
    CHECK(!row_pending(app, "drop me"));
    char ref[12];
    last_text_msgid(ref);
    e2e_dropped_enqueue(app, "azzurra", "alice", "mSOMEONEELS", (int)WIRE_E2E_DROP_LATE);
    run_jobs(app);
    CHECK(!said(app, "not delivered"));
    e2e_dropped_enqueue(app, "azzurra", "alice", ref, (int)WIRE_E2E_DROP_SESSION_ENDED);
    run_jobs(app);
    CHECK(said(app, "not delivered: \"drop me\" (grappa dropped it unsent (session_ended))"));
    pthread_mutex_lock(&fg.lock);
    carried = fg.nsent;
    pthread_mutex_unlock(&fg.lock);
    handle_command(app, "/e2e resend");
    run_jobs(app);
    tpeer_carry(app, &alice, 1);
    CHECK_STR(heard[0], "drop me");
    CHECK_LONG(heard_n[0], 1);
    CHECK_LONG(said_count(app, LOCKED("<vjt> drop me")), 2);
    CHECK(!row_pending(app, "drop me"));
    /* Nothing failed any more. */
    handle_command(app, "/e2e resend");
    run_jobs(app);
    CHECK(said(app, "nothing failed in this query to send again"));
    tpeer_free(&alice);
    free_e2e_app(app);
}

/* A peer who writes encrypted turns the query encrypted (persisted); a
 * refusal at the send door fails the row, never falls back; /e2e off warns
 * and the next line goes in clear through the normal door. */
TEST(the_peer_turns_it_on_and_only_off_turns_it_off) {
    struct app *app = send_app("user:auto", "alice");
    tpeer alice;
    tpeer_new(&alice, "alice");
    tpeer_say(app, &alice, "psst");
    drain(app);
    CHECK(said(app, "alice writes encrypted"));
    CHECK(e2e_query_encrypted(app, "azzurra", "ALICE"));
    CHECK(prompt_locked(app));
    type_line(app, "psst back");
    run_jobs(app);
    /* Her list is not held yet: what went also waits for her KEYS. */
    tpeer_carry(app, &alice, 1);
    drain(app);
    tpeer_carry(app, &alice, 1);
    CHECK_STR(heard[0], "psst back");
    /* grappa refuses: the row fails, nothing goes in clear. */
    pthread_mutex_lock(&fg.lock);
    fg.fail_send_status = 429;
    snprintf(fg.fail_send_error, sizeof(fg.fail_send_error), "rate_limited");
    pthread_mutex_unlock(&fg.lock);
    type_line(app, "too fast");
    run_jobs(app);
    CHECK(said(app, "(failed: grappa refused it: HTTP 429"));
    CHECK_LONG(fg.nplain, 0);
    /* The last door to plaintext refuses an encrypted query outright. */
    send_message_target(app, "azzurra", "alice", "sneaky");
    CHECK(said(app, "NOT sent — this query is in encrypted mode"));
    CHECK_LONG(fg.nplain, 0);

    /* It survives a restart. */
    e2e_slots_free(app);
    free_e2e_app(app);
    app = e2e_app("user:auto");
    run_job(app, JOB_E2E_SYNC);
    add_window_ex(app, "azzurra", "alice", true);
    CHECK(e2e_query_encrypted(app, "azzurra", "alice"));

    handle_command(app, "/e2e off");
    CHECK(said(app, "encrypted mode OFF — from now on what you type here goes in CLEAR"));
    CHECK(!prompt_locked(app));
    run_jobs(app);
    type_line(app, "plain now");
    run_jobs(app);
    CHECK_LONG(fg.nplain, 1);
    CHECK(grappa_saw("plain now"));
    e2e_record rec;
    e2e_slots_free(app);
    CHECK(disk_record(app, &rec));
    CHECK(!e2e_record_encrypted(&rec, "alice"));
    e2e_record_free(&rec);
    tpeer_free(&alice);
    free_e2e_app(app);
}

/* What read_scrollback hands a model: a model's tools are a door to a
 * third party (the endpoint) and, through the bot, to whoever asked it. An
 * encrypted query is refused outright, and a row that was encrypted stays
 * out of the answer after the query went clear again — only the rows that
 * were clear in the first place are read. */
static char *read_scrollback(struct app *app, const char *target) {
    struct llm_req req = {0};
    snprintf(req.network, sizeof(req.network), "azzurra");
    struct llm_tool_call call = {0};
    snprintf(call.name, sizeof(call.name), "read_scrollback");
    snprintf(call.arguments, sizeof(call.arguments), "{\"target\":\"%s\",\"lines\":\"100\"}",
             target);
    return tool_execute(app, &req, &call, "");
}

TEST(no_model_tool_reads_an_encrypted_row) {
    struct app *app = send_app("user:llmread", "alice");
    struct wire_scrollback_message m = {0};
    m.id = 900;
    m.network = "azzurra";
    m.channel = "vjt";
    m.dm_with = "alice";
    m.sender = "alice";
    m.body = "said in clear";
    m.kind = MSG_PRIVMSG;
    render_message(app, &m, true);
    tpeer alice;
    tpeer_new(&alice, "alice");
    tpeer_say(app, &alice, "the secret plan");
    drain(app);
    CHECK(said(app, LOCKED("<alice> the secret plan")));
    CHECK(e2e_query_encrypted(app, "azzurra", "alice"));
    type_line(app, "my own secret");
    run_jobs(app);
    CHECK(said(app, "my own secret"));
    /* Every row the E2E history drew is marked as such; the clear one not. */
    CHECK(app->log_e2e[row_of(app, "the secret plan")]);
    CHECK(app->log_e2e[row_of(app, "my own secret")]);
    CHECK(!app->log_e2e[row_of(app, "said in clear")]);

    char *out = read_scrollback(app, "alice");
    CHECK(strncmp(out, "error:", 6) == 0);
    CHECK(strstr(out, "encrypted") != NULL);
    CHECK(strstr(out, "the secret plan") == NULL);
    CHECK(strstr(out, "my own secret") == NULL);
    free(out);
    out = read_scrollback(app, "ALICE");
    CHECK(strncmp(out, "error:", 6) == 0);
    free(out);

    handle_command(app, "/e2e off");
    CHECK(!e2e_query_encrypted(app, "azzurra", "alice"));
    out = read_scrollback(app, "alice");
    CHECK(strstr(out, "said in clear") != NULL);
    CHECK(strstr(out, "the secret plan") == NULL);
    CHECK(strstr(out, "my own secret") == NULL);
    free(out);
    tpeer_free(&alice);
    free_e2e_app(app);
}

/* A link in an encrypted row is not "the last link": /preview and /open
 * with no argument fetch what remember_url kept, so a decrypted URL there
 * would be one keystroke from a GET its host was never meant to see.
 * The row keeps it as a link (the draw path, test_layout). */
TEST(an_encrypted_link_is_not_remembered_for_preview) {
    struct app *app = send_app("user:link", "alice");
    tpeer alice;
    tpeer_new(&alice, "alice");
    tpeer_say(app, &alice, "see https://ex.net/secret.png");
    drain(app);
    CHECK(said(app, "https://ex.net/secret.png"));
    CHECK(strstr(app->last_url, "secret") == NULL);
    CHECK(strstr(app->last_media_url, "secret") == NULL);
    tpeer_free(&alice);
    free_e2e_app(app);
}

/* An attachment in an encrypted query is refused BEFORE anything reaches
 * grappa: /api/uploads stores the file in clear and serves it to anyone
 * with the link, so uploading it and refusing only the link afterwards
 * had already given the file away. /upload, /vmsg and /video all stop at
 * the door, and the worker's upload door checks again. */
TEST(an_attachment_is_refused_before_it_is_uploaded_to_an_encrypted_query) {
    struct app *app = send_app("user:upload", "alice");
    handle_command(app, "/e2e on");
    run_jobs(app);
    CHECK(e2e_query_encrypted(app, "azzurra", "alice"));
    char path[PATH_MAX];
    snprintf(path, sizeof(path), "%s/secret.png", getenv("HOME"));
    FILE *f = fopen(path, "wb");
    CHECK(f != NULL);
    if (f) {
        fputs("\x89PNG not really", f);
        fclose(f);
    }
    char cmd[PATH_MAX + 16];
    snprintf(cmd, sizeof(cmd), "/upload %s", path);
    handle_command(app, cmd);
    CHECK(said(app, "/upload: refused"));
    CHECK(said(app, "encrypted attachments are not supported yet"));
    pthread_mutex_lock(&app->jobs_lock);
    CHECK(app->jobs_head == app->jobs_tail);
    pthread_mutex_unlock(&app->jobs_lock);
    /* The worker's door, should the mode have turned on after the queue. */
    upload_file_to(app, path, "📸", "azzurra", "alice");
    CHECK_LONG(said_count(app, "encrypted attachments are not supported yet"), 2);
    CHECK(!said(app, "uploading secret.png"));
    handle_command(app, "/vmsg");
    CHECK(said(app, "/voice: refused"));
    handle_command(app, "/video");
    CHECK(said(app, "/video: refused"));
    CHECK(!app->rec.active);
    CHECK(!fg_logged("/api/uploads"));
    CHECK_LONG(fg.nplain, 0);
    unlink(path);
    free_e2e_app(app);
}

/* A CTCP body in an encrypted query is refused at the last door too: a
 * \x01-led line is still words sent in clear to the person the query is
 * encrypted with, and nothing legitimate needs the message door for one —
 * /ctcp and /ping go as raw lines, and the PING answer is a raw NOTICE.
 * Those stay; an ACTION through /ctcp is a /me in clear, and is refused. */
TEST(a_ctcp_body_never_goes_in_clear_to_an_encrypted_query) {
    struct app *app = send_app("user:ctcp", "alice");
    handle_command(app, "/e2e on");
    run_jobs(app);
    send_message_target(app, "azzurra", "alice", "\001VERSION\001");
    CHECK(said(app, "NOT sent — this query is in encrypted mode"));
    send_message_target(app, "azzurra", "alice", "\001SECRET words in clear\001");
    CHECK_LONG(said_count(app, "NOT sent — this query is in encrypted mode"), 2);
    CHECK_LONG(fg.nplain, 0);
    handle_command(app, "/ctcp alice action waves in clear");
    CHECK(said(app, "/ctcp alice ACTION: refused"));
    CHECK(!said(app, "--- sent: PRIVMSG alice :\001ACTION"));
    handle_command(app, "/ctcp alice version");
    CHECK(said(app, "--- sent: PRIVMSG alice :\001VERSION\001"));
    /* A channel is not a query: its CTCPs are untouched. */
    send_message_target(app, "azzurra", "#grappa", "\001VERSION\001");
    CHECK_LONG(said_count(app, "NOT sent — this query is in encrypted mode"), 2);
    free_e2e_app(app);
}

/* What this device sends a peer reaches our other device as a copy
 * (claim, then the copy door — never IRC), after grappa took the text. */
TEST(a_sent_text_is_copied_to_our_sibling) {
    struct app *app = send_app("user:sibsend", "alice");
    tpeer sib;
    sibling_of(app, &sib);
    run_job(app, JOB_E2E_SYNC);
    CHECK_LONG(app->e2e[0].rec.own->list_ver, 2);
    tpeer alice;
    tpeer_new(&alice, "alice");
    tpeer_say(app, &alice, "hi");
    drain(app);
    pthread_mutex_lock(&fg.lock);
    fg.log[0] = 0;
    size_t inbox_before = fg.ninbox;
    pthread_mutex_unlock(&fg.lock);
    type_line(app, "and my phone too");
    run_jobs(app);
    char claim[128], copies[128];
    snprintf(claim, sizeof(claim), "/devices/%s/claim\n", sib.rec.own->did);
    snprintf(copies, sizeof(copies), "/devices/%s/copies\n", sib.rec.own->did);
    pthread_mutex_lock(&fg.lock);
    const char *m = strstr(fg.log, "POST /networks/azzurra/e2e/messages\n");
    const char *cl = strstr(fg.log, claim), *cp = strstr(fg.log, copies);
    CHECK(m && cl && cp && m < cl && cl < cp);
    char *cjson = NULL;
    e2e_verb verb = E2E_VERB_NONE;
    for (size_t i = inbox_before; i < fg.ninbox; i++)
        if (strcmp(fg.inbox[i].to, sib.rec.own->did) == 0 && strstr(fg.inbox[i].json, "\"own\":true")) {
            cjson = xasprintf("%s", fg.inbox[i].json);
            verb = fg.inbox[i].verb;
        }
    pthread_mutex_unlock(&fg.lock);
    CHECK(cjson != NULL);
    if (cjson) {
        e2e_ctx sc = {&sib.rec, "vjt", 394, (int64_t)time(NULL) * 1000};
        json_doc *d = json_parse(cjson, strlen(cjson), NULL, 0);
        e2e_result r;
        e2e_result_init(&r);
        e2e_receive_copy(&sc, our_did(app), verb, json_string(json_get(json_root(d), "payload")), &r);
        bool copied = false;
        for (size_t i = 0; i < r.nevents; i++)
            copied |= r.events[i].kind == E2E_EV_COPIED && strcmp(r.events[i].peer, "alice") == 0 &&
                      r.events[i].body_len == 16 && memcmp(r.events[i].body, "and my phone too", 16) == 0;
        CHECK(copied);
        e2e_result_free(&r);
        json_free(d);
        free(cjson);
    }
    tpeer_free(&sib);
    tpeer_free(&alice);
    free_e2e_app(app);
}

/* /emsg: one encrypted message; the query stays as it was. */
TEST(emsg_sends_one_encrypted_message) {
    struct app *app = send_app("user:emsg", "alice");
    tpeer alice;
    tpeer_new(&alice, "alice");
    tpeer_say(app, &alice, "hi");
    drain(app);
    handle_command(app, "/e2e off alice");
    run_jobs(app);
    CHECK(!e2e_query_encrypted(app, "azzurra", "alice"));
    handle_command(app, "/emsg alice just this one");
    CHECK(said(app, LOCKED("<vjt> just this one")));
    run_jobs(app);
    tpeer_carry(app, &alice, 1);
    CHECK_STR(heard[0], "just this one");
    CHECK(!e2e_query_encrypted(app, "azzurra", "alice"));
    CHECK_LONG(fg.nplain, 0);
    handle_command(app, "/e2e on #chan");
    CHECK(said(app, "/e2e on: type it in a query, or name the nick"));
    handle_command(app, "/e2e on vjt");
    CHECK(said(app, "/e2e on: vjt is your own nick"));
    tpeer_free(&alice);
    free_e2e_app(app);
}

/* Boot: the encrypted modes are read off the disk before the first
 * keystroke (e2e_peek_modes), so a line typed before the worker's open
 * never reaches the clear door — it waits behind the sync, then goes
 * encrypted. */
TEST(a_line_typed_before_the_slot_loads_never_goes_in_clear) {
    struct app *app = send_app("user:early", "alice");
    tpeer alice;
    tpeer_new(&alice, "alice");
    tpeer_say(app, &alice, "psst");
    drain(app);
    CHECK(e2e_query_encrypted(app, "azzurra", "alice"));
    e2e_slots_free(app);
    free_e2e_app(app);

    app = e2e_app("user:early");
    app->networks[0].has_frame_budget_base = true;
    app->networks[0].frame_budget_base = 394;
    e2e_peek_modes(app, "azzurra");
    e2e_enqueue(app, JOB_E2E_SYNC, "azzurra");
    add_window_ex(app, "azzurra", "alice", true);
    CHECK(prompt_locked(app));
    pthread_mutex_lock(&fg.lock);
    carried = fg.nsent;
    pthread_mutex_unlock(&fg.lock);
    type_line(app, "typed at once");
    handle_command(app, "/me too");
    send_message_target(app, "azzurra", "alice", "and a stray one");
    CHECK_LONG(fg.nplain, 0);
    run_jobs(app);
    CHECK(view_of(app).state == E2E_SLOT_READY);
    tpeer_carry(app, &alice, 1);
    CHECK_LONG(heard_n[0], 2);
    CHECK_STR(heard[0], "\001ACTION too\001");
    CHECK(!grappa_saw("typed at once"));
    CHECK(!grappa_saw("and a stray one"));
    CHECK_LONG(fg.nplain, 0);
    tpeer_free(&alice);
    free_e2e_app(app);
}

/* Another shottino holds the device: the modes are still read (no lock
 * is needed to read), and the query fails closed, saying why. */
TEST(a_busy_slot_fails_closed) {
    struct app *app = send_app("user:busy2", "alice");
    tpeer alice;
    tpeer_new(&alice, "alice");
    tpeer_say(app, &alice, "psst");
    drain(app);
    char dir[PATH_MAX];
    e2e_slot_dir(app, &app->e2e[0], dir, sizeof(dir));
    e2e_slots_free(app);
    free_e2e_app(app);
    e2e_store *held;
    char err[256];
    CHECK(e2e_store_open(dir, &held, err, sizeof(err)) == E2E_STORE_OK);

    app = e2e_app("user:busy2");
    e2e_peek_modes(app, "azzurra");
    e2e_enqueue(app, JOB_E2E_SYNC, "azzurra");
    add_window_ex(app, "azzurra", "alice", true);
    type_line(app, "while busy");
    run_jobs(app);
    CHECK(view_of(app).state == E2E_SLOT_BUSY);
    CHECK(said(app, "(failed: this device is not ready for encrypted queries here"));
    CHECK(!grappa_saw("while busy"));
    CHECK_LONG(fg.nplain, 0);
    e2e_store_close(held);
    tpeer_free(&alice);
    free_e2e_app(app);
}

/* A record that is no record: one still naming its encrypted queries
 * keeps them encrypted (and failing: the worker cannot use it); one that
 * is no JSON at all says nothing, so every query there fails closed
 * until /e2e off in it. */
static void write_record(struct app *app, const char *text) {
    struct e2e_slot s = {.network_id = app->networks[0].id};
    char dir[PATH_MAX - 16], path[PATH_MAX];
    e2e_slot_dir(app, &s, dir, sizeof(dir));
    char *mk = xasprintf("mkdir -p '%s'", dir);
    CHECK(system(mk) == 0);
    free(mk);
    snprintf(path, sizeof(path), "%s/record.json", dir);
    FILE *f = fopen(path, "wb");
    CHECK(f && fwrite(text, 1, strlen(text), f) == strlen(text));
    if (f) fclose(f);
}

TEST(a_corrupt_record_fails_closed) {
    fg_reset();
    struct app *app = e2e_app("user:corrupt1");
    write_record(app, "{\"v\":99,\"encrypted\":[\"alice\"]}");
    e2e_peek_modes(app, "azzurra");
    e2e_enqueue(app, JOB_E2E_SYNC, "azzurra");
    add_window_ex(app, "azzurra", "bob", true);
    add_window_ex(app, "azzurra", "alice", true);
    type_line(app, "still secret");
    run_jobs(app);
    CHECK(said(app, "(failed: this device is not ready for encrypted queries here"));
    CHECK(!grappa_saw("still secret"));
    CHECK_LONG(fg.nplain, 0);
    free_e2e_app(app);

    fg_reset();
    app = e2e_app("user:corrupt2");
    write_record(app, "\x01 not json");
    e2e_peek_modes(app, "azzurra");
    CHECK(said(app, "which queries on azzurra were encrypted is unknown"));
    e2e_enqueue(app, JOB_E2E_SYNC, "azzurra");
    add_window_ex(app, "azzurra", "bob", true);
    CHECK(prompt_locked(app));
    type_line(app, "for bob");
    run_jobs(app);
    CHECK(said(app, "(failed: this network's encrypted state on disk cannot be read"));
    CHECK(!grappa_saw("for bob"));
    CHECK_LONG(fg.nplain, 0);
    handle_command(app, "/e2e off");
    CHECK(said(app, "encrypted mode OFF"));
    run_jobs(app);
    CHECK(!prompt_locked(app));
    type_line(app, "for bob in clear");
    run_jobs(app);
    CHECK_LONG(fg.nplain, 1);
    free_e2e_app(app);
}

/* ── trust: SAS, the key alarm, devices (slice F) ─────────────────────── */

/* The peer's half of a SAS, scripted here from vodozemac and hand-written
 * JSON as cicchetto's sas.ts runs it — NOT through e2e.c's verifier — so
 * what it accepts is shottino's bytes judged independently: the
 * commitment, the info string, both MACs. */
typedef struct {
    vz_sas *sas;
    vz_established_sas *est;
    char key[64], their[64], tx[16];
} hpeer;

static void hp_free(hpeer *h) {
    vz_sas_free(h->sas);
    vz_established_sas_free(h->est);
    memset(h, 0, sizeof(*h));
}

static void hp_new(hpeer *h) {
    memset(h, 0, sizeof(*h));
    h->sas = vz_sas_new();
    char *k = th_vz(vz_sas_public_key(h->sas));
    snprintf(h->key, sizeof(h->key), "%s", k);
    free(k);
}

static char *hp_commitment(const char *key, const char *tx) {
    char *text = xasprintf("%s|%s", key, tx);
    uint8_t d[32];
    CHECK(vz_sha256((const uint8_t *)text, strlen(text), d) == 0);
    free(text);
    return th_vz(vz_base64_encode(d, 32));
}

static char *acct_key(vz_account *a, bool curve) {
    return th_vz(curve ? vz_account_curve25519_key(a) : vz_account_ed25519_key(a));
}

/* Our device's keys, as the peer has them. */
static char *our_key(struct app *app, bool curve) { return acct_key(app->e2e[0].rec.account, curve); }

/* The peer sends an inner message to us, through its engine. */
static void tpeer_inner(struct app *app, tpeer *p, const char *inner) {
    e2e_ctx c = tpeer_ctx(p);
    e2e_result r;
    e2e_result_init(&r);
    CHECK(e2e_send(&c, "vjt", inner, "sas", 0, NULL, &r));
    tpeer_pump(app, p, &r, 0);
}

/* The newest sas.* the peer read from us of type `t`, parsed (field `f`). */
static bool heard_field(const char *t, const char *f, char *out, size_t out_sz) {
    for (size_t i = nheard_sas; i > 0; i--) {
        json_doc *d = json_parse(heard_sas[i - 1], strlen(heard_sas[i - 1]), NULL, 0);
        const json_value *o = json_root(d);
        bool hit = json_str_is(json_get(o, "t"), t);
        if (hit) snprintf(out, out_sz, "%s", json_string(json_get(o, f)) ? json_string(json_get(o, f)) : "");
        json_free(d);
        if (hit) return true;
    }
    return false;
}

/* The info both sides derive the emoji from: A's curve|key, B's, the tx. */
static void hp_emoji(hpeer *h, const char *a_curve, const char *a_key, const char *b_curve,
                     const char *b_key, uint8_t out[7]) {
    char *info = xasprintf("irc-e2e:v1:sas:%s|%s|%s|%s|%s", a_curve, a_key, b_curve, b_key, h->tx);
    CHECK(vz_established_sas_emoji_indices(h->est, info, out) == 0);
    free(info);
}

static char *hp_mac(hpeer *h, const char *key, bool master, const char *first, const char *second) {
    char *info = xasprintf("%s%s|%s|%s", master ? "irc-e2e:v2:sas-mmac:" : "irc-e2e:v1:sas-mac:",
                           first, second, h->tx);
    char *mac = th_vz(vz_established_sas_calculate_mac(h->est, key, info));
    free(info);
    return mac;
}

static bool verified_here(struct app *app, const char *nick) {
    e2e_ctx c;
    char own[MAX_CHANNEL];
    e2e_ctx_of(app, &app->e2e[0], &c, own, sizeof(own));
    const char *m;
    bool verified = false;
    size_t trusted;
    return e2e_pinned(&c, nick, &m, &verified, &trusted) && verified;
}

static struct app *trust_app(const char *subject, tpeer *alice) {
    struct app *app = send_app(subject, "alice");
    tpeer_new(alice, "alice");
    meet(app, alice);
    nheard_sas = 0;
    return app;
}

/* As the initiator: /e2e verify alice → start, the peer accepts, keys,
 * the 7 emoji in the query are the peer's own, both confirm, the peer's
 * MASTER is verified here and ours there would be (its MACs check out). */
TEST(sas_as_initiator_verifies_the_peers_master) {
    tpeer alice;
    struct app *app = trust_app("user:sas-a", &alice);
    CHECK(!verified_here(app, "alice"));
    type_line(app, "/e2e verify");
    run_jobs(app);
    tpeer_carry(app, &alice, 1);
    char tx[16] = "";
    CHECK(heard_field("sas.start", "tx", tx, sizeof(tx)) && strlen(tx) == 11);
    CHECK(said(app, "you asked alice to compare emoji"));
    e2e_ctx c;
    char own[MAX_CHANNEL];
    e2e_ctx_of(app, &app->e2e[0], &c, own, sizeof(own));
    CHECK(e2e_waits_on_the_clock(&c));

    hpeer h;
    hp_new(&h);
    snprintf(h.tx, sizeof(h.tx), "%s", tx);
    char *commit = hp_commitment(h.key, tx);
    char *inner = xasprintf("{\"t\":\"sas.accept\",\"tx\":\"%s\",\"commitment\":\"%s\"}", tx, commit);
    tpeer_inner(app, &alice, inner);
    free(inner);
    free(commit);
    drain(app);
    tpeer_carry(app, &alice, 1);
    char akey[64] = "";
    CHECK(heard_field("sas.key", "key", akey, sizeof(akey)) && strlen(akey) == 43);
    inner = xasprintf("{\"t\":\"sas.key\",\"tx\":\"%s\",\"key\":\"%s\"}", tx, h.key);
    tpeer_inner(app, &alice, inner);
    free(inner);
    drain(app);
    h.est = vz_sas_diffie_hellman(h.sas, akey);
    h.sas = NULL;
    CHECK(h.est != NULL);
    char *ak = our_key(app, true), *ae = our_key(app, false);
    char *bk = acct_key(alice.rec.account, true), *be = acct_key(alice.rec.account, false);
    uint8_t emoji[7];
    hp_emoji(&h, ak, akey, bk, h.key, emoji);
    char line[256];
    e2e_sas_emoji_line(emoji, line, sizeof(line));
    CHECK(said(app, line));
    CHECK(said(app, "--- e2e: compare emoji with alice — does alice see these, in this order?"));
    CHECK(said(app, "/e2e verify confirm if they match, /e2e verify cancel if not"));
    CHECK_LONG(said_count(app, line), 1);

    type_line(app, "/e2e verify confirm");
    run_jobs(app);
    CHECK(said(app, "you confirmed the emoji; waiting for alice to confirm"));
    CHECK(!verified_here(app, "alice"));
    tpeer_carry(app, &alice, 1);
    char mac[64] = "", mmac[64] = "";
    CHECK(heard_field("sas.mac", "mac", mac, sizeof(mac)));
    CHECK(heard_field("sas.mac", "mmac", mmac, sizeof(mmac)));
    char *want = hp_mac(&h, ae, false, ak, bk);
    CHECK_STR(mac, want);
    free(want);
    want = hp_mac(&h, app->e2e[0].rec.own->master, true, ak, bk);
    CHECK_STR(mmac, want);
    free(want);

    char *bmac = hp_mac(&h, be, false, bk, ak);
    char *bmmac = hp_mac(&h, alice.rec.own->master, true, bk, ak);
    inner = xasprintf("{\"t\":\"sas.mac\",\"tx\":\"%s\",\"mac\":\"%s\",\"mmac\":\"%s\"}", tx, bmac, bmmac);
    tpeer_inner(app, &alice, inner);
    free(inner);
    free(bmac);
    free(bmmac);
    drain(app);
    CHECK(verified_here(app, "alice"));
    char words[MAX_LINE];
    snprintf(words, sizeof(words), "alice's key %s is verified — the emoji matched",
             alice.rec.own->master);
    CHECK(said(app, words));
    e2e_ctx_of(app, &app->e2e[0], &c, own, sizeof(own));
    CHECK(app->e2e[0].rec.state.nsas == 0);
    /* /e2e who says so; a second /e2e verify does not start another. */
    type_line(app, "/e2e who");
    run_jobs(app);
    CHECK(said(app, "— verified, 1 device trusted"));
    CHECK(said(app, "last emoji comparison: matched"));
    type_line(app, "/e2e verify");
    run_jobs(app);
    CHECK(said(app, "alice's key is verified already"));
    free(ak);
    free(ae);
    free(bk);
    free(be);
    hp_free(&h);
    tpeer_free(&alice);
    free_e2e_app(app);
}

/* As the responder: the peer's start is a loud request, accepted by hand;
 * our commitment is to the key we then show; the peer MACs first and the
 * verification waits for our human. */
TEST(sas_as_responder_waits_for_its_human) {
    tpeer alice;
    struct app *app = trust_app("user:sas-b", &alice);
    hpeer h;
    hp_new(&h);
    snprintf(h.tx, sizeof(h.tx), "q83vEjRWeJA");
    tpeer_inner(app, &alice, "{\"t\":\"sas.start\",\"tx\":\"q83vEjRWeJA\"}");
    drain(app);
    CHECK(said(app, "*** alice wants to verify keys with you — /e2e verify accept | /e2e verify "
                    "cancel"));
    tpeer_carry(app, &alice, 1);
    char got[64] = "";
    CHECK(!heard_field("sas.accept", "tx", got, sizeof(got))); /* nothing before the human */
    type_line(app, "/e2e verify accept");
    run_jobs(app);
    CHECK(said(app, "accepted; exchanging keys with alice"));
    tpeer_carry(app, &alice, 1);
    char commitment[64] = "";
    CHECK(heard_field("sas.accept", "commitment", commitment, sizeof(commitment)));
    char *inner = xasprintf("{\"t\":\"sas.key\",\"tx\":\"q83vEjRWeJA\",\"key\":\"%s\"}", h.key);
    tpeer_inner(app, &alice, inner);
    free(inner);
    drain(app);
    tpeer_carry(app, &alice, 1);
    char bkey[64] = "";
    CHECK(heard_field("sas.key", "key", bkey, sizeof(bkey)));
    char *want = hp_commitment(bkey, "q83vEjRWeJA");
    CHECK_STR(commitment, want); /* B committed to the key it then sent */
    free(want);
    h.est = vz_sas_diffie_hellman(h.sas, bkey);
    h.sas = NULL;
    char *bk = our_key(app, true), *be = our_key(app, false);
    char *ak = acct_key(alice.rec.account, true), *ae = acct_key(alice.rec.account, false);
    uint8_t emoji[7];
    hp_emoji(&h, ak, h.key, bk, bkey, emoji);
    char line[256];
    e2e_sas_emoji_line(emoji, line, sizeof(line));
    CHECK(said(app, line));
    /* The peer's MACs come first: kept, nothing verified until we say. */
    char *amac = hp_mac(&h, ae, false, ak, bk);
    char *ammac = hp_mac(&h, alice.rec.own->master, true, ak, bk);
    inner = xasprintf("{\"t\":\"sas.mac\",\"tx\":\"q83vEjRWeJA\",\"mac\":\"%s\",\"mmac\":\"%s\"}",
                      amac, ammac);
    tpeer_inner(app, &alice, inner);
    free(inner);
    free(amac);
    free(ammac);
    drain(app);
    CHECK(!verified_here(app, "alice"));
    type_line(app, "/e2e verify confirm alice");
    run_jobs(app);
    CHECK(verified_here(app, "alice"));
    tpeer_carry(app, &alice, 1);
    char mac[64] = "", mmac[64] = "";
    CHECK(heard_field("sas.mac", "mac", mac, sizeof(mac)));
    CHECK(heard_field("sas.mac", "mmac", mmac, sizeof(mmac)));
    want = hp_mac(&h, be, false, bk, ak);
    CHECK_STR(mac, want);
    free(want);
    want = hp_mac(&h, app->e2e[0].rec.own->master, true, bk, ak);
    CHECK_STR(mmac, want);
    free(want);
    free(ak);
    free(ae);
    free(bk);
    free(be);
    hp_free(&h);
    tpeer_free(&alice);
    free_e2e_app(app);
}

/* The emoji differ: "cancel" on shown emoji is `mismatch`, and nothing is
 * verified; a wrong MAC from the peer is refused `mac-mismatch`. */
TEST(sas_mismatch_and_a_wrong_mac_verify_nothing) {
    tpeer alice;
    struct app *app = trust_app("user:sas-x", &alice);
    for (int round = 0; round < 2; round++) {
        nheard_sas = 0;
        hpeer h;
        hp_new(&h);
        snprintf(h.tx, sizeof(h.tx), round ? "BBBBBBBBBBB" : "AAAAAAAAAAA");
        char *inner = xasprintf("{\"t\":\"sas.start\",\"tx\":\"%s\"}", h.tx);
        tpeer_inner(app, &alice, inner);
        free(inner);
        drain(app);
        type_line(app, "/e2e verify accept");
        run_jobs(app);
        inner = xasprintf("{\"t\":\"sas.key\",\"tx\":\"%s\",\"key\":\"%s\"}", h.tx, h.key);
        tpeer_inner(app, &alice, inner);
        free(inner);
        drain(app);
        tpeer_carry(app, &alice, 1);
        char bkey[64] = "", reason[64] = "";
        CHECK(heard_field("sas.key", "key", bkey, sizeof(bkey)));
        if (round == 0) {
            type_line(app, "/e2e verify cancel");
            run_jobs(app);
            tpeer_carry(app, &alice, 1);
            CHECK(heard_field("sas.cancel", "reason", reason, sizeof(reason)));
            CHECK_STR(reason, "mismatch");
            CHECK(said(app, "emoji comparison with alice stopped: the emoji did not match"));
        } else {
            h.est = vz_sas_diffie_hellman(h.sas, bkey);
            h.sas = NULL;
            char *bk = our_key(app, true), *ak = acct_key(alice.rec.account, true);
            char *ae = acct_key(alice.rec.account, false);
            char *amac = hp_mac(&h, ae, false, ak, bk);
            char *ammac = hp_mac(&h, app->e2e[0].rec.own->master, true, ak, bk); /* wrong master */
            inner = xasprintf("{\"t\":\"sas.mac\",\"tx\":\"%s\",\"mac\":\"%s\",\"mmac\":\"%s\"}",
                              h.tx, amac, ammac);
            tpeer_inner(app, &alice, inner);
            free(inner);
            drain(app);
            type_line(app, "/e2e verify confirm");
            run_jobs(app);
            tpeer_carry(app, &alice, 1);
            CHECK(heard_field("sas.cancel", "reason", reason, sizeof(reason)));
            CHECK_STR(reason, "mac-mismatch");
            CHECK(said(app, "emoji comparison with alice stopped: the confirmation did not match"));
            free(bk);
            free(ak);
            free(ae);
            free(amac);
            free(ammac);
        }
        CHECK(!verified_here(app, "alice"));
        CHECK(app->e2e[0].rec.state.nsas == 0);
        hp_free(&h);
    }
    tpeer_free(&alice);
    free_e2e_app(app);
}

/* 600 s with no answer: the clock cancels it `timeout`, on both sides. */
TEST(sas_times_out_on_the_engines_clock) {
    tpeer alice;
    struct app *app = trust_app("user:sas-t", &alice);
    type_line(app, "/e2e verify alice");
    run_jobs(app);
    CHECK(app->e2e[0].rec.state.nsas == 1);
    CHECK(app->e2e[0].clock); /* the main loop ticks while it runs */
    app->e2e[0].rec.state.sas[0].at -= E2E_SAS_TIMEOUT_MS + 1;
    tick(app);
    CHECK(app->e2e[0].rec.state.nsas == 0);
    CHECK(said(app, "emoji comparison with alice stopped: no answer in 10 minutes"));
    tpeer_carry(app, &alice, 1);
    char reason[64] = "";
    CHECK(heard_field("sas.cancel", "reason", reason, sizeof(reason)));
    CHECK_STR(reason, "timeout");
    /* Stored: a restart reads no SAS back. */
    e2e_slots_free(app);
    e2e_record rec;
    CHECK(disk_record(app, &rec));
    CHECK(rec.state.nsas == 0);
    e2e_record_free(&rec);
    tpeer_free(&alice);
    free_e2e_app(app);
}

/* A restart mid-SAS loses the secret (memory only): the request comes
 * back from the record, and the next tick ends it `page-gone`. */
TEST(sas_restart_loses_the_secret_and_says_so) {
    tpeer alice;
    struct app *app = trust_app("user:sas-r", &alice);
    type_line(app, "/e2e verify alice");
    run_jobs(app);
    e2e_slots_free(app);
    free_e2e_app(app);
    app = e2e_app("user:sas-r");
    run_job(app, JOB_E2E_SYNC);
    CHECK(app->e2e[0].rec.state.nsas == 1);
    tick(app);
    CHECK(app->e2e[0].rec.state.nsas == 0);
    CHECK(said(app, "stopped: the page running it was closed or reloaded"));
    tpeer_free(&alice);
    free_e2e_app(app);
}

/* The alarm resolves only by hand: shown, then confirmed — the new key
 * pinned NOT verified; verifying it takes the very key pinned. */
TEST(key_alarm_resolves_only_by_an_explicit_trust) {
    fg_reset();
    struct app *app = recv_app("user:trust");
    add_window_ex(app, "azzurra", "alice", true);
    tpeer alice, mallory;
    tpeer_new(&alice, "alice");
    tpeer_new(&mallory, "alice");
    tpeer_say(app, &alice, "it is me");
    drain(app);
    tpeer_say(app, &mallory, "it is me too");
    drain(app);
    char pinned[64], presented[64];
    snprintf(pinned, sizeof(pinned), "%s", alice.rec.own->master);
    snprintf(presented, sizeof(presented), "%s", mallory.rec.own->master);
    e2e_ctx c;
    char own[MAX_CHANNEL];
    e2e_ctx_of(app, &app->e2e[0], &c, own, sizeof(own));
    const char *m;
    bool verified;
    size_t trusted;

    type_line(app, "/e2e alarm");
    run_jobs(app);
    CHECK(said(app, "key alarm open for alice"));
    type_line(app, "/e2e who");
    run_jobs(app);
    CHECK(said(app, "— key changed"));
    /* Neither a SAS nor an out-of-band verify while the alarm is open. */
    type_line(app, "/e2e verify");
    run_jobs(app);
    CHECK(said(app, "a key alarm is open for alice: answer it first"));
    CHECK(app->e2e[0].rec.state.nsas == 0);

    /* A confirm before the warning was shown takes nothing. */
    type_line(app, "/e2e trust confirm");
    run_jobs(app);
    CHECK(said(app, "To take it: /e2e trust alice confirm"));
    CHECK(e2e_pinned(&c, "alice", &m, &verified, &trusted) && strcmp(m, pinned) == 0);
    type_line(app, "/e2e trust alice confirm");
    run_jobs(app);
    CHECK(e2e_pinned(&c, "alice", &m, &verified, &trusted) && strcmp(m, presented) == 0);
    CHECK(!verified);
    char words[MAX_LINE];
    snprintf(words, sizeof(words), "alice is now pinned to the new key %s — NOT verified",
             presented);
    CHECK(said(app, words));
    type_line(app, "/e2e alarm");
    run_jobs(app);
    CHECK(said(app, "--- e2e azzurra: no key alarm open"));

    /* Verifying a key that is not the pinned one moves nothing. */
    char line[160];
    snprintf(line, sizeof(line), "/e2e verify alice %s", pinned);
    type_line(app, line);
    run_jobs(app);
    CHECK(said(app, "that is not the key pinned to alice"));
    CHECK(e2e_pinned(&c, "alice", &m, &verified, &trusted) && strcmp(m, presented) == 0 && !verified);
    snprintf(line, sizeof(line), "/e2e verify alice %s", presented);
    type_line(app, line);
    run_jobs(app);
    CHECK(e2e_pinned(&c, "alice", &m, &verified, &trusted) && strcmp(m, presented) == 0 && verified);
    snprintf(words, sizeof(words), "alice's key %s is verified (compared out of band)", presented);
    CHECK(said(app, words));

    /* A restart reads the alarm as answered: the rows say so. */
    e2e_slots_free(app);
    free_e2e_app(app);
    app = e2e_app("user:trust");
    run_job(app, JOB_E2E_SYNC);
    add_window_ex(app, "azzurra", "alice", true);
    type_line(app, "/e2e alarm");
    run_jobs(app);
    CHECK(said(app, "no key alarm open"));
    tpeer_free(&alice);
    tpeer_free(&mallory);
    free_e2e_app(app);
}

static void did_of(vz_account *a, char out[E2E_DID_LEN + 1]) {
    char *e = vz_account_ed25519_key(a);
    e2e_did(e, out);
    vz_str_free(e);
}

/* The holder lists the identity's devices and revokes one: the master
 * signs ver+1 without it, grappa drops it; this device is never offered. */
TEST(devices_listed_and_revoked_by_the_holder) {
    fg_reset();
    struct app *app = recv_app("user:devs");
    run_jobs(app);
    add_window_ex(app, "azzurra", "alice", true);
    tpeer sib;
    sibling_of(app, &sib);
    char mine[E2E_DID_LEN + 1], theirs[E2E_DID_LEN + 1];
    did_of(app->e2e[0].rec.account, mine);
    did_of(sib.rec.account, theirs);
    type_line(app, "/e2e devices");
    run_jobs(app);
    CHECK(said(app, "--- e2e devices on azzurra: list v2, 2 of 3; this device holds the master key"));
    char line[MAX_LINE];
    snprintf(line, sizeof(line), "  %s  added ", mine);
    CHECK(said(app, line));
    snprintf(line, sizeof(line), "  %s  added ", theirs);
    CHECK(said(app, line));
    CHECK(said(app, "  — this device"));
    CHECK(said(app, "/e2e revoke <did> removes a device"));

    snprintf(line, sizeof(line), "/e2e revoke %s", theirs);
    type_line(app, line);
    run_jobs(app);
    CHECK(said(app, "To revoke it: /e2e revoke"));
    pthread_mutex_lock(&fg.lock);
    CHECK_LONG(fg.ver, 2); /* nothing put before the confirm */
    pthread_mutex_unlock(&fg.lock);
    snprintf(line, sizeof(line), "/e2e revoke %s confirm", theirs);
    type_line(app, line);
    run_jobs(app);
    snprintf(line, sizeof(line), "device %s revoked — the master signed list v3 without it", theirs);
    CHECK(said(app, line));
    pthread_mutex_lock(&fg.lock);
    CHECK_LONG(fg.ver, 3);
    CHECK_LONG(fg.ndevices, 1);
    CHECK(fg_device_by_did(theirs) == NULL); /* grappa dropped it */
    pthread_mutex_unlock(&fg.lock);
    CHECK_LONG(app->e2e[0].rec.own->list_ver, 3);
    CHECK_LONG(view_of(app).list_devices, 1);
    /* Itself: refused, nothing put. */
    snprintf(line, sizeof(line), "/e2e revoke %s confirm", mine);
    type_line(app, line);
    run_jobs(app);
    CHECK(said(app, "it cannot revoke itself"));
    pthread_mutex_lock(&fg.lock);
    CHECK_LONG(fg.ver, 3);
    pthread_mutex_unlock(&fg.lock);
    /* On disk. */
    e2e_slots_free(app);
    e2e_record rec;
    CHECK(disk_record(app, &rec));
    CHECK(rec.own && rec.own->list_ver == 3 && rec.own->list_devices.n == 1);
    CHECK(rec.own && e2e_own_verify(rec.own, rec.account));
    e2e_record_free(&rec);
    tpeer_free(&sib);
    free_e2e_app(app);
}

/* A paired device lists the devices but revokes none: only the holder of
 * the master can, and nothing is put from here. */
TEST(a_paired_device_cannot_revoke) {
    struct app *app = pair_to_confirm("user:pair-revoke");
    pair_run(app, "confirm", "", 0);
    char joiner[64] = "";
    CHECK(th_join(joiner));
    th_sign(joiner, 2);
    ring(app);
    CHECK(view_of(app).state == E2E_SLOT_READY && !view_of(app).holder);
    add_window_ex(app, "azzurra", "alice", true);
    type_line(app, "/e2e devices");
    run_jobs(app);
    CHECK(said(app, "the master key is on another device"));
    CHECK(said(app, "Devices are added and revoked from the device that started this identity"));
    char holder[E2E_DID_LEN + 1];
    e2e_did(th.e, holder);
    char line[96];
    snprintf(line, sizeof(line), "/e2e revoke %s confirm", holder);
    size_t puts = 0;
    pthread_mutex_lock(&fg.lock);
    for (const char *p = fg.log; (p = strstr(p, "PUT /networks/azzurra/e2e/list")); p++) puts++;
    pthread_mutex_unlock(&fg.lock);
    type_line(app, line);
    run_jobs(app);
    CHECK(said(app, "only the device holding the master key can remove devices"));
    /* The worker refuses too, whatever reaches it. */
    e2e_send_enqueue(app, "azzurra", "", "revoke", holder, 0);
    run_jobs(app);
    size_t after = 0;
    pthread_mutex_lock(&fg.lock);
    for (const char *p = fg.log; (p = strstr(p, "PUT /networks/azzurra/e2e/list")); p++) after++;
    pthread_mutex_unlock(&fg.lock);
    CHECK_LONG(after, puts);
    free_pair_app(app);
}

/* ── order challenges (slice G) ──────────────────────────────────────── */

/* The bot's CHAL for `body` in `channel` on `network`. */
static void bot_challenges(struct app *app, tpeer *bot, const char *network, const char *channel,
                           const char *body, const char *nonce, int64_t expires_at) {
    char sha[65];
    e2e_line_sha256(body, strlen(body), sha);
    char *inner = e2e_inner_chal(network, channel, "vjt!v@host", sha, nonce, expires_at);
    tpeer_inner(app, bot, inner);
    free(inner);
    drain(app);
    run_jobs(app);
}

/* The 005 edge as grappa pushes it (isupport_changed), with `extra`
 * fields appended to the required head, through the client's own door. */
static void isupport_edge(struct app *app, const char *extra) {
    char text[512];
    snprintf(text, sizeof(text),
             "[null,null,\"grappa:user:vjt\",\"event\",{\"kind\":\"isupport_changed\","
             "\"network_id\":%d,\"chanmodes_a\":[],\"chanmodes_b\":[],\"chanmodes_c\":[],"
             "\"chanmodes_d\":[],\"prefix\":{\"o\":\"@\"}%s}]",
             app->networks[0].id, extra);
    json_doc *d = json_parse(text, strlen(text), NULL, 0);
    struct wire_frame f;
    struct wire_event ev;
    CHECK(d && wire_frame_split(json_root(d), &f) && wire_narrow(f.payload, &ev));
    if (d && wire_frame_split(json_root(d), &f) && wire_narrow(f.payload, &ev))
        handle_wire_event(app, f.network, &ev);
    json_free(d);
}

/* A plaintext channel line this client sent, challenged by a bot whose key
 * we verified: ACKed with its nonce, to the bot's device, with the CHAL's
 * deadline. A line we did not send, an unverified bot, another network
 * token: no ACK, and the identity-check line says why. */
TEST(an_order_challenge_is_acked_only_for_a_line_we_sent) {
    struct app *app = send_app("user:chal", "bot");
    snprintf(app->networks[0].network_name, sizeof(app->networks[0].network_name), "Azzurra");
    tpeer bot;
    tpeer_new(&bot, "bot");
    meet(app, &bot);
    nheard_ack = 0;
    add_window_ex(app, "azzurra", "#grappa", true);
    type_line(app, "!op vjt");
    run_jobs(app);
    CHECK(grappa_saw("!op vjt"));
    int64_t exp = (int64_t)time(NULL) + 20;

    /* Not verified yet: nothing goes, the check failed. */
    size_t before = fg.nsent;
    bot_challenges(app, &bot, "Azzurra", "#grappa", "!op vjt", "nonce-0", exp);
    CHECK(said(app, "identity check ✗ failed — bot asked to confirm a line in #grappa on "
                    "Azzurra: not confirmed, their key is not verified here"));
    CHECK_LONG(posted(before, "msg", NULL) + posted(before, "pkmsg", NULL), 0);

    char line[160];
    snprintf(line, sizeof(line), "/e2e verify bot %s", bot.rec.own->master);
    type_line(app, line);
    run_jobs(app);

    /* Verified, the line ours: one ACK, with that nonce and deadline. */
    before = fg.nsent;
    bot_challenges(app, &bot, "Azzurra", "#Grappa", "!op vjt", "nonce-1", exp);
    CHECK(said(app, "[azzurra/bot] " E2E_LOCK " --- e2e: identity check ✓ passed — bot asked to "
                    "confirm your line in #Grappa on Azzurra; confirmed"));
    const char *ack = NULL;
    CHECK_LONG(posted(before, "msg", &ack), 1);
    char deadline[48];
    snprintf(deadline, sizeof(deadline), "\"expires_at\":%lld", (long long)exp);
    CHECK(ack && strstr(ack, deadline));
    tpeer_carry(app, &bot, 1);
    CHECK_LONG(nheard_ack, 1);
    CHECK_STR(heard_ack[0], "nonce-1");
    /* Never a row of the encrypted history. */
    CHECK(!said(app, "nonce-1"));

    /* A line we never sent (another client's, or the echo of one): no ACK. */
    before = fg.nsent;
    bot_challenges(app, &bot, "Azzurra", "#grappa", "!deop vjt", "nonce-2", exp);
    CHECK(said(app, "identity check – not answered here — bot asked to confirm a line in "
                    "#grappa on Azzurra that this device did not send"));
    CHECK_LONG(posted(before, "msg", NULL), 0);
    /* The same line under a second nonce is not confirmed twice. */
    bot_challenges(app, &bot, "Azzurra", "#grappa", "!op vjt", "nonce-3", exp);
    CHECK_LONG(posted(before, "msg", NULL), 0);
    /* Another network's token, and a PM to someone else: no ACK. */
    type_line(app, "!voice vjt");
    run_jobs(app);
    bot_challenges(app, &bot, "AzzurraNet", "#grappa", "!voice vjt", "nonce-4", exp);
    CHECK(said(app, "not confirmed, it names another network"));
    bot_challenges(app, &bot, "Azzurra", "alice", "!voice vjt", "nonce-5", exp);
    CHECK(said(app, "not confirmed, it names a private message to someone other than the bot"));
    /* Expired by our clock. */
    bot_challenges(app, &bot, "Azzurra", "#grappa", "!voice vjt", "nonce-6",
                   (int64_t)time(NULL) - 1);
    CHECK(said(app, "not confirmed, it has expired by this device's clock"));
    CHECK_LONG(posted(before, "msg", NULL), 0);
    /* Still there for a live, well-named CHAL. */
    bot_challenges(app, &bot, "Azzurra", "#grappa", "!voice vjt", "nonce-7", exp);
    CHECK_LONG(posted(before, "msg", NULL), 1);

    /* A sigil the network does not advertise (CHANTYPES=# here) names no
     * channel: "&local" is then a private message to someone else, even
     * though the RFC class would have read it as a channel. */
    isupport_edge(app, ",\"frame_budget_base\":394,\"network\":\"Azzurra\",\"chantypes\":[\"#\"]");
    CHECK(app->networks[0].has_chantypes);
    CHECK_STR(app->networks[0].chantypes, "#");
    add_window_ex(app, "azzurra", "&local", true);
    type_line(app, "!op amp");
    run_jobs(app);
    bot_challenges(app, &bot, "Azzurra", "&local", "!op amp", "nonce-9", exp);
    CHECK(said(app, "identity check ✗ failed — bot asked to confirm a line in &local on Azzurra: "
                    "not confirmed, it names a private message to someone other than the bot"));
    CHECK_LONG(posted(before, "msg", NULL), 1);
    /* Unknown (no CHANTYPES on the wire): the RFC class, so it is one. */
    isupport_edge(app, ",\"frame_budget_base\":394,\"network\":\"Azzurra\"");
    CHECK(!app->networks[0].has_chantypes);
    type_line(app, "!op amp2");
    run_jobs(app);
    bot_challenges(app, &bot, "Azzurra", "&local", "!op amp2", "nonce-10", exp);
    CHECK_LONG(posted(before, "msg", NULL), 2);
    add_window_ex(app, "azzurra", "#grappa", true);

    /* No NETWORK= advertised: nothing to match against. */
    app->networks[0].network_name[0] = 0;
    type_line(app, "!kick x");
    run_jobs(app);
    bot_challenges(app, &bot, "Azzurra", "#grappa", "!kick x", "nonce-8", exp);
    CHECK(said(app, "this network has sent no 005 NETWORK= name"));
    CHECK_LONG(posted(before, "msg", NULL), 2);
    tpeer_free(&bot);
    free_e2e_app(app);
}

/* ── consent requests (slice G) ─────────────────────────────────────── */

/* What grappa pushes for request `id` as it now holds it (or a gone). */
static void push_request(struct app *app, long id) {
    pthread_mutex_lock(&fg.lock);
    ssize_t i = fg_req_index_locked(id);
    char *r = i >= 0 ? fg_req_json_locked((size_t)i) : NULL;
    pthread_mutex_unlock(&fg.lock);
    if (!r) return;
    char *frame = xasprintf("{\"kind\":\"e2e_request\",\"network\":\"azzurra\",\"request\":%s}", r);
    json_doc *d = json_parse(frame, strlen(frame), NULL, 0);
    struct wire_event ev;
    CHECK(d && wire_narrow(json_root(d), &ev) && ev.kind == WIRE_E2E_REQUEST);
    e2e_request_push(app, ev.u.e2e_request.network, &ev.u.e2e_request.request);
    json_free(d);
    free(frame);
    free(r);
}

static bool req_body(const char *needle) {
    pthread_mutex_lock(&fg.lock);
    bool found = strstr(fg.req_bodies, needle) != NULL;
    pthread_mutex_unlock(&fg.lock);
    return found;
}

/* A peer asks: the query says so; /e2e accept answers with our line, turns
 * the query encrypted and asks for their keys, and messages flow both ways. */
TEST(an_incoming_request_is_accepted_and_messages_flow) {
    struct app *app = send_app("user:consent-in", "alice");
    tpeer alice;
    tpeer_new(&alice, "alice");
    long id = fg_req_add("alice", "incoming", "2099-01-01T00:00:00Z");
    push_request(app, id);
    CHECK(said(app, "[azzurra/alice] *** e2e: alice would like to start an encrypted chat with "
                    "you — /e2e accept alice | /e2e refuse alice"));
    /* The same request pushed again says nothing new. */
    push_request(app, id);
    CHECK_LONG(said_count(app, "would like to start an encrypted chat"), 1);
    type_line(app, "/e2e requests");
    CHECK(said(app, "e2e request azzurra: alice asks to start an encrypted chat"));
    CHECK(!prompt_locked(app));

    size_t before = fg.nsent;
    type_line(app, "/e2e accept");
    run_jobs(app);
    char path[64];
    snprintf(path, sizeof(path), "POST /%ld/accept {\"from\":\"%s\"", id, our_did(app));
    CHECK(req_body(path));
    CHECK(req_body("\"payload\":\"{\\\"v\\\":2,\\\"master\\\":\\\""));
    CHECK(said(app, "you accepted alice's encrypted chat"));
    CHECK(said(app, "this query is in encrypted mode now"));
    CHECK(prompt_locked(app));
    CHECK_LONG(posted(before, "keyreq", NULL), 1);
    CHECK_LONG(fg.nreq, 0);
    type_line(app, "/e2e requests");
    CHECK(said(app, "e2e requests: none"));

    /* Keys come; what we type goes encrypted, what alice says reads. */
    tpeer_carry(app, &alice, 1);
    drain(app);
    type_line(app, "hello after consent");
    run_jobs(app);
    tpeer_carry(app, &alice, 1);
    CHECK_STR(heard[0], "hello after consent");
    tpeer_say(app, &alice, "glad you agreed");
    drain(app);
    CHECK(said(app, LOCKED("<alice> glad you agreed")));
    CHECK(!grappa_saw("hello after consent"));
    tpeer_free(&alice);
    free_e2e_app(app);
}

/* Refusing goes with no line (grappa says no for us), and needs no
 * identity; a request gone is dropped without a word; one past its
 * deadline is no longer offered. */
TEST(an_incoming_request_is_refused_or_goes) {
    struct app *app = send_app("user:consent-no", "bob");
    long id = fg_req_add("bob", "incoming", "2099-01-01T00:00:00Z");
    run_job(app, JOB_E2E_SYNC); /* the sync reads the requests */
    CHECK(said(app, "bob would like to start an encrypted chat with you"));
    type_line(app, "/e2e refuse bob");
    run_jobs(app);
    char line[64];
    snprintf(line, sizeof(line), "POST /%ld/refuse -", id);
    CHECK(req_body(line));
    CHECK(said(app, "you refused bob's encrypted chat; bob is told"));
    CHECK(!prompt_locked(app));
    /* Nothing waits now: accept and refuse say so, and send nothing. */
    type_line(app, "/e2e accept bob");
    run_jobs(app);
    CHECK(said(app, "bob has not asked for an encrypted chat"));
    CHECK(!req_body("/accept"));

    /* Gone: dropped, nothing said. */
    long gone = fg_req_add("carol", "incoming", "2099-01-01T00:00:00Z");
    push_request(app, gone);
    CHECK(said(app, "carol would like to start"));
    char *frame = xasprintf("{\"kind\":\"e2e_request_gone\",\"network\":\"azzurra\",\"id\":%ld}",
                            gone);
    json_doc *d = json_parse(frame, strlen(frame), NULL, 0);
    struct wire_event ev;
    CHECK(d && wire_narrow(json_root(d), &ev) && ev.kind == WIRE_E2E_REQUEST_GONE);
    e2e_request_gone(app, ev.u.e2e_request_gone.network, ev.u.e2e_request_gone.id);
    json_free(d);
    free(frame);
    type_line(app, "/e2e requests");
    CHECK(said(app, "e2e requests: none"));

    /* An incoming request past its deadline shows nothing. */
    long late = fg_req_add("dave", "incoming", "2000-01-01T00:00:00Z");
    push_request(app, late);
    CHECK(!said(app, "dave would like"));
    free_e2e_app(app);
}

/* Our asking: pending, with our line; the peer's accept (a push) opens the
 * query encrypted, asks for their keys and dismisses the request; a
 * refusal is shown and dismissed; a pending one is withdrawn with a line. */
TEST(an_outgoing_request_waits_then_is_accepted) {
    struct app *app = send_app("user:consent-out", "alice");
    type_line(app, "/e2e ask");
    CHECK(said(app, "asking alice to start an encrypted chat"));
    run_jobs(app);
    CHECK(req_body("POST / {\"target\":\"alice\",\"from\":\""));
    CHECK(said(app, "[azzurra/alice] --- e2e: waiting for alice to accept the encrypted chat"));
    CHECK(!prompt_locked(app));
    CHECK_LONG(fg.nreq, 1);
    long id = fg.req[0].id;

    pthread_mutex_lock(&fg.lock);
    snprintf(fg.req[0].state, sizeof(fg.req[0].state), "accepted");
    pthread_mutex_unlock(&fg.lock);
    size_t before = fg.nsent;
    push_request(app, id);
    CHECK(said(app, "alice accepted the encrypted chat"));
    run_jobs(app);
    CHECK(prompt_locked(app));
    CHECK_LONG(posted(before, "keyreq", NULL), 1);
    char line[64];
    snprintf(line, sizeof(line), "DELETE /%ld -", id);
    CHECK(req_body(line));
    CHECK_LONG(fg.nreq, 0);
    /* The same accepted request read again by a later GET opens nothing. */
    run_jobs(app);
    CHECK_LONG(posted(before, "keyreq", NULL), 1);

    /* bob refuses ours: shown; /e2e cancel dismisses it with no line. */
    add_window_ex(app, "azzurra", "bob", true);
    type_line(app, "/e2e ask bob");
    run_jobs(app);
    long bid = fg.req[0].id;
    pthread_mutex_lock(&fg.lock);
    snprintf(fg.req[0].state, sizeof(fg.req[0].state), "refused");
    pthread_mutex_unlock(&fg.lock);
    push_request(app, bid);
    CHECK(said(app, "bob refused the encrypted chat"));
    type_line(app, "/e2e cancel");
    run_jobs(app);
    snprintf(line, sizeof(line), "DELETE /%ld -", bid);
    CHECK(req_body(line));
    CHECK(said(app, "request dismissed"));

    /* A pending one withdrawn: CANCEL carries our line. */
    type_line(app, "/e2e ask bob");
    run_jobs(app);
    long cid = fg.req[0].id;
    type_line(app, "/e2e cancel bob");
    run_jobs(app);
    snprintf(line, sizeof(line), "DELETE /%ld {\"from\":\"%s\"", cid, our_did(app));
    CHECK(req_body(line));
    CHECK(said(app, "you withdrew the encrypted chat request"));
    CHECK_LONG(fg.nreq, 0);
    free_e2e_app(app);
}

/* Below protocol 53 nothing is asked, read or answered. */
TEST(consent_needs_protocol_53) {
    struct app *app = send_app("user:consent-old", "alice");
    app->server_protocol = 52;
    pthread_mutex_lock(&fg.lock);
    fg.req_bodies[0] = 0;
    pthread_mutex_unlock(&fg.lock);
    type_line(app, "/e2e ask");
    run_jobs(app);
    CHECK(said(app, "encrypted chat requests need server protocol v53"));
    run_job(app, JOB_E2E_SYNC);
    long id = fg_req_add("alice", "incoming", "2099-01-01T00:00:00Z");
    push_request(app, id);
    CHECK(!said(app, "would like to start"));
    CHECK_STR(fg.req_bodies, "");
    free_e2e_app(app);
}

int main(void) {
    test_use_temp_home();
    if (!fg_start()) {
        FAIL("cannot start the fake grappa on loopback");
        return test_report();
    }
    RUN(no_identity_is_left_alone);
    RUN(init_makes_this_device_the_first);
    RUN(sync_tops_the_bundle_up);
    RUN(lost_list_is_relisted_by_the_holder);
    RUN(identity_elsewhere_is_never_touched);
    RUN(failed_enlist_rolls_back_and_never_deletes_others);
    RUN(a_held_device_is_not_fought);
    RUN(an_old_server_keeps_e2e_off);
    RUN(the_command_reads_its_arguments);
    RUN(pairing_joins_an_identity_end_to_end);
    RUN(pairing_refuses_a_device_already_in_the_identity);
    RUN(pairing_decline);
    RUN(pairing_closed_by_the_holder_drops_the_device);
    RUN(pairing_times_out);
    RUN(pairing_refuses_tampered_messages);
    RUN(pairing_refusals_are_explained);
    RUN(pairing_command);
    RUN(drain_shows_a_peers_pkmsg_then_msg);
    RUN(history_comes_back_after_a_restart);
    RUN(a_decrypted_body_cannot_draw_a_line_of_its_own);
    RUN(a_message_read_twice_writes_one_row);
    RUN(an_undecryptable_message_is_nacked_and_said);
    RUN(a_key_alarm_is_loud_and_pins_nothing);
    RUN(sas_as_initiator_verifies_the_peers_master);
    RUN(sas_as_responder_waits_for_its_human);
    RUN(sas_mismatch_and_a_wrong_mac_verify_nothing);
    RUN(sas_times_out_on_the_engines_clock);
    RUN(sas_restart_loses_the_secret_and_says_so);
    RUN(key_alarm_resolves_only_by_an_explicit_trust);
    RUN(devices_listed_and_revoked_by_the_holder);
    RUN(a_paired_device_cannot_revoke);
    RUN(a_copy_from_a_sibling_reads_as_ours);
    RUN(copying_to_a_new_sibling_claims_first);
    RUN(the_doorbell_rings_for_this_device_once);
    RUN(a_typed_line_in_an_encrypted_query_goes_encrypted);
    RUN(a_long_line_is_sized_on_the_networks_budget);
    RUN(a_line_past_a_clear_lines_size_goes_whole_when_encrypted);
    RUN(a_peer_with_two_devices_gets_one_payload_two_bodies);
    RUN(no_keys_fails_the_row_and_nothing_goes_in_clear);
    RUN(a_full_table_refuses_a_new_message_and_keeps_every_pending_one);
    RUN(a_record_that_cannot_be_stored_after_a_send_is_said);
    RUN(a_nack_rekeys_and_resends_once_then_fails);
    RUN(a_nack_from_star_asks_the_user);
    RUN(a_dropped_send_fails_and_resend_sends_it_again);
    RUN(the_peer_turns_it_on_and_only_off_turns_it_off);
    RUN(no_model_tool_reads_an_encrypted_row);
    RUN(an_encrypted_link_is_not_remembered_for_preview);
    RUN(an_attachment_is_refused_before_it_is_uploaded_to_an_encrypted_query);
    RUN(a_ctcp_body_never_goes_in_clear_to_an_encrypted_query);
    RUN(a_sent_text_is_copied_to_our_sibling);
    RUN(emsg_sends_one_encrypted_message);
    RUN(a_line_typed_before_the_slot_loads_never_goes_in_clear);
    RUN(a_busy_slot_fails_closed);
    RUN(a_corrupt_record_fails_closed);
    RUN(an_order_challenge_is_acked_only_for_a_line_we_sent);
    RUN(an_incoming_request_is_accepted_and_messages_flow);
    RUN(an_incoming_request_is_refused_or_goes);
    RUN(an_outgoing_request_waits_then_is_accepted);
    RUN(consent_needs_protocol_53);
    th_free();
    fg_stop();
    return test_report();
}
