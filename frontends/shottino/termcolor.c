/* termcolor.c — see termcolor.h. */
#include "termcolor.h"

#include <stdlib.h>
#include <string.h>
#include <strings.h>

/* The six levels the xterm cube actually holds. Not a uniform grid: the
 * first step is 95, every later one 40. */
static const int cube_level[6] = {0, 95, 135, 175, 215, 255};

static int nearest_cube_step(int v) {
    int best = 0;
    for (int i = 1; i < 6; i++)
        if (abs(v - cube_level[i]) < abs(v - cube_level[best])) best = i;
    return best;
}

static long dist2(int r, int g, int b, int r2, int g2, int b2) {
    long dr = r - r2, dg = g - g2, db = b - b2;
    return dr * dr + dg * dg + db * db;
}

int termcolor_xterm256(long rgb) {
    if (rgb < 0) return -1;
    int r = (int)((rgb >> 16) & 0xff), g = (int)((rgb >> 8) & 0xff), b = (int)(rgb & 0xff);
    int qr = nearest_cube_step(r), qg = nearest_cube_step(g), qb = nearest_cube_step(b);
    int cube = 16 + 36 * qr + 6 * qg + qb;
    long cube_d = dist2(r, g, b, cube_level[qr], cube_level[qg], cube_level[qb]);
    /* The grey ramp: 24 steps, 8 + 10*i. Rounded, not floored. */
    int level = (r + g + b) / 3;
    int step = (level - 8 + 5) / 10;
    if (step < 0) step = 0;
    if (step > 23) step = 23;
    int grey = 8 + 10 * step;
    long grey_d = dist2(r, g, b, grey, grey, grey);
    /* Whichever is closer, and the ramp on a tie: the cube's grey axis has
     * only six steps and visibly tints greys toward whichever channel
     * rounds up. */
    return grey_d <= cube_d ? 232 + step : cube;
}

int termcolor_basic8(long rgb) {
    if (rgb < 0) return -1;
    int r = (int)((rgb >> 16) & 0xff), g = (int)((rgb >> 8) & 0xff), b = (int)(rgb & 0xff);
    /* ANSI order is black, red, green, yellow, blue, magenta, cyan,
     * white — i.e. bit 0 red, bit 1 green, bit 2 blue. */
    return (r > 127 ? 1 : 0) | (g > 127 ? 2 : 0) | (b > 127 ? 4 : 0);
}

char termcolor_ramp_char(int r, int g, int b) {
    static const char ramp[] = " .:-=+*#%@";
    int lum = (r * 30 + g * 59 + b * 11) / 100; /* 0..255, Rec.601 weights */
    if (lum < 0) lum = 0;
    if (lum > 255) lum = 255;
    int idx = lum * (int)(sizeof(ramp) - 2) / 255;
    return ramp[idx];
}

static bool env_contains(const char *name, const char *needle) {
    const char *v = getenv(name);
    if (!v) return false;
    /* Case-insensitive substring without strcasestr, which is a GNU/BSD
     * extension and not guaranteed by C11. */
    size_t nlen = strlen(needle);
    if (nlen == 0) return true;
    for (const char *p = v; *p; p++)
        if (strncasecmp(p, needle, nlen) == 0) return true;
    return false;
}

term_color_depth termcolor_detect_depth(void) {
    /* Truecolor requires an explicit advertisement. Guessing it and being
     * wrong prints raw escape sequences as visible garbage, which is a
     * far worse failure than rendering in 256 colours. */
    if (env_contains("COLORTERM", "truecolor") || env_contains("COLORTERM", "24bit"))
        return TERM_COLOR_TRUE;
    if (env_contains("TERM", "256color") || env_contains("TERM", "direct")) return TERM_COLOR_256;
    const char *term = getenv("TERM");
    if (!term || !*term || strcmp(term, "dumb") == 0) return TERM_COLOR_NONE;
    return TERM_COLOR_8;
}

bool termcolor_has_graphics(void) {
    if (getenv("KITTY_WINDOW_ID") || env_contains("TERM", "kitty")) return true;
    if (env_contains("TERM_PROGRAM", "iTerm")) return true;
    if (getenv("WEZTERM_PANE") || env_contains("TERM_PROGRAM", "WezTerm")) return true;
    if (env_contains("TERM", "sixel") || env_contains("TERM", "mlterm")) return true;
    /* Sixel support is not reliably detectable without querying the
     * terminal, so allow an explicit opt-in. */
    if (getenv("SHOTTINO_GRAPHICS")) return true;
    return false;
}

void termcolor_render_rgb(const unsigned char *rgb, int w, int h, term_color_depth depth,
                          FILE *out) {
    if (!rgb || !out || w <= 0 || h <= 1) return;
    for (int y = 0; y + 1 < h; y += 2) {
        for (int x = 0; x < w; x++) {
            const unsigned char *top = rgb + ((size_t)y * (size_t)w + (size_t)x) * 3;
            const unsigned char *bot = rgb + ((size_t)(y + 1) * (size_t)w + (size_t)x) * 3;
            switch (depth) {
            case TERM_COLOR_TRUE:
                fprintf(out, "\033[38;2;%d;%d;%dm\033[48;2;%d;%d;%dm▀", top[0], top[1],
                        top[2], bot[0], bot[1], bot[2]);
                break;
            case TERM_COLOR_256: {
                long tv = ((long)top[0] << 16) | ((long)top[1] << 8) | top[2];
                long bv = ((long)bot[0] << 16) | ((long)bot[1] << 8) | bot[2];
                fprintf(out, "\033[38;5;%dm\033[48;5;%dm▀", termcolor_xterm256(tv),
                        termcolor_xterm256(bv));
                break;
            }
            case TERM_COLOR_8: {
                /* With 8 colours a half block would usually show two
                 * indistinguishable blocks and carry no shape; one
                 * averaged cell with a ramp glyph carries both. */
                int r = (top[0] + bot[0]) / 2, g = (top[1] + bot[1]) / 2,
                    b = (top[2] + bot[2]) / 2;
                long avg = ((long)r << 16) | ((long)g << 8) | b;
                fprintf(out, "\033[%dm%c", 30 + termcolor_basic8(avg),
                        termcolor_ramp_char(r, g, b));
                break;
            }
            case TERM_COLOR_NONE: {
                int r = (top[0] + bot[0]) / 2, g = (top[1] + bot[1]) / 2,
                    b = (top[2] + bot[2]) / 2;
                fputc(termcolor_ramp_char(r, g, b), out);
                break;
            }
            }
        }
        /* Reset per row, and CRLF because the terminal is in raw mode
         * during a preview — a bare \n would stair-step the image. */
        fputs("\033[0m\r\n", out);
    }
}

int termcolor_luminance(long rgb) {
    if (rgb < 0) return -1;
    int r = (int)((rgb >> 16) & 0xff), g = (int)((rgb >> 8) & 0xff), b = (int)(rgb & 0xff);
    return (r * 30 + g * 59 + b * 11) / 100;
}

long termcolor_readable(long rgb, int bg_lum, int min_delta) {
    if (rgb < 0) return rgb;
    if (bg_lum < 0) bg_lum = 0;
    if (bg_lum > 255) bg_lum = 255;
    int lum = termcolor_luminance(rgb);
    if (abs(lum - bg_lum) >= min_delta) return rgb;

    int r = (int)((rgb >> 16) & 0xff), g = (int)((rgb >> 8) & 0xff), b = (int)(rgb & 0xff);
    /* Which way is away from the background. Exactly at the midpoint the
     * two directions are equally far, and lightening is the choice that
     * keeps a colour looking like itself on the dark terminals this
     * mostly runs on. */
    bool lighten = bg_lum <= 127;
    int want = lighten ? bg_lum + min_delta : bg_lum - min_delta;
    if (want > 255) want = 255;
    if (want < 0) want = 0;

    if (lighten) {
        /* Move each channel toward white by the fraction that lifts the
         * weighted mean to `want`. Blending toward white rather than
         * scaling channels up keeps a colour with a zero channel (pure
         * blue, 0x0000fc) from staying exactly as dark as it was —
         * scaling multiplies zero by anything and gets zero. */
        int room = 255 - lum;
        int need = want - lum;
        int t = room > 0 ? (need * 255) / room : 255;
        if (t < 0) t = 0;
        if (t > 255) t = 255;
        r += ((255 - r) * t) / 255;
        g += ((255 - g) * t) / 255;
        b += ((255 - b) * t) / 255;
    } else {
        int need = lum - want;
        int t = lum > 0 ? (need * 255) / lum : 0;
        if (t < 0) t = 0;
        if (t > 255) t = 255;
        r -= (r * t) / 255;
        g -= (g * t) / 255;
        b -= (b * t) / 255;
    }
    if (r > 255) r = 255;
    if (g > 255) g = 255;
    if (b > 255) b = 255;
    if (r < 0) r = 0;
    if (g < 0) g = 0;
    if (b < 0) b = 0;
    return ((long)r << 16) | ((long)g << 8) | (long)b;
}
