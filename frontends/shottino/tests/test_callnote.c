/* test_callnote — what the media helper is allowed to put on stderr.
 *
 * stderr is a PARSED stream: shottino's call_reader_main treats every
 * line that is not empty and does not begin with '#' as one JSON event.
 * So the whole safety of the channel rests on two byte-level properties
 * that nothing at runtime will ever complain about — a note that fails
 * to comment ALL of its lines, and an event value that escapes its own
 * string. Both are decided here, and only here.
 *
 * Links call/note.c only — no libdatachannel — so the default gate never
 * depends on the opt-in submodule having been built.
 */
#include "../call/note.h"

#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "test.h"

/* stderr is what is under test AND what test.h reports failures on, so
 * it is captured to a file and put back BEFORE anything is asserted. */
static int cap_saved = -1;
static char cap_path[64];

static void cap_start(void) {
    snprintf(cap_path, sizeof(cap_path), "/tmp/shottino-note-XXXXXX");
    int fd = mkstemp(cap_path);
    if (fd < 0) abort();
    fflush(stderr);
    cap_saved = dup(STDERR_FILENO);
    dup2(fd, STDERR_FILENO);
    close(fd);
}

static void cap_end(char *out, size_t out_sz) {
    fflush(stderr);
    dup2(cap_saved, STDERR_FILENO);
    close(cap_saved);
    cap_saved = -1;
    FILE *f = fopen(cap_path, "r");
    size_t n = f ? fread(out, 1, out_sz - 1, f) : 0;
    out[n] = 0;
    if (f) fclose(f);
    unlink(cap_path);
}

/* True when every non-empty line the helper wrote is one the reader
 * will skip — i.e. nothing here can be mistaken for an event. */
static bool every_line_is_a_comment(const char *s) {
    for (const char *p = s; *p;) {
        const char *nl = strchr(p, '\n');
        size_t len = nl ? (size_t)(nl - p) : strlen(p);
        if (len > 0 && p[0] != '#') return false;
        p = nl ? nl + 1 : p + len;
    }
    return true;
}

TEST(a_note_comments_every_line_it_writes) {
    char got[8192];
    note_set_verbose(true);

    cap_start();
    note("subscribe 0: joined late");
    cap_end(got, sizeof(got));
    CHECK_STR(got, "# subscribe 0: joined late\n");

    /* A MULTI-LINE note. The helper writes one for every answer it gets
     * at --verbose, and the reader comments out lines, not messages. */
    cap_start();
    note("%s: answer\n%s", "publish", "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n");
    cap_end(got, sizeof(got));
    CHECK(every_line_is_a_comment(got));
    CHECK(strstr(got, "# v=0") != NULL);
    CHECK(strstr(got, "# o=- 0 0 IN IP4 127.0.0.1") != NULL);

    /* THE INJECTION. The answer body is the SFU's, not ours, and an SDP
     * is a list of lines. One shaped like an event reaches the reader as
     * an event unless every line of the note is commented — which is a
     * remote peer closing the call window, or worse. */
    cap_start();
    note("%s: answer\n%s", "subscribe 0",
         "v=0\r\na=x:{\"event\":\"closed\"}\r\n{\"event\":\"error\",\"message\":\"pwned\"}\r\n");
    cap_end(got, sizeof(got));
    CHECK(every_line_is_a_comment(got));
    CHECK(strstr(got, "\n{\"event\"") == NULL);

    /* Longer than any buffer a formatter would put on the stack: a real
     * answer with a dozen candidates clears 1 KB easily, and a note that
     * silently truncates loses the very body it was asked to show. */
    char big[4096];
    memset(big, 'a', sizeof(big) - 1);
    big[sizeof(big) - 1] = 0;
    big[1000] = '\n';
    big[2000] = '\n';
    cap_start();
    note("answer\n%s", big);
    cap_end(got, sizeof(got));
    CHECK(every_line_is_a_comment(got));
    CHECK(strlen(got) >= sizeof(big));
    CHECK(got[strlen(got) - 1] == '\n');

    /* Off means silent — the notes are the only thing --verbose adds. */
    note_set_verbose(false);
    cap_start();
    note("%s", "not written");
    cap_end(got, sizeof(got));
    CHECK_STR(got, "");
    note_set_verbose(true);
}

/* The other half of the same surface: a value that escapes its string
 * is a line the reader parses as some other event entirely. */
TEST(an_event_value_cannot_escape_its_own_string) {
    char got[8192];

    cap_start();
    emit_event("state", "value", "publish connected");
    cap_end(got, sizeof(got));
    CHECK_STR(got, "{\"event\":\"state\",\"value\":\"publish connected\"}\n");

    cap_start();
    emit_event("closed", NULL, NULL);
    cap_end(got, sizeof(got));
    CHECK_STR(got, "{\"event\":\"closed\"}\n");

    /* Server text: quotes, backslashes and control bytes all come back
     * as one line with the braces still ours. */
    cap_start();
    emit_event("error", "message", "he said \"no\" \\ then\nleft");
    cap_end(got, sizeof(got));
    CHECK_STR(got,
              "{\"event\":\"error\",\"message\":\"he said \\\"no\\\" \\\\ then\\u000aleft\"}\n");
    /* ONE line out, whatever went in. */
    CHECK(strchr(got, '\n') == got + strlen(got) - 1);

    /* Over-long server text is cut, not spilled: still one line, still
     * closed, still parseable. */
    char loud[2048];
    memset(loud, '"', sizeof(loud) - 1);
    loud[sizeof(loud) - 1] = 0;
    cap_start();
    emit_event("error", "message", loud);
    cap_end(got, sizeof(got));
    CHECK(strchr(got, '\n') == got + strlen(got) - 1);
    CHECK(strncmp(got, "{\"event\":\"error\",\"message\":\"", 27) == 0);
    CHECK(strstr(got, "\"}\n") == got + strlen(got) - 3);
}

int main(void) {
    RUN(a_note_comments_every_line_it_writes);
    RUN(an_event_value_cannot_escape_its_own_string);
    return test_report();
}
