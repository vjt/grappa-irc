/* test_call — the helpers that decide WHO is in a call.
 *
 * Everything here is on the path from "two people typed /call" to "two
 * processes publish to the same URL". The failure mode they share is
 * silence: nothing errors, both ends connect, and each hears nobody —
 * because the two ends derived different paths, or worse, because two
 * different people derived the SAME one and landed in one room.
 *
 * `call_path_nick` is the sharp one. Its own comment says ESCAPE, do not
 * squash, and that is not style: mapping `[ ] \ ` ^ { | }` to `_` would
 * make `foo[1]` and `foo{1}` one room. It is the same invariant the rest
 * of this tree spells `canonical_target` — only KEYs fold, the fold is
 * ASCII `A-Z` and nothing else, and a fold one byte too wide merges two
 * identities without saying so.
 *
 * The call helpers already covered by test_windows (invite build/split,
 * the peer list, the ring policy) stay there; this suite is the
 * identity-and-exec family that had no test at all.
 *
 * Like test_layout, test_commands and test_windows, it compiles
 * shottino.c itself — these are static functions in the app binary. It
 * also links call/media.c, which is the OTHER binary: the codec word
 * shottino puts in the helper's argv is only correct if the helper's own
 * parser accepts it, and no assertion on shottino alone can say that. */
#define main shottino_main_unused
#include "../shottino.c"
#undef main

#include "../call/media.h"
#include "test.h"

#include <sys/stat.h>

static struct app *call_app(const char *nick) {
    struct app *app = calloc(1, sizeof(*app));
    if (!app) return NULL;
    pthread_mutex_init(&app->lock, NULL);
    snprintf(app->subject, sizeof(app->subject), "user:%s", nick);
    struct network *n = &app->networks[app->network_count++];
    snprintf(n->slug, sizeof(n->slug), "azzurra");
    snprintf(n->nick, sizeof(n->nick), "%s", nick);
    n->id = 1;
    return app;
}

static void call_app_free(struct app *app) {
    pthread_mutex_destroy(&app->lock);
    free(app);
}

/* ── the path segment ──────────────────────────────────────────────── */

TEST(a_nick_folds_to_one_path_and_two_people_never_fold_to_one) {
    char out[128];

    /* FOLD, because IRC says `Alice` and `alice` are one person and two
     * paths would be two halves of one conversation. */
    call_path_nick("Alice", out, sizeof(out));
    CHECK_STR(out, "alice");
    call_path_nick("VJT", out, sizeof(out));
    CHECK_STR(out, "vjt");

    /* ESCAPE, do not squash. Every character IRC lets into a nick and a
     * URL does not, spelled out: a `_` for each of these would be
     * simpler and would put all of them in one room. */
    static const struct {
        const char *nick;
        const char *path;
    } specials[] = {
        { "foo[1]", "foo%5b1%5d" }, { "foo{1}", "foo%7b1%7d" }, { "a\\b", "a%5cb" },
        { "a`b", "a%60b" },         { "a^b", "a%5eb" },         { "a|b", "a%7cb" },
        { "a-b_c.d~e", "a-b_c.d~e" },
    };
    for (size_t i = 0; i < sizeof(specials) / sizeof(specials[0]); i++) {
        call_path_nick(specials[i].nick, out, sizeof(out));
        CHECK_STR(out, specials[i].path);
    }

    /* The pair the comment names, stated as the thing that must not
     * happen rather than as two encodings that happen to differ. On
     * CASEMAPPING=ascii these are two people (#525), and the ircd will
     * happily seat both in the channel the call was started from. */
    char bracket[64], brace[64];
    call_path_nick("foo[1]", bracket, sizeof(bracket));
    call_path_nick("foo{1}", brace, sizeof(brace));
    CHECK(strcmp(bracket, brace) != 0);

    /* Non-ASCII is bytes, and the fold is `A-Z` — not tolower(), whose
     * answer for a byte above 127 is the locale's business. Two nicks
     * that differ only in a non-ASCII case pair stay two nicks, and a
     * fold wide enough to merge them here would merge them in a room. */
    char lower[64], upper[64];
    call_path_nick("caf\xc3\xa9", lower, sizeof(lower)); /* café */
    call_path_nick("CAF\xc3\x89", upper, sizeof(upper)); /* CAFÉ */
    CHECK_STR(lower, "caf%c3%a9");
    CHECK_STR(upper, "caf%c3%89");
    CHECK(strcmp(lower, upper) != 0);

    /* A nick we never had is an empty segment, not a crash: the call
     * site passes `query ? channel : ""` for the far end of a channel
     * call. */
    call_path_nick("", out, sizeof(out));
    CHECK_STR(out, "");
    call_path_nick(NULL, out, sizeof(out));
    CHECK_STR(out, "");
}

/* Every `%XX` in `s` is complete. A segment cut mid-escape is not a
 * shorter name, it is a name the far end cannot have derived. */
static bool escapes_are_whole(const char *s) {
    for (const char *p = s; *p; p++) {
        if (*p != '%') continue;
        if (!isxdigit((unsigned char)p[1]) || !isxdigit((unsigned char)p[2])) return false;
        p += 2;
    }
    return true;
}

TEST(a_nick_that_does_not_fit_is_cut_between_escapes_and_never_past_the_end) {
    /* Held against the whole encoding: a short buffer must yield a
     * PREFIX of it. Dropping the byte that did not fit and carrying on
     * with the next one would also produce a shorter string — and would
     * map `a[b` and `ab` to the same path. */
    const char *nick = "a[b]c\xc3\xa9";
    char full[64];
    call_path_nick(nick, full, sizeof(full));
    CHECK_STR(full, "a%5bb%5dc%c3%a9");

    /* Exactly-sized heap buffers, so ASan is the bounds assertion: an
     * off-by-one in either `n + 2 > out_sz` or `n + 4 > out_sz` writes
     * the terminator one past the end, and this loop is where it lands. */
    for (size_t sz = 1; sz <= strlen(full) + 2; sz++) {
        char *out = malloc(sz);
        CHECK(out != NULL);
        if (!out) break;
        call_path_nick(nick, out, sz);
        CHECK(strlen(out) < sz);
        CHECK(escapes_are_whole(out));
        CHECK(strncmp(out, full, strlen(out)) == 0);
        free(out);
    }

    /* A zero-length buffer is not written to at all — the caller may
     * have handed us the tail of a full one. */
    char *none = malloc(1);
    CHECK(none != NULL);
    if (none) {
        none[0] = 'Z';
        call_path_nick("abc", none, 0);
        CHECK_LONG(none[0], 'Z');
        free(none);
    }

    /* The headroom the call sites rely on. Every one of them encodes
     * into a `char pn[128]`, and the encoder can triple its input, so
     * the longest nick that certainly survives is 42 bytes. That is
     * comfortably past NICKLEN on the ircds this talks to — bahamut and
     * solanum both cap well under it, and both keep nicks ASCII — and
     * this is the assertion that notices if either number moves. */
    char worst[43];
    memset(worst, '[', sizeof(worst) - 1);
    worst[sizeof(worst) - 1] = 0;
    char pn[128];
    call_path_nick(worst, pn, sizeof(pn));
    CHECK_LONG(strlen(pn), (sizeof(worst) - 1) * 3);
}

TEST(the_nick_in_me_is_the_same_byte_string_as_the_nick_in_peers) {
    /* A nick with a bracket in it, because that is the one that tells
     * two encoders apart. With a plain ASCII nick both a raw copy and a
     * percent-encoder produce the same answer and the test proves
     * nothing. */
    struct app *app = call_app("vjt[m]");
    CHECK(app != NULL);
    if (!app) return;

    char invite[512];
    call_invite_build(CALL_AUDIO, "https://h/call", "shottino-1", invite, sizeof(invite));
    char posted[512];
    snprintf(posted, sizeof(posted), "%s", strchr(invite, ' ') + 1);
    call_invite_peers(app, "azzurra", "sarabean", posted, sizeof(posted));
    CHECK_STR(posted, "https://h/call/#r=shottino-1&peers=vjt%5bm%5d,sarabean");

    /* What the SAME client appends when IT opens the link: the page
     * prefills the nick from `me`, and the far end subscribes to the
     * path built from `peers`. One byte of difference between the two
     * and the browser publishes where nobody is listening. */
    char mine[512];
    call_url_for_me(app, "azzurra", posted, mine, sizeof(mine));
    CHECK(strstr(mine, "&me=vjt%5bm%5d") != NULL);
    const char *me = strstr(mine, "&me=");
    const char *peers = strstr(mine, "&peers=");
    CHECK(me != NULL && peers != NULL);
    if (me && peers) {
        me += 4;
        peers += 7;
        size_t n = strcspn(peers, ",&");
        CHECK_LONG(strlen(me), n);
        CHECK(strncmp(me, peers, n) == 0);
    }

    /* A URL that is not an invite is opened UNCHANGED. This runs on
     * every link clicked in scrollback, and appending `&me=` to
     * somebody's news article is both wrong and visible. */
    char plain[512];
    call_url_for_me(app, "azzurra", "https://example.com/article?a=1", plain, sizeof(plain));
    CHECK_STR(plain, "https://example.com/article?a=1");

    call_app_free(app);
}

/* ── the codec word ────────────────────────────────────────────────── */

TEST(the_codec_word_is_one_the_helper_itself_accepts) {
    static const enum call_vcodec all[] = { CALL_VCODEC_VP8, CALL_VCODEC_H264 };

    for (size_t i = 0; i < sizeof(all) / sizeof(all[0]); i++) {
        /* The word /set shows, the word the config file holds and the
         * word /set accepts are one pair of functions. */
        enum call_vcodec back;
        CHECK(call_vcodec_parse(call_vcodec_word(all[i]), &back));
        CHECK_LONG(back, all[i]);

        /* And the word handed to the helper's `--video-codec` is one the
         * HELPER parses — which the loop above cannot say, because this
         * side accepts strictly more spellings than the other side does.
         * `h.264` round-trips here and is refused by call/media.c, so a
         * word() that emitted it would satisfy every assertion above and
         * still put the call on the default codec while the user asked
         * for the other one. */
        enum media_video_codec helper;
        CHECK(media_video_codec_parse(call_vcodec_word(all[i]), &helper));
        CHECK_LONG(helper, all[i] == CALL_VCODEC_H264 ? MEDIA_VIDEO_H264 : MEDIA_VIDEO_VP8);
    }

    /* The spellings a person types. `h.264` is here because that is how
     * the codec is written everywhere except a command-line flag. */
    enum call_vcodec c;
    CHECK(call_vcodec_parse("H264", &c));
    CHECK_LONG(c, CALL_VCODEC_H264);
    CHECK(call_vcodec_parse("h.264", &c));
    CHECK_LONG(c, CALL_VCODEC_H264);
    CHECK(call_vcodec_parse("VP8", &c));
    CHECK_LONG(c, CALL_VCODEC_VP8);

    /* Refused, not defaulted: asking for one codec and silently getting
     * the other is the failure the enum exists to prevent. */
    CHECK(!call_vcodec_parse("h265", &c));
    CHECK(!call_vcodec_parse("vp9", &c));
    CHECK(!call_vcodec_parse("", &c));
    CHECK(!call_vcodec_parse(NULL, &c));
}

/* ── the frame the helper is told to decode to ─────────────────────── */

TEST(the_frame_box_is_never_empty_and_never_unbounded) {
    int cols = 0, rows = 0;

    /* The chrome the call window does not get to draw in: two columns of
     * border, four rows of border and status. */
    call_frame_box(80, 24, &cols, &rows);
    CHECK_LONG(cols, 78);
    CHECK_LONG(rows, 20);

    /* Capped, because this ends up as ASCII: past the cap the extra
     * pixels are decoded, sampled and thrown away, every frame. */
    call_frame_box(400, 200, &cols, &rows);
    CHECK_LONG(cols, 160);
    CHECK_LONG(rows, 60);

    /* Floored. The size is handed to the helper at exec and the reader
     * thread turns it into `cols * rows * 2 * 3` bytes per frame — a box
     * that reached zero would make that a malloc(0) the reads then fill
     * from a pipe, and a negative one an allocation of nearly SIZE_MAX. */
    call_frame_box(4, 3, &cols, &rows);
    CHECK_LONG(cols, 16);
    CHECK_LONG(rows, 6);

    for (int c = -4; c <= 400; c += 7) {
        for (int r = -4; r <= 200; r += 11) {
            call_frame_box(c, r, &cols, &rows);
            CHECK(cols >= 16 && cols <= 160);
            CHECK(rows >= 6 && rows <= 60);
        }
    }
}

/* ── finding the helper binary ─────────────────────────────────────── */

static bool write_exec(const char *path, mode_t mode) {
    FILE *f = fopen(path, "w");
    if (!f) return false;
    fputs("#!/bin/sh\nexit 0\n", f);
    fclose(f);
    return chmod(path, mode) == 0;
}

TEST(a_configured_helper_is_used_or_refused_never_quietly_replaced) {
    char dir[] = "/tmp/shottino-helper-XXXXXX";
    CHECK(mkdtemp(dir) != NULL);
    char good[PATH_MAX], plain[PATH_MAX];
    snprintf(good, sizeof(good), "%s/shottino-call", dir);
    snprintf(plain, sizeof(plain), "%s/not-executable", dir);
    CHECK(write_exec(good, 0755));
    CHECK(write_exec(plain, 0644));

    char out[PATH_MAX];

    /* An executable that fits is taken. */
    out[0] = 0;
    CHECK(call_helper_accept(good, out, sizeof(out)));
    CHECK_STR(out, good);

    /* One that is not executable is not. */
    snprintf(out, sizeof(out), "%s", "untouched");
    CHECK(!call_helper_accept(plain, out, sizeof(out)));
    CHECK_STR(out, "untouched");

    /* One that does not FIT is refused rather than shortened: a
     * truncated path names a different file, and a shorter one is quite
     * likely a directory, which passes access(X_OK). */
    snprintf(out, sizeof(out), "%s", "untouched");
    CHECK(!call_helper_accept(good, out, strlen(good)));
    CHECK_STR(out, "untouched");
    CHECK(call_helper_accept(good, out, strlen(good) + 1));

    /* Now the search. HOME and PATH both hold a usable helper, so the
     * only thing these assertions can be reading is the ORDER. */
    const char *home_saved = getenv("HOME");
    const char *path_saved = getenv("PATH");
    char home_keep[PATH_MAX], path_keep[4096];
    snprintf(home_keep, sizeof(home_keep), "%s", home_saved ? home_saved : "");
    snprintf(path_keep, sizeof(path_keep), "%s", path_saved ? path_saved : "");

    char home[] = "/tmp/shottino-home-XXXXXX";
    CHECK(mkdtemp(home) != NULL);
    char sub[PATH_MAX], in_home[PATH_MAX];
    snprintf(sub, sizeof(sub), "%s/.local", home);
    CHECK_LONG(mkdir(sub, 0755), 0);
    snprintf(sub, sizeof(sub), "%s/.local/share", home);
    CHECK_LONG(mkdir(sub, 0755), 0);
    snprintf(sub, sizeof(sub), "%s/.local/share/shottino", home);
    CHECK_LONG(mkdir(sub, 0755), 0);
    snprintf(sub, sizeof(sub), "%s/.local/share/shottino/bin", home);
    CHECK_LONG(mkdir(sub, 0755), 0);
    snprintf(in_home, sizeof(in_home), "%s/shottino-call", sub);
    CHECK(write_exec(in_home, 0755));

    struct app *app = call_app("vjt");
    CHECK(app != NULL);
    if (!app) return;

    setenv("PATH", dir, 1);
    setenv("HOME", home, 1);
    out[0] = 0;
    CHECK(call_helper_path(app, out, sizeof(out)));
    CHECK_STR(out, in_home);

    /* Nothing in HOME: PATH answers, which is the case where the helper
     * arrived in a package rather than a download. */
    setenv("HOME", "/nonexistent-shottino", 1);
    out[0] = 0;
    CHECK(call_helper_path(app, out, sizeof(out)));
    CHECK_STR(out, good);

    /* Nowhere at all is FALSE, so the caller falls back to the browser
     * instead of forking something that exits 127 into a pipe. */
    setenv("PATH", "/nonexistent-shottino", 1);
    CHECK(!call_helper_path(app, out, sizeof(out)));

    /* THE one that matters: `/set call.helper` names a path that is not
     * usable, and there IS a perfectly good helper on PATH. The setting
     * wins anyway — by failing. Falling through to the other binary
     * would run something the user did not ask for and would hide the
     * typo in their setting forever. */
    setenv("PATH", dir, 1);
    snprintf(app->call_helper, sizeof(app->call_helper), "%s/typo", dir);
    CHECK(!call_helper_path(app, out, sizeof(out)));
    snprintf(app->call_helper, sizeof(app->call_helper), "%s", plain);
    CHECK(!call_helper_path(app, out, sizeof(out)));

    /* And a configured one that IS usable is taken as given, ahead of
     * the one PATH would have found. */
    snprintf(app->call_helper, sizeof(app->call_helper), "%s", in_home);
    out[0] = 0;
    CHECK(call_helper_path(app, out, sizeof(out)));
    CHECK_STR(out, in_home);

    setenv("HOME", home_keep, 1);
    setenv("PATH", path_keep, 1);
    call_app_free(app);
    unlink(good);
    unlink(plain);
    unlink(in_home);
    snprintf(sub, sizeof(sub), "%s/.local/share/shottino/bin", home);
    rmdir(sub);
    snprintf(sub, sizeof(sub), "%s/.local/share/shottino", home);
    rmdir(sub);
    snprintf(sub, sizeof(sub), "%s/.local/share", home);
    rmdir(sub);
    snprintf(sub, sizeof(sub), "%s/.local", home);
    rmdir(sub);
    rmdir(home);
    rmdir(dir);
}

int main(void) {
    RUN(a_nick_folds_to_one_path_and_two_people_never_fold_to_one);
    RUN(a_nick_that_does_not_fit_is_cut_between_escapes_and_never_past_the_end);
    RUN(the_nick_in_me_is_the_same_byte_string_as_the_nick_in_peers);
    RUN(the_codec_word_is_one_the_helper_itself_accepts);
    RUN(the_frame_box_is_never_empty_and_never_unbounded);
    RUN(a_configured_helper_is_used_or_refused_never_quietly_replaced);
    return test_report();
}
