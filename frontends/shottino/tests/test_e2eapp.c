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
 */
#define main shottino_main_unused
#include "../shottino.c"
#undef main

#include "test.h"

/* ── the fake grappa ──────────────────────────────────────────────────── */

#define FG_MAX_DEV 8

typedef struct {
    char did[16], ed[64], curve[64], sig[128];
    long otks;
    bool fallback;
} fg_device;

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
    /* every request, "METHOD path\n" */
    char log[16384];
    size_t requests;
} fg;

static void fg_reset(void) {
    pthread_mutex_lock(&fg.lock);
    fg.has_list = false;
    fg.ndevices = 0;
    fg.ndev = 0;
    fg.fail_put_status = 0;
    fg.fail_upload_status = 0;
    fg.log[0] = 0;
    fg.requests = 0;
    pthread_mutex_unlock(&fg.lock);
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

/* One request, under fg.lock. Returns the body (malloc'd, may be "") and
 * sets the status. */
static char *fg_handle(const char *method, const char *path, const char *body, int *status) {
    const char *prefix = "/networks/azzurra/e2e";
    *status = 200;
    if (strcmp(path, "/api/config") == 0) return xasprintf("{\"protocol_version\":59}");
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
            if (json_type_of(fb) == JSON_OBJECT) d->fallback = true;
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
    fg_stop();
    return test_report();
}
