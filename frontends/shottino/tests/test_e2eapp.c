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
    size_t nsent;
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
    fg.acks[0] = 0;
    fg.watch_dir[0] = 0;
    fg.nack_disk = 0;
    fg.log[0] = 0;
    fg.requests = 0;
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
static void fg_watch_locked(void) {
    if (!fg.watch_dir[0] || fg.nack_disk >= 16) return;
    char *path = xasprintf("%s/record.json", fg.watch_dir);
    FILE *f = fopen(path, "r");
    free(path);
    long inbox = -1;
    if (f) {
        static char buf[1 << 20];
        size_t n = fread(buf, 1, sizeof(buf), f);
        fclose(f);
        e2e_record rec;
        if (e2e_record_from_json(buf, n, &rec)) {
            inbox = rec.state.inbox;
            e2e_record_free(&rec);
        }
    }
    char *dir = xasprintf("%s/chats", fg.watch_dir);
    e2e_rows rows;
    size_t nrows = 0;
    if (e2e_chat_load(dir, &rows, NULL, 0)) nrows = rows.n;
    e2e_rows_free(&rows);
    free(dir);
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
static char *fg_handle(const char *method, const char *path, const char *body, int *status) {
    const char *prefix = "/networks/azzurra/e2e";
    *status = 200;
    if (strcmp(path, "/api/config") == 0) return xasprintf("{\"protocol_version\":59}");
    if (strncmp(path, "/e2e/pairings", 13) == 0) return fg_pairing(method, path + 13, body, status);
    if (strncmp(path, prefix, strlen(prefix)) != 0) FG_ERR(404, "not_found");
    const char *rest = path + strlen(prefix);
    json_doc *doc = body && body[0] ? json_parse(body, strlen(body), NULL, 0) : NULL;
    const json_value *root = doc ? json_root(doc) : NULL;
    char *out = NULL;

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
        fg.sent[fg.nsent++] = xasprintf("%s", body);
        char msgid[12];
        fg_msgid(msgid);
        *status = 202;
        out = xasprintf("{\"msgid\":\"%s\"}", msgid);
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

static void tpeer_say(struct app *app, tpeer *p, const char *text) {
    e2e_ctx c = tpeer_ctx(p);
    e2e_result r;
    e2e_result_init(&r);
    char *inner = e2e_inner_text(text, strlen(text));
    CHECK(e2e_send(&c, "vjt", inner, "t", 0, NULL, &r));
    free(inner);
    tpeer_pump(app, p, &r, 0);
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

    drain(app);
    CHECK_LONG(app->e2e[0].rec.own->list_ver, 2);
    CHECK(said(app, LOCKED("<vjt> sent from my phone")));
    CHECK(has_window(app, "alice"));
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
    RUN(a_message_read_twice_writes_one_row);
    RUN(an_undecryptable_message_is_nacked_and_said);
    RUN(a_key_alarm_is_loud_and_pins_nothing);
    RUN(a_copy_from_a_sibling_reads_as_ours);
    RUN(copying_to_a_new_sibling_claims_first);
    RUN(the_doorbell_rings_for_this_device_once);
    th_free();
    fg_stop();
    return test_report();
}
