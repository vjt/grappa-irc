/* note.h — everything this process says to shottino.
 *
 * ONE owner for the stderr contract, because it IS a contract and it has
 * a reader at the other end (`call_reader_main` in shottino.c):
 *
 *   stdout — the raw rgb24 frame stream. NOTHING else writes here.
 *   stderr — one JSON object per line: {"event":…}. With --verbose,
 *            human notes are interleaved as `#` comment lines, which the
 *            reader skips on the first character.
 *
 * Split out of main.c so the contract can be TESTED without the media
 * helper's libdatachannel link: the two ways it can be broken — a line
 * that is not a `#` comment and is not JSON either, and an event value
 * that escapes its own string — are both silent at runtime and both
 * decided entirely by the bytes these functions write.
 */
#ifndef SHOTTINO_CALL_NOTE_H
#define SHOTTINO_CALL_NOTE_H

#include <stdbool.h>

/* --verbose. Off, notes are not written at all; events always are. */
void note_set_verbose(bool on);
bool note_verbose(void);

/* One JSON object on one line. `value` is escaped; `key` is ours. */
void emit_event(const char *event, const char *key, const char *value);

/* A human note, EVERY line of it prefixed with "# ".
 *
 * Every line, not just the first: the reader skips a line only when its
 * first character is '#', so a note carrying a whole SDP body hands the
 * event stream one attacker-shaped line per line the server sent. */
void note(const char *fmt, ...) __attribute__((format(printf, 1, 2)));

#endif /* SHOTTINO_CALL_NOTE_H */
