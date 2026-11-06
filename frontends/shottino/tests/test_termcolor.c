/* test_termcolor.c — RGB quantisation and character-art rendering.
 *
 * The quantiser feeds two very different consumers (mIRC colours and the
 * media preview), so getting it wrong is visible twice. The art renderer
 * is checked for the properties that matter at a terminal: correct cell
 * count, no colour leaking past a row, and never emitting 24-bit escapes
 * at a terminal that cannot parse them.
 */
#include "../termcolor.h"
#include "test.h"

#include <stdlib.h>

TEST(xterm256_primaries) {
    /* Pure primaries land on the cube's corners. */
    CHECK_LONG(termcolor_xterm256(0x000000), 16);  /* cube black */
    CHECK_LONG(termcolor_xterm256(0xffffff), 231); /* cube white */
    CHECK_LONG(termcolor_xterm256(0xff0000), 196);
    CHECK_LONG(termcolor_xterm256(0x00ff00), 46);
    CHECK_LONG(termcolor_xterm256(0x0000ff), 21);
    CHECK_LONG(termcolor_xterm256(0xffff00), 226);
    CHECK_LONG(termcolor_xterm256(0x00ffff), 51);
    CHECK_LONG(termcolor_xterm256(0xff00ff), 201);
    /* Every result must be a legal index. */
    for (long v = 0; v < 0xffffff; v += 7919) {
        int idx = termcolor_xterm256(v);
        CHECK(idx >= 16 && idx <= 255);
    }
    CHECK_LONG(termcolor_xterm256(-1), -1);
}

/* Near-neutral colours must use the grey RAMP, not the cube: the cube's
 * grey axis has six steps and visibly tints greys. */
TEST(xterm256_greys_use_the_ramp) {
    int mid = termcolor_xterm256(0x808080);
    CHECK(mid >= 232 && mid <= 255);
    int dark = termcolor_xterm256(0x303030);
    CHECK(dark >= 232 && dark <= 255);
    /* A grey never comes back TINTED, wherever it lands — the cube's own
     * diagonal (0x5f5f5f, 0x878787, …) is neutral too, and nearer for
     * some — and brighter in stays brighter out. */
    static const int lv[6] = {0, 95, 135, 175, 215, 255};
    int prev = -1;
    for (int v = 0; v < 256; v++) {
        int idx = termcolor_xterm256(((long)v << 16) | ((long)v << 8) | v);
        int r, g, b;
        if (idx >= 232) r = g = b = 8 + 10 * (idx - 232);
        else r = lv[(idx - 16) / 36], g = lv[((idx - 16) / 6) % 6], b = lv[(idx - 16) % 6];
        CHECK(r == g && g == b);
        CHECK(r >= prev);
        prev = r;
    }
    /* A saturated colour must NOT be sent to the grey ramp. */
    int red = termcolor_xterm256(0xff0000);
    CHECK(red < 232);
}

/* The answer is the NEAREST index, measured against the levels the
 * palette really holds. The cube is not a uniform grid — its six levels
 * are 0, 95, 135, 175, 215, 255 — so rounding onto a uniform one lands a
 * channel a whole step off (0x5f = 95 is a cube level and was being sent
 * to 135). And the grey ramp's steps are 10 apart starting at 8, so its
 * index has to ROUND, or 0x111111 floors onto the same index as 0x0a0a0a
 * and two theme greys meant to be told apart become one. */
TEST(xterm256_picks_the_nearest_index) {
    CHECK_LONG(termcolor_xterm256(0x5fafd7), 74);  /* exactly cube (1,3,4) */
    CHECK_LONG(termcolor_xterm256(0x87afd7), 110); /* exactly cube (2,3,4) */
    CHECK_LONG(termcolor_xterm256(0xff8787), 210); /* exactly cube (5,2,2) */
    CHECK_LONG(termcolor_xterm256(0x080808), 232); /* exactly ramp 0 */
    CHECK_LONG(termcolor_xterm256(0x121212), 233); /* exactly ramp 1 */
    CHECK_LONG(termcolor_xterm256(0x111111), 233); /* nearer 0x12 than 0x08 */
    CHECK_LONG(termcolor_xterm256(0x0a0a0a), 232);
    /* Every cube and ramp colour maps to itself. */
    static const int lv[6] = {0, 95, 135, 175, 215, 255};
    for (int i = 0; i < 216; i++) {
        long rgb = ((long)lv[i / 36] << 16) | ((long)lv[(i / 6) % 6] << 8) | lv[i % 6];
        CHECK_LONG(termcolor_xterm256(rgb), 16 + i);
    }
    for (int i = 0; i < 24; i++) {
        long v = 8 + 10 * i;
        CHECK_LONG(termcolor_xterm256((v << 16) | (v << 8) | v), 232 + i);
    }
}

TEST(basic8) {
    CHECK_LONG(termcolor_basic8(0x000000), 0); /* black   */
    CHECK_LONG(termcolor_basic8(0xff0000), 1); /* red     */
    CHECK_LONG(termcolor_basic8(0x00ff00), 2); /* green   */
    CHECK_LONG(termcolor_basic8(0xffff00), 3); /* yellow  */
    CHECK_LONG(termcolor_basic8(0x0000ff), 4); /* blue    */
    CHECK_LONG(termcolor_basic8(0xff00ff), 5); /* magenta */
    CHECK_LONG(termcolor_basic8(0x00ffff), 6); /* cyan    */
    CHECK_LONG(termcolor_basic8(0xffffff), 7); /* white   */
    CHECK_LONG(termcolor_basic8(-1), -1);
    for (long v = 0; v < 0xffffff; v += 7919) {
        int c = termcolor_basic8(v);
        CHECK(c >= 0 && c <= 7);
    }
}

TEST(ramp_char_tracks_luminance) {
    CHECK(termcolor_ramp_char(0, 0, 0) == ' ');
    CHECK(termcolor_ramp_char(255, 255, 255) == '@');
    /* Monotonic: brighter never picks a sparser glyph. */
    static const char order[] = " .:-=+*#%@";
    int prev = -1;
    for (int v = 0; v <= 255; v += 5) {
        char c = termcolor_ramp_char(v, v, v);
        const char *at = strchr(order, c);
        CHECK(at != NULL);
        int idx = at ? (int)(at - order) : -1;
        CHECK(idx >= prev);
        prev = idx;
    }
    /* Green weighs most in Rec.601, so pure green reads brighter than
     * pure blue at the same channel value. */
    CHECK(termcolor_ramp_char(0, 255, 0) > termcolor_ramp_char(0, 0, 255));
}

/* Build a solid-colour RGB buffer. */
static unsigned char *solid(int w, int h, int r, int g, int b) {
    unsigned char *buf = malloc((size_t)w * (size_t)h * 3);
    for (int i = 0; i < w * h; i++) {
        buf[i * 3] = (unsigned char)r;
        buf[i * 3 + 1] = (unsigned char)g;
        buf[i * 3 + 2] = (unsigned char)b;
    }
    return buf;
}

static char *render_to_string(const unsigned char *rgb, int w, int h, term_color_depth d,
                              size_t *len_out) {
    char *buf = NULL;
    size_t len = 0;
    FILE *f = open_memstream(&buf, &len);
    termcolor_render_rgb(rgb, w, h, d, f);
    fclose(f);
    if (len_out) *len_out = len;
    return buf;
}

TEST(render_emits_one_row_per_two_pixel_rows) {
    unsigned char *img = solid(4, 8, 255, 0, 0);
    size_t len = 0;
    char *out = render_to_string(img, 4, 8, TERM_COLOR_TRUE, &len);
    /* 8 pixel rows -> 4 character rows. */
    int rows = 0;
    for (char *p = out; *p; p++)
        if (*p == '\n') rows++;
    CHECK_LONG(rows, 4);
    /* Raw mode needs CRLF; a bare LF stair-steps the image. */
    CHECK(strstr(out, "\r\n") != NULL);
    /* Every row resets SGR so a torn render cannot leak colour. */
    CHECK(strstr(out, "\033[0m\r\n") != NULL);
    free(out);
    free(img);
}

TEST(render_uses_the_right_escapes_per_depth) {
    unsigned char *img = solid(2, 4, 200, 100, 50);

    char *t = render_to_string(img, 2, 4, TERM_COLOR_TRUE, NULL);
    CHECK(strstr(t, "\033[38;2;200;100;50m") != NULL); /* 24-bit fg */
    free(t);

    char *c256 = render_to_string(img, 2, 4, TERM_COLOR_256, NULL);
    CHECK(strstr(c256, "\033[38;5;") != NULL);
    /* Must NOT emit 24-bit escapes at a 256-colour terminal — they would
     * print as visible garbage. */
    CHECK(strstr(c256, "38;2;") == NULL);
    free(c256);

    char *c8 = render_to_string(img, 2, 4, TERM_COLOR_8, NULL);
    CHECK(strstr(c8, "38;5;") == NULL);
    CHECK(strstr(c8, "38;2;") == NULL);
    free(c8);

    /* No colour at all: no escapes except the per-row reset. */
    char *none = render_to_string(img, 2, 4, TERM_COLOR_NONE, NULL);
    CHECK(strstr(none, "38;") == NULL);
    CHECK(strstr(none, "48;") == NULL);
    free(none);
    free(img);
}

TEST(render_handles_degenerate_sizes) {
    unsigned char *img = solid(2, 2, 10, 20, 30);
    size_t len = 0;
    /* An odd height leaves the last row unpaired; it is skipped rather
     * than read past the end of the buffer. */
    char *out = render_to_string(img, 2, 1, TERM_COLOR_TRUE, &len);
    CHECK_LONG(len, 0);
    free(out);

    /* Zero and negative dimensions produce nothing and do not crash. */
    out = render_to_string(img, 0, 4, TERM_COLOR_TRUE, &len);
    CHECK_LONG(len, 0);
    free(out);
    out = render_to_string(img, -1, -1, TERM_COLOR_TRUE, &len);
    CHECK_LONG(len, 0);
    free(out);

    /* NULL buffer is a no-op, not a segfault. */
    char *buf = NULL;
    size_t l = 0;
    FILE *f = open_memstream(&buf, &l);
    termcolor_render_rgb(NULL, 4, 4, TERM_COLOR_TRUE, f);
    fclose(f);
    CHECK_LONG(l, 0);
    free(buf);
    free(img);
}

/* Truecolor must never be GUESSED: emitting 24-bit escapes at a terminal
 * that cannot parse them prints raw text at the user. */
TEST(depth_detection_is_conservative) {
    setenv("COLORTERM", "truecolor", 1);
    CHECK(termcolor_detect_depth() == TERM_COLOR_TRUE);
    setenv("COLORTERM", "24bit", 1);
    CHECK(termcolor_detect_depth() == TERM_COLOR_TRUE);

    unsetenv("COLORTERM");
    setenv("TERM", "xterm-256color", 1);
    CHECK(termcolor_detect_depth() == TERM_COLOR_256);

    setenv("TERM", "xterm", 1);
    CHECK(termcolor_detect_depth() == TERM_COLOR_8);

    setenv("TERM", "dumb", 1);
    CHECK(termcolor_detect_depth() == TERM_COLOR_NONE);
    unsetenv("TERM");
    CHECK(termcolor_detect_depth() == TERM_COLOR_NONE);
}

TEST(graphics_detection) {
    unsetenv("KITTY_WINDOW_ID");
    unsetenv("WEZTERM_PANE");
    unsetenv("TERM_PROGRAM");
    unsetenv("SHOTTINO_GRAPHICS");
    setenv("TERM", "xterm-256color", 1);
    CHECK(!termcolor_has_graphics());

    setenv("TERM", "xterm-kitty", 1);
    CHECK(termcolor_has_graphics());

    setenv("TERM", "xterm-256color", 1);
    setenv("KITTY_WINDOW_ID", "1", 1);
    CHECK(termcolor_has_graphics());
    unsetenv("KITTY_WINDOW_ID");

    setenv("TERM_PROGRAM", "iTerm.app", 1);
    CHECK(termcolor_has_graphics());
    unsetenv("TERM_PROGRAM");

    /* Sixel cannot be probed without querying the terminal, so an
     * explicit opt-in is honoured. */
    CHECK(!termcolor_has_graphics());
    setenv("SHOTTINO_GRAPHICS", "1", 1);
    CHECK(termcolor_has_graphics());
    unsetenv("SHOTTINO_GRAPHICS");
}


/* ── Readability against a background the colour never met ────────────
 *
 * mIRC's palette was picked against mIRC's own WHITE background. A bot
 * writing navy (0x00007f) into a black terminal has posted text nobody
 * can read, and no amount of quantisation fixes that — the colour is
 * faithfully reproduced and faithfully invisible. */
TEST(a_colour_too_close_to_the_background_is_lifted_off_it) {
    /* Navy on black: 12 luminance against 0, nowhere near a 64 floor. */
    CHECK_LONG(termcolor_luminance(0x00007f), 13);
    long fixed = termcolor_readable(0x00007f, 0, 64);
    CHECK(termcolor_luminance(fixed) >= 64);
    /* Still blue: the blue channel stays the largest. It is the same
     * colour, made visible — not a substitution, which would lose the
     * one thing the bot was trying to say with it. */
    CHECK(( fixed        & 0xff) > ((fixed >> 16) & 0xff));
    CHECK(((fixed >> 8)  & 0xff) < ( fixed        & 0xff));

    /* The mirror case: pale yellow on a white background. */
    long dark = termcolor_readable(0xffff9c, 255, 64);
    CHECK(termcolor_luminance(dark) <= 255 - 64);

    /* Pure blue has a zero red and a zero green channel. Scaling the
     * channels up multiplies those zeros by anything and gets zero, so
     * the lift has to blend toward white instead — a colour that came
     * back unchanged would be the bug this guards. */
    long pureblue = termcolor_readable(0x0000fc, 0, 64);
    CHECK(pureblue != 0x0000fc);
    CHECK(termcolor_luminance(pureblue) >= 64);
}

TEST(a_colour_that_already_reads_is_left_exactly_alone) {
    /* White on black clears any floor; touching it would shift a colour
     * that was never a problem. */
    CHECK_LONG(termcolor_readable(0xffffff, 0, 64), 0xffffff);
    CHECK_LONG(termcolor_readable(0x00ff00, 0, 64), 0x00ff00);
    /* "Inherit" is not a colour and must survive as itself. */
    CHECK_LONG(termcolor_readable(-1, 0, 64), -1);
    /* A floor of zero is the off switch, and asks nothing of anything. */
    CHECK_LONG(termcolor_readable(0x00007f, 0, 0), 0x00007f);
}

int main(void) {
    RUN(xterm256_primaries);
    RUN(xterm256_greys_use_the_ramp);
    RUN(xterm256_picks_the_nearest_index);
    RUN(basic8);
    RUN(ramp_char_tracks_luminance);
    RUN(render_emits_one_row_per_two_pixel_rows);
    RUN(render_uses_the_right_escapes_per_depth);
    RUN(render_handles_degenerate_sizes);
    RUN(depth_detection_is_conservative);
    RUN(graphics_detection);
    RUN(a_colour_too_close_to_the_background_is_lifted_off_it);
    RUN(a_colour_that_already_reads_is_left_exactly_alone);
    return test_report();
}
