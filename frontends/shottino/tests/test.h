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
    atexit(test_temp_home_remove);
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
