#include "note.h"

#include <pthread.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static bool verbose;
static pthread_mutex_t out_lock = PTHREAD_MUTEX_INITIALIZER;

void note_set_verbose(bool on) { verbose = on; }

bool note_verbose(void) { return verbose; }

/* Every line out of this process goes through this or note(), so the
 * "stdout is frames only" rule cannot be broken by a stray printf. */
static void emit(const char *fmt, ...) __attribute__((format(printf, 1, 2)));

static void emit(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    pthread_mutex_lock(&out_lock);
    vfprintf(stderr, fmt, ap);
    fputc('\n', stderr);
    fflush(stderr);
    pthread_mutex_unlock(&out_lock);
    va_end(ap);
}

void note(const char *fmt, ...) {
    if (!verbose) return;
    /* FORMATTED FIRST, then written a line at a time. Writing "# " and
     * then handing the format string to vfprintf comments the first line
     * and no other, and the notes that matter are the multi-line ones:
     * a whole SDP answer goes through here, the body is the SFU's, and
     * the reader at the other end decides line by line. An answer with a
     * line shaped like an event is then an event — a remote peer driving
     * shottino's call window. */
    char stack[1024];
    char *buf = stack;
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(stack, sizeof(stack), fmt, ap);
    va_end(ap);
    if (n < 0) return;
    if ((size_t)n >= sizeof(stack)) {
        /* A real answer with a dozen candidates clears a kilobyte, and
         * truncating loses exactly the part that was worth printing. */
        char *big = malloc((size_t)n + 1);
        if (big) {
            va_start(ap, fmt);
            vsnprintf(big, (size_t)n + 1, fmt, ap);
            va_end(ap);
            buf = big;
        }
    }
    pthread_mutex_lock(&out_lock);
    const char *p = buf;
    do {
        const char *nl = strchr(p, '\n');
        size_t len = nl ? (size_t)(nl - p) : strlen(p);
        fputs("# ", stderr);
        fwrite(p, 1, len, stderr);
        fputc('\n', stderr);
        p = nl ? nl + 1 : p + len;
    } while (*p);
    fflush(stderr);
    pthread_mutex_unlock(&out_lock);
    if (buf != stack) free(buf);
}

/* JSON string escaping for the few fields that can carry server text. */
void emit_event(const char *event, const char *key, const char *value) {
    char esc[512];
    size_t n = 0;
    for (const unsigned char *p = (const unsigned char *)(value ? value : "");
         *p && n + 7 < sizeof(esc); p++) {
        if (*p == '"' || *p == '\\') {
            esc[n++] = '\\';
            esc[n++] = (char)*p;
        } else if (*p < 0x20) {
            n += (size_t)snprintf(esc + n, sizeof(esc) - n, "\\u%04x", *p);
        } else {
            esc[n++] = (char)*p;
        }
    }
    esc[n] = 0;
    if (key) emit("{\"event\":\"%s\",\"%s\":\"%s\"}", event, key, esc);
    else emit("{\"event\":\"%s\"}", event);
}
