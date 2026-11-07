/* test.h — the smallest thing that can hold shottino honest.
 *
 * Shottino shipped without any test target. The wire-narrowing and
 * formatting code being added for cicchetto parity is pure (bytes in,
 * typed values out) and is exactly the kind of code that rots silently in
 * C, so it gets tests. No framework dependency: a header of macros, one
 * `main` per suite, non-zero exit on failure.
 *
 * Usage:
 *   TEST(name) { ... CHECK(cond); CHECK_STR(a, b); }
 *   int main(void) { RUN(name); return test_report(); }
 *
 * A suite that #includes ../shottino.c calls test_use_temp_home() as the
 * first statement of main — see below, and `make check-home-guard`.
 */
#ifndef SHOTTINO_TEST_H
#define SHOTTINO_TEST_H

#include <errno.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
/* mkdir, for the temporary XDG data home built below. */
#include <sys/stat.h>
/* mkdtemp lives in stdlib.h on glibc and in unistd.h on macOS. */
#include <unistd.h>

static int test_failures;
static int test_checks;
static const char *test_current;

#define TEST(name) static void test_##name(void)

#define RUN(name)                                                                                  \
    do {                                                                                           \
        test_current = #name;                                                                      \
        test_##name();                                                                             \
    } while (0)

#define CHECK(cond)                                                                                \
    do {                                                                                           \
        test_checks++;                                                                             \
        if (!(cond)) {                                                                             \
            test_failures++;                                                                       \
            fprintf(stderr, "FAIL %s:%d [%s] %s\n", __FILE__, __LINE__, test_current, #cond);      \
        }                                                                                          \
    } while (0)

/* An unconditional failure, for the case a CHECK cannot express: a
 * dependency the test needs is missing, so nothing below it can run. */
#define FAIL(msg)                                                                                  \
    do {                                                                                           \
        test_checks++;                                                                             \
        test_failures++;                                                                           \
        fprintf(stderr, "FAIL %s:%d [%s] %s\n", __FILE__, __LINE__, test_current, msg);            \
    } while (0)

/* String equality with both values printed on failure — a bare CHECK on
 * strcmp tells you it differed but not how, which is the whole question. */
#define CHECK_STR(actual, expect)                                                                  \
    do {                                                                                           \
        test_checks++;                                                                             \
        const char *a_ = (actual);                                                                 \
        const char *e_ = (expect);                                                                 \
        if (!a_ || !e_ || strcmp(a_, e_) != 0) {                                                   \
            test_failures++;                                                                       \
            fprintf(stderr, "FAIL %s:%d [%s] expected \"%s\", got \"%s\"\n", __FILE__, __LINE__,   \
                    test_current, e_ ? e_ : "(null)", a_ ? a_ : "(null)");                         \
        }                                                                                          \
    } while (0)

#define CHECK_LONG(actual, expect)                                                                 \
    do {                                                                                           \
        test_checks++;                                                                             \
        long a_ = (long)(actual);                                                                  \
        long e_ = (long)(expect);                                                                  \
        if (a_ != e_) {                                                                            \
            test_failures++;                                                                       \
            fprintf(stderr, "FAIL %s:%d [%s] expected %ld, got %ld\n", __FILE__, __LINE__,         \
                    test_current, e_, a_);                                                         \
        }                                                                                          \
    } while (0)

/* A skip is REQUESTED, never inferred.
 *
 * A suite that reads its own environment and quietly decides not to
 * assert anything reports exactly what a passing suite reports. Two here
 * did: test_layout returned 0 for the WHOLE suite where terminfo was
 * missing, and its decode test returns having asserted nothing wherever
 * ffmpeg is absent — which is every CI run to date. So a missing test
 * dependency FAILS, and an operator who knows their host cannot have it
 * says so with SHOTTINO_TEST_ALLOW_SKIP=1.
 *
 * Exactly "1", not merely set: an empty SHOTTINO_TEST_ALLOW_SKIP= in a CI
 * env block would otherwise disable the gate while looking like it turns
 * nothing on, and a typo'd value should fail loudly rather than skip
 * quietly. Whichever way this reading errs, it must err towards red. */
static inline bool test_skip_allowed(void) {
    const char *v = getenv("SHOTTINO_TEST_ALLOW_SKIP");
    return v && strcmp(v, "1") == 0;
}

/* A HOME OF OUR OWN, before a single test runs.
 *
 * Anything that reaches shottino_state_dir() mkdirs under $HOME and may
 * then write there: prefs_save resolves prefs_path at call time, so a
 * suite that saves settings rewrites the DEVELOPER'S OWN
 * ~/.local/share/shottino/shottino.conf with whatever defaults a test app
 * happens to hold. That is not hypothetical: vjt lost
 * `voice.source = alsa:hw:2` to `pulse:default` on every `make check`,
 * and blamed the reinstall that always happened alongside it.
 *
 * So every suite that compiles shottino.c takes a temporary HOME here,
 * whether or not it currently reaches that code — the reach is one new
 * test away and nothing warns when it appears. `make check-home-guard`
 * is what keeps the next suite from forgetting.
 *
 * FATAL rather than conditional on purpose. The guard this replaces read
 *     if (mkdtemp(test_home)) setenv("HOME", test_home, 1);
 * which runs the whole suite against the real $HOME when mkdtemp fails,
 * silently, with no failure reported — the original incident, restored by
 * the one line that was supposed to prevent it. A guard whose failure is
 * invisible is not a guard. */
static char test_temp_home[64];

static inline void test_temp_home_remove(void) {
    if (!test_temp_home[0]) return;
    /* Recursive because the suite left a state directory in there, and
     * `make check` leaked one /tmp/shottino-test-home-* per run before
     * this. The path is mkdtemp's own output, never input. */
    char cmd[sizeof(test_temp_home) + 16];
    snprintf(cmd, sizeof(cmd), "rm -rf '%s'", test_temp_home);
    if (system(cmd) != 0) fprintf(stderr, "warning: %s not removed\n", test_temp_home);
    test_temp_home[0] = 0;
}

static inline void test_use_temp_home(void) {
    snprintf(test_temp_home, sizeof(test_temp_home), "/tmp/shottino-test-home-XXXXXX");
    if (!mkdtemp(test_temp_home)) {
        fprintf(stderr, "FATAL %s: mkdtemp: %s — refusing to run against the real $HOME\n",
                __FILE__, strerror(errno));
        exit(1);
    }
    if (setenv("HOME", test_temp_home, 1) != 0) {
        fprintf(stderr, "FATAL %s: setenv(HOME): %s\n", __FILE__, strerror(errno));
        test_temp_home_remove();
        exit(1);
    }
    /* XDG_DATA_HOME as well, and for the same reason.
     *
     * shottino_state_dir() prefers that variable over $HOME. A developer
     * who exports it — which is ordinary on a Linux desktop — would
     * otherwise have every suite that compiles shottino.c write its
     * settings and tokens into their REAL data directory, with the
     * temporary HOME above sitting there looking like it prevented
     * exactly that. Moving HOME alone stopped being enough the moment
     * the variable was honoured, so the two move together.
     *
     * It is SET rather than unset, and set to where $HOME would have put
     * it, so the suites keep seeing the ordinary layout. */
    char data_home[sizeof(test_temp_home) + 16];
    snprintf(data_home, sizeof(data_home), "%s/.local", test_temp_home);
    mkdir(data_home, 0700);
    snprintf(data_home, sizeof(data_home), "%s/.local/share", test_temp_home);
    mkdir(data_home, 0700);
    if (setenv("XDG_DATA_HOME", data_home, 1) != 0) {
        fprintf(stderr, "FATAL %s: setenv(XDG_DATA_HOME): %s\n", __FILE__, strerror(errno));
        test_temp_home_remove();
        exit(1);
    }
    /* And no keyring. Saving E2E state reaches for the OS keyring through
     * secret-tool (keyring.h), and a developer's desktop has one: a suite
     * would store test keys in the real Secret Service. A binary that is
     * not there is "no keyring"; a suite that wants one takes the fake
     * (test_use_fake_keyring). */
    if (setenv("SHOTTINO_SECRET_TOOL", "/nonexistent/shottino-test-secret-tool", 1) != 0) {
        fprintf(stderr, "FATAL %s: setenv(SHOTTINO_SECRET_TOOL): %s\n", __FILE__, strerror(errno));
        test_temp_home_remove();
        exit(1);
    }
    atexit(test_temp_home_remove);
}

/* A keyring for the suite: tests/fake-secret-tool (run from
 * frontends/shottino, as `make check` does), its items in <temp home>/keyring.
 * After test_use_temp_home. `mode` NULL, "fail" or "forget" (see the script). */
static inline void test_keyring_mode(const char *mode) {
    if (mode) setenv("FAKE_KEYRING_MODE", mode, 1);
    else unsetenv("FAKE_KEYRING_MODE");
}

static inline void test_use_fake_keyring(void) {
    char cwd[4096], tool[4200], dir[sizeof(test_temp_home) + 16];
    if (!getcwd(cwd, sizeof(cwd))) exit(1);
    snprintf(tool, sizeof(tool), "%s/tests/fake-secret-tool", cwd);
    if (access(tool, X_OK) != 0) {
        fprintf(stderr, "FATAL %s: %s is missing (run from frontends/shottino)\n", __FILE__, tool);
        exit(1);
    }
    snprintf(dir, sizeof(dir), "%s/keyring", test_temp_home);
    mkdir(dir, 0700);
    setenv("SHOTTINO_SECRET_TOOL", tool, 1);
    setenv("FAKE_KEYRING", dir, 1);
    test_keyring_mode(NULL);
}

/* A state directory of its OWN, for one test that needs to start empty.
 *
 * Three tests used to write this by hand as `setenv("HOME", mkdtemp(...))`
 * and put HOME back at the end. That stopped isolating anything the
 * moment shottino_state_dir() began preferring XDG_DATA_HOME: the swap
 * still looked deliberate, and the test went on reading and writing the
 * suite-wide directory that every other test uses. Two of the three
 * failed outright; the third would have passed for the wrong reason,
 * which is the worse outcome. So the swap lives here once, moves BOTH
 * variables, and there is no hand-rolled fourth copy to get wrong.
 *
 * XDG_DATA_HOME is pointed at `<dir>/.local/share` rather than at `<dir>`
 * so the on-disk layout is the one a real installation has — tests that
 * name `.local/share/shottino/...` in a path are describing what a user
 * would find, and should keep doing so. */
struct test_state_dir {
    char dir[64];
    char *saved_home;
    char *saved_data_home;
};

static inline bool test_state_dir_take(struct test_state_dir *s, const char *template) {
    snprintf(s->dir, sizeof(s->dir), "%s", template);
    s->saved_home = NULL;
    s->saved_data_home = NULL;
    if (!mkdtemp(s->dir)) return false;
    const char *home = getenv("HOME");
    const char *data_home = getenv("XDG_DATA_HOME");
    if (home) s->saved_home = strdup(home);
    if (data_home) s->saved_data_home = strdup(data_home);
    char under[sizeof(s->dir) + 16];
    snprintf(under, sizeof(under), "%s/.local", s->dir);
    mkdir(under, 0700);
    snprintf(under, sizeof(under), "%s/.local/share", s->dir);
    mkdir(under, 0700);
    return setenv("HOME", s->dir, 1) == 0 && setenv("XDG_DATA_HOME", under, 1) == 0;
}

static inline void test_state_dir_release(struct test_state_dir *s) {
    if (s->saved_home) setenv("HOME", s->saved_home, 1);
    else unsetenv("HOME");
    if (s->saved_data_home) setenv("XDG_DATA_HOME", s->saved_data_home, 1);
    else unsetenv("XDG_DATA_HOME");
    free(s->saved_home);
    free(s->saved_data_home);
    s->saved_home = NULL;
    s->saved_data_home = NULL;
}

/* CAPTURING STDERR, which two suites now need: it is the media helper's
 * whole output contract (one JSON event per line, notes commented) and it
 * is also where test.h reports failures. So it is put back BEFORE anything
 * is asserted — a CHECK between start and end writes its own diagnosis
 * into the buffer under test and then loses it. */
static int test_capture_fd = -1;
static char test_capture_path[64];

static inline void test_capture_stderr_start(void) {
    snprintf(test_capture_path, sizeof(test_capture_path), "/tmp/shottino-capture-XXXXXX");
    int fd = mkstemp(test_capture_path);
    if (fd < 0) abort();
    fflush(stderr);
    test_capture_fd = dup(STDERR_FILENO);
    dup2(fd, STDERR_FILENO);
    close(fd);
}

static inline void test_capture_stderr_end(char *out, size_t out_sz) {
    fflush(stderr);
    dup2(test_capture_fd, STDERR_FILENO);
    close(test_capture_fd);
    test_capture_fd = -1;
    FILE *f = fopen(test_capture_path, "r");
    size_t n = f ? fread(out, 1, out_sz - 1, f) : 0;
    out[n] = 0;
    if (f) fclose(f);
    unlink(test_capture_path);
}

static int test_report(void) {
    if (test_failures) {
        fprintf(stderr, "\n%d/%d checks FAILED\n", test_failures, test_checks);
        return 1;
    }
    fprintf(stderr, "%d checks passed\n", test_checks);
    return 0;
}

#endif /* SHOTTINO_TEST_H */
