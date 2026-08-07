// #963 — `color-scheme` on <html>, derived from the theme that is actually
// painting.
//
// `appearance: none` (themes/default.css) makes the CLOSED <select> ours, but
// everything the user agent still paints by itself stays the UA's: the open
// list of <option>s (native by design — the whole point of keeping a real
// <select> is the system picker), the scrollbars on engines that ignore
// `scrollbar-color`, any future date/number input. `color-scheme` is the only
// declaration that tells the UA which way to paint those.
//
// It cannot be a literal in the stylesheet. cic ships a light theme, a dark
// theme AND a user theme editor whose payload overrides `--bg` inline on
// <html>, so the mode is not knowable at authoring time — a
// `:root[data-theme="irssi-dark"] { color-scheme: dark }` would lie the moment
// a user parks a light custom theme on top of the dark base. So it is driven
// from where the theme tokens are applied (theme.ts's base write and
// customTheme.ts's overlay write both call `applyColorScheme`), and it is
// DERIVED from `--bg` rather than from a second mode flag nobody would keep in
// sync: the mode of a theme IS the lightness of its background.
//
// The threshold is not a guess: it is the luminance at which black and white
// contrast EQUALLY against the colour (WCAG's own ratio formula solved for
// L, `sqrt(1.05 * 0.05) - 0.05`). Below it white text is the better fit, which
// is exactly the question `color-scheme: dark` answers for the UA.

export type ColorScheme = "dark" | "light";

const EQUAL_CONTRAST_LUMINANCE = Math.sqrt(1.05 * 0.05) - 0.05;

type Rgb = { r: number; g: number; b: number };

// `#rgb`, `#rrggbb` and the `rgb()` forms an engine may hand back. Anything
// else (a named colour, a gradient, an empty computed value) is not a colour
// this can reason about and yields null rather than a guessed mode.
function parseColor(value: string): Rgb | null {
  const v = value.trim();

  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v)?.[1];
  if (hex !== undefined) {
    const wide = hex.length === 6 ? hex : hex.replace(/./g, (c) => c + c);
    const packed = Number.parseInt(wide, 16);
    return { r: (packed >> 16) & 255, g: (packed >> 8) & 255, b: packed & 255 };
  }

  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(v);
  if (rgb !== null) {
    const [r, g, b] = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
    if ([r, g, b].every((c) => Number.isFinite(c))) return { r, g, b };
  }

  return null;
}

// WCAG 2.x relative luminance.
function relativeLuminance({ r, g, b }: Rgb): number {
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

// The scheme a background colour asks the UA for, or null when the value is
// not a colour we can read.
export function colorSchemeFor(cssColor: string): ColorScheme | null {
  const rgb = parseColor(cssColor);
  if (rgb === null) return null;
  return relativeLuminance(rgb) < EQUAL_CONTRAST_LUMINANCE ? "dark" : "light";
}

// Re-derive `color-scheme` from whatever `--bg` resolves to RIGHT NOW —
// the base [data-theme] block, or a custom theme's inline override on top of
// it, whichever is winning. Called from both token-application sites; reading
// the computed value rather than the payload is what keeps it to ONE rule for
// both. An unreadable `--bg` (no stylesheet yet, a non-colour) clears the
// declaration instead of guessing a mode.
export function applyColorScheme(): void {
  const root = document.documentElement;
  const scheme = colorSchemeFor(getComputedStyle(root).getPropertyValue("--bg"));
  if (scheme === null) root.style.removeProperty("color-scheme");
  else root.style.setProperty("color-scheme", scheme);
}
